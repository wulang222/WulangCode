// 官方 Anthropic SDK。这里用默认导入拿到 `Anthropic` 类，
// 它同时提供构造函数、`Anthropic.APIError` 等静态成员，以及类型命名空间 `Anthropic.*`
// （所以下面能看到 `Anthropic.MessageParam` 这种“类名当命名空间用”的写法）。
import Anthropic from "@anthropic-ai/sdk";
// 从配置模块导入若干工具函数与类型：
// - getContextWindow / getMaxOutputTokens：从配置读取（或推断）上下文窗口和最大输出 token 数
// - resolveAPIKey：按优先级解析 API key（配置字段 → 环境变量等）
// - ProviderConfig：提供商配置类型
import { getContextWindow, getMaxOutputTokens, resolveAPIKey, type ProviderConfig } from "../config/config.js";
// 会话相关类型：ConversationManager 管理历史，Message 是单条消息的结构
import type { ConversationManager, Message } from "../conversation/conversation.js";
// 统一客户端接口 LLMClient，以及“可设置最大输出”能力接口 MaxTokensSetter
// 本类同时实现这两个接口。
import type { LLMClient, MaxTokensSetter } from "./client.js";
// emptyUsage：构造一个全 0 的用量对象；StreamEvent/UsageInfo 是流事件与 token 用量的类型
import { emptyUsage, type StreamEvent, type UsageInfo } from "./events.js";
// 统一的错误类型体系。上层只认这些错误，不关心底层 SDK 的错误长什么样。
import {
  AuthenticationError,   // 401 / 缺少 key
  ContextTooLongError,   // 输入超出上下文窗口
  isAbortError,          // 判断是否为“用户主动中止”类错误
  LLMError,              // 通用 LLM 错误基类
  NetworkError,          // 网络/未知错误
  RateLimitError,        // 429 限流
} from "./errors.js";

/**
 * 向 anthropic 兼容的 /v1/models 探测上下文窗口。
 * 任何失败都返回 0，调用方降级，不能抛。
 *
 * 设计要点：这是一个“尽力而为”的探测。探测失败不应该影响主流程，
 * 所以整段用 try/catch 包住，任何异常都吞掉返回 0；
 * 调用方拿到 0 就回退到配置里的默认值。
 */
export async function fetchModelContextWindow(cfg: ProviderConfig): Promise<number> {
  // 只有 anthropic 协议才探测；其他协议直接返回 0。
  if (cfg.protocol !== "anthropic") return 0;
  // 用 AbortController 实现 3 秒超时，避免探测卡住启动流程。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // 去掉 base_url 末尾的斜杠，避免拼出双斜杠 URL。
    const base = cfg.base_url.replace(/\/$/, "");
    // 模型名要 URL 编码（有些模型名可能含特殊字符）。
    const url = `${base}/v1/models/${encodeURIComponent(cfg.model)}`;
    // Anthropic API 必须带版本头。
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    const apiKey = resolveAPIKey(cfg);
    // 有 key 才加认证头；某些自建代理可能不需要 key。
    if (apiKey) headers["x-api-key"] = apiKey;
    const response = await fetch(url, { headers, signal: controller.signal });
    // 非 2xx 直接放弃，返回 0。
    if (!response.ok) return 0;
    const body = (await response.json()) as { max_input_tokens?: unknown };
    // 只有拿到正数才认为有效，否则返回 0 让调用方降级。
    return typeof body.max_input_tokens === "number" && body.max_input_tokens > 0
        ? body.max_input_tokens
        : 0;
  } catch {
    // 网络错误、超时、JSON 解析失败等一律吞掉。
    return 0;
  } finally {
    // 无论成功失败都要清掉定时器，防止定时器泄漏。
    clearTimeout(timer);
  }
}

// 类型别名：Anthropic 消息内容块（text / thinking / tool_use / tool_result 等）
type ContentBlock = Anthropic.ContentBlockParam;

/**
 * 把内部历史转成 Anthropic messages。
 * 连续的纯文本 user 合并，避免打乱交替。
 *
 * Anthropic 的 messages 要求 role 在 user/assistant 之间交替，
 * 所以这里做了“合并相邻 user 文本”的处理，避免因内部历史结构
 * 产生连续两条 user 消息导致 API 报错。
 */
export function buildAnthropicMessages(history: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of history) {
    // 系统提示不放在 messages 里，而是单独通过 system 参数传，所以跳过。
    if (message.role === "system") continue;

    // ---------- assistant 消息：可能包含思考块、文本、工具调用 ----------
    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      // 1) 思考块（extended thinking），带上 signature 用于校验。
      for (const thinking of message.thinkingBlocks ?? []) {
        blocks.push({
          type: "thinking",
          thinking: thinking.thinking,
          signature: thinking.signature,
        });
      }
      // 2) 普通文本
      if (message.content) blocks.push({ type: "text", text: message.content });
      // 3) 工具调用块
      for (const tool of message.toolUses ?? []) {
        blocks.push({ type: "tool_use", id: tool.toolUseId, name: tool.toolName, input: tool.arguments });
      }
      // 有块就用块数组，没有块就退回纯字符串（保持与原消息形式一致）。
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : message.content });
      continue;
    }

    // ---------- user 消息：可能包含工具结果，或普通文本 ----------
    // 工具结果必须作为 user 消息中的 tool_result 块回传。
    if (message.toolResults && message.toolResults.length > 0) {
      out.push({
        role: "user",
        content: message.toolResults.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolUseId,   // 对应哪次 tool_use
          content: result.content,          // 工具执行结果
          is_error: result.isError,         // 是否出错
        })),
      });
      continue;
    }
    // 普通用户文本走合并逻辑。
    pushUserText(out, message.content);
  }
  return out;
}

/**
 * 把一段用户文本追加到 out 中，并尽量与上一条 user 消息合并。
 * 目的：满足 Anthropic “user/assistant 交替”的要求，避免连续 user。
 */
function pushUserText(out: Anthropic.MessageParam[], text: string): void {
  const prev = out[out.length - 1];
  // 情况 1：上一条是 user 且内容是字符串 → 直接字符串拼接。
  if (prev?.role === "user" && typeof prev.content === "string") {
    prev.content = `${prev.content}\n${text}`;
    return;
  }
  // 情况 2：上一条是 user 且内容是块数组 → 块全为 text / tool_result 时追加一个 text 块。
  // （tool_result 消息后跟补充提醒文本是合法组合，合并保证交替不被打断。）
  if (prev?.role === "user" && Array.isArray(prev.content) && prev.content.length > 0) {
    const mergeable = prev.content.every((block) => block.type === "text" || block.type === "tool_result");
    if (mergeable) {
      prev.content.push({ type: "text", text });
      return;
    }
  }
  // 其他情况：新开一条 user 消息。
  out.push({ role: "user", content: text });
}

/**
 * 给最后一条普通 user 内容的最后一块打缓存标记。
 * 作用：利用 Anthropic 的 prompt caching，把这段前缀缓存起来，减少重复计费/延迟。
 */export function markLastUserTailForCache(messages: Anthropic.MessageParam[]): void {
  // 从后往前找最近一条 user 消息。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;

    // 字符串形式 → 转成单 text 块并加 cache_control。
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
      return;
    }
    // 空数组或不合法内容跳过，继续往前找。
    if (!Array.isArray(message.content) || message.content.length === 0) continue;

    // 只给最后一块打标记，且这块必须是 text 块。
    // （tool_result 等块不能作为缓存断点）
    const last = message.content[message.content.length - 1];
    if (!last || last.type !== "text") continue;
    last.cache_control = { type: "ephemeral" };
    return;
  }
}

/** buildAnthropicParams 的入参。 */
export interface AnthropicParamsInput {
  model: string;
  maxTokens: number;
  /** 提供则开启 extended thinking，值为 budget_tokens。 */
  thinkingBudget?: number;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  toolSchemas: Record<string, unknown>[];
}

/**
 * 组装 MessageCreateParams（纯函数，便于单测断言缓存断点）。
 * 三层 ephemeral 断点（F3）：system 块、工具列表末项、历史尾部 user 末块
 * ——messages 侧的断点由 markLastUserTailForCache 预先打好。
 */
export function buildAnthropicParams(input: AnthropicParamsInput): Anthropic.MessageCreateParamsStreaming {
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: input.model,
    max_tokens: input.maxTokens,
    stream: true,
    // 系统提示单独传，并打 cache_control 让它也走 prompt caching。
    system: [{ type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: input.messages,
  };
  if (input.thinkingBudget !== undefined) {
    params.thinking = { type: "enabled", budget_tokens: input.thinkingBudget };
  }
  if (input.toolSchemas.length > 0) {
    const tools = input.toolSchemas.map((s) => {
      const schema = s as { name?: string; description?: string; input_schema?: Record<string, unknown> };
      return {
        name: schema.name ?? "",
        description: schema.description ?? "",
        input_schema: {
          type: "object",
          properties: schema.input_schema?.properties ?? {},
          required: schema.input_schema?.required ?? [],
        },
      };
    });
    // 工具列表末项打 ephemeral 断点：工具集变化时前缀（system + 前面的工具）仍可命中。
    (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    params.tools = tools as unknown as Anthropic.Tool[];
  }
  return params;
}

/**
 * 把 Anthropic SDK 抛出的各种错误归类成我们统一的 LLMError 子类，
 * 让上层只处理少数几种错误语义。
 */
export function classifyAnthropicError(err: unknown): LLMError {
  if (err instanceof Anthropic.APIError) {
    const message = err.message;
    // 401 → 认证失败
    if (err.status === 401) return new AuthenticationError(message);
    // 429 → 限流，额外提取 retry-after 头，告诉上层多久后重试
    if (err.status === 429) {
      const retry = err.headers?.get("retry-after") ?? undefined;
      return new RateLimitError(message, retry);
    }
    // 413 或提示词过长 → 上下文超限
    if (err.status === 413 || message.includes("prompt is too long")) {
      return new ContextTooLongError(message);
    }
    // 其他 API 错误 → 通用 LLMError
    return new LLMError(message);
  }
  // 已经是我们的错误类型，原样返回（避免重复包装）。
  if (err instanceof LLMError) return err;
  // 其余（网络错误、未知异常）统一归为 NetworkError。
  const message = err instanceof Error ? err.message : String(err);
  return new NetworkError(message);
}

// 累积工具调用参数的临时结构。
// 流式返回工具参数时是分片的 JSON 字符串，需要边收边拼，最后再整体解析。
interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * Anthropic Messages 流式客户端。
 * 思考增量会向上游发出，由界面决定不渲染。
 * 同时实现 LLMClient（流式接口）与 MaxTokensSetter（可动态设置最大输出）。
 */
export class AnthropicClient implements LLMClient, MaxTokensSetter {
  private readonly client: Anthropic;   // 底层 SDK 实例
  private maxOutputTokens: number;      // 单次最大输出 token（可被 setMaxOutputTokens 修改）
  private contextWindow: number;        // 上下文窗口大小

  constructor(
      private readonly cfg: ProviderConfig,
      private readonly systemPrompt: string,
  ) {
    // 构造阶段就校验 API key，没有就立刻抛认证错误，避免等到真正请求时才报。
    const apiKey = resolveAPIKey(cfg);
    if (!apiKey) {
      throw new AuthenticationError("缺少 API 密钥。请在配置中填写 api_key，或设置 ANTHROPIC_API_KEY。");
    }
    // 用配置的 base_url 初始化 SDK（支持代理/自建网关）。
    this.client = new Anthropic({ apiKey, baseURL: cfg.base_url });
    // 初始化数值型配置，后续可通过 setter 动态调整。
    this.maxOutputTokens = getMaxOutputTokens(cfg);
    this.contextWindow = getContextWindow(cfg);
  }

  setMaxOutputTokens(n: number): void {
    this.maxOutputTokens = n;
  }

  setContextWindow(n: number): void {
    this.contextWindow = n;
  }

  getContextWindow(): number {
    return this.contextWindow;
  }

  /**
   * 发起流式请求，逐条产出统一事件。
   * 事件顺序大致是：
   *   thinking_delta* → thinking_complete
   *   text_delta*
   *   tool_call_start → tool_call_delta* → tool_call_complete
   *   stream_end
   */
  async *stream(
      conv: ConversationManager,
      toolSchemas: Record<string, unknown>[],
      abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // 1) 把内部历史（含待发补充提醒）转成 Anthropic 消息格式，并给尾部打缓存标记。
    const messages = buildAnthropicMessages(conv.getRequestMessages());
    markLastUserTailForCache(messages);

    // Anthropic 要求 budget_tokens ≥ 1024，并且小于 max_tokens。
    // 所以这里做一次“自适应”：开启思考时，确保 budget 至少 1024 且 max > budget。
    let maxTokens = this.maxOutputTokens;
    let budget = maxTokens - 1;
    if (this.cfg.thinking && budget < 1024) {
      budget = 1024;
      maxTokens = budget + 1;
    }

    // 2) 组装请求参数（system / 末 tool 断点在 buildAnthropicParams 内统一处理）。
    const params = buildAnthropicParams({
      model: this.cfg.model,
      maxTokens,
      thinkingBudget: this.cfg.thinking ? budget : undefined,
      systemPrompt: this.systemPrompt,
      messages,
      toolSchemas,
    });

    // 3) 流式状态跟踪变量（跨事件累积）。
    const usage: UsageInfo = emptyUsage();
    let stopReason = "end_turn";           // 默认停止原因
    let thinkingText = "";                  // 当前思考块累积文本
    let signature = "";                     // 当前思考块的签名
    let blockKind: "thinking" | "tool" | "text" | null = null; // 当前内容块类型
    let tool: ToolAcc | null = null;        // 当前正在累积的工具调用

    try {
      // SDK 的 stream 方法本身返回异步可迭代对象；传入 signal 支持取消。
      const stream = this.client.messages.stream(params, { signal: abortSignal });
      for await (const event of stream) {
        // ---------- 消息开始：读取初始 token 用量 ----------
        if (event.type === "message_start") {
          const startUsage = event.message.usage;
          usage.inputTokens = startUsage.input_tokens ?? 0;
          usage.outputTokens = startUsage.output_tokens ?? 0;
          usage.cacheReadInputTokens = startUsage.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens = startUsage.cache_creation_input_tokens ?? 0;
          continue;
        }

        // ---------- 内容块开始：根据块类型初始化累积状态 ----------
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking") {
            blockKind = "thinking";
            thinkingText = block.thinking ?? "";
            signature = block.signature ?? "";
          } else if (block.type === "tool_use") {
            blockKind = "tool";
            tool = { id: block.id, name: block.name, args: "" };
            // 立即通知上游“有一个工具调用开始了”。
            yield { type: "tool_call_start", toolName: block.name, toolId: block.id };
          } else if (block.type === "text") {
            blockKind = "text";
          } else {
            // 其他未知块类型忽略。
            blockKind = null;
          }
          continue;
        }

        // ---------- 内容块增量：按增量类型分派 ----------
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            thinkingText += delta.thinking;
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (delta.type === "signature_delta") {
            // 签名分片也要累积，最终随 thinking_complete 一起给出。
            signature += delta.signature;
          } else if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            // 工具参数是分片 JSON 字符串，先拼起来，最后统一解析。
            if (tool) tool.args += delta.partial_json;
            yield { type: "tool_call_delta", text: delta.partial_json };
          }
          continue;
        }

        // ---------- 内容块结束：产出对应的完成事件 ----------
        if (event.type === "content_block_stop") {
          if (blockKind === "thinking") {
            // 思考块结束，带上完整文本和签名。
            yield { type: "thinking_complete", thinking: thinkingText, signature };
            thinkingText = "";
            signature = "";
          } else if (blockKind === "tool" && tool) {
            // 工具块结束，尝试把累积的 JSON 字符串解析成对象。
            yield {
              type: "tool_call_complete",
              toolId: tool.id,
              toolName: tool.name,
              arguments: parseArgs(tool.args),
            };
            tool = null;
          }
          // 重置块类型（text 块结束无需额外事件）。
          blockKind = null;
          continue;
        }

        // ---------- 消息级增量：停止原因 + 最终输出 token 数 ----------
        if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (typeof event.usage.output_tokens === "number") {
            usage.outputTokens = event.usage.output_tokens;
          }
        }
      }
    } catch (err) {
      // 用户主动中止：原样抛出，让上层识别并安静处理。
      if (isAbortError(err)) throw err;
      // 其他错误：归类成统一 LLMError 再抛。
      throw classifyAnthropicError(err);
    }

    // 4) 流结束，产出汇总事件（停止原因 + 用量）。
    yield { type: "stream_end", stopReason, usage };
  }
}

/**
 * 解析工具调用参数。
 * 流式拼出来的 JSON 可能不完整/为空/非对象，所以这里做防御性处理：
 * - 空白 → {}
 * - JSON 解析失败 → {}
 * - 解析结果不是普通对象（比如数组、null）→ {}
 * 保证返回的永远是 Record<string, unknown>。
 */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
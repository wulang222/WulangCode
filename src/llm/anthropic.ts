import Anthropic from "@anthropic-ai/sdk";
import { getContextWindow, getMaxOutputTokens, resolveAPIKey, type ProviderConfig } from "../config/config.js";
import type { ConversationManager, Message } from "../conversation/conversation.js";
import type { LLMClient, MaxTokensSetter } from "./client.js";
import { emptyUsage, type StreamEvent, type UsageInfo } from "./events.js";
import {
  AuthenticationError,
  ContextTooLongError,
  isAbortError,
  LLMError,
  NetworkError,
  RateLimitError,
} from "./errors.js";

/**
 * 向 anthropic 兼容的 /v1/models 探测上下文窗口。
 * 任何失败都返回 0，调用方降级，不能抛。
 */
export async function fetchModelContextWindow(cfg: ProviderConfig): Promise<number> {
  if (cfg.protocol !== "anthropic") return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const base = cfg.base_url.replace(/\/$/, "");
    const url = `${base}/v1/models/${encodeURIComponent(cfg.model)}`;
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    const apiKey = resolveAPIKey(cfg);
    if (apiKey) headers["x-api-key"] = apiKey;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return 0;
    const body = (await response.json()) as { max_input_tokens?: unknown };
    return typeof body.max_input_tokens === "number" && body.max_input_tokens > 0
      ? body.max_input_tokens
      : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

type ContentBlock = Anthropic.ContentBlockParam;

/** 把内部历史转成 Anthropic messages。连续的纯文本 user 合并，避免打乱交替。 */
export function buildAnthropicMessages(history: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      for (const thinking of message.thinkingBlocks ?? []) {
        blocks.push({
          type: "thinking",
          thinking: thinking.thinking,
          signature: thinking.signature,
        });
      }
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const tool of message.toolUses ?? []) {
        blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : message.content });
      continue;
    }
    if (message.toolResults && message.toolResults.length > 0) {
      out.push({
        role: "user",
        content: message.toolResults.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolUseId,
          content: result.content,
          is_error: result.isError,
        })),
      });
      continue;
    }
    pushUserText(out, message.content);
  }
  return out;
}

function pushUserText(out: Anthropic.MessageParam[], text: string): void {
  const prev = out[out.length - 1];
  if (prev?.role === "user" && typeof prev.content === "string") {
    prev.content = `${prev.content}\n${text}`;
    return;
  }
  if (prev?.role === "user" && Array.isArray(prev.content)) {
    const onlyText = prev.content.every((block) => block.type === "text");
    if (onlyText) {
      prev.content.push({ type: "text", text });
      return;
    }
  }
  out.push({ role: "user", content: text });
}

/** 给最后一条普通 user 内容的最后一块打缓存标记。 */
export function markLastUserTailForCache(messages: Anthropic.MessageParam[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
      return;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) continue;
    const last = message.content[message.content.length - 1];
    if (!last || last.type !== "text") continue;
    last.cache_control = { type: "ephemeral" };
    return;
  }
}

export function classifyAnthropicError(err: unknown): LLMError {
  if (err instanceof Anthropic.APIError) {
    const message = err.message;
    if (err.status === 401) return new AuthenticationError(message);
    if (err.status === 429) {
      const retry = err.headers?.get("retry-after") ?? undefined;
      return new RateLimitError(message, retry);
    }
    if (err.status === 413 || message.includes("prompt is too long")) {
      return new ContextTooLongError(message);
    }
    return new LLMError(message);
  }
  if (err instanceof LLMError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new NetworkError(message);
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

/** Anthropic Messages 流式客户端。思考增量会向上游发出，由界面决定不渲染。 */
export class AnthropicClient implements LLMClient, MaxTokensSetter {
  private readonly client: Anthropic;
  private maxOutputTokens: number;
  private contextWindow: number;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly systemPrompt: string,
  ) {
    const apiKey = resolveAPIKey(cfg);
    if (!apiKey) {
      throw new AuthenticationError("缺少 API 密钥。请在配置中填写 api_key，或设置 ANTHROPIC_API_KEY。");
    }
    this.client = new Anthropic({ apiKey, baseURL: cfg.base_url });
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

  async *stream(
    conv: ConversationManager,
    toolSchemas: Record<string, unknown>[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const messages = buildAnthropicMessages(conv.getMessages());
    markLastUserTailForCache(messages);

    // Anthropic 要求 budget_tokens ≥ 1024，并且小于 max_tokens。
    let maxTokens = this.maxOutputTokens;
    let budget = maxTokens - 1;
    if (this.cfg.thinking && budget < 1024) {
      budget = 1024;
      maxTokens = budget + 1;
    }

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.cfg.model,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (this.cfg.thinking) {
      params.thinking = { type: "enabled", budget_tokens: budget };
    }
    if (toolSchemas.length > 0) {
      params.tools = toolSchemas as unknown as Anthropic.Tool[];
    }

    const usage: UsageInfo = emptyUsage();
    let stopReason = "end_turn";
    let thinkingText = "";
    let signature = "";
    let blockKind: "thinking" | "tool" | "text" | null = null;
    let tool: ToolAcc | null = null;

    try {
      const stream = this.client.messages.stream(params, { signal: abortSignal });
      for await (const event of stream) {
        if (event.type === "message_start") {
          const startUsage = event.message.usage;
          usage.inputTokens = startUsage.input_tokens ?? 0;
          usage.outputTokens = startUsage.output_tokens ?? 0;
          usage.cacheReadInputTokens = startUsage.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens = startUsage.cache_creation_input_tokens ?? 0;
          continue;
        }
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking") {
            blockKind = "thinking";
            thinkingText = block.thinking ?? "";
            signature = block.signature ?? "";
          } else if (block.type === "tool_use") {
            blockKind = "tool";
            tool = { id: block.id, name: block.name, args: "" };
            yield { type: "tool_call_start", toolName: block.name, toolId: block.id };
          } else if (block.type === "text") {
            blockKind = "text";
          } else {
            blockKind = null;
          }
          continue;
        }
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            thinkingText += delta.thinking;
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (delta.type === "signature_delta") {
            signature += delta.signature;
          } else if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            if (tool) tool.args += delta.partial_json;
            yield { type: "tool_call_delta", text: delta.partial_json };
          }
          continue;
        }
        if (event.type === "content_block_stop") {
          if (blockKind === "thinking") {
            yield { type: "thinking_complete", thinking: thinkingText, signature };
            thinkingText = "";
            signature = "";
          } else if (blockKind === "tool" && tool) {
            yield {
              type: "tool_call_complete",
              toolId: tool.id,
              toolName: tool.name,
              arguments: parseArgs(tool.args),
            };
            tool = null;
          }
          blockKind = null;
          continue;
        }
        if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (typeof event.usage.output_tokens === "number") {
            usage.outputTokens = event.usage.output_tokens;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw classifyAnthropicError(err);
    }

    yield { type: "stream_end", stopReason, usage };
  }
}

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

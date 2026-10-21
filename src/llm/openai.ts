import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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

type ResponseInput = OpenAI.Responses.ResponseInput;

/** Responses API 输入：工具调用拆成 function_call / function_call_output。 */
export function buildOpenAIInput(history: Message[]): ResponseInput {
  const items: ResponseInput = [];
  for (const message of history) {
    if (message.role === "assistant" && message.toolUses && message.toolUses.length > 0) {
      if (message.content) items.push({ role: "assistant", content: message.content });
      for (const tool of message.toolUses) {
        items.push({
          type: "function_call",
          call_id: tool.id,
          name: tool.name,
          arguments: JSON.stringify(tool.input),
        });
      }
      continue;
    }
    if (message.role === "user" && message.toolResults && message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        items.push({
          type: "function_call_output",
          call_id: result.toolUseId,
          output: result.content,
        });
      }
      continue;
    }
    const role = message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user";
    items.push({ role, content: message.content });
  }
  return items;
}

/** Chat Completions 消息。tool 结果用 role=tool。 */
export function buildChatCompletionMessages(history: Message[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  for (const message of history) {
    if (message.role === "assistant" && message.toolUses && message.toolUses.length > 0) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolUses.map((tool) => ({
          id: tool.id,
          type: "function" as const,
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        })),
      });
      continue;
    }
    if (message.role === "user" && message.toolResults && message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        messages.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
      }
      continue;
    }
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    messages.push({ role: "user", content: message.content });
  }
  return messages;
}

export function classifyOpenAIError(err: unknown): LLMError {
  if (err instanceof OpenAI.APIError) {
    const message = err.message;
    if (err.status === 401) return new AuthenticationError(message);
    if (err.status === 429) {
      const retry = err.headers?.get("retry-after") ?? undefined;
      return new RateLimitError(message, retry);
    }
    const tooLong =
      err.status === 413 ||
      (err.status === 400 &&
        /context_length_exceeded|maximum context length|prompt is too long/i.test(message));
    if (tooLong) return new ContextTooLongError(message);
    return new LLMError(message);
  }
  if (err instanceof LLMError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new NetworkError(message);
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

function requireKey(cfg: ProviderConfig): string {
  const apiKey = resolveAPIKey(cfg);
  if (!apiKey) {
    const envName = cfg.protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new AuthenticationError(`缺少 API 密钥。请在配置中填写 api_key，或设置 ${envName}。`);
  }
  return apiKey;
}

/** 官方 OpenAI Responses API。 */
export class OpenAIClient implements LLMClient, MaxTokensSetter {
  private readonly client: OpenAI;
  private maxOutputTokens: number;
  private contextWindow: number;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly systemPrompt: string,
  ) {
    this.client = new OpenAI({ apiKey: requireKey(cfg), baseURL: cfg.base_url });
    this.maxOutputTokens = getMaxOutputTokens(cfg);
    this.contextWindow = getContextWindow(cfg);
  }

  setMaxOutputTokens(n: number): void {
    this.maxOutputTokens = n;
  }

  setContextWindow(n: number): void {
    this.contextWindow = n;
  }

  async *stream(
    conv: ConversationManager,
    toolSchemas: Record<string, unknown>[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const input: ResponseInput = [
      { role: "system", content: this.systemPrompt },
      ...buildOpenAIInput(conv.getMessages()),
    ];
    const usage: UsageInfo = emptyUsage();
    let stopReason = "end_turn";
    try {
      const stream = await this.client.responses.create(
        {
          model: this.cfg.model,
          input,
          stream: true,
          max_output_tokens: this.maxOutputTokens,
          ...(toolSchemas.length > 0
            ? { tools: toolSchemas as unknown as OpenAI.Responses.Tool[] }
            : {}),
        },
        { signal: abortSignal },
      );
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text_delta", text: event.delta };
          continue;
        }
        if (event.type === "response.function_call_arguments.delta") {
          yield { type: "tool_call_delta", text: event.delta };
          continue;
        }
        if (event.type === "response.output_item.added" && event.item.type === "function_call") {
          yield { type: "tool_call_start", toolName: event.item.name, toolId: event.item.call_id };
          continue;
        }
        if (event.type === "response.output_item.done" && event.item.type === "function_call") {
          yield {
            type: "tool_call_complete",
            toolId: event.item.call_id,
            toolName: event.item.name,
            arguments: parseArgs(event.item.arguments),
          };
          continue;
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          const response = event.response;
          const cached = response.usage?.input_tokens_details.cached_tokens ?? 0;
          const inputTokens = Math.max(0, (response.usage?.input_tokens ?? 0) - cached);
          usage.inputTokens = inputTokens;
          usage.outputTokens = response.usage?.output_tokens ?? 0;
          usage.cacheReadInputTokens = cached;
          usage.cacheCreationInputTokens = response.usage?.input_tokens_details.cache_write_tokens ?? 0;
          if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
            stopReason = "max_tokens";
          } else {
            stopReason = "end_turn";
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw classifyOpenAIError(err);
    }
    yield { type: "stream_end", stopReason, usage };
  }
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/** 兼容端点用的 Chat Completions 流。 */
export class OpenAICompatClient implements LLMClient, MaxTokensSetter {
  private readonly client: OpenAI;
  private maxOutputTokens: number;
  private contextWindow: number;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly systemPrompt: string,
  ) {
    this.client = new OpenAI({ apiKey: requireKey(cfg), baseURL: cfg.base_url });
    this.maxOutputTokens = getMaxOutputTokens(cfg);
    this.contextWindow = getContextWindow(cfg);
  }

  setMaxOutputTokens(n: number): void {
    this.maxOutputTokens = n;
  }

  setContextWindow(n: number): void {
    this.contextWindow = n;
  }

  async *stream(
    conv: ConversationManager,
    toolSchemas: Record<string, unknown>[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...buildChatCompletionMessages(conv.getMessages()),
    ];
    const usage: UsageInfo = emptyUsage();
    let finishReason = "";
    const toolCalls = new Map<number, ToolCallAcc>();

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.cfg.model,
          messages,
          stream: true,
          max_tokens: this.maxOutputTokens,
          stream_options: { include_usage: true },
          ...(toolSchemas.length > 0 ? { tools: toolSchemas as unknown as ChatCompletionTool[] } : {}),
        },
        { signal: abortSignal },
      );
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const content = choice?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          yield { type: "text_delta", text: content };
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
          let acc = toolCalls.get(call.index);
          if (!acc) {
            acc = { id: "", name: "", args: "", started: false };
            toolCalls.set(call.index, acc);
          }
          if (call.id) acc.id = call.id;
          if (call.function?.name) acc.name = call.function.name;
          if (call.function?.arguments) {
            acc.args += call.function.arguments;
            yield { type: "tool_call_delta", text: call.function.arguments };
          }
          if (!acc.started && acc.id && acc.name) {
            acc.started = true;
            yield { type: "tool_call_start", toolName: acc.name, toolId: acc.id };
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached);
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          usage.cacheReadInputTokens = cached;
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw classifyOpenAIError(err);
    }

    let stopReason = "end_turn";
    if (finishReason === "length") stopReason = "max_tokens";
    else if (finishReason === "tool_calls" || toolCalls.size > 0) stopReason = "tool_use";

    for (const acc of toolCalls.values()) {
      yield {
        type: "tool_call_complete",
        toolId: acc.id,
        toolName: acc.name,
        arguments: parseArgs(acc.args),
      };
    }
    yield { type: "stream_end", stopReason, usage };
  }
}

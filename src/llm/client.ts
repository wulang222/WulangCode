import type { ProviderConfig } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { StreamEvent } from "./events.js";

/** 三个协议共同的流式接口。tools 本章传空数组。 */
export interface LLMClient {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
  setContextWindow?(n: number): void;
}

export interface MaxTokensSetter {
  setMaxOutputTokens(n: number): void;
}

/** 按 protocol 动态加载对应客户端，避免一次拉起两个 SDK。 */
export async function createClient(cfg: ProviderConfig, systemPrompt: string): Promise<LLMClient> {
  switch (cfg.protocol) {
    case "anthropic": {
      const { AnthropicClient } = await import("./anthropic.js");
      return new AnthropicClient(cfg, systemPrompt);
    }
    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      return new OpenAIClient(cfg, systemPrompt);
    }
    case "openai-compat": {
      const { OpenAICompatClient } = await import("./openai.js");
      return new OpenAICompatClient(cfg, systemPrompt);
    }
    default:
      throw new Error(`Unknown protocol: ${cfg.protocol}`);
  }
}

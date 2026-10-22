// 从配置模块导入 ProviderConfig 类型。
// 这里用 `import type`，表示只在编译期用于类型检查，不会生成运行时代码，
// 因此不会把 config.js 真的加载进来，有助于避免循环依赖和无谓的运行时开销。
import type { ProviderConfig } from "../config/config.js";
// 从会话管理模块导入 ConversationManager 类型（同上，仅类型导入）。
// ConversationManager 负责保存整个对话历史（消息列表、角色、内容等）。
import type { ConversationManager } from "../conversation/conversation.js";
// 从 events 模块导入 StreamEvent 类型（仅类型导入）。
// StreamEvent 是流式输出事件联合类型，例如“文本增量”“工具调用”“结束”等。
import type { StreamEvent } from "./events.js";

/**
 * 三个协议共同的流式接口。
 * 无论是 Anthropic、OpenAI 还是 OpenAI 兼容协议，对外都暴露这一套统一方法，
 * 上层调用者（例如主循环、UI 层）不需要关心底层用的是哪个 SDK。
 * tools 本章传空数组。
 */
export interface LLMClient {
  /**
   * 发起一次流式请求。
   *
   * @param conv         当前会话（包含历史消息、系统提示等上下文）
   * @param tools        可用的工具定义列表。本章（当前实现阶段）固定传空数组，
   *                     表示暂不支持工具调用；后续可扩展。
   * @param abortSignal  可选的中止信号。用户取消请求或超时时，通过它中断流。
   * @returns            一个异步生成器，逐条产出 StreamEvent。
   *                     调用方用 `for await (const ev of client.stream(...))` 消费。
   *
   * 为什么返回 AsyncGenerator 而不是 Promise：
   * 流式输出是“边生成边返回”，异步生成器天然适合这种逐步产出事件的场景。
   */
  stream(
      conv: ConversationManager,
      tools: Record<string, unknown>[],
      abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;

  /**
   * 可选方法：设置上下文窗口大小（模型一次能容纳的最大 token 数）。
   * 用 `?` 标记为可选，因为不是所有客户端都需要/实现它。
   * 某些实现会据此裁剪历史消息，避免超出模型上限。
   */
  setContextWindow?(n: number): void;
}

/**
 * 可设置“最大输出 token 数”的能力接口。
 * 这是一个独立的小接口，用于“能力探测”：
 * 调用方可以用 `if ("setMaxOutputTokens" in client)` 或类型守卫判断某个客户端是否支持，
 * 而不是把该方法硬塞进 LLMClient 让所有实现都必须提供。
 */
export interface MaxTokensSetter {
  /** 设置单次响应的最大输出 token 数。 */
  setMaxOutputTokens(n: number): void;
}

/**
 * 按 protocol 动态加载对应客户端，避免一次拉起两个 SDK。
 *
 * 为什么要动态 import（`await import(...)`）：
 * Anthropic 和 OpenAI 的 SDK 体积都不小，而且用户配置里只会用其中一个。
 * 如果顶部静态 import 两个 SDK，即使只用其中一个也会全部加载，
 * 增加启动时间、内存占用，甚至可能因未安装某个 SDK 而直接报错。
 * 动态 import 让模块（以及它依赖的 SDK）只在真正需要时才被求值加载。
 *
 * @param cfg           提供商配置，核心是 cfg.protocol 决定用哪个客户端。
 * @param systemPrompt  系统提示词，创建客户端时一并传入。
 * @returns             符合 LLMClient 接口的客户端实例。
 */
export async function createClient(cfg: ProviderConfig, systemPrompt: string): Promise<LLMClient> {
  // 根据配置里的协议字段分派到不同实现。
  switch (cfg.protocol) {
      // Anthropic 协议（Claude 系列模型）
    case "anthropic": {
      // 仅在走这个分支时才加载 anthropic.js 及其依赖的 SDK。
      const { AnthropicClient } = await import("./anthropic.js");
      // 用配置和系统提示构造客户端实例并返回。
      return new AnthropicClient(cfg, systemPrompt);
    }
      // 原生 OpenAI 协议（官方 API）
    case "openai": {
      // 动态加载 openai.js，取出官方 OpenAI 客户端类。
      const { OpenAIClient } = await import("./openai.js");
      return new OpenAIClient(cfg, systemPrompt);
    }
      // OpenAI 兼容协议（如各类第三方/自建服务，接口形似 OpenAI 但细节不同）
    case "openai-compat": {
      // 同样从 openai.js 加载，但用的是兼容实现类，处理差异（如 endpoint、字段兼容等）。
      const { OpenAICompatClient } = await import("./openai.js");
      return new OpenAICompatClient(cfg, systemPrompt);
    }
      // 兜底：协议未知，说明配置有误或代码未覆盖该协议，直接抛错。
      // 模板字符串把非法值带进错误信息，便于排查。
    default:
      throw new Error(`Unknown protocol: ${cfg.protocol}`);
  }
}
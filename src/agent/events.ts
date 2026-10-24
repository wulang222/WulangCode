import type { UsageInfo } from "../llm/events.js";

/** 协议无关的 Agent 事件：TUI 只消费这些，不感知底层协议。 */
export type AgentEvent =
  | { type: "stream_text"; text: string }
  | { type: "thinking_text"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_use"; toolName: string; toolId: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; toolId: string; output: string; isError: boolean; elapsed: number }
  | { type: "turn_complete" }
  | { type: "loop_complete"; stopReason: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error }
  | { type: "retry"; reason: string; delay: number }
  | { type: "permission_request"; toolName: string; args: Record<string, unknown> };

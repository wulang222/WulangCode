/** 一轮请求的 token 计数。界面只展示，不计算费用。 */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function emptyUsage(): UsageInfo {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/**
 * 协议无关的流式事件。
 * 界面只认识这些 type，不关心底层 SDK。
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | { type: "tool_call_complete"; toolId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };

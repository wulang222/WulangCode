import type { ToolResultBlock } from "../conversation/conversation.js";

/** 与 Agent 的 tool_result 事件结构兼容的最小形状（全可选，联合类型可直接传入）。 */
interface ToolResultLike {
  type?: string;
  toolId?: string;
  output?: string;
  isError?: boolean;
}

/**
 * 工具执行结果 → 回灌消息块：主循环在 addToolResultsMessage 前统一走这里，
 * 后续章节的记录钩子（文件快照 / 追踪）挂同一入口，不再散落在主循环里。
 */
export function toToolResultBlocks(events: Iterable<ToolResultLike>): ToolResultBlock[] {
  const blocks: ToolResultBlock[] = [];
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    blocks.push({ toolUseId: event.toolId ?? "", content: event.output ?? "", isError: event.isError ?? false });
  }
  return blocks;
}

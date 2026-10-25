import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationManager } from "../conversation/conversation.js";

/** 归档条目里的工具调用（snake_case，落盘格式与 Anthropic 消息形态对齐）。 */
interface TranscriptToolUse {
  tool_use_id: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

/** 归档条目里的工具结果。 */
interface TranscriptToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** 归档条目（F40）：仅在工具调用 / 工具结果非空时挂对应字段。 */
export interface TranscriptEntry {
  role: string;
  content?: string;
  tool_uses?: TranscriptToolUse[];
  tool_results?: TranscriptToolResult[];
}

/** 序列化对话历史：逐条消息映射成归档条目。 */
function serializeConversation(conv: ConversationManager): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const msg of conv.getMessages()) {
    const entry: TranscriptEntry = { role: msg.role };
    if (msg.content !== "") entry.content = msg.content;
    if (msg.toolUses && msg.toolUses.length > 0) {
      entry.tool_uses = msg.toolUses.map((tu) => ({
        tool_use_id: tu.toolUseId,
        tool_name: tu.toolName,
        arguments: tu.arguments,
      }));
    }
    if (msg.toolResults && msg.toolResults.length > 0) {
      entry.tool_results = msg.toolResults.map((tr) => ({
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError,
      }));
    }
    entries.push(entry);
  }
  return entries;
}

/** 归档子目录：<workDir>/.mewcode/teams/<team>/transcripts。 */
function transcriptDir(workDir: string, teamName: string): string {
  return join(workDir, ".mewcode", "teams", teamName, "transcripts");
}

/** 保存归档（F41）：递归建目录、写 <agentId>.json，返回写入路径。 */
export function saveTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
  conv: ConversationManager,
): string {
  const dir = transcriptDir(workDir, teamName);
  mkdirSync(dir, { recursive: true });
  const data: TranscriptEntry[] = serializeConversation(conv);
  const path = join(dir, agentId + ".json");
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

/** 加载归档（F42）：文件不存在或解析失败返回 null。 */
export function loadTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
): TranscriptEntry[] | null {
  const path = join(transcriptDir(workDir, teamName), agentId + ".json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TranscriptEntry[];
  } catch {
    return null;
  }
}

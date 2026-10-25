import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** 会话存档过期阈值（天）：按最后修改时间清理（F20）。 */
const SESSION_EXPIRY_DAYS = 30;

/** 压缩边界行标识（T18）。 */
export const COMPACT_BOUNDARY = "compact_boundary";

/** 会话文件里的单行消息（.jsonl 每行一个 JSON）。 */
export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  type?: string;
  toolUseId?: string;
}

/** 压缩边界里 verbatim 保留的消息（只存 role + content，drop tool blocks）。 */
export interface KeptMessage {
  role: string;
  content: string;
}

/** 压缩边界负载：bare summary + keep 内联，/resume 读这一行即可重建压缩态。 */
export interface CompactBoundaryPayload {
  summary: string;
  keep: KeptMessage[];
}

/** rebuildFromSession 的输出：可直接回放进 ConversationManager 的文本消息。 */
export interface RestoredMessage {
  role: "user" | "assistant";
  content: string;
}

/** 会话目录概览（/resume 无参列表用）：标题取首条非空 user 消息前 100 字符（F15）。 */
export interface SessionInfo {
  id: string;
  firstMessage: string;
  messageCount: number;
  size: number;
  modTime: Date;
}

/** 进程启动生成一次：base36 时间戳 + 短随机段，进程内唯一，不持久化（F34）。 */
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function sessionsDir(workDir: string): string {
  return join(workDir, ".mewcode", "sessions");
}

export function getSessionFilePath(workDir: string, sessionId: string): string {
  return join(sessionsDir(workDir), `${sessionId}.jsonl`);
}

/** 追加一行会话消息；目录按需创建，已存在不报错（N6 容忍重复启动）。 */
export function saveMessage(workDir: string, sessionId: string, msg: SessionMessage): void {
  mkdirSync(sessionsDir(workDir), { recursive: true });
  appendFileSync(getSessionFilePath(workDir, sessionId), `${JSON.stringify(msg)}\n`, "utf-8");
}

/** 压缩边界持久化：一行 role=system、type=compact_boundary、content=payload JSON（T18）。 */
export function saveCompactBoundary(workDir: string, sessionId: string, payload: CompactBoundaryPayload): void {
  saveMessage(workDir, sessionId, {
    role: "system",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    type: COMPACT_BOUNDARY,
  });
}

/** 读整个会话；空行跳过，非空 content 才保留（boundary 行 content 为 JSON 串，天然非空）。 */
export function loadSession(workDir: string, sessionId: string): SessionMessage[] {
  const path = getSessionFilePath(workDir, sessionId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const saved: SessionMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionMessage;
      if (parsed && typeof parsed.content === "string" && parsed.content !== "") saved.push(parsed);
    } catch {
      // 损坏行跳过，不让单行脏数据拖垮整个会话
    }
  }
  return saved;
}

/** 按修改时间倒序列出现有会话；单文件失败隔离跳过（F15/N5）。 */
export function listSessions(workDir: string): SessionInfo[] {
  const dir = sessionsDir(workDir);
  if (!existsSync(dir)) return [];
  const infos: SessionInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      const messages = loadSession(workDir, name.replace(/\.jsonl$/, ""));
      const firstUser = messages.find((m) => m.role === "user" && m.content !== "");
      infos.push({
        id: name.replace(/\.jsonl$/, ""),
        firstMessage: (firstUser?.content ?? "").slice(0, 100),
        messageCount: messages.length,
        size: stat.size,
        modTime: new Date(stat.mtimeMs),
      });
    } catch {
      // 单个存档读取失败不影响其他会话的列举
    }
  }
  return infos.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
}

/** 清理超过过期天数的存档（尽力而为）；返回删除数量（F20/F21）。 */
export function cleanExpiredSessions(workDir: string): number {
  const dir = sessionsDir(workDir);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // 单文件删除失败静默跳过
      }
    }
  } catch {
    return 0;
  }
  return removed;
}

/**
 * /resume 重建（T19）：倒序找最后一条压缩边界。
 * - 找到：[中文框架摘要 user, ...payload.keep, ...边界之后的普通消息]；
 *   边界之前的原始消息不回放（已被摘要替代）。
 * - 找不到：全量 replay（兼容无压缩的旧会话）。
 */
export function rebuildFromSession(saved: SessionMessage[]): RestoredMessage[] {
  const out: RestoredMessage[] = [];
  let lastBoundary = -1;
  for (let i = saved.length - 1; i >= 0; i -= 1) {
    if (saved[i]?.type === COMPACT_BOUNDARY) {
      lastBoundary = i;
      break;
    }
  }

  if (lastBoundary === -1) {
    for (const item of saved) {
      if ((item.role === "user" || item.role === "assistant") && item.content) {
        out.push({ role: item.role, content: item.content });
      }
    }
    return out;
  }

  let payload: CompactBoundaryPayload | null = null;
  try {
    payload = JSON.parse(saved[lastBoundary]!.content) as CompactBoundaryPayload;
  } catch {
    payload = null;
  }

  if (payload) {
    let resumeSummary =
      "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + payload.summary;
    if (payload.keep && payload.keep.length > 0) resumeSummary += "\n\n近期消息已原样保留。";
    out.push({ role: "user", content: resumeSummary });
    for (const k of payload.keep ?? []) {
      if ((k.role === "user" || k.role === "assistant") && k.content) {
        out.push({ role: k.role, content: k.content });
      }
    }
  }

  for (const item of saved.slice(lastBoundary + 1)) {
    if (item.type === COMPACT_BOUNDARY) continue;
    if ((item.role === "user" || item.role === "assistant") && item.content) {
      out.push({ role: item.role, content: item.content });
    }
  }
  return out;
}

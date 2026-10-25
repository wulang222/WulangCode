import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, ToolResultBlock } from "../conversation/conversation.js";
import { ContentReplacementState } from "./state.js";

/** 单条工具结果阈值（字符）：超过即落盘留预览（F1/F36）。 */
export const SINGLE_RESULT_LIMIT = 50000;
/** 单条消息内工具结果聚合阈值（字符）：超过按大→小继续落盘（F2/F36）。 */
export const MESSAGE_AGGREGATE_LIMIT = 200000;
/** 旧轮次 toolResult 裁剪线（字符）：超过且已出近期窗口才裁（F36）。 */
export const OLD_RESULT_SNIP_CHARS = 2000;
/** 近期窗口保留的真实轮次数（snipStale）。 */
export const KEEP_RECENT_TURNS = 10;
/** 预览体头部字符数。 */
export const PREVIEW_CHARS = 2000;

/** 落盘目录：与 sessionId 解耦，toolUseId 全局唯一即可定位。 */
function spillDir(workDir: string): string {
  return join(workDir, ".mewcode", "tool_results");
}

/**
 * 单条工具结果落盘（F3）：wx flag 保证幂等，已存在（EEXIST）静默吞，
 * 其余错误（磁盘满 / 只读目录）冒泡给调用方，由上层降级为不替换（N6）。
 */
export function writeSpill(workDir: string, toolUseId: string, content: string): string {
  const dir = spillDir(workDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, toolUseId);
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  return path;
}

/**
 * 预览替换体（F4）：确定性模板，同一 (content, spillPath) 逐字节稳定（G2）。
 * 含原始大小、落盘路径、重读提示与头部预览四项信息。
 */
export function buildSpillPreview(content: string, spillPath: string): string {
  const sizeKB = Math.floor(content.length / 1024);
  const preview = content.slice(0, PREVIEW_CHARS);
  const hasMore = content.length > PREVIEW_CHARS;
  return (
    `<persisted-output>\n` +
    `输出太大（${sizeKB}KB），完整内容已保存到：\n` +
    `${spillPath}\n` +
    `如需完整内容，请用 ReadFile 工具读取该路径。\n\n` +
    `预览（前 2KB）：\n` +
    preview +
    (hasMore ? "\n..." : "") +
    `\n</persisted-output>`
  );
}

/**
 * 第 1 层主入口（F6）：每轮组装请求前执行的纯字符串替换，不调用 LLM。
 * Pass 1 单条阈值 → Pass 2 聚合阈值 → snipStale 旧轮次裁剪。
 * 不修改入参，返回新 Message[]。
 */
export function applyBudget(
  messages: Message[],
  workDir: string,
  state: ContentReplacementState,
): Message[] {
  const result: Message[] = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const msg = { ...messages[mi]! };
    if (msg.toolResults && msg.toolResults.length > 0) {
      // Pass 1：单条阈值。已决策的 id 直接复用冻结字符串（F5d）。
      const newResults: ToolResultBlock[] = [];
      for (const tr of msg.toolResults) {
        const existing = state.getReplacement(tr.toolUseId);
        if (existing !== undefined) {
          newResults.push({ ...tr, content: existing });
          continue;
        }
        let content = tr.content;
        if (content.length > SINGLE_RESULT_LIMIT) {
          const spillPath = writeSpill(workDir, tr.toolUseId, content);
          content = buildSpillPreview(content, spillPath);
          state.record(tr.toolUseId, tr.content, content);
        }
        newResults.push({ ...tr, content });
      }
      // Pass 2：聚合阈值。按内容长度大→小落盘，直到回落到阈值内。
      let totalLen = newResults.reduce((sum, r) => sum + r.content.length, 0);
      if (totalLen > MESSAGE_AGGREGATE_LIMIT) {
        const sorted = [...newResults].sort((a, b) => b.content.length - a.content.length);
        for (const r of sorted) {
          if (totalLen <= MESSAGE_AGGREGATE_LIMIT) break;
          // 已是预览体或已裁剪的不再二次落盘，避免破坏冻结字符串。
          if (r.content.length <= OLD_RESULT_SNIP_CHARS) continue;
          if (r.content.startsWith("<persisted-output>")) continue;
          const before = r.content;
          const spillPath = writeSpill(workDir, r.toolUseId, before);
          const replacement = buildSpillPreview(before, spillPath);
          totalLen += replacement.length - before.length;
          r.content = replacement;
          state.record(r.toolUseId, before, replacement);
        }
      }
      msg.toolResults = newResults;
    }
    result.push(msg);
  }
  return snipStale(result);
}

/** 轮次完整标志：assistant 纯文本消息（无 toolUses）记为一轮真实答复。 */
function isRealTurn(msg: Message): boolean {
  return msg.role === "assistant" && (!msg.toolUses || msg.toolUses.length === 0);
}

/**
 * 旧轮次裁剪：真实轮次超过 KEEP_RECENT_TURNS 时，窗口外的大 toolResult
 * 替换为定长的 [Stale output snipped: N chars]。替换串由内容长度决定，
 * 同一内容每轮产物逐字节一致（G2），无需进账本。
 */
export function snipStale(messages: Message[]): Message[] {
  const totalTurns = messages.filter(isRealTurn).length;
  if (totalTurns <= KEEP_RECENT_TURNS) return messages;

  const oldBoundary = totalTurns - KEEP_RECENT_TURNS;
  let turnsSeen = 0;
  return messages.map((msg) => {
    if (isRealTurn(msg)) {
      turnsSeen += 1;
      return msg;
    }
    if (!msg.toolResults || msg.toolResults.length === 0) return msg;
    // 该结果所属轮次已在近期窗口内（其后已有 >= oldBoundary 轮答复）则保留。
    if (turnsSeen >= oldBoundary) return msg;
    const toolResults = msg.toolResults.map((tr) => {
      const c = tr.content;
      if (c.startsWith("<persisted-output>") || c.startsWith("[Stale output snipped:")) return tr;
      if (c.length <= OLD_RESULT_SNIP_CHARS) return tr;
      return { ...tr, content: `[Stale output snipped: ${c.length} chars]` };
    });
    return { ...msg, toolResults };
  });
}

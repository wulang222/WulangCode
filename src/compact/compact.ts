import type { LLMClient } from "../llm/client.js";
import { ContextTooLongError } from "../llm/errors.js";
import { ConversationManager, type Message } from "../conversation/conversation.js";
import type { RecoveryState } from "./recovery.js";
import type { CompactBoundaryPayload } from "../session/session.js";

/** legacy ratio 占位（阈值实际由 computeCompactThreshold 推导，F33）。 */
export const AUTO_COMPACT_THRESHOLD = 0.8;
/** 自动摘要连续失败熔断阈值（F28/F36）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** 字符 → token 估算比（F13/F36）。 */
export const CHARS_PER_TOKEN = 3.5;
/** 近期原文 token 下界（择宽保留的触发线之一）。 */
export const KEEP_RECENT_TOKENS = 10_000;
/** 近期原文条数下界。 */
export const MIN_KEEP_MESSAGES = 5;
/** 近期原文 token 上界：严格不跨越，防止 verbatim 尾部吃掉摘要收益。 */
export const KEEP_MAX_TOKENS = 40_000;
/** 退化保护：可摘要前缀不足 2 条时跳过整次压缩。 */
export const MIN_COMPACT_PREFIX = 2;
/** 摘要自身输出的预留空间（F7/F36）。 */
export const SUMMARY_OUTPUT_RESERVE = 20_000;
/** 自动压缩安全余量：估算误差 + 单轮波动（F7/F36）。 */
export const AUTO_COMPACT_SAFETY_MARGIN = 13_000;
/** 手动 / 摘要预检安全余量（F23/F36）。 */
export const MANUAL_COMPACT_SAFETY_MARGIN = 3_000;
/** 摘要请求自身撞 PTL 的直捷重试上限（F27/F36）。 */
const SUMMARY_PTL_DIRECT_RETRIES = 3;
/** 直捷重试用尽后的比例丢弃步长（F27/F36）。 */
const SUMMARY_PTL_DROP_RATIO = 0.2;

/** 估算锚点：上次真实 usage 四项之和 + 发送时的历史条数（F13/F14）。 */
export interface UsageAnchor {
  baselineTokens: number;
  anchorCount: number;
}

export interface CompactResult {
  compacted: boolean;
  message: string;
  boundary?: CompactBoundaryPayload;
}

/** 自动压缩熔断计数：连续失败累计，任一次成功清零（F28）。 */
export class AutoCompactTrackingState {
  consecutiveFailures = 0;
}

/** 触发阈值：窗口减输出预留，再减安全余量（F33：buffer 硬编码不配置化）。 */
export function computeCompactThreshold(contextWindow: number, maxOutput: number, manual = false): number {
  const effective = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE);
  const margin = manual ? MANUAL_COMPACT_SAFETY_MARGIN : AUTO_COMPACT_SAFETY_MARGIN;
  return effective - margin;
}

/** 粗估一组消息的 token：content + toolUses JSON + 工具结果 + thinking 之和 / 3.5。 */
export function estimateMessages(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += m.content.length;
    if (m.toolUses && m.toolUses.length > 0) totalChars += JSON.stringify(m.toolUses).length;
    for (const tr of m.toolResults ?? []) totalChars += tr.content.length;
    for (const tb of m.thinkingBlocks ?? []) totalChars += tb.thinking.length;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export function estimateTokens(conv: ConversationManager): number {
  return estimateMessages(conv.getMessages());
}

function estimateOne(msg: Message): number {
  return estimateMessages([msg]);
}

/**
 * 当前上下文估算（F13）：有锚点用 baseline + 锚点之后增量（字符 / 3.5），
 * 无锚点（冷启动 / 压缩后清零）退化为全量估算；锚点越界时 clamp 不切负数。
 */
export function currentContextTokens(conv: ConversationManager, anchor: UsageAnchor | null): number {
  if (!anchor) return estimateTokens(conv);
  const messages = conv.getMessages();
  const start = Math.min(anchor.anchorCount, messages.length);
  return anchor.baselineTokens + estimateMessages(messages.slice(start));
}

function hasToolResult(msg: Message): boolean {
  return msg.role === "user" && !!msg.toolResults && msg.toolResults.length > 0;
}

/**
 * 配对修正（F12）：截断点落在 tool_result user 消息上时，前推到携带相同
 * toolUseId 的 assistant tool_use 消息，避免把一对调用切成两半。
 */
function backUpPastToolUse(messages: Message[], keepStart: number): number {
  if (keepStart <= 0 || keepStart >= messages.length) return keepStart;
  if (!hasToolResult(messages[keepStart]!)) return keepStart;
  const ids = new Set((messages[keepStart]!.toolResults ?? []).map((tr) => tr.toolUseId));
  for (let i = keepStart - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolUses?.some((tu) => ids.has(tu.toolUseId))) return i;
  }
  return keepStart;
}

/**
 * 近期原文起点：从尾部倒序累加，条数或 token 任一命中下界即停（择窄）；
 * 上界严格不跨越；最后做 tool_use/tool_result 配对修正。
 */
export function computeKeepStartIndex(messages: Message[]): number {
  let keepTokens = 0;
  let keepCount = 0;
  let keepStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const t = estimateOne(messages[i]!);
    if (keepCount > 0 && keepTokens + t > KEEP_MAX_TOKENS) break;
    keepStart = i;
    keepTokens += t;
    keepCount += 1;
    if (keepTokens >= KEEP_RECENT_TOKENS || keepCount >= MIN_KEEP_MESSAGES) break;
  }
  return backUpPastToolUse(messages, keepStart);
}

const SUMMARY_PROMPT_HEAD =
  "Summarize the following conversation. Wrap your analysis in <analysis> tags, then provide the summary in <summary> tags.\n\n";

function buildTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      let t = `[${m.role}]: ${m.content}`;
      if (m.toolUses && m.toolUses.length > 0) t += `\n[tools: ${m.toolUses.map((tu) => tu.toolName).join(", ")}]`;
      return t;
    })
    .join("\n\n");
}

/** 按"用户提交 → 一组 assistant/tool 往返"分组（F27 丢组的最小单位）。 */
function splitGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    const isUserSubmission = m.role === "user" && !(m.toolResults && m.toolResults.length > 0);
    if (isUserSubmission && current.length > 0) {
      groups.push(current);
      current = [m];
    } else {
      current.push(m);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function requestSummary(client: LLMClient, prompt: string): Promise<string> {
  const summaryConv = new ConversationManager();
  summaryConv.addUserMessage(prompt);
  let summaryText = "";
  const stream = client.stream(summaryConv, []);
  for await (const ev of stream) {
    if (ev.type === "text_delta") summaryText += ev.text;
  }
  return summaryText;
}

/**
 * 摘要请求自身的 PTL 处理（F27，自动 / 手动 / 紧急共用）：
 * 先按 F23 预检估算，超预算直接丢最旧组不发；发出后仍撞 PTL 则
 * 3 次直捷重试（每次丢 1 组），用尽后按剩余组数 20% 比例丢弃，
 * 直至塞下或全部丢光（丢光按一次摘要失败上抛，不发空请求）。
 */
async function summarizeWithGroupDrop(
  client: LLMClient,
  toSummarize: Message[],
  contextWindow: number,
): Promise<string> {
  const groups = splitGroups(toSummarize);
  const budget = contextWindow - SUMMARY_OUTPUT_RESERVE - MANUAL_COMPACT_SAFETY_MARGIN;
  let drop = 0;
  let directRetries = 0;
  for (;;) {
    const subset = groups.slice(drop);
    if (subset.length === 0) {
      throw new Error("Summary request still too long after dropping all message groups");
    }
    const prompt = SUMMARY_PROMPT_HEAD + buildTranscript(subset.flat());
    if (estimateMessages([{ role: "user", content: prompt }]) > budget) {
      drop += 1;
      continue;
    }
    try {
      return await requestSummary(client, prompt);
    } catch (err) {
      if (!(err instanceof ContextTooLongError)) throw err;
      const remaining = groups.length - drop;
      if (directRetries < SUMMARY_PTL_DIRECT_RETRIES) {
        directRetries += 1;
        drop += 1;
      } else {
        drop += Math.max(1, Math.ceil(remaining * SUMMARY_PTL_DROP_RATIO));
      }
      if (drop >= groups.length) throw err;
    }
  }
}

/**
 * 核心摘要路径（自动 / 手动 / 紧急共用）：
 * 前缀摘要 + 恢复段 → 中文框架拼接 → verbatim 尾部整体替换。
 * boundary 只载 bare summary 与 keep（role+content），持久化由调用方决定。
 */
export async function doCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  sessionFilePath = "",
  contextWindow = 200_000,
): Promise<CompactResult> {
  const messages = conv.getMessages();
  const keepStart = computeKeepStartIndex(messages);
  if (keepStart <= 0 || keepStart < MIN_COMPACT_PREFIX) {
    return {
      compacted: false,
      message: `Compaction skipped: only ${keepStart} message(s) to summarize, kept verbatim`,
    };
  }
  const toSummarize = messages.slice(0, keepStart);
  const toKeep = messages.slice(keepStart);

  const summaryText = await summarizeWithGroupDrop(client, toSummarize, contextWindow);
  const summaryMatch = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
  const summary = summaryMatch ? summaryMatch[1]!.trim() : summaryText;

  const recoveryAttachment = recoveryState ? recoveryState.buildRecoveryAttachment(toolSchemaNames) : "";
  let summaryContent =
    "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + summary;
  if (toKeep.length > 0) summaryContent += "\n\n近期消息已原样保留。";
  if (sessionFilePath) {
    summaryContent += `\n\n如果你需要压缩前的具体细节（代码片段、报错信息等），请用 ReadFile 读取完整会话记录：${sessionFilePath}`;
  }
  if (recoveryAttachment) summaryContent += `\n\n---\n\n${recoveryAttachment}`;

  conv.replaceWithCompacted(summaryContent, toKeep);

  const keep = toKeep
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    compacted: true,
    message: `Compacted ${toSummarize.length} messages into summary (${summary.length} chars), kept ${toKeep.length} recent messages verbatim`,
    boundary: { summary, keep },
  };
}

/**
 * 自动路径（F5 触发判定 + F28 熔断）：低于阈值直通；达到 hardBlock 时
 * 绕过熔断强制压缩；失败累计进熔断计数。成功消息附压缩前后估算 token。
 */
export async function manageContext(
  conv: ConversationManager,
  client: LLMClient,
  contextWindow: number,
  maxOutput: number,
  trackingState: AutoCompactTrackingState,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  anchor: UsageAnchor | null = null,
  sessionFilePath = "",
): Promise<CompactResult> {
  const tokens = currentContextTokens(conv, anchor);
  const autoThreshold = computeCompactThreshold(contextWindow, maxOutput);
  const hardBlock = computeCompactThreshold(contextWindow, maxOutput, true);
  if (tokens < autoThreshold) return { compacted: false, message: "" };
  const forced = tokens >= hardBlock;
  if (!forced && trackingState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      compacted: false,
      message: `Auto-compact circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
    };
  }
  try {
    const result = await doCompact(conv, client, recoveryState, toolSchemaNames, sessionFilePath, contextWindow);
    trackingState.consecutiveFailures = 0;
    if (result.compacted) {
      const tokensAfter = currentContextTokens(conv, null);
      return { ...result, message: `${result.message}（估算 tokens：${tokens} → ${tokensAfter}）` };
    }
    return result;
  } catch (err) {
    trackingState.consecutiveFailures += 1;
    return { compacted: false, message: `Auto-compact failed: ${(err as Error).message}` };
  }
}

/** 手动 / 紧急路径：无条件摘要，不读也不写熔断（F22/F29）。 */
export async function forceCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  sessionFilePath = "",
  contextWindow = 200_000,
): Promise<CompactResult> {
  return doCompact(conv, client, recoveryState, toolSchemaNames, sessionFilePath, contextWindow);
}

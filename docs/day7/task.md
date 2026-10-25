# 上下文管理 Tasks

> 本章上下文管理逻辑落在 `src/toolresult/`、`src/compact/`、`src/session/` 三个目录，主循环编排在 `src/agent/agent.ts`，命令入口在 `src/commands/commands.ts` + `src/tui/app.tsx`。运行时 bun + TypeScript 5.x，类型检查用 `tsc --noEmit`，测试用 `bun test`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/toolresult/state.ts` | `ContentReplacementState` 决策账本 |
| 新建 | `src/toolresult/budget.ts` | `applyBudget` / `writeSpill` / `buildSpillPreview` / `snipStale` |
| 新建 | `src/toolresult/reconstruct.ts` | `buildManager` 把 `Message[]` 包成 `ConversationManager` |
| 新建 | `src/toolresult/record.ts` | 工具结果记录辅助（被主循环复用） |
| 新建 | `src/compact/compact.ts` | `manageContext` / `forceCompact` / `doCompact` / `currentContextTokens` / `computeKeepStartIndex` / `AutoCompactTrackingState` / `UsageAnchor` |
| 新建 | `src/compact/recovery.ts` | `RecoveryState` / `FileReadRecord` / `SkillInvocationRecord` / `buildRecoveryAttachment` |
| 修改 | `src/conversation/conversation.ts` | 新增 `replaceWithCompacted(summaryContent, keep)` |
| 修改 | `src/llm/errors.ts` | 新增 `ContextTooLongError` 哨兵类 |
| 修改 | `src/llm/anthropic.ts` | 状态 400 + `prompt is too long` → 抛 `ContextTooLongError` |
| 修改 | `src/llm/openai.ts` | `context_length_exceeded` → 抛 `ContextTooLongError` |
| 修改 | `src/llm/events.ts` | `UsageInfo` 加 `cacheReadInputTokens` / `cacheCreationInputTokens` |
| 修改 | `src/session/session.ts` | `COMPACT_BOUNDARY` 常量、`KeptMessage` / `CompactBoundaryPayload`、`saveCompactBoundary`、`rebuildFromSession` 含 boundary 分支 |
| 修改 | `src/agent/agent.ts` | 主循环集成 `manageContext` + `applyBudget` + ContextTooLongError 自愈 + `usageAnchor` 维护 + ReadFile recordFileRead |
| 修改 | `src/agent/events.ts` | `AgentEvent` 加 `{ type: "compact"; message; boundary? }` |
| 修改 | `src/commands/commands.ts` | 注册 `compact` / 别名 `c`，handler 返回 `"compact"` |
| 修改 | `src/tui/app.tsx` | `case "compact":` 分支调 `forceCompact` + `saveCompactBoundary` |
| 修改 | `src/main.tsx` | 创建 Agent 时按 protocol 注入 `contextWindow` / `maxOutput` |
| 新建 | `tests/toolresult.test.ts` | `applyBudget` 单条 / 聚合 / 幂等 / `snipStale` |
| 新建 | `tests/compact.test.ts` | 估算 / `computeKeepStartIndex` / `doCompact` via `forceCompact` / boundary 字段 |
| 新建 | `tests/conversation.test.ts` | `replaceWithCompacted` |
| 修改 | `tests/session.test.ts` | `rebuildFromSession` 含 boundary 与无 boundary 两个分支 |
| 修改 | `tests/agent.test.ts` | `ContextTooLongError` 自愈 + `usageAnchor` 替换不累加 |

---

## T1 - ContentReplacementState 决策账本

- **文件**：`src/toolresult/state.ts`
- **依赖**：无
- **步骤**：
  1. 新建 `src/toolresult/state.ts`，导出类 `ContentReplacementState`。
  2. 私有字段 `seenIds = new Set<string>()`、`replacements = new Map<string, string>()`。
  3. 实现方法：
     - `record(toolUseId: string, original: string, replaced: string): void`：把 id 加入 `seenIds`；当 `original !== replaced` 时把 `replaced` 写进 `replacements`。
     - `has(toolUseId: string): boolean`：`seenIds.has(toolUseId)`。
     - `getReplacement(toolUseId: string): string | undefined`：`replacements.get(toolUseId)`。
     - `clone(): ContentReplacementState`：拷贝两本 set/map，返回新实例（用于测试 fixture）。
     - `size(): number`：`seenIds.size`。
- **验证**：`tsc --noEmit` 通过；写一个最小测试 `state.record("a", "x", "y"); state.has("a") === true; state.getReplacement("a") === "y"`。

## T2 - 单条工具结果落盘 writeSpill

- **文件**：`src/toolresult/budget.ts`
- **依赖**：T1
- **步骤**：
  1. 新建 `src/toolresult/budget.ts`，顶部 import：`writeFileSync, mkdirSync` from `node:fs`；`join` from `node:path`；本地 `ContentReplacementState`、`Message` 类型。
  2. 定义常量：`SINGLE_RESULT_LIMIT = 50000`、`MESSAGE_AGGREGATE_LIMIT = 200000`、`OLD_RESULT_SNIP_CHARS = 2000`、`KEEP_RECENT_TURNS = 10`、`PREVIEW_CHARS = 2000`。
  3. 实现内部辅助：
     - `spillDir(workDir: string): string` = `join(workDir, ".mewcode", "tool_results")`。
     - `writeSpill(workDir, toolUseId, content): string`：`mkdirSync(dir, { recursive: true })` → `writeFileSync(path, content, { encoding: "utf-8", flag: "wx" })`；catch 时若 `e.code === "EEXIST"` 静默吞，其他 throw；返回 `path`。
- **验证**：`tsc --noEmit` 通过。

## T3 - 预览替换体 buildSpillPreview

- **文件**：`src/toolresult/budget.ts`
- **依赖**：T2
- **步骤**：
  1. 实现 `buildSpillPreview(content: string, spillPath: string): string`：
     - `sizeKB = Math.floor(content.length / 1024)`。
     - `preview = content.slice(0, PREVIEW_CHARS)`。
     - `hasMore = content.length > PREVIEW_CHARS`。
     - 拼接固定模板：以 `<persisted-output>\n` 开头、`</persisted-output>` 结尾，中间含 `输出太大（<sizeKB>KB），完整内容已保存到：\n<spillPath>\n\n` + `预览（前 2KB）：\n<preview>` + (hasMore 时 `\n...`)。
  2. 同一 (content, spillPath) 多次调用必须返回逐字节相等字符串（用 `strings.Builder` 风格不用 template literal 的 raw 字段时无需特殊处理，但要避免引入 `Date.now()` 之类副作用）。
- **验证**：`tsc --noEmit` 通过；同 fixture 两次调用 `===` 比较为 true。

## T4 - applyBudget 主体：两遍 + 一遍 snipStale

- **文件**：`src/toolresult/budget.ts`
- **依赖**：T3
- **步骤**：
  1. 实现 `applyBudget(messages: Message[], workDir: string, state: ContentReplacementState): Message[]`：
     - 外层 `const result: Message[] = []`；逐条 `messages` 遍历。
     - 拷贝消息：`const msg = { ...messages[mi] }`。
     - 若 `msg.toolResults?.length > 0`：
       - **Pass 1**：对每个 `tr`：
         - 查 `state.getReplacement(tr.toolUseId)`，存在则 `return { ...tr, content: existing }`（复用冻结决策）。
         - 否则 `let content = tr.content`；若 `content.length > SINGLE_RESULT_LIMIT`：`spillPath = writeSpill(workDir, tr.toolUseId, content)`；`content = buildSpillPreview(content, spillPath)`；`state.record(tr.toolUseId, tr.content, content)`。
         - 返回 `{ ...tr, content }`，组成 `newResults`。
       - **Pass 2**：计算 `totalLen = newResults.reduce((s, r) => s + r.content.length, 0)`；若 `totalLen > MESSAGE_AGGREGATE_LIMIT`：
         - `sorted = [...newResults].sort((a, b) => b.content.length - a.content.length)`。
         - for r of sorted：若 `totalLen <= MESSAGE_AGGREGATE_LIMIT` break；若 `r.content.length > OLD_RESULT_SNIP_CHARS`：`before = r.content`；`spillPath = writeSpill(workDir, r.toolUseId, before)`；`replacement = buildSpillPreview(before, spillPath)`；`totalLen += replacement.length - before.length`；`r.content = replacement`；`state.record(r.toolUseId, before, replacement)`。
       - `msg.toolResults = newResults`。
     - `result.push(msg)`。
     - 最后 `return snipStale(result)`。
  2. 实现 `snipStale(messages: Message[]): Message[]`：
     - 统计真实轮次 `totalTurns = messages.filter(m => m.role === "assistant" && (!m.toolUses || m.toolUses.length === 0)).length`。
     - 若 `totalTurns <= KEEP_RECENT_TURNS` 直接 return messages。
     - `oldBoundary = totalTurns - KEEP_RECENT_TURNS`；遍历，`turnsSeen` 计数；进入近期窗口（`turnsSeen > oldBoundary`）或无 toolResults 直接保留。
     - 旧轮次的 toolResults：若内容已有 `<persisted-output>` 或 `[Stale output snipped:` 前缀，或 `length <= OLD_RESULT_SNIP_CHARS`，保留；否则替换为 `[Stale output snipped: <N> chars]`。
- **验证**：`tsc --noEmit` 通过。

## T5 - reconstruct.ts buildManager

- **文件**：`src/toolresult/reconstruct.ts`
- **依赖**：T4
- **步骤**：
  1. 实现 `buildManager(messages: Message[]): ConversationManager`：构造空 `ConversationManager`，按 messages 依次调 `addUserMessage` / `addAssistantFull` / `addToolResultsMessage` 等方法重建；这是为了让 `client.stream(apiConv, tools)` 第一参数仍是 `ConversationManager` 类型。
  2. 实现细节按现有 ConversationManager API 决定；assistant 消息若带 toolUses 用 `addAssistantFull(content, toolUses, thinkingBlocks ?? [])`；user 消息若带 toolResults 用 `addToolResultsMessage(toolResults)`；纯 user 文本用 `addUserMessage(content)`。
- **验证**：`tsc --noEmit` 通过。

## T6 - ConversationManager.replaceWithCompacted

- **文件**：`src/conversation/conversation.ts`
- **依赖**：无
- **步骤**：
  1. 在 `ConversationManager` 类内新增方法：
     ```typescript
     replaceWithCompacted(summaryContent: string, keep: Message[]): void {
       this.history = [
         { role: "user", content: summaryContent },
         ...keep,
       ];
     }
     ```
  2. 不做额外深拷贝（keep 切片由调用方保证一致性）；后续若需要可改成深拷贝。
- **验证**：`tsc --noEmit` 通过；测试用例 `tests/conversation.test.ts` 验证替换后 `getMessages()[0].role === "user" && getMessages()[0].content === summaryContent`。

## T7 - UsageInfo 新增 cache 字段

- **文件**：`src/llm/events.ts`
- **依赖**：无
- **步骤**：
  1. 修改 `UsageInfo` 接口：在已有 `inputTokens` / `outputTokens` 之后追加 `cacheReadInputTokens: number;` 与 `cacheCreationInputTokens: number;`。
  2. 同步更新 `src/llm/anthropic.ts` 与 `src/llm/openai.ts` 解析 usage 的位置：anthropic 从 `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` 取值；openai 从 `prompt_tokens_details?.cached_tokens` 取 cache_read（cache_creation 通常 0）。
- **验证**：`tsc --noEmit` 通过；现有 anthropic / openai 测试仍跑通。

## T8 - ContextTooLongError 哨兵

- **文件**：`src/llm/errors.ts`
- **依赖**：无
- **步骤**：
  1. 在 `src/llm/errors.ts` 末尾新增：
     ```typescript
     export class ContextTooLongError extends LLMError {
       constructor(message: string) {
         super(message);
         this.name = "ContextTooLongError";
       }
     }
     ```
  2. 在 `src/llm/anthropic.ts` 的错误映射处（HTTP 400 分支）：若 `err.message?.includes("prompt is too long")` 则 `return new ContextTooLongError("Context too long: " + err.message)`。
  3. 在 `src/llm/openai.ts` 的错误映射处：若错误 code/message 命中 `context_length_exceeded` 同样 `return new ContextTooLongError(...)`。
- **验证**：`tsc --noEmit` 通过；测试构造 fixture 错误 → catch 后 `err instanceof ContextTooLongError === true`。

## T9 - RecoveryState 基础结构

- **文件**：`src/compact/recovery.ts`
- **依赖**：无
- **步骤**：
  1. 新建 `src/compact/recovery.ts`，定义常量：
     ```typescript
     const RECOVERY_FILE_LIMIT = 5;
     const RECOVERY_TOKENS_PER_FILE = 5_000;
     const RECOVERY_SKILLS_BUDGET = 25_000;
     const RECOVERY_TOKENS_PER_SKILL = 5_000;
     const RECOVERY_CHARS_PER_TOKEN = 3.5;
     ```
  2. 实现内部辅助：
     - `approxTokens(s: string): number` = `s ? Math.floor(s.length / RECOVERY_CHARS_PER_TOKEN) : 0`。
     - `truncateByTokens(s, tokenBudget)`：tokenBudget ≤ 0 或 s 空返回 s；`approxTokens(s) <= tokenBudget` 返回 s；否则 `maxChars = Math.floor(tokenBudget * RECOVERY_CHARS_PER_TOKEN)`；若 `maxChars <= 0 || maxChars >= s.length` 返回 s；否则 `s.slice(0, maxChars) + "\n… (content truncated)"`。
     - `firstLine(s)`：split `"\n"` 取第一条非空 trim 后的内容。
  3. 定义内部接口 `FileReadRecord { path; content; timestamp }` 与 `SkillInvocationRecord { name; body; timestamp }`。
  4. 导出类 `RecoveryState`：私有字段 `files = new Map<string, FileReadRecord>()`、`skills = new Map<string, SkillInvocationRecord>()`。
- **验证**：`tsc --noEmit` 通过。

## T10 - RecoveryState 写入与快照

- **文件**：`src/compact/recovery.ts`
- **依赖**：T9
- **步骤**：
  1. 实现 `recordFileRead(path: string, content: string)`：`this.files.set(path, { path, content, timestamp: Date.now() })`。
  2. 实现 `recordSkillInvocation(name: string, body: string)`：`this.skills.set(name, { name, body, timestamp: Date.now() })`。
  3. 实现 `snapshotFiles(limit = RECOVERY_FILE_LIMIT)`：把 `files.values()` 拍成数组，按 `b.timestamp - a.timestamp` 倒序排序，`slice(0, limit)`。
  4. 实现 `snapshotSkills()`：同样倒序排序，但不 slice（由 `buildRecoveryAttachment` 自己做预算控制）。
- **验证**：`tsc --noEmit` 通过；写测试连续 record 同名文件，timestamp 用 `Date.now()` 后写覆盖前写。

## T11 - buildRecoveryAttachment 三块拼接

- **文件**：`src/compact/recovery.ts`
- **依赖**：T10
- **步骤**：
  1. 实现 `buildRecoveryAttachment(toolSchemaNames: string[]): string`：
     - `const sections: string[] = []`。
     - **Recently read files 段**：调 `snapshotFiles()`，若非空：
       - push `"## Recently read files\n"`。
       - push `"These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.\n"`。
       - for f of recentFiles：`content = truncateByTokens(f.content, RECOVERY_TOKENS_PER_FILE)`；`ts = new Date(f.timestamp).toISOString().replace(/\.\d{3}Z$/, "Z")`；push `` `### ${f.path}  (read <equation>{ts})\n\n\`\`\`\n</equation>{content}${content.endsWith("\n") ? "" : "\n"}\`\`\`` ``。
     - **Active skills 段**：调 `snapshotSkills()`，若非空：
       - 维护 `used` 累计 + `skillParts` 数组先 push header；
       - for sk of skills：`body = truncateByTokens(sk.body, RECOVERY_TOKENS_PER_SKILL)`；`tokens = approxTokens(body) + approxTokens(sk.name) + 8`；若 `used + tokens > RECOVERY_SKILLS_BUDGET` break；累加 used，push `` `### <equation>{sk.name}\n\n</equation>{body}` ``，标记 `emitted = true`。
       - emitted 时把 `skillParts.join("\n\n")` push 进 sections。
     - **Available tools 段**：若 toolSchemaNames 非空：push `"## Available tools\n\nYou still have access to the following tools — call them directly when the task needs one:\n\n" + toolSchemaNames.map(n => "- " + n).join("\n")`。
     - 若 `sections.length === 0` return `""`。
     - 否则追加 `## Note` 边界提示固定文案，return `sections.join("\n\n")`。
- **验证**：`tsc --noEmit` 通过；写测试 7 个文件 → recent 段只渲染 5 个、按时间倒序；超长内容 → 出现 `… (content truncated)`；空 toolSchemaNames → 不渲染 Available tools 段。

## T12 - compact 常量与类型

- **文件**：`src/compact/compact.ts`
- **依赖**：T9
- **步骤**：
  1. 新建 `src/compact/compact.ts`，顶部 import：`LLMClient` from `../llm/client.js`；`ConversationManager`、`Message` from `../conversation/conversation.js`；`RecoveryState` from `./recovery.js`；`CompactBoundaryPayload`、`getSessionFilePath` from `../session/session.js`。
  2. 定义所有常量：`AUTO_COMPACT_THRESHOLD = 0.8`（legacy ratio 占位）、`MAX_CONSECUTIVE_FAILURES = 3`、`CHARS_PER_TOKEN = 3.5`、`KEEP_RECENT_TOKENS = 10000`、`MIN_KEEP_MESSAGES = 5`、`KEEP_MAX_TOKENS = 40000`、`MIN_COMPACT_PREFIX = 2`、`SUMMARY_OUTPUT_RESERVE = 20000`、`AUTO_COMPACT_SAFETY_MARGIN = 13000`、`MANUAL_COMPACT_SAFETY_MARGIN = 3000`。
  3. 导出接口 `CompactResult { compacted: boolean; message: string; boundary?: CompactBoundaryPayload }`、`UsageAnchor { baselineTokens: number; anchorCount: number }`。
  4. 导出类 `AutoCompactTrackingState`：单字段 `consecutiveFailures = 0`。
- **验证**：`tsc --noEmit` 通过。

## T13 - computeCompactThreshold

- **文件**：`src/compact/compact.ts`
- **依赖**：T12
- **步骤**：
  1. 实现 `computeCompactThreshold(contextWindow: number, maxOutput: number, manual = false): number`：
     - `effective = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE)`。
     - `margin = manual ? MANUAL_COMPACT_SAFETY_MARGIN : AUTO_COMPACT_SAFETY_MARGIN`。
     - `return effective - margin`。
- **验证**：`tsc --noEmit` 通过；测试 contextWindow=200000, maxOutput=8192 → effective = 200000 − min(8192, 20000) = 200000 − 8192 = 191808；auto threshold = 191808 − 13000 = 178808。

## T14 - estimateMessages / estimateTokens / currentContextTokens

- **文件**：`src/compact/compact.ts`
- **依赖**：T12
- **步骤**：
  1. 实现 `estimateMessages(messages: Message[]): number`：
     - 累加 totalChars：`content.length` + `JSON.stringify(toolUses).length`（toolUses 存在时）+ 每个 `toolResults[i].content.length` + 每个 `thinkingBlocks[i].thinking.length`。
     - 返回 `Math.ceil(totalChars / CHARS_PER_TOKEN)`。
  2. 实现 `estimateTokens(conv: ConversationManager): number` = `estimateMessages(conv.getMessages())`。
  3. 实现内部 `estimateOne(msg: Message): number` = `estimateMessages([msg])`。
  4. 实现 `currentContextTokens(conv, anchor)`：
     - anchor 为 null → return `estimateTokens(conv)`（冷启动）。
     - 否则 `messages = conv.getMessages()`；`start = Math.min(anchor.anchorCount, messages.length)`；return `anchor.baselineTokens + estimateMessages(messages.slice(start))`。
- **验证**：`tsc --noEmit` 通过；7 字符 user 消息单独估算 = `Math.ceil(7 / 3.5) = 2`。

## T15 - computeKeepStartIndex + backUpPastToolUse

- **文件**：`src/compact/compact.ts`
- **依赖**：T14
- **步骤**：
  1. 实现内部 `hasToolResult(msg: Message): boolean` = `msg.role === "user" && !!msg.toolResults && msg.toolResults.length > 0`。
  2. 实现 `backUpPastToolUse(messages, keepStart): number`：
     - 边界检查（`keepStart <= 0` 或 `>= messages.length`）直接 return keepStart。
     - 若不是 tool_result user 消息 return keepStart。
     - 否则 `ids = new Set((messages[keepStart].toolResults ?? []).map(tr => tr.toolUseId))`。
     - 倒序找 i：若 `messages[i].role === "assistant" && messages[i].toolUses?.some(tu => ids.has(tu.toolUseId))` return i。
     - 找不到（异常情况） return 原 keepStart。
  3. 实现 `computeKeepStartIndex(messages)`：
     - `keepTokens = 0`、`keepCount = 0`、`keepStart = messages.length`。
     - 倒序循环 i：`t = estimateOne(messages[i])`；若 `keepCount > 0 && keepTokens + t > KEEP_MAX_TOKENS` break（上界严格不跨越）；`keepStart = i`；`keepTokens += t`；`keepCount += 1`；若 `keepTokens >= KEEP_RECENT_TOKENS || keepCount >= MIN_KEEP_MESSAGES` break。
     - return `backUpPastToolUse(messages, keepStart)`。
- **验证**：`tsc --noEmit` 通过；12 条短消息 → 返回 7（保留 5 条命中 count 下界）；构造 tool_use/tool_result 切割场景 → 起点前推到 assistant tool_use。

## T16 - doCompact 主体

- **文件**：`src/compact/compact.ts`
- **依赖**：T6、T11、T13、T14、T15
- **步骤**：
  1. 实现 async `doCompact(conv, client, recoveryState, toolSchemaNames, sessionFilePath = "")`：
     - `messages = conv.getMessages()`。
     - `keepStart = computeKeepStartIndex(messages)`。
     - 若 `keepStart <= 0 || keepStart < MIN_COMPACT_PREFIX` return `{ compacted: false, message: "Compaction skipped: only ${keepStart} message(s) to summarize, kept verbatim" }`。
     - `toSummarize = messages.slice(0, keepStart)`；`toKeep = messages.slice(keepStart)`。
     - `conversationText = toSummarize.map(m => { let t = `[${m.role}]: ${m.content}`; if (m.toolUses) t += `\n[tools: ${m.toolUses.map(t => t.toolName).join(", ")}]`; return t; }).join("\n\n")`。
     - `summaryConv = new ConversationManager()`；`summaryConv.addUserMessage("Summarize the following conversation. Wrap your analysis in <analysis> tags, then provide the summary in <summary> tags.\n\n" + conversationText)`。
     - `summaryText = ""`；`stream = client.stream(summaryConv, [])`；for await ev of stream：若 `ev.type === "text_delta"` 累加 `ev.text`。
     - `summaryMatch = summaryText.match(/<summary>([\s\S]*?)<\/summary>/)`；`summary = summaryMatch ? summaryMatch[1].trim() : summaryText`。
     - `recoveryAttachment = recoveryState ? recoveryState.buildRecoveryAttachment(toolSchemaNames) : ""`。
     - 拼接 `summaryContent`：
       ```typescript
       let summaryContent = "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + summary;
       if (toKeep.length > 0) summaryContent += "\n\n近期消息已原样保留。";
       if (sessionFilePath) summaryContent += `\n\n如果你需要压缩前的具体细节（代码片段、报错信息等），请用 ReadFile 读取完整会话记录：${sessionFilePath}`;
       if (recoveryAttachment) summaryContent += `\n\n---\n\n${recoveryAttachment}`;
       ```
     - `conv.replaceWithCompacted(summaryContent, toKeep)`。
     - 构造 boundary：`keep = toKeep.filter(m => (m.role === "user" || m.role === "assistant") && m.content).map(m => ({ role: m.role, content: m.content }))`。
     - return `{ compacted: true, message: "Compacted <equation>{toSummarize.length} messages into summary (</equation>{summary.length} chars), kept ${toKeep.length} recent messages verbatim", boundary: { summary, keep } }`。
- **验证**：`tsc --noEmit` 通过。

## T17 - manageContext 与 forceCompact

- **文件**：`src/compact/compact.ts`
- **依赖**：T16
- **步骤**：
  1. 实现 async `manageContext(conv, client, contextWindow, maxOutput, trackingState, recoveryState, toolSchemaNames, anchor = null, sessionFilePath = "")`：
     - `tokens = currentContextTokens(conv, anchor)`。
     - `autoThreshold = computeCompactThreshold(contextWindow, maxOutput)`。
     - `hardBlock = computeCompactThreshold(contextWindow, maxOutput, true)`。
     - 若 `tokens < autoThreshold` return `{ compacted: false, message: "" }`。
     - `forced = tokens >= hardBlock`。
     - 若 `!forced && trackingState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES` return `{ compacted: false, message: `Auto-compact circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive failures` }`。
     - try：`result = await doCompact(...)`；`trackingState.consecutiveFailures = 0`；return result。
     - catch err：`trackingState.consecutiveFailures += 1`；return `{ compacted: false, message: `Auto-compact failed: ${(err as Error).message}` }`。
  2. 实现 async `forceCompact(conv, client, recoveryState, toolSchemaNames, sessionFilePath = "")`：直接 `return doCompact(...)`，不读熔断也不写熔断。
- **验证**：`tsc --noEmit` 通过；连续 3 次 throw 后 tracking.consecutiveFailures === 3；下一次 manageContext 在 tokens < hardBlock 时返回熔断消息。

## T18 - Session 压缩边界持久化

- **文件**：`src/session/session.ts`
- **依赖**：无
- **步骤**：
  1. 在 `src/session/session.ts` 顶部新增 `export const COMPACT_BOUNDARY = "compact_boundary"`。
  2. 新增 `export interface KeptMessage { role: string; content: string }`。
  3. 新增 `export interface CompactBoundaryPayload { summary: string; keep: KeptMessage[] }`。
  4. 在 `SessionMessage` 上添加 optional `type?: string` 与 `toolUseId?: string` 字段（若已存在跳过）。
  5. 实现 `saveCompactBoundary(workDir, sessionId, payload)`：
     ```typescript
     saveMessage(workDir, sessionId, {
       role: "system",
       content: JSON.stringify(payload),
       timestamp: new Date().toISOString(),
       type: COMPACT_BOUNDARY,
     });
     ```
  6. 在 `loadSession` 内确保 boundary 行也被读出（已有非空 content 的 filter 自动覆盖）。
- **验证**：`tsc --noEmit` 通过。

## T19 - rebuildFromSession 含 boundary 分支

- **文件**：`src/session/session.ts`
- **依赖**：T18
- **步骤**：
  1. 新增 `export interface RestoredMessage { role: "user" | "assistant"; content: string }`。
  2. 实现 `rebuildFromSession(saved: SessionMessage[]): RestoredMessage[]`：
     - 倒序找最后一条 `saved[i].type === COMPACT_BOUNDARY`。
     - 找到：
       - try `payload = JSON.parse(saved[lastBoundary].content) as CompactBoundaryPayload`，失败置 null。
       - payload 非空：
         - `resumeSummary = "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + payload.summary`；keep 非空时追加 `\n\n近期消息已原样保留。`；push `{ role: "user", content: resumeSummary }`。
         - for k of (payload.keep ?? [])：role 为 user/assistant 且 content 非空时 push。
       - 然后遍历 boundary 之后的 saved 项：跳过其他 boundary，push user/assistant 非空内容。
       - return out。
     - 找不到：全量 replay（push 所有 user/assistant 非空 content）。
- **验证**：`tsc --noEmit` 通过；测试构造含 boundary 的 saved → 返回 `[摘要 user, ...keep, ...boundary 之后追加]`。

## T20 - Agent 主循环：注入 manageContext

- **文件**：`src/agent/agent.ts`
- **依赖**：T17、T5
- **步骤**：
  1. 在 `Agent` 类构造器中初始化新字段：`private compactTracking = new AutoCompactTrackingState()`、`private usageAnchor: UsageAnchor | null = null`。
  2. `AgentConfig` 接收 `contextWindow?: number`（默认 200000）、`maxOutput?: number`（默认 8192）、`recoveryState?: RecoveryState`（默认 `new RecoveryState()`）、`replacementState?: ContentReplacementState`（默认 `new ContentReplacementState()`）。
  3. `run()` async generator 主循环：
     - 入口 `toolSchemas = registry.getAllSchemas()`，按 `toolFilter` 过滤（系统工具豁免）；`toolSchemaNames = registry.listTools().map(t => t.name)`。
     - 每轮 iteration 顶部：
       ```typescript
       const mc = await manageContext(
         this.conversation,
         this.client,
         this.contextWindow,
         this.maxOutput,
         this.compactTracking,
         this.recoveryState,
         toolSchemaNames,
         this.usageAnchor,
         this.sessionFilePath
       );
       if (mc.message) yield { type: "compact", message: mc.message, boundary: mc.boundary };
       if (mc.compacted) this.usageAnchor = null;
       ```
  4. 然后注入 Plan Mode reminder / 技能 reminder / hook notifications（保留现有逻辑）。
- **验证**：`tsc --noEmit` 通过。

## T21 - Agent 主循环：apiConv 与 stream 处理

- **文件**：`src/agent/agent.ts`
- **依赖**：T20、T4
- **步骤**：
  1. 在 `manageContext` 之后构造 apiConv：
     ```typescript
     const apiConv = buildManager(
       applyBudget(this.conversation.getMessages(), this.workDir, this.replacementState)
     );
     const sentMessageCount = this.conversation.len();
     ```
  2. `for await ev of this.client.stream(apiConv, toolSchemas, this.abortSignal)`：
     - `text_delta`：累加 fullText、yield `{ type: "stream_text", text: ev.text }`。
     - `thinking_delta`：yield。
     - `thinking_complete`：push 到 thinkingBlocks、yield。
     - `tool_call_complete`：push 到 toolUses、yield `{ type: "tool_use", ... }`。
     - `stream_end`：
       ```typescript
       this.usageAnchor = {
         baselineTokens:
           ev.usage.inputTokens +
           ev.usage.cacheReadInputTokens +
           ev.usage.cacheCreationInputTokens +
           ev.usage.outputTokens,
         anchorCount: sentMessageCount,
       };
       yield { type: "usage", usage: ev.usage };
       ```
- **验证**：`tsc --noEmit` 通过；测试连续 3 次 stream → `usageAnchor.baselineTokens` 替换为最新一次。

## T22 - Agent 主循环：ContextTooLongError 自愈

- **文件**：`src/agent/agent.ts`
- **依赖**：T21、T8、T17
- **步骤**：
  1. `try { for await ev of stream } catch (err)`：
     ```typescript
     if (this.abortSignal?.aborted) {
       yield { type: "loop_complete", stopReason: "interrupted" };
       return;
     }
     const e = err as Error;
     if (e instanceof ContextTooLongError) {
       try {
         const result = await forceCompact(
           this.conversation,
           this.client,
           this.recoveryState,
           toolSchemaNames,
           this.sessionFilePath
         );
         this.usageAnchor = null;
         yield {
           type: "compact",
           message: "Auto-compacted due to context length: " + result.message,
           boundary: result.boundary,
         };
         continue;
       } catch {
         yield { type: "error", error: e };
         return;
       }
     }
     if (e instanceof RateLimitError) { /* 现有 retry 逻辑 */ }
     yield { type: "error", error: e };
     return;
     ```
  2. continue 后下一轮 iteration 会重新调 `manageContext`（anchor 已清零，走冷启动估算）并重新构造 apiConv 与 stream。
- **验证**：`tsc --noEmit` 通过；测试 stub client 第 1 次 stream throw ContextTooLongError、第 2 次正常 → Agent yield compact 事件 + 后续正常完成。

## T23 - Agent 主循环：ReadFile 触发 recordFileRead

- **文件**：`src/agent/agent.ts`
- **依赖**：T20、T10
- **步骤**：
  1. 在 `executeTools(toolUses)` 调用之后遍历 results：
     ```typescript
     for (const r of results) {
       if (r.type !== "tool_result") continue;
       if (r.isError) continue;
       const tu = toolUses.find(u => u.toolUseId === r.toolId);
       if (!tu) continue;
       if (tu.toolName === "Read" || tu.toolName === "read_file") {
         const path = typeof tu.arguments.path === "string" ? tu.arguments.path : "";
         if (path) {
           try {
             const content = await readFile(path, "utf-8");
             this.recoveryState.recordFileRead(path, content);
           } catch { /* 忽略 */ }
         }
       }
     }
     ```
  2. `readFile` 来自 `node:fs/promises`；失败吞掉。同步发生在 `addToolResultsMessage` 之前。
- **验证**：`tsc --noEmit` 通过；测试 Read 成功后 `recovery.snapshotFiles()` 含该路径，内容为磁盘真实字节。

## T24 - Agent events.ts 加 compact 事件

- **文件**：`src/agent/events.ts`
- **依赖**：无
- **步骤**：
  1. 在 `AgentEvent` 联合类型上新增 `| { type: "compact"; message: string; boundary?: CompactBoundaryPayload }`。
  2. import `CompactBoundaryPayload` from `../session/session.js`。
- **验证**：`tsc --noEmit` 通过。

## T25 - 注册 /compact 命令

- **文件**：`src/commands/commands.ts`
- **依赖**：无
- **步骤**：
  1. 在 `registerBuiltins(registry)` 函数体内追加：
     ```typescript
     registry.register({
       name: "compact",
       aliases: ["c"],
       type: "local_ui",
       description: "Force context compaction",
       handler: () => "compact",
     });
     ```
  2. 不要破坏其他既有 builtin 注册顺序，避免 name/alias 冲突。
- **验证**：`tsc --noEmit` 通过；测试 `registry.find("compact")?.name === "compact"`、`registry.find("c")?.name === "compact"`。

## T26 - TUI app.tsx /compact 分支

- **文件**：`src/tui/app.tsx`
- **依赖**：T17、T18、T25
- **步骤**：
  1. import `forceCompact` from `../compact/compact.js`、`RecoveryState` from `../compact/recovery.js`、`* as sessionMod` from `../session/session.js`。
  2. 在命令分发的 switch 内新增：
     ```typescript
     case "compact":
       if (clientRef.current) {
         setMessages((prev) => [...prev, { role: "system", content: "Compacting conversation..." }]);
         forceCompact(
           convRef.current,
           clientRef.current,
           recoveryStateRef.current,
           registryRef.current.listTools().map((t) => t.name)
         ).then((result) => {
           if (result.boundary) {
             sessionMod.saveCompactBoundary(workDir, sessionIdRef.current, result.boundary);
           }
           setMessages((prev) => [...prev, { role: "system", content: `Compact: ${result.message}` }]);
         }).catch((err) => {
           setMessages((prev) => [...prev, { role: "system", content: `Compact failed: ${(err as Error).message}` }]);
         });
       }
       break;
     ```
  3. 确保 `recoveryStateRef` / `sessionIdRef` / `workDir` 在组件作用域内可用；若缺，从 `useRef<RecoveryState>(new RecoveryState())` 注入并把同一实例传给 `new Agent({...})`。
- **验证**：`tsc --noEmit` 通过；手动跑 bun + TUI 输入 `/compact` 看系统消息出现。

## T27 - main.tsx 注入 contextWindow / maxOutput

- **文件**：`src/main.tsx`
- **依赖**：T20
- **步骤**：
  1. 在创建 Agent 的位置（构造 `new Agent({ ... })`）按选定的 provider 注入：
     ```typescript
     const contextWindow = providerCfg.protocol === "openai" ? 128000 : 200000;
     const maxOutput = 8192;
     ```
     传给 `AgentConfig`。
  2. 同时传入共享的 `RecoveryState` 与 `ContentReplacementState` 实例，TUI 通过 ref 持有同一份。
- **验证**：`tsc --noEmit` 通过；启动 bun + Anthropic provider 默认 200000。

## T28 - toolresult 测试

- **文件**：`tests/toolresult.test.ts`
- **依赖**：T4
- **步骤**：
  1. `bun:test` 风格 `import { describe, it, expect } from "bun:test"`。
  2. 测试用例：
     - `applies single-cap spill for one oversized result`：构造单条 toolResult 60000 字符 → applyBudget 返回 messages[0].toolResults[0].content 含 `<persisted-output>`、原始 KB 数、绝对路径、前 2000 字符 + `...`；`.mewcode/tool_results/<id>` 文件存在 size 60000。
     - `applies aggregate-cap for multi tool_results`：3 条 80000 字符 → 至少 2 条被替换、聚合 ≤ 200000。
     - `idempotent on second pass`：连续两次 applyBudget 同一 messages、同一 state → 第二次结果与第一次逐字节相等；spill 文件 mtime 不变（用 `statSync` 比较）。
     - `decision freeze via getReplacement`：第一次落盘后修改原内容仍传同一 toolUseId → applyBudget 使用 state 中冻结的 replaced。
     - `snipStale snips old turns`：构造 12 个真实轮次（不含 toolUse 的 assistant 消息）+ 旧轮次大 toolResults → 最旧 2 个轮次的 toolResults 被替换为 `[Stale output snipped: N chars]`。
- **验证**：`bun test tests/toolresult.test.ts` 通过。

## T29 - compact 测试

- **文件**：`tests/compact.test.ts`
- **依赖**：T17
- **步骤**：
  1. import 测试目标与 `bun:test`。
  2. helper `stubClient(summaryBody: string)` 返回 `{ client: LLMClient; lastPrompt(): string }`，stream 实现：
     ```typescript
     async *stream(conv) {
       lastPrompt = conv.getMessages()[0]?.content ?? "";
       yield { type: "text_delta", text: `<summary>${summaryBody}</summary>` };
     }
     ```
  3. 测试用例：
     - `currentContextTokens (cold start) = estimateTokens(conv)`。
     - `currentContextTokens (with anchor) = baseline + estimate of tail beyond anchorCount`。
     - `anchor 优势：缓存命中后真实 input 远 < chars`。
     - `clamps when transcript truncated below anchorCount`。
     - `computeKeepStartIndex 命中 count 下界 5`。
     - `computeKeepStartIndex 不切 tool_use/tool_result 对`。
     - `computeKeepStartIndex 命中上界 KEEP_MAX_TOKENS`。
     - `forceCompact 保留近期 verbatim 并只摘要前缀`：长前缀 + RECENT-* 标记尾部 → boundary.summary === "THE SUMMARY BODY"、`boundary.keep` 含 `marker-recent-q/f`；`conv.getMessages()` 含中文框架与近期消息原文；`lastPrompt` 含 `OLD-PREFIX-0` 但不含 `marker-recent-q`。
     - `summary 请求 tools 参数严格为空数组`。
     - `MIN_COMPACT_PREFIX 退化保护：keepStart < 2 时返回 compacted: false`。
- **验证**：`bun test tests/compact.test.ts` 通过。

## T30 - conversation 测试

- **文件**：`tests/conversation.test.ts`
- **依赖**：T6
- **步骤**：
  1. 测试 `replaceWithCompacted`：构造 2 条 history → 调 replaceWithCompacted("SUMMARY", [keep1, keep2]) → `getMessages()` 长度 3、首条 role=user content="SUMMARY"、后两条等于 keep。
  2. 测试 keep 为空数组 → 长度 1、仅摘要消息。
- **验证**：`bun test tests/conversation.test.ts` 通过。

## T31 - session 测试更新

- **文件**：`tests/session.test.ts`
- **依赖**：T19
- **步骤**：
  1. 测试 `rebuildFromSession` 含 boundary：构造 saved = [user1, asst1, boundary(summary, keep=[user2, asst2]), user3, asst3] → restored = [摘要 user, user2, asst2, user3, asst3]。
  2. 测试 `rebuildFromSession` 无 boundary：全量 replay 不变。
  3. 测试 `saveCompactBoundary` + `loadSession` round-trip：写一个 payload → 读回的 saved 数组里能找到 type=COMPACT_BOUNDARY 的行、JSON.parse(content) 等于原 payload。
- **验证**：`bun test tests/session.test.ts` 通过。

## T32 - agent 测试更新

- **文件**：`tests/agent.test.ts`
- **依赖**：T22
- **步骤**：
  1. 测试 `Agent self-heals on ContextTooLongError`：stub client 第 1 次 stream throw ContextTooLongError、第 2 次返回正常 `<summary>SUM</summary>` 与正常完成事件 → 收集 Agent.run() 的所有事件，含一个 `{ type: "compact" }` 事件后续是正常 `loop_complete`。
  2. 测试 `usageAnchor replace not accumulate`：stub client 在 3 次连续 stream_end 事件分别带 usage `{input:1000,...}` / `{input:1500,...}` / `{input:2200,...}` → Agent 私有 usageAnchor 字段（通过暴露给测试的内部访问，或读 manageContext 行为侧推）每次被替换为最新值，不是累加。
  3. 测试 `紧急 forceCompact 自身失败 → yield error 后 return`：第 1 次 stream throw PTL、紧急 forceCompact 内的 stream 也 throw → yield `{ type: "error", ... }` 后 generator return。
- **验证**：`bun test tests/agent.test.ts` 通过。

## T33 - 端到端冒烟（bun + tmux 手测）

- **文件**：无（手测）
- **依赖**：T22、T26、T27
- **步骤**：
  1. `bun run src/main.tsx`（或先 `bun install`）。
  2. 在 tmux 内启动 mewcode，配置 anthropic provider，对话触发一次大文件 Read（构造一个 80KB 文件）→ 观察 `.mewcode/tool_results/<toolUseId>` 文件出现；下一轮请求对应 toolResult 被替换为 `<persisted-output>` 预览串。
  3. 临时把 `src/main.tsx` 注入的 `contextWindow` 改成 80000，连续多轮对话触发自动 layer2；TUI 不闪退、对话继续。
  4. 任意时刻输入 `/compact` 看到系统消息 `Compact: Compacted N messages into summary (M chars), kept K recent messages verbatim`；`.mewcode/sessions/<sessionId>.jsonl` 末尾新增一行 type=compact_boundary。
  5. 退出后再启动 → `/resume <sessionId>` → 看到摘要被以中文框架展示在对话头部，verbatim 尾部跟在后面，boundary 之后追加的消息也都在。
- **验证**：以上 5 步全部观察到预期行为，无未捕获异常、无死循环。

---

## 执行顺序

```text
T1 ContentReplacementState
  └─ T2 writeSpill
      └─ T3 buildSpillPreview
          └─ T4 applyBudget
              └─ T5 buildManager
                  └─ T21 Agent apiConv & stream

T6 replaceWithCompacted
  └─ T16 doCompact 主体

T7 UsageInfo cache 字段
  └─ T21 stream_end 用到

T8 ContextTooLongError
  └─ T22 Agent 自愈

T9 RecoveryState 结构
  └─ T10 写入与快照
      └─ T11 buildRecoveryAttachment
          └─ T16 doCompact (recovery 段)

T12 compact 常量
  ├─ T13 computeCompactThreshold
  ├─ T14 estimate*
  ├─ T15 computeKeepStartIndex
  └─ T17 manageContext / forceCompact (依赖 T13/T14/T15/T16)

T18 saveCompactBoundary
  └─ T19 rebuildFromSession
      └─ T26 TUI 持久化、T31 session 测试

T20 Agent manageContext 注入
  ├─ T21 apiConv + stream
  ├─ T22 ContextTooLongError 自愈
  └─ T23 ReadFile recordFileRead

T24 AgentEvent 加 compact
  └─ T20/T22 emit 用

T25 commands.ts 注册 compact
  └─ T26 TUI 分支

T27 main.tsx 注入 contextWindow

T28 toolresult 测试 ← T4
T29 compact 测试 ← T17
T30 conversation 测试 ← T6
T31 session 测试 ← T19
T32 agent 测试 ← T22

T33 端到端冒烟 ← T22 + T26 + T27
```

并行机会：
- T7（UsageInfo cache 字段）独立，可与 T1~T6 并行。
- T8（ContextTooLongError）独立。
- T9~T11（recovery）只在 T16 处合流。
- T18~T19（session 持久化）只在 T26 / T31 处合流。
- T28~T32 五份测试可在对应实现完成后分别并行写。

关键路径：T1 → T2 → T3 → T4 → T20 → T21 → T22 → T33。
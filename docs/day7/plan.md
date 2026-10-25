# 上下文管理 Plan## 技术栈

- 运行时：bun（package.json `"type": "module"`，bin 入口 `src/main.tsx`）
- 语言：TypeScript 5.x（`tsc --noEmit` 做类型检查）
- LLM SDK：`@anthropic-ai/sdk` ^0.99、`openai` ^6.39
- TUI：Ink ^5.2（React 渲染到终端）、`ink-text-input`、`ink-spinner`
- 配置：`js-yaml` ^4.1
- 模糊搜索：`fuse.js`（命令补全用）
- 终端样式：`chalk`
- markdown 渲染：`marked` + `marked-terminal`
- 测试：`bun test`
- 文件 I/O：`node:fs`（同步 `writeFileSync` / `mkdirSync` 用在落盘路径）、`node:crypto`（`randomBytes` 用在 sessionId）

## 架构概览

ch08 的上下文管理由两个独立的目录承担，对外只暴露窄函数：

```
src/
├── toolresult/              第 1 层：工具结果预防性落盘
│   ├── budget.ts            applyBudget 主入口 + spill / preview
│   └── state.ts             ContentReplacementState 决策账本
├── compact/                 第 2 层：LLM 摘要 + 恢复段
│   ├── compact.ts           manageContext / forceCompact / doCompact / 估算
│   └── recovery.ts          RecoveryState + buildRecoveryAttachment
├── session/
│   └── session.ts           sessionId / saveCompactBoundary / rebuildFromSession
├── agent/
│   └── agent.ts             主循环编排：apiConv 构造 → manageContext → stream
├── llm/
│   └── errors.ts            ContextTooLongError 哨兵
├── tui/
│   └── app.tsx              /compact 命令分支调 forceCompact + saveCompactBoundary
└── commands/
    └── commands.ts          builtinCommands 注册表（含 compact / c 别名）
```

依赖方向：

- `src/toolresult/` 不依赖 `src/compact/`、不依赖 `src/agent/`。
- `src/compact/` 依赖 `src/conversation/`、`src/llm/`、`src/session/`，但不依赖 `src/agent/`、`src/tui/`、`src/tools/`。`recovery.ts` 接受 `toolSchemaNames: string[]` 而非 `ToolRegistry`，避免反向耦合。
- `src/agent/agent.ts` 是唯一同时持有 `LLMClient`、`ConversationManager`、`ToolRegistry`、`RecoveryState`、`ContentReplacementState`、`AutoCompactTrackingState` 的地方；它每轮把这些注入 `applyBudget` 与 `manageContext`。
- `src/tui/app.tsx` 把 `forceCompact` 的结果回写 conversation 并调 `saveCompactBoundary` 持久化。

主循环关键时序（一次 iteration）：

```
Agent.run() — iteration N
  ↓
manageContext(conv, client, contextWindow, maxOutput, tracking, recovery, toolSchemaNames, usageAnchor, sessionFilePath)
  ├─ tokens = currentContextTokens(conv, usageAnchor)
  ├─ if tokens < autoThreshold and tokens < hardBlock → return {compacted: false}
  ├─ if 熔断 tripped and not forced → return {compacted: false, message: "circuit breaker"}
  └─ doCompact(...)
       ├─ keepStart = computeKeepStartIndex(messages)
       ├─ if keepStart < MIN_COMPACT_PREFIX → return {compacted: false}
       ├─ client.stream(summaryConv, []) → 累加 text → 抠 <summary>
       ├─ recovery.buildRecoveryAttachment(toolSchemaNames)
       └─ conv.replaceWithCompacted(summaryContent, toKeep)
  ↓ 如果 compacted=true → usageAnchor = null
  ↓
apiConv = buildManager(applyBudget(conv.getMessages(), workDir, replacementState))
  ├─ Pass 1: single-cap → spill + record
  ├─ Pass 2: aggregate-cap → spill largest
  └─ Pass 3: snipStale(KEEP_RECENT_TURNS=10)
  ↓
sentMessageCount = conv.len()
stream = client.stream(apiConv, toolSchemas, abortSignal)
  for await event of stream:
    ├─ text_delta / tool_call_complete / thinking_*
    └─ stream_end:
        usageAnchor = { baselineTokens: input+cacheRead+cacheCreation+output,
                        anchorCount: sentMessageCount }
  ↓
catch ContextTooLongError:
  forceCompact(...) → usageAnchor = null → yield compact event → continue
  ↓
执行 toolUses → 对 ReadFile / 技能调用调 recovery.recordFileRead / recordSkillInvocation
  ↓
conv.addToolResultsMessage(results) → 进入下一轮 iteration
```

## 数据流

第 1 层（applyBudget）的数据流：

```
ConversationManager.getMessages()          ContentReplacementState
  ↓                                          ↑    ↑
  ↓                                          │    │ getReplacement
  ↓                                          │    │ record
applyBudget(messages, workDir, state) ──────┘    │
  │                                              │
  ├─ for each msg with toolResults:              │
  │    for each tr:                              │
  │      if state.getReplacement(id) → 复用      │
  │      elif content.length > 50000:            │
  │        spillPath = writeSpill(workDir, id)   │
  │        content = buildSpillPreview(...)      │
  │        state.record(id, original, content)   │
  │      append to newResults                    │
  │    if sum(newResults.length) > 200000:       │
  │      sort desc → spill until ≤ 200000        │
  │  snipStale(KEEP_RECENT_TURNS=10)             │
  │                                              │
  ↓                                              │
new Message[] (apiConv) ──→ client.stream() ─────┘ (state 被冻结，下一轮复用)
```

第 2 层（doCompact）的数据流：

```
ConversationManager.getMessages()
  ↓
computeKeepStartIndex(messages)
  ├─ 倒序累加 token / count
  ├─ 命中下界（>= 10000 token 或 >= 5 条）即停
  ├─ 上界检查（不让 keep tail > 40000 token）
  └─ backUpPastToolUse 保 tool_use/tool_result 配对
  ↓
keepStart
  ├─ if keepStart < MIN_COMPACT_PREFIX(2) → 退化返回 {compacted: false}
  ├─ toSummarize = messages.slice(0, keepStart)
  └─ toKeep = messages.slice(keepStart)
  ↓
conversationText = toSummarize.map(m => `[${m.role}]: ${m.content}\n[tools: ...]`).join("\n\n")
  ↓
summaryConv = new ConversationManager()
summaryConv.addUserMessage(prompt + conversationText)
client.stream(summaryConv, [])  ← tools 强制为空
  ↓
summaryText += event.text  (for event of stream)
  ↓
summary = /<summary>([\s\S]*?)<\/summary>/.exec(summaryText)?.[1].trim() ?? summaryText
  ↓
recoveryAttachment = recoveryState?.buildRecoveryAttachment(toolSchemaNames) ?? ""
  ↓
summaryContent = "本次会话延续自之前的对话..." + summary
                + (toKeep.length > 0 ? "\n\n近期消息已原样保留。" : "")
                + (sessionFilePath ? "\n\n如果你需要压缩前的具体细节...：" + sessionFilePath : "")
                + (recoveryAttachment ? "\n\n---\n\n" + recoveryAttachment : "")
  ↓
conv.replaceWithCompacted(summaryContent, toKeep)
  ↓
返回 { compacted: true, message: "Compacted N msgs into summary (M chars), kept K verbatim",
       boundary: { summary, keep: filtered toKeep as KeptMessage[] } }
```

## 核心数据结构与接口

```typescript
// src/conversation/conversation.ts
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}

export interface ToolUseBlock {
  toolUseId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export class ConversationManager {
  addUserMessage(content: string): void;
  addAssistantMessage(content: string): void;
  addAssistantFull(text: string, thinking: ThinkingBlock[], toolUses: ToolUseBlock[]): void;
  addToolResultsMessage(results: ToolResultBlock[]): void;
  addSystemReminder(content: string): void;
  len(): number;
  getMessages(): Message[];
  // 整体替换：摘要 user 消息 + verbatim 尾部
  replaceWithCompacted(summaryContent: string, keep: Message[]): void;
}
```

```typescript
// src/toolresult/state.ts
export class ContentReplacementState {
  // 写入决策：original ≠ replaced 时才进 replacements 映射
  record(toolUseId: string, original: string, replaced: string): void;
  has(toolUseId: string): boolean;
  // 已记录过的 id 返回替换字符串；未记录或 original === replaced 返回 undefined
  getReplacement(toolUseId: string): string | undefined;
  clone(): ContentReplacementState;
  size(): number;
}
```

```typescript
// src/toolresult/budget.ts
const SINGLE_RESULT_LIMIT = 50000;
const MESSAGE_AGGREGATE_LIMIT = 200000;
const OLD_RESULT_SNIP_CHARS = 2000;
const KEEP_RECENT_TURNS = 10;
const PREVIEW_CHARS = 2000;

// 主入口：纯函数，返回新 Message[]，原数组不变
export function applyBudget(
  messages: Message[],
  workDir: string,
  state: ContentReplacementState
): Message[];
```

```typescript
// src/compact/compact.ts
export interface UsageAnchor {
  baselineTokens: number;   // input + cache_read + cache_creation + output
  anchorCount: number;      // stream 发出时的 conversation.len()
}

export class AutoCompactTrackingState {
  consecutiveFailures = 0;
}

export interface CompactResult {
  compacted: boolean;
  message: string;
  boundary?: CompactBoundaryPayload;  // 仅 compacted=true 时存在
}

export function computeCompactThreshold(
  contextWindow: number,
  maxOutput: number,
  manual?: boolean
): number;

export function estimateMessages(messages: Message[]): number;
export function estimateTokens(conv: ConversationManager): number;
export function currentContextTokens(
  conv: ConversationManager,
  anchor: UsageAnchor | null
): number;
export function computeKeepStartIndex(messages: Message[]): number;

export async function manageContext(
  conv: ConversationManager,
  client: LLMClient,
  contextWindow: number,
  maxOutput: number,
  trackingState: AutoCompactTrackingState,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  anchor?: UsageAnchor | null,
  sessionFilePath?: string
): Promise<CompactResult>;

export async function forceCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  sessionFilePath?: string
): Promise<CompactResult>;
```

```typescript
// src/compact/recovery.ts
interface FileReadRecord {
  path: string;
  content: string;
  timestamp: number;
}

interface SkillInvocationRecord {
  name: string;
  body: string;
  timestamp: number;
}

export class RecoveryState {
  recordFileRead(path: string, content: string): void;
  recordSkillInvocation(name: string, body: string): void;
  snapshotFiles(limit?: number): FileReadRecord[];
  snapshotSkills(): SkillInvocationRecord[];
  buildRecoveryAttachment(toolSchemaNames: string[]): string;
}
```

```typescript
// src/session/session.ts
export const COMPACT_BOUNDARY = "compact_boundary";

export interface KeptMessage { role: string; content: string; }
export interface CompactBoundaryPayload {
  summary: string;
  keep: KeptMessage[];
}

export function newSessionId(): string;
export function getSessionFilePath(workDir: string, sessionId: string): string;
export function saveMessage(workDir: string, sessionId: string, msg: SessionMessage): void;
export function saveCompactBoundary(
  workDir: string,
  sessionId: string,
  payload: CompactBoundaryPayload
): void;
export function loadSession(workDir: string, sessionId: string): SessionMessage[];
export function rebuildFromSession(saved: SessionMessage[]): RestoredMessage[];
```

```typescript
// src/llm/errors.ts
export class ContextTooLongError extends LLMError { /* 哨兵：状态 400 + "prompt is too long" */ }
export class RateLimitError extends LLMError { retryAfter?: string; }
```

```typescript
// src/agent/agent.ts
export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  sessionId?: string;
  hookEngine?: HookEngine;
  fileHistory?: FileHistory;
  fileStateCache?: FileStateCache;
  abortSignal?: AbortSignal;
  contextWindow?: number;     // 默认 200000
  maxOutput?: number;         // 默认 8192
  recoveryState?: RecoveryState;
  replacementState?: ContentReplacementState;
  maxIterations?: number;
  notificationFn?: () => string[];
  onLoopComplete?: (conversation: ConversationManager) => void;
  activeSkills?: Map<string, string>;
  toolFilter?: (name: string) => boolean;
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision
  ) => Promise<"allow" | "deny" | "allowAlways">;
}

export class Agent {
  constructor(config: AgentConfig);
  // 主循环，每轮 yield 各类事件给 TUI / 调用方
  async *run(): AsyncGenerator<AgentEvent>;
  // 暴露给 TUI 用于 ReadFile 触发后或测试中读取
  readonly activeSkills: Map<string, string>;
}

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
  | { type: "compact"; message: string; boundary?: CompactBoundaryPayload }
  | { type: "retry"; reason: string; delay: number }
  | { type: "permission_request"; toolName: string; args: Record<string, unknown> };
```

## 模块设计### `src/toolresult/budget.ts`**职责**：每轮主循环开头把 `conv.getMessages()` 拷一份，针对每条 user 消息的 `toolResults` 数组做两遍 + 一遍裁剪。

**对外接口**：`applyBudget(messages, workDir, state) -> Message[]`，纯函数风格不改入参。

**内部分工**：
- `writeSpill(workDir, toolUseId, content)`：`mkdirSync(.mewcode/tool_results, recursive)` → `writeFileSync(path, content, { flag: "wx" })`，EEXIST 时静默吞掉，其他错误冒泡 throw。
- `buildSpillPreview(content, spillPath)`：用模板字符串拼 `<persisted-output>` 段，含 `${sizeKB}KB`、绝对路径、前 2000 字符、`...` 截断标记。
- `applyBudget`：两遍处理 toolResults + 一遍 `snipStale`。
- `snipStale(messages)`：统计 `assistant && (!toolUses || toolUses.length === 0)` 真实轮次；超过 `KEEP_RECENT_TURNS = 10` 时把旧轮次的大 toolResult 替换为 `[Stale output snipped: N chars]`。

**依赖**：`ContentReplacementState`、Node `fs` 同步 API。

### `src/toolresult/state.ts`**职责**：会话级账本，保证同一 toolUseId 的替换决策与替换字符串在一个 Agent 实例的生命周期内不变。

**对外接口**：`record / has / getReplacement / clone / size`。

**实现要点**：`record(id, original, replaced)` 总是把 id 加入 `seenIds`；仅当 `original !== replaced` 时把 `replaced` 写进 `replacements` map。`getReplacement(id)` 是 `replacements.get(id)`，返回 `undefined | string`，调用方据此判断是否已有替换。

### `src/compact/compact.ts`**职责**：摘要触发判定、token 估算、`doCompact` 核心、`AutoCompactTrackingState` 熔断。

**对外接口**：`manageContext`、`forceCompact`、`computeCompactThreshold`、`estimateMessages`、`estimateTokens`、`currentContextTokens`、`computeKeepStartIndex`、`UsageAnchor` 类型、`AutoCompactTrackingState` 类。

**内部分工**：
- `computeCompactThreshold(contextWindow, maxOutput, manual=false)`：先 `effective = contextWindow − min(maxOutput, SUMMARY_OUTPUT_RESERVE)`，再 `effective − (manual ? MANUAL : AUTO) margin`。
- `estimateMessages(messages)`：累加 `content.length + JSON.stringify(toolUses).length + sum(toolResults[i].content.length) + sum(thinkingBlocks[i].thinking.length)`，结果 `Math.ceil(chars / 3.5)`。
- `currentContextTokens(conv, anchor)`：anchor 为 null 时走 `estimateMessages(conv.getMessages())`；否则 `anchor.baselineTokens + estimateMessages(messages.slice(min(anchor.anchorCount, messages.length)))`。
- `computeKeepStartIndex(messages)`：倒序循环，命中下界（token ≥ 10000 或 count ≥ 5）即停；上界 `keepTokens + t > 40000` 时停（且 keepCount > 0）；调用 `backUpPastToolUse` 修正起点。
- `hasToolResult(msg)`：`msg.role === "user" && msg.toolResults?.length > 0`。
- `backUpPastToolUse(messages, keepStart)`：若起点是 tool_result user 消息，往前找含相同 `toolUseId` 的 assistant tool_use 消息。
- `doCompact`：组装摘要 prompt → `client.stream(summaryConv, [])` → 抠 `<summary>` → `recoveryState?.buildRecoveryAttachment(toolSchemaNames)` → `conv.replaceWithCompacted(summaryContent, toKeep)` → 构造 `boundary: { summary, keep }` 返回。
- `manageContext`：tokens < autoThreshold 直接返回；tokens ≥ hardBlock 强制压缩（forced=true）；熔断 + not forced 返回熔断消息；try `doCompact`、catch +1 失败。
- `forceCompact`：直接 `doCompact`，不读熔断、不写熔断。

**依赖**：`LLMClient` 接口、`ConversationManager`、`RecoveryState`（可选）、`session.getSessionFilePath` / `CompactBoundaryPayload`。

### `src/compact/recovery.ts`**职责**：维护"最近读过的文件"与"已激活的技能"两个 map，按时间戳倒序输出快照；按预算把信息拼成恢复段文本。

**对外接口**：`RecoveryState` 类，方法 `recordFileRead / recordSkillInvocation / snapshotFiles / snapshotSkills / buildRecoveryAttachment`。

**内部分工**：
- `approxTokens(s)`：`Math.floor(s.length / 3.5)`。
- `truncateByTokens(s, tokenBudget)`：超过预算时按 `Math.floor(tokenBudget * 3.5)` 取头部，尾部追加 `\n… (content truncated)`。
- `firstLine(s)`：技能首行展示用，跳过空行。
- `buildRecoveryAttachment(toolSchemaNames)`：依次拼 `## Recently read files` / `## Active skills`（预算约束）/ `## Available tools` / `## Note`。三块如果都为空返回空字符串；只要有任意内容就一定追加 `## Note` 边界提示。

**依赖**：无外部依赖（纯字符串处理）。

### `src/session/session.ts`**职责**：sessionId 生成 + 行式 `.jsonl` 写读 + 压缩边界写读 + `/resume` 恢复重建。

**对外接口**：`newSessionId / getSessionFilePath / saveMessage / saveCompactBoundary / loadSession / rebuildFromSession / listSessions / COMPACT_BOUNDARY` 常量、`SessionMessage / KeptMessage / CompactBoundaryPayload / SessionInfo / RestoredMessage` 类型。

**内部分工**：
- `newSessionId`：`Date.now().toString(36) + "-" + randomBytes(4).toString("hex")`。
- `saveCompactBoundary`：调 `saveMessage` 写一行 `role: "system", content: JSON.stringify(payload), type: COMPACT_BOUNDARY, timestamp`。
- `rebuildFromSession(saved)`：从末尾找最后一条 boundary，找到则 `[摘要 user 消息, ...payload.keep, ...boundary 之后的 ordinary 消息]`；未找到走全量 replay。

**依赖**：`node:fs` / `node:path` / `node:crypto`。

### `src/agent/agent.ts`**职责**：主循环编排——每轮调 `manageContext`、构造 `apiConv`、调 `client.stream`、捕获 `ContextTooLongError` 触发紧急 `forceCompact`、维护 `usageAnchor`。

**主循环关键步骤**：
1. `toolSchemas = registry.getAllSchemas()`，按 `toolFilter` 过滤（系统工具豁免）；`toolSchemaNames = registry.listTools().map(t => t.name)`。
2. 每轮 iteration 开头调 `manageContext(..., this.usageAnchor, this.sessionFilePath)`，根据结果 yield `compact` 事件；若 `compacted: true` 则 `this.usageAnchor = null`。
3. 注入 Plan Mode reminder / 技能 reminder / hook notifications。
4. 算 `apiConv = buildManager(applyBudget(...))`、记 `sentMessageCount = conv.len()`。
5. `for await event of client.stream(apiConv, toolSchemas, abortSignal)`：text_delta 累加、tool_call_complete 累加、`stream_end` 记 `usageAnchor = { baselineTokens: 四项相加, anchorCount: sentMessageCount }`。
6. catch `ContextTooLongError`：调 `forceCompact`、清 `usageAnchor`、yield `compact` 事件、`continue`。
7. catch `RateLimitError`：按 Retry-After 等待后 `continue`。
8. 工具执行后对 ReadFile 调 `recoveryState.recordFileRead(path, content)`；对技能调 `recoveryState.recordSkillInvocation(name, body)`。
9. `addToolResultsMessage(toolResults)` 进入下一轮。

**依赖**：所有 src/ 子目录中的类型与函数；通过构造器注入。

### `src/tui/app.tsx`**职责**：处理 `/compact` 命令分支——`commandRegistry.find("compact")` 返回 handler 后路由到 switch 的 `case "compact":` 分支，调 `forceCompact` 并 push 系统消息、持久化 boundary。

**关键代码段**：
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

### `src/commands/commands.ts`**职责**：内置命令注册表。`registerBuiltins(registry)` 注册 `clear / compact / status / model / ...`；compact 的注册项：

```typescript
registry.register({
  name: "compact",
  aliases: ["c"],
  type: "local_ui",
  description: "Force context compaction",
  handler: () => "compact",
});
```

`handler` 返回字符串作为 switch 分支的 key，由 `app.tsx` 接管实际行为。

## 模块交互**正常自动压缩路径：**

```
TUI 输入 "<普通文本>"
    │
    ▼
runAgentLoop(mode) → Agent.run() generator
    │
    ├─[iteration N]→ manageContext(conv, client, ctxWindow, maxOut,
    │                              tracking, recovery, toolSchemaNames,
    │                              usageAnchor, sessionFilePath)
    │     ├─ tokens = currentContextTokens(conv, anchor)
    │     ├─ tokens < autoThreshold → return {compacted: false}
    │     └─ tokens ≥ autoThreshold:
    │         ├─ tripped && !forced → return circuit-breaker msg
    │         └─ doCompact:
    │             ├─ computeKeepStartIndex → keepStart
    │             ├─ keepStart < MIN_COMPACT_PREFIX → return {compacted: false}
    │             ├─ client.stream(summaryConv, [])  ← tools 强制空
    │             ├─ 抠 <summary>
    │             ├─ recovery.buildRecoveryAttachment(toolSchemaNames)
    │             ├─ conv.replaceWithCompacted(summaryContent, toKeep)
    │             └─ return {compacted: true, message, boundary}
    │   ↓
    │   if compacted: usageAnchor = null
    │   yield {type: "compact", message, boundary}
    │
    ├─→ apiConv = buildManager(applyBudget(conv.getMessages(), workDir, replacement))
    │     ├─ Pass 1: > 50K → spill + preview + state.record
    │     ├─ Pass 2: 聚合 > 200K → 大序优先 spill
    │     └─ Pass 3: snipStale(KEEP_RECENT_TURNS=10)
    │
    ├─→ sentMessageCount = conv.len()
    │   stream = client.stream(apiConv, toolSchemas, abortSignal)
    │   for await ev of stream:
    │     case stream_end: usageAnchor = {baselineTokens, anchorCount: sentMessageCount}
    │
    └─→ 执行 toolUses → recovery.recordFileRead/recordSkillInvocation
        → conv.addToolResultsMessage(results) → next iteration
```

**紧急路径（主对话撞 ContextTooLongError）：**

```
client.stream 抛 ContextTooLongError
    │
    ▼
Agent catch 分支：
    ├─ instanceof ContextTooLongError → 是
    ├─ forceCompact(conv, client, recovery, toolSchemaNames, sessionFilePath)
    │     ├─ doCompact(...)
    │     └─ 返回 CompactResult（含 boundary）
    ├─ usageAnchor = null
    ├─ yield {type: "compact", message: "Auto-compacted due to context length: ..."}
    └─ continue → 重新进入下一轮 iteration（这次 currentContextTokens 是冷启动估算）
```

**手动 /compact 路径：**

```
TUI 输入 "/compact"
    │
    ▼
commandRegistry.find("compact") → command{type: "local_ui", handler: () => "compact"}
    │
    ▼
app.tsx switch (handler 返回值)：
case "compact":
    ├─ push 系统消息 "Compacting conversation..."
    ├─ forceCompact(convRef, clientRef, recoveryRef, toolSchemaNames)
    │     ├─ doCompact(...)
    │     └─ 返回 {compacted, message, boundary?}
    ├─ if result.boundary:
    │     saveCompactBoundary(workDir, sessionId, result.boundary)
    │     → 写一行 type: "compact_boundary" 到 .mewcode/sessions/<sessionId>.jsonl
    └─ push 系统消息 "Compact: <result.message>" 或 "Compact failed: <err>"
```

**/resume 恢复路径：**

```
TUI 输入 "/resume <sessionId>"
    │
    ▼
saved = loadSession(workDir, sessionId)   ← 读 .jsonl 每行 JSON.parse
    │
    ▼
restored = rebuildFromSession(saved)
    ├─ 找最后一条 compact_boundary
    ├─ if 找到:
    │     payload = JSON.parse(saved[lastBoundary].content)
    │     out.push({role: "user", content: 中文框架 + payload.summary + 近期消息行})
    │     out.push(...payload.keep.map(k => {role: k.role, content: k.content}))
    │     out.push(...boundary 之后的 ordinary user/assistant 消息)
    └─ else: 全量 replay
    │
    ▼
conv = new ConversationManager()
conv.injectLongTermMemory(instructions, memories)
for m of restored: conv.addUserMessage / addAssistantMessage
```

## 文件组织

```text
src/
├── agent/
│   ├── agent.ts                — Agent 主循环：manageContext 调度、apiConv 构造、stream 处理、紧急 forceCompact、usageAnchor 维护
│   ├── events.ts               — AgentEvent 联合类型（含 compact 事件携带 boundary）
│   └── streaming-executor.ts   — 工具执行细节
├── compact/
│   ├── compact.ts              — manageContext / forceCompact / doCompact / 估算 / computeKeepStartIndex / AutoCompactTrackingState
│   └── recovery.ts             — RecoveryState / FileReadRecord / SkillInvocationRecord / buildRecoveryAttachment
├── toolresult/
│   ├── budget.ts               — applyBudget / writeSpill / buildSpillPreview / snipStale
│   ├── state.ts                — ContentReplacementState
│   ├── record.ts               — 工具执行记录辅助
│   └── reconstruct.ts          — buildManager: 把 Message[] 重新包成 ConversationManager
├── session/
│   └── session.ts              — newSessionId / saveCompactBoundary / loadSession / rebuildFromSession
├── conversation/
│   └── conversation.ts         — ConversationManager / replaceWithCompacted
├── llm/
│   ├── client.ts               — LLMClient 接口、createClient 工厂
│   ├── errors.ts               — ContextTooLongError 哨兵
│   ├── anthropic.ts            — Anthropic provider；400 + "prompt is too long" 时构造 ContextTooLongError
│   ├── openai.ts               — OpenAI / OpenAI-compat provider
│   └── events.ts               — StreamEvent / UsageInfo（cache token 字段）
├── tui/
│   ├── app.tsx                 — case "compact": 分支、saveCompactBoundary、resume 重建
│   └── chat.tsx                — 压缩前后 turn summary 渲染
├── commands/
│   └── commands.ts             — registerBuiltins 注册 compact/c 等命令
└── tools/
    ├── read-file.ts            — Read 工具：成功后由 agent 调 recovery.recordFileRead
    └── registry.ts             — ToolRegistry.listTools() 提供 toolSchemaNames

tests/
├── compact.test.ts             — currentContextTokens / computeKeepStartIndex / doCompact via forceCompact / 摘要 prompt 不含工具 / boundary 持久化
├── conversation.test.ts        — replaceWithCompacted
├── session.test.ts             — rebuildFromSession 含 boundary / 全量 replay
├── toolresult.test.ts          — applyBudget single/aggregate/snipStale
└── agent.test.ts               — ContextTooLongError 自愈、usageAnchor 替换不累加
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 第 1 层与第 2 层分目录 | `src/toolresult/` + `src/compact/` 两个独立目录 | 第 1 层是确定性纯函数 + 落盘 I/O，关注预防；第 2 层涉及 LLM 调用 + 状态机；放一起会让 `src/compact/compact.ts` 既要管阈值又要管字符串裁剪，职责不内聚 |
| 第 1 层 spill 路径 | `.mewcode/tool_results/<toolUseId>`（与 sessionId 解耦） | toolUseId 全局唯一，跨 sessions 同名概率极低；不引入 sessionId 子目录让 `applyBudget` 不需要持有 session 上下文，纯函数纯靠 workDir + state |
| 单条阈值 50000 | 硬编码 | 大多数源码/日志文件远低于 50K；超过这个阈值通常是异常输出（git log / npm ls 大列表），落盘后预览体让模型自行决定是否重读 |
| Pass 2 聚合阈值 200000 | 硬编码 | 单消息上限 200K 给后续摘要留出足够空间；按 content.length 倒序优先落最大那条，最快回落到阈值下 |
| writeSpill 用 `flag: "wx"` 实现幂等 | EEXIST 静默吞，其他错误 throw | wx flag 是 Node 原生的"只在不存在时写"语义，省去手动 `existsSync` 检查；EEXIST 静默表示"已落盘"，不算错；其他错误（磁盘满 / 权限）需要冒泡让上层感知 |
| 第 2 层下界用 OR 不是 AND | `count >= 5 || tokens >= 10000` 满足任一即停 | 两个下界覆盖不同场景：消息又短又多（聊天闲聊）靠 count；少数大消息（一次性贴长代码）靠 token。OR 让二者互补 |
| 上界用 KEEP_MAX_TOKENS = 40000 严格不跨越 | `if keepTokens + t > 40000 break` | 上界保证 verbatim 尾部不会失控吃掉摘要节省的空间；上界严格不跨越（不允许"再加一条就溢出"），避免极端单条消息把上界挤爆 |
| backUpPastToolUse 配对修正 | tool_result 起点必前推到带相同 toolUseId 的 tool_use assistant | tool_use / tool_result 是协议层强约束（Anthropic 显式要求成对），切开会让 provider 直接报错 |
| MIN_COMPACT_PREFIX 退化保护 | `keepStart < 2` 跳过整次压缩 | "压了个寂寞"——前缀只有 1 条消息时 LLM 摘要的成本远大于节省；返回 `{compacted: false, message: "..."}` 让 TUI 显示原因 |
| 摘要请求 tools 参数固定 `[]` | `client.stream(summaryConv, [])` 第二参数硬编码空数组 | 摘要语义不应触发工具调用；省去 tool schema token + 防止模型分心；缺点是无法在摘要里调"格式化"类工具——可接受 |
| 摘要解析用正则 | `/<summary>([\s\S]*?)<\/summary>/` | 解析失败时 fallback 用整段返回，避免硬失败；`[\s\S]` 跨行匹配避免 multiline flag 兼容性问题 |
| `replaceWithCompacted` 不插 assistant 衔接 | 摘要 user 消息 + 直接 verbatim 尾部 | 注释明确说明 verbatim 尾部"大多数情况下首条是 assistant"，省一条 ack 消息也少花 token；如果尾部首条是 user 会有 user/user 连续——provider 在大多数情况下能容忍（Anthropic 现行接口已放宽），不专门加占位 |
| `boundary` 字段载摘要 + verbatim 尾部 inline | 持久化时把 `keep` 内联在 boundary 记录里 | `/resume` 只需读这一行就能完整重建压缩态，避免"边界之前的物理消息要不要 replay"的歧义；keep 只存 role+content（drop tool blocks）与 `.jsonl` 既有持久化形式一致 |
| boundary summary 不带中文框架 | persisted summary = bare model output | recovery attachment / 中文框架在每次 replay 时重新拼，避免持久化里塞进进程级的临时态（recovery 在新进程重启后是空） |
| usageAnchor 在压缩后清零 | `manageContext` 返回 `compacted: true` 或紧急 forceCompact 后立即 `this.usageAnchor = null` | 压缩重写了消息列表，旧的 anchorCount 与新列表索引对不上；清零后下次 currentContextTokens 退化为冷启动 estimateMessages，正确再校准 |
| ContextTooLongError 自愈只重试一次 | catch 分支直接 `continue`，下一轮再撞还是 throw | 一次紧急压缩已经丢掉一大段历史；再撞说明问题不是 token 而是别的（单条 user 消息超长等），加 retry 反而把错误信息淹没 |
| 熔断只挡自动路径 | `forceCompact` 与紧急 catch 都不读 `consecutiveFailures` | 手动 / 紧急是用户与 provider 主动信号，必须放行；熔断是为了避免在长时间故障期间每轮都 wast 一次 LLM 调用 |
| hardBlock 强制压缩绕过熔断 | tokens >= hardBlock 时 `forced = true` 不查熔断 | 兜底防止 token 一直涨到 provider 真的报错；这种情况下"再失败一次"比"必然撞墙"代价小 |
| `AgentConfig.contextWindow` 默认 200000 | Anthropic 风格默认 | mewcode 当前优先适配 Anthropic；OpenAI 用户在 `src/main.tsx` 创建 Agent 时显式传 128000 |
| 命令注册表 + handler 返回 key | `handler: () => "compact"` + app.tsx switch 接管 | 让 TUI 侧能自由控制副作用（持久化 / 进度消息），同时让命令注册表保持纯映射不依赖 React state |
| boundary 持久化由 TUI 触发，不由 doCompact 触发 | doCompact 只构造 boundary，写文件留给调用方 | doCompact 不持有 sessionId 与 workDir（避免反向依赖 src/session 的副作用 API）；TUI / 主循环知道这两个值，由它们决定写不写 |
| RecoveryState 单线程模型不加锁 | 没有 mutex、没有 lock-free 数据结构 | JS 主事件循环天然串行；Agent.run 是 async generator，await 之间 state 不被打断；只要不跨 Agent 实例共享 state 就安全 |
| recovery `## Note` 边界提示英文 | 固定英文文案，不本地化 | 与摘要请求 prompt（也是英文）保持同语言；模型在恢复段上下文里更容易把这段当成 system instruction 对待 |
| recovery 文件 fragment 用 ```` ``` ```` 包裹 | markdown fenced code block | Anthropic / OpenAI 模型对 markdown 高度敏感，包裹后能正确识别为代码片段 |
| applyBudget 不写 promise / 不用 async | 同步 `writeFileSync` | 单文件几十 KB 同步写在 SSD 上 < 5ms；改 async 反而要在主循环加 await 影响整体延迟；写失败冒泡 throw，主循环按 error 事件处理 |
| 不引入 tokenizer | `Math.ceil(chars / 3.5)` | tiktoken 是 GPT-2 BPE，与 Anthropic 实际 tokenizer 不一致；自带的 `@anthropic-ai/sdk` 也没暴露 tokenizer。锚定真实 usage + 字符增量已经够用 |
# Agent Team Tasks

> 本章在 `src/teams/`、`src/code-review/`、`src/teammate.ts` 与 `src/tui/*` 落地多 Team 协作能力；运行时为 bun + TypeScript 5.x，构建命令 `bun run src/main.tsx`、测试 `bun test`、类型检查 `tsc --noEmit`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/teams/file-mailbox.ts` | `FileMailbox` 类、`acquireLock` / `withLock` 文件锁 |
| 新建 | `src/teams/progress.ts` | `TeammateUIState` / `AgentProgress` / 工具描述生成 |
| 新建 | `src/teams/transcript.ts` | `saveTranscript` / `loadTranscript` 队员对话历史持久化 |
| 新建 | `src/teams/backend.ts` | `detectBackend` / `detectPaneBackend` / `spawnTeammate(SpawnConfig)` |
| 新建 | `src/teams/team.ts` | `Team` / `TeamManager` / `Member` / `RunAgent` / `AgentEventCallback` |
| 新建 | `src/teams/tools.ts` | `TeamCreateTool` / `SpawnTeammateTool` / `SendMessageTool` / `ListTeamsTool` / `TeamDeleteTool` |
| 新建 | `src/teams/coordinator.ts` | `COORDINATOR_ALLOWED_TOOLS` / `isCoordinatorTool` / `coordinatorToolFilter` |
| 新建 | `src/teammate.ts` | `parseTeammateFlags` / `runTeammate` — `--teammate` CLI 模式 |
| 新建 | `src/tui/team-status.tsx` | 状态栏 `● N teammates` |
| 新建 | `src/tui/teammate-message.tsx` | `parseTeammateMessage` + `TeammateMessage` 组件 |
| 新建 | `src/tui/teammate-spinner-line.tsx` | 单个队员 spinner 行 |
| 新建 | `src/tui/teammate-spinner-tree.tsx` | Lead + 队员的树形 spinner |
| 新建 | `src/tui/teams-dialog.tsx` | `Ctrl+T` 弹出的 Teams Dialog |
| 修改 | `src/tui/app.tsx` | 注册 5 工具、Spinner Tree、TeamStatus、TeamsDialog、Coordinator 过滤器 |
| 修改 | `src/main.tsx` | `parseTeammateFlags` 命中走 `runTeammate` 分支 |
| 新建 | `src/code-review/manager.ts` | `CodeReviewManager` |
| 新建 | `src/code-review/session.ts` | `ReviewSession` / `ReviewRequest` / `ReviewComment` / `CriticAssessment` / `ReviewSummary` |
| 新建 | `src/code-review/handler.ts` | `/code-review` slash 命令分发 |
| 新建 | `tests/file-mailbox.test.ts` | `FileMailbox` 单测 |
| 新建 | `tests/teams.test.ts` | `Team` / `TeamManager` / 5 工具单测 |
| 新建 | `tests/code-review.test.ts` | `CodeReviewManager` / `ReviewSession` 单测 |
| 新建 | `examples/create-code-review-team.ts` | 评审 team 示例脚本 |
| 新建 | `examples/create-custom-team.ts` | 自定义 team 示例脚本 |

## T1: 文件锁基础 — `src/teams/file-mailbox.ts`（锁部分）**文件：** `src/teams/file-mailbox.ts`
**依赖：** Node.js stdlib `node:fs`
**步骤：**
1. 顶部 `import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync, openSync, closeSync } from "node:fs"; import { join } from "node:path";`
2. 定义常量 `LOCK_MAX_ATTEMPTS = 10` / `LOCK_STALE_MS = 10_000` / `LOCK_RETRY_MIN_MS = 5` / `LOCK_RETRY_MAX_MS = 100`
3. 实现 `sleepSync(ms: number): void`——用 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` 阻塞当前事件循环，避免让出导致多个锁请求同时进入 stat
4. 实现 `acquireLock(lockFile: string): void`：
   - `for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++)`
   - try `openSync(lockFile, "wx")` 成功 → `closeSync(fd)` return
   - catch：若 `code === "EEXIST"`：`statSync(lockFile)` 看 `Date.now() - info.mtimeMs > LOCK_STALE_MS` 则 `unlinkSync(lockFile)`（失败静默）
   - 非 `EEXIST` 错误直接 throw
   - 延迟 `LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1))` 毫秒后重试
   - 10 次都失败 throw `lastErr`
5. 实现 `releaseLock(lockFile: string): void`——`try { unlinkSync(lockFile) } catch {}`
6. 实现 `withLock<T>(filePath: string, fn: () => T): T`——`const lockFile = filePath + ".lock"; acquireLock(lockFile); try { return fn() } finally { releaseLock(lockFile) }`

**验证：** `tsc --noEmit` 通过；锁函数为内部 helper，由 T2 间接覆盖

## T2: `FileMailbox` 主体 — 继续 `src/teams/file-mailbox.ts`**文件：** `src/teams/file-mailbox.ts`
**依赖：** T1
**步骤：**
1. 定义 `export interface FileMailMessage { from: string; text: string; timestamp: string }`
2. 定义 `export class FileMailbox`，私有字段 `filePath` / `readStatePath` / `lastReadLines`
3. 构造函数 `constructor(dir: string, memberName: string)`——`mkdirSync(dir, {recursive:true})`；`filePath = join(dir, memberName + ".jsonl")`；`readStatePath = join(dir, memberName + ".read")`；`lastReadLines = this.loadReadState()`
4. 私有 `loadReadState(): number`——try `parseInt(readFileSync(readStatePath, "utf-8").trim(), 10) || 0`；catch 返回 0
5. 私有 `saveReadState(): void`——try `writeFileSync(readStatePath, String(lastReadLines), "utf-8")`；catch 静默
6. 私有 `allLines(): string[]`——`!existsSync(filePath)` 返回 `[]`；否则 `readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean)`
7. `async send(from: string, text: string): Promise<void>`——构造 `msg: FileMailMessage = { from, text, timestamp: new Date().toISOString() }`；`withLock(filePath, () => { writeFileSync(filePath, JSON.stringify(msg) + "\n", { flag: "a", encoding: "utf-8" }) })`
8. `receiveSync(): FileMailMessage[]`——在 `withLock(filePath, ...)` 内：`const lines = this.allLines(); const newLines = lines.slice(this.lastReadLines); this.lastReadLines = lines.length; this.saveReadState();`；逐行 `JSON.parse`（catch 静默跳过 malformed 行）；返回结果数组
9. `async receive(): Promise<FileMailMessage[]>` —— 直接 `return this.receiveSync()`
10. `unreadCount(): number` —— `Math.max(0, this.allLines().length - this.lastReadLines)`
11. `markAllRead(): void` —— `withLock(filePath, () => { this.lastReadLines = this.allLines().length; this.saveReadState() })`
12. `async *poll(intervalMs = 1000): AsyncGenerator<FileMailMessage>` —— `while (true) { const msgs = await this.receive(); for (const m of msgs) yield m; await new Promise(r => setTimeout(r, intervalMs)) }`

**验证：** 写一段 ad-hoc 脚本：`new FileMailbox(tmpDir, "alice")` → `send("lead", "hi")` → `receiveSync()` 返回 1 条；再调返回空；新实例的 `unreadCount()` 反映持久化的游标

## T3: 进度状态 — `src/teams/progress.ts`**文件：** `src/teams/progress.ts`
**依赖：** 无
**步骤：**
1. 定义 `export interface ToolActivity { toolName: string; input: Record<string, unknown>; activityDescription: string }`
2. 定义 `export interface AgentProgress { toolUseCount: number; tokenCount: number; lastActivity?: ToolActivity; recentActivities: ToolActivity[] }`
3. 定义 `export interface TeammateUIState { name: string; teamName: string; status: "running" | "idle" | "completed" | "failed" | "stopped"; progress: AgentProgress; startTime: number; spinnerVerb: string; lastMessage?: string }`
4. 实现 `export function createProgress(): AgentProgress` —— 返回零值 `{ toolUseCount: 0, tokenCount: 0, lastActivity: undefined, recentActivities: [] }`
5. 实现 `export function recordToolUse(p: AgentProgress, toolName: string, input: Record<string, unknown>): void`：
   - `p.toolUseCount++`
   - `const desc = describeToolActivity(toolName, input)`
   - `const activity: ToolActivity = { toolName, input, activityDescription: desc }`
   - `p.lastActivity = activity; p.recentActivities.push(activity); if (p.recentActivities.length > 5) p.recentActivities.shift()`
6. 实现 `export function recordTokens(p: AgentProgress, inputTokens: number, outputTokens: number): void` —— `p.tokenCount = inputTokens + outputTokens`
7. 实现私有 `describeToolActivity(toolName, input): string`：
   - `ReadFile` → `"Reading " + (input.file_path ?? "file")`
   - `EditFile` → `"Editing " + (input.file_path ?? "file")`
   - `WriteFile` → `"Writing " + (input.file_path ?? "file")`
   - `Bash` → `const cmd = String(input.command ?? ""); return "Running " + (cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd)`
   - `Glob` → `"Searching " + (input.pattern ?? "files")`
   - `Grep` → `"Grepping " + (input.pattern ?? "pattern")`
   - default → `toolName`
8. 实现 `export function summarizeActivities(activities: ToolActivity[]): string` —— 空返空；否则 `activities[activities.length - 1]!.activityDescription`
9. 实现 `export function formatTokens(n: number): string`：`>= 1e6` → `(n/1e6).toFixed(1) + "M"`；`>= 1e3` → `(n/1e3).toFixed(1) + "k"`；否则 `String(n)`

**验证：** `tsc --noEmit` 通过

## T4: 后端工厂 — `src/teams/backend.ts`**文件：** `src/teams/backend.ts`
**依赖：** 无（依赖 `node:child_process`）
**步骤：**
1. `import { execSync, spawn } from "node:child_process"; import type { TeamMode } from "./team.js";`（注意：`team.ts` 还没建，先用 type-only import；T5 建完后类型可用）
2. 实现 `export function detectBackend(): TeamMode` —— 直接 `return "in-process"`
3. 实现 `export function detectPaneBackend(): TeamMode`：
   - `process.env.TMUX` 非空 → `return "tmux"`
   - try `execSync("which tmux", { stdio: ["pipe","pipe","pipe"] })` 成功 → `return "tmux"`
   - catch → `return "in-process"`
4. 定义 `export interface SpawnConfig { mode: TeamMode; command: string; args: string[]; cwd: string; env?: Record<string, string> }`
5. 实现 `export function spawnTeammate(config: SpawnConfig): { cancel: () => void; paneId?: string }`：
   - `case "in-process":`
     - `const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: ["pipe","pipe","pipe"], env: {...process.env, ...config.env} })`
     - return `{ cancel: () => child.kill("SIGTERM") }`
   - `case "tmux":`
     - `const sessionName = "mewcode-" + Date.now().toString(36)`
     - `const cmd = [config.command, ...config.args].join(" ")`
     - try `execSync(\`tmux new-window -t "${sessionName}" -n teammate "${cmd}"\`, ...)`；catch 回退 `execSync(\`tmux new-session -d -s "${sessionName}" -n teammate "${cmd}"\`, ...)`
     - return `{ cancel: () => { try { execSync(\`tmux kill-session -t "${sessionName}"\`) } catch {} }, paneId: sessionName }`
   - `case "iterm":` throw `Error("iTerm backend not supported on this platform")`
   - default throw `Error(\`Unknown team mode: ${config.mode}\`)`

**验证：** `tsc --noEmit` 通过；`detectBackend()` 应返回 `"in-process"`

## T5: Team / TeamManager — `src/teams/team.ts`**文件：** `src/teams/team.ts`
**依赖：** T1-T4
**步骤：**
1. import `join` from `node:path`、`mkdirSync` from `node:fs`、`FileMailbox` from `./file-mailbox.js`、`detectBackend` from `./backend.js`、`TeammateUIState` / `createProgress` / `recordToolUse` / `recordTokens` from `./progress.js`、`randomVerb` from `../tui/verbs.js`、`ConversationManager` from `../conversation/conversation.js`（type-only）、`saveTranscript` from `./transcript.js`
2. 定义 `export type TeamMode = "in-process" | "tmux" | "iterm"`
3. 定义 `export type AgentEventCallback = (event: { type: string; toolName?: string; args?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number }; text?: string }) => void`
4. 定义 `export interface Member { name: string; active: boolean; cancel?: () => void; mailbox: FileMailbox; uiState?: TeammateUIState; conversation?: ConversationManager }`
5. 定义 `export type RunAgent = (task: string, onEvent?: AgentEventCallback) => Promise<string>`
6. 定义 `export class Team`：
   - 字段 `name: string; mode: TeamMode; members = new Map<string, Member>(); leadMailbox: FileMailbox; private mailboxDir: string; private workDir: string`
   - 静态 `static readonly IDLE_POLL_INTERVAL_MS = 500` / `static readonly SHUTDOWN_PREFIX = "[shutdown]"`
   - 构造 `constructor(name, mode, workDir)`——保存字段；`this.mailboxDir = join(workDir, ".mewcode", "teams", name)`；`mkdirSync(mailboxDir, {recursive:true})`；`this.leadMailbox = new FileMailbox(mailboxDir, "lead")`
   - `addMember(name): Member` —— `const mailbox = new FileMailbox(this.mailboxDir, name)`；`const member: Member = { name, active: false, mailbox }`；`this.members.set(name, member)`；`return member`
   - `spawnTeammate(name, task, runAgent): void`：
     1. `const member = this.addMember(name); member.active = true`
     2. 构造 `uiState: TeammateUIState`，挂 `member.uiState = uiState`
     3. 构造 `onEvent: AgentEventCallback` —— `switch event.type` 三个 case 更新 progress / lastMessage
     4. `void (async () => { let nextPrompt = task; let idleReason = "available"; try { while (member.active) { uiState.status = "running"; const result = await runAgent(nextPrompt, onEvent); uiState.lastMessage = result.length > 200 ? result.slice(0,200)+"..." : result; uiState.status = "idle"; await this.leadMailbox.send(name, \`[idle] ${name} (reason: ${idleReason})\`); idleReason = "available"; const pollResult = await this.waitForNextPromptOrShutdown(member); if (pollResult.shutdown || !member.active) break; nextPrompt = pollResult.prompt } uiState.status = "completed" } catch (e) { uiState.status = "failed"; uiState.lastMessage = (e as Error).message; await this.leadMailbox.send(name, \`[idle] ${name} (reason: failed)\`) } finally { member.active = false; if (uiState.status === "running") uiState.status = "idle"; if (member.conversation) { try { saveTranscript(this.workDir, this.name, name, member.conversation) } catch {} } } })()`
   - 私有 `async waitForNextPromptOrShutdown(member): Promise<{ prompt: string; shutdown: boolean }>` —— `while (member.active) { await new Promise(r => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS)); const msgs = member.mailbox.receiveSync(); if (msgs.length === 0) continue; const hasShutdown = msgs.some(m => m.text.trimStart().startsWith(Team.SHUTDOWN_PREFIX)); if (hasShutdown) return { prompt: "", shutdown: true }; const prompt = msgs.map(m => \`From ${m.from}: ${m.text}\`).join("\n\n"); return { prompt: \`You have new messages from your team:\n\n${prompt}\`, shutdown: false } } return { prompt: "", shutdown: true }`
   - `getMember(name)` / `async sendMessage(from, to, content)` / `async stopMember(name)` / `async stopAll()` / `listMembers()` / `getTeammateStates()` 按 spec.md F8-F10 实现
7. 定义 `export class TeamManager`：
   - 字段 `private teams = new Map<string, Team>(); private workDir: string`
   - 构造 `constructor(workDir: string)`
   - `create(name, mode = detectBackend()): Team` —— `const team = new Team(name, mode, this.workDir); this.teams.set(name, team); return team`
   - `get(name): Team | undefined` / `list(): Team[]` / `async delete(name): Promise<void>`（先 `team.stopAll()` 再 `teams.delete(name)`）
   - `getAllTeammateStates(): TeammateUIState[]` —— `this.list().flatMap(t => t.getTeammateStates())`
   - `drainLeads(): string[]` —— 遍历所有 team，`msgs = team.leadMailbox.receiveSync()`，非空时拼 `<team-notification team="<name>">\nfrom=<from>: <text>\n...\n</team-notification>` push 到 out 数组

**验证：** `tsc --noEmit` 通过；`new TeamManager(workDir).create("demo")` 在 `<workDir>/.mewcode/teams/demo/` 创建目录

## T6: Transcript 持久化 — `src/teams/transcript.ts`**文件：** `src/teams/transcript.ts`
**依赖：** `src/conversation/conversation.ts`（仅类型）
**步骤：**
1. import `mkdirSync` / `readFileSync` / `writeFileSync` / `existsSync` from `node:fs`、`join` from `node:path`、类型 `ConversationManager` / `Message` / `ToolUseBlock` / `ToolResultBlock` from `../conversation/conversation.js`
2. 定义内部接口 `TranscriptToolUse { tool_use_id: string; tool_name: string; arguments?: Record<string, unknown> }` / `TranscriptToolResult { tool_use_id: string; content: string; is_error?: boolean }` / `TranscriptEntry { role: string; content?: string; tool_uses?: TranscriptToolUse[]; tool_results?: TranscriptToolResult[] }`
3. 实现私有 `serializeConversation(conv): TranscriptEntry[]` —— 遍历 `conv.getMessages()`，构造 `entry: TranscriptEntry`；若 `msg.toolUses?.length > 0` 映射成 `tool_uses`；若 `msg.toolResults?.length > 0` 映射成 `tool_results`
4. 实现私有 `transcriptDir(workDir, teamName): string` —— `join(workDir, ".mewcode", "teams", teamName, "transcripts")`
5. `export function saveTranscript(workDir, teamName, agentId, conv): string` —— `mkdirSync(dir, {recursive:true})`；`writeFileSync(<dir>/<agentId>.json, JSON.stringify(data, null, 2), "utf-8")`；返回路径
6. `export function loadTranscript(workDir, teamName, agentId): TranscriptEntry[] | null` —— 文件不存在 return null；try `JSON.parse(readFileSync)`；catch return null

**验证：** `tsc --noEmit` 通过

## T7: Coordinator 过滤器 — `src/teams/coordinator.ts`**文件：** `src/teams/coordinator.ts`
**依赖：** T5
**步骤：**
1. import `TeamManager` from `./team.js`（仅类型）
2. 定义 `const COORDINATOR_ALLOWED_TOOLS = new Set([...])` —— 包含 `Agent` / `SendMessage` / `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TeamCreate` / `TeamDelete` / `ListTeams` / `SpawnTeammate` / `ReadFile` / `Glob` / `Grep` / `Bash`
3. `export function isCoordinatorTool(name: string): boolean` —— `COORDINATOR_ALLOWED_TOOLS.has(name)`
4. `export function coordinatorToolFilter(teamMgr: TeamManager): (name: string) => boolean`：
   - 返回 `(name) => { if (teamMgr.list().length === 0) return true; if (name.startsWith("mcp__")) return true; return isCoordinatorTool(name) }`

**验证：** `tsc --noEmit` 通过

## T8: 5 个工具 — `src/teams/tools.ts`**文件：** `src/teams/tools.ts`
**依赖：** T5
**步骤：**
1. import `Tool` / `ToolResult` from `../tools/types.js`、`strArg` from `../tools/types.js`、`TeamManager` / `RunAgent` from `./team.js`
2. 定义 helper `function obj(props, required): Record<string, unknown> { return { type: "object", properties: props, required } }`
3. `TeamCreateTool`：实现 `Tool`；`name = "TeamCreate"` / `description = "Create a team for coordinating multiple agents."` / `category = "read" as const` / `system = true`；构造 `constructor(private mgr: TeamManager)`；`schema()` 返回 `{ name, description, input_schema: obj({ name: { type: "string", description: "Team name" } }, ["name"]) }`；`async execute(args)`：取 `name = strArg(args, "name")`，空返 `isError: true`；`mgr.get(name)` 存在 → `"Team 'X' already exists."`；否则 `mgr.create(name)` → `"Team 'X' created."`
4. `SpawnTeammateTool`：构造 `constructor(private mgr: TeamManager, private runAgent: RunAgent)`；`name = "SpawnTeammate"`；input_schema `{ team, name, task }` 全必填；execute 取三参数，校验非空；`const t = this.mgr.get(team) ?? this.mgr.create(team); t.spawnTeammate(name, task, this.runAgent);` 返回提示「continue working and watch for it」
5. `SendMessageTool`：构造 `constructor(private mgr: TeamManager)`；`name = "SendMessage"`；input_schema `{ team, to, message }` 全必填；execute 取 Team，try `t.sendMessage("lead", to, message)`，catch 转 `isError: true`
6. `ListTeamsTool`：`name = "ListTeams"`；无参数 schema；execute 遍历 `mgr.list()`，每个拼 `<name> [<mode>]: <members>`，空则 `"No teams."`
7. `TeamDeleteTool`：`name = "TeamDelete"`；schema `{ name }` 必填；execute 调 `mgr.delete(name)`，返回 `"Team 'X' deleted."`
8. 所有工具 `category = "read" as const; system = true`

**验证：** `tsc --noEmit` 通过；5 个类都能实例化

## T9: `--teammate` CLI 模式 — `src/teammate.ts`**文件：** `src/teammate.ts`
**依赖：** T2、`src/agent/agent.ts`、`src/conversation/conversation.ts`、`src/tools/*`、`src/llm/client.ts`、`src/prompt/builder.ts`、`src/permissions/checker.ts`、`src/config/config.ts`
**步骤：**
1. import `loadConfig` / `createClient` / `ConversationManager` / `buildSystemPrompt` / `detectEnvironment` / 5 个工具类 / `PermissionChecker` / `Agent` / `FileStateCache` / `FileMailbox` / `FileMailMessage`
2. 定义内部 `interface TeammateArgs { teamDir: string; memberName: string; initialTask: string; providerName?: string }`
3. `export function parseTeammateFlags(args: string[]): TeammateArgs | null`：
   - `if (!args.includes("--teammate")) return null`
   - 循环解析 `--team-dir <dir>` / `--member-name <name>` / `--task <task>` / `--provider <name>`
   - 三必填缺一返回 null
4. 定义常量 `ShutdownPrefix = "[shutdown]"` / `LeadName = "lead"`；helper `isShutdownRequest(msg)` 与 `createIdleNotification(name)`
5. `export async function runTeammate(args)`：
   1. `const cfg = loadConfig()`
   2. `const provider = args.providerName ? cfg.providers.find(p => p.name === args.providerName) ?? cfg.providers[0] : cfg.providers[0]`
   3. `const env = detectEnvironment(process.cwd()); env.model = provider.model; const systemPrompt = buildSystemPrompt(env)`
   4. `const client = await createClient(provider, systemPrompt)`
   5. `const registry = new ToolRegistry()`，注册 `ReadFileTool / BashTool / GlobTool / GrepTool / WriteFileTool / EditFileTool`
   6. `const conv = new ConversationManager(); const checker = new PermissionChecker(process.cwd(), "acceptEdits"); const agent = new Agent({ client, registry, checker, conversation: conv, workDir: process.cwd(), fileStateCache: new FileStateCache() })`
   7. `conv.addUserMessage(args.initialTask)`；`for await (const event of agent.run())` 处理 `stream_text` → stdout / `tool_result` → 简短 log / `loop_complete` / `error`
   8. 跑完构造 `mailbox = new FileMailbox(args.teamDir, args.memberName); leadMailbox = new FileMailbox(args.teamDir, LeadName)`；发 `[idle]` 通知
   9. `for await (const msg of mailbox.poll(2000))`：若 `isShutdownRequest(msg)` 打印「Shutdown requested」并 break；否则 `conv.addUserMessage(msg.text)`，再跑一轮，再发 `[idle]`

**验证：** `tsc --noEmit` 通过；ad-hoc `bun run src/main.tsx --teammate --team-dir /tmp/t --member-name a --task "echo hi"` 启动后能跑完任务

## T10: `main.tsx` 接入 — `src/main.tsx`**文件：** `src/main.tsx`（修改）
**依赖：** T9
**步骤：**
1. 顶部 import `parseTeammateFlags, runTeammate` from `./teammate.js`
2. `main()` 函数开头：`const args = process.argv.slice(2); const teammateArgs = parseTeammateFlags(args); if (teammateArgs) { try { await runTeammate(teammateArgs) } catch (err) { console.error(\`teammate: ${(err as Error).message}\`); process.exit(1) } return }`
3. 之后才走原本的 `loadConfig` + `render(<App ... />)`

**验证：** `bun run src/main.tsx --teammate --team-dir /tmp/t --member-name a --task "echo hi"` 不渲染 TUI 直接跑 teammate 路径

## T11: TUI 队员组件 — `src/tui/team-status.tsx` / `teammate-message.tsx`**文件：** 两个新文件
**依赖：** T3
**步骤：**

`src/tui/team-status.tsx`：
1. import `React`、`Text` from `ink`
2. `export function TeamStatus({ count }: { count: number })` —— `count === 0` 返 null；否则 `<Text dimColor><Text color="magenta">●</Text> {count} {count === 1 ? "teammate" : "teammates"}</Text>`

`src/tui/teammate-message.tsx`：
1. import `React`、`Box` / `Text` from `ink`
2. `export function TeammateMessage({ from, content, type = "text" }: { from: string; content: string; type?: "idle" | "completed" | "text" | "shutdown" })`：
   - `idle` / `shutdown` → `return null`
   - `completed` → 渲染 `<Text color="cyan">@{from}</Text>❯ <Text color="green">✓</Text> Task completed` + 缩进 content
   - `text` → 拆 `lines = content.split("\n")`；`summary = lines[0]`；`rest = lines.slice(1).join("\n").trimStart()`；渲染 `@<from> ❯ <summary>` + 缩进 rest
3. 定义正则 `teamMsgRe = /^\[team\s+\S+\]\s+(\S+):\s+(.*)$/s` / `idleRe = /^\[idle\]\s*/` / `shutdownRe = /^\[shutdown\]\s*/`
4. `export function parseTeammateMessage(raw: string)`：match `teamMsgRe`，不命中 return null；提取 `from` 与 `body`；按 idleRe / shutdownRe 判断 type，剥掉前缀后返回 `{ from, content, type }`

**验证：** `tsc --noEmit` 通过；`parseTeammateMessage("[team alpha] alice: [idle] done")` 返回 `{ from: "alice", type: "idle", content: "done" }`

## T12: Spinner 行与树 — `src/tui/teammate-spinner-line.tsx` / `teammate-spinner-tree.tsx`**文件：** 两个新文件
**依赖：** T3
**步骤：**

`teammate-spinner-line.tsx`：
1. import `React`、`Box` / `Text` from `ink`、`TeammateUIState` / `summarizeActivities` / `formatTokens` from `../teams/progress.js`
2. `export function TeammateSpinnerLine({ state, isLast, isSelected }: Props)`：
   - `const pointer = isSelected ? "❯ " : "  "`；`const connector = isSelected ? (isLast ? "╘═ " : "╞═ ") : (isLast ? "└─ " : "├─ ")`
   - 按 `state.status` 选 `statusNode`：`idle` dimColor / `completed` green / `failed` red / `stopped` yellow / `running` 用 `summarizeActivities` 或 `spinnerVerb`
   - `stats = " · {progress.toolUseCount} tools · {formatTokens(progress.tokenCount)} tokens"`
   - 渲染 `<Box><Text>{pointer}<Text dimColor>{connector}</Text><Text color="cyan">@{name}</Text>: {statusNode}<Text dimColor>{stats}</Text></Text></Box>`

`teammate-spinner-tree.tsx`：
1. import `TeammateSpinnerLine`、`TeammateUIState`、`formatTokens`
2. `export function TeammateSpinnerTree({ teammates, leaderVerb, leaderTokens }: Props)`：
   - `teammates.length === 0` → null
   - `tokenSuffix` 计算 leader 的 token 提示
   - 渲染头部 `<Text color="cyan">  ┌─ team-lead: {leaderVerb ?? "thinking"}...</Text><Text dimColor>{tokenSuffix}</Text>`
   - 遍历 teammates 渲染 `<TeammateSpinnerLine key={tm.name} state={tm} isLast={i === teammates.length - 1} />`

**验证：** `tsc --noEmit` 通过

## T13: Teams Dialog — `src/tui/teams-dialog.tsx`**文件：** `src/tui/teams-dialog.tsx`
**依赖：** T3
**步骤：**
1. import `React`、`useState`、`Box` / `Text` / `useInput` from `ink`、`brand` / `symbols` from `./styles.js`、`TeammateUIState` / `formatTokens` / `summarizeActivities` from `../teams/progress.js`
2. `export function TeamsDialog({ teammates, onClose, onKill?, onShutdown? }: Props)`：
   - `const [selectedIndex, setSelectedIndex] = useState(0)`；`const [view, setView] = useState<"list" | "detail">("list")`；`const [detailName, setDetailName] = useState<string | null>(null)`
   - `useInput((input, key) => { ... })`：detail 视图按 Esc/← 返回 list；list 视图 Esc 关闭、↑/↓ 翻、Enter 进详情、`k`/`s` 触发回调
   - 队员为空时渲染「No active teammates」
   - 否则按 `view` 渲染 `renderList` 或 `renderDetail`
3. helper `formatElapsed(startTime)` / `statusColor(status)`

**验证：** `tsc --noEmit` 通过

## T14: `app.tsx` 集成 — `src/tui/app.tsx`**文件：** `src/tui/app.tsx`（修改）
**依赖：** T1-T13、`src/agents/spawn.ts`（已有）
**步骤：**
1. 顶部 import `TeamManager` from `../teams/team.js`、`coordinatorToolFilter` from `../teams/coordinator.js`、`TeamCreateTool` / `SpawnTeammateTool` / `SendMessageTool` / `ListTeamsTool` / `TeamDeleteTool` from `../teams/tools.js`、`RunAgent` from `../teams/team.js`、`TeammateSpinnerTree`、`TeamStatus`、`TeamsDialog`、`TeammateUIState` from `../teams/progress.js`
2. 在 `App` 组件内：`const teamManagerRef = useRef(new TeamManager(workDir))`；`const [teammateStates, setTeammateStates] = useState<TeammateUIState[]>([])`；`const [teamsDialogOpen, setTeamsDialogOpen] = useState(false)`
3. 在 mount 后启动 `setInterval(() => setTeammateStates(teamManagerRef.current.getAllTeammateStates()), 500)`，clean-up 时 `clearInterval`
4. 在注册工具的代码块：
   ```typescript
   const teamRunAgent: RunAgent = (task, onEvent) =>
     spawnSubAgent(BUILTIN_AGENTS[0], task, client, registryRef.current, provider, workDir, undefined, onEvent);
   registryRef.current.register(new TeamCreateTool(teamManagerRef.current));
   registryRef.current.register(new SpawnTeammateTool(teamManagerRef.current, teamRunAgent));
   registryRef.current.register(new SendMessageTool(teamManagerRef.current));
   registryRef.current.register(new ListTeamsTool(teamManagerRef.current));
   registryRef.current.register(new TeamDeleteTool(teamManagerRef.current));
   ```
5. Lead 主循环 `agent.run` 的 options 加：
   ```typescript
   toolFilter: buildComposedToolFilter(coordinatorToolFilter(teamManagerRef.current), toolFilterRef.current),
   notificationFn: () => teamManagerRef.current.drainLeads(),
   ```
6. 实现 `buildComposedToolFilter(coordinator, skillFilter)` —— `skillFilter == null` 返回 coordinator；否则返回 `(name) => coordinator(name) && skillFilter(name)`
7. 在 `useInput` 中加 `Ctrl+T` 处理：`if (key.ctrl && input === "t") { setTeamsDialogOpen(o => !o); return }`
8. 在主 JSX 渲染区：
   - `{teammateStates.length > 0 && (<TeammateSpinnerTree teammates={teammateStates} leaderVerb={leaderVerb} leaderTokens={leaderTokens} />)}`
   - 状态栏底部 `<TeamStatus count={teammateStates.filter(t => t.status === "running" || t.status === "idle").length} />`
   - `{teamsDialogOpen && (<TeamsDialog teammates={teammateStates} onClose={() => setTeamsDialogOpen(false)} onKill={(name, teamName) => { const team = teamManagerRef.current.get(teamName); if (team) team.stopMember(name) }} onShutdown={(name, teamName) => { const team = teamManagerRef.current.get(teamName); if (team) team.sendMessage("lead", name, "[shutdown] Please finish and exit") }} />)}`

**验证：** `tsc --noEmit` 通过；`bun run src/main.tsx` 启动 TUI 不报错；按 `Ctrl+T` 弹出 Teams Dialog

## T15: Code Review Manager — `src/code-review/manager.ts`**文件：** `src/code-review/manager.ts`
**依赖：** T5
**步骤：**
1. import `join` from `node:path`、`readFileSync` / `writeFileSync` / `existsSync` / `mkdirSync` from `node:fs`、`Team` / `TeamManager` from `../teams/team.js`（类型）、`detectBackend` from `../teams/backend.js`
2. 定义 `export interface CodeReviewMember { name: string; email: string; role: "reviewer" | "lead" | "junior" | "critic"; expertise: string[]; active: boolean }`
3. 定义 `export interface CodeReviewTeam { name: string; members: CodeReviewMember[]; createdAt: string; lastActive: string }`
4. `export class CodeReviewManager`：
   - 字段 `private teams = new Map<string, CodeReviewTeam>(); private configPath: string; private teamManager: TeamManager; private workDir: string`
   - 构造 `constructor(workDir, teamManager)` —— `configPath = join(workDir, ".mewcode", "code-review-teams.json")`；`loadTeams()`
   - 私有 `loadTeams()` —— 文件不存在跳过；读 JSON 反序列化，失败静默
   - 私有 `saveTeams()` —— `mkdirSync(<workDir>/.mewcode, {recursive:true})`；`writeFileSync(configPath, JSON.stringify(teams, null, 2))`
   - `createTeam(name, members): CodeReviewTeam` —— 构造 team 对象（成员附 `active:true`），保存；调底层 `teamManager.create(name, detectBackend())`；对每个成员 `teamInstance.addMember(member.name)`
   - `getTeam` / `listTeams` / `addMember` / `removeMember` / `activateMember` / `deactivateMember` / `deleteTeam` / `getActiveReviewers` / `getTeamSummary` 按 spec.md F66 实现
5. 导出 `createDefaultCodeReviewTeam()` 工厂——构造 3 人评审组（alice/bob/charlie）

**验证：** `tsc --noEmit` 通过

## T16: Review Session — `src/code-review/session.ts`**文件：** `src/code-review/session.ts`
**依赖：** T15
**步骤：**
1. import `CodeReviewManager` / `CodeReviewTeam` / `CodeReviewMember` from `./manager.js`
2. 定义类型：
   - `ReviewRequest { id; title; description; author; branch; files; status: "pending"|"in-review"|"approved"|"rejected"|"changes-requested"; createdAt; updatedAt; reviewers; comments }`
   - `CommentResolution = "accepted" | "rejected" | "pending" | "resolved"`
   - `CriticEvaluation = "reasonable" | "unreasonable" | "partially-reasonable"`
   - `CriticAssessment { commentId; critic; evaluation; reasoning; timestamp }`
   - `ReviewComment { id; reviewer; file?; line?; content; timestamp; resolved; resolution?; authorResponse?; resolutionTimestamp?; criticAssessments }`
   - `ReviewSummary` / `FileFeedback` / `CommentIssue`
3. `export class ReviewSession`：
   - 字段 `private requests = new Map<string, ReviewRequest>(); private manager; private workDir; private commentCounter = 0`
   - 构造 `constructor(workDir, manager)` —— `loadRequests()`（占位）
   - `createReviewRequest(teamName, title, description, author, branch, files)`：校验 team 存在、`getActiveReviewers` 非空；id = `review-<Date.now()>`；构造对象放入 map
   - `getRequest(id)` / `updateRequestStatus(id, status)`
   - `addComment(requestId, reviewer, content, file?, line?)` —— id = `comment-<ts>-<counter>`，push 到 `request.comments`
   - `resolveComment / acceptComment / rejectComment`：找到 comment 改 `resolved` / `resolution` / `authorResponse` / `resolutionTimestamp`
   - `addCriticAssessment(requestId, commentId, criticName, evaluation, reasoning)` —— push 到 `comment.criticAssessments`
   - `generateFinalReport(requestId): ReviewSummary` —— 按文件聚合评论，统计 accepted/rejected/pending；构造 `ReviewSummary`
   - `formatFinalReport(summary): string` / `getCriticSummary(requestId): string` —— 字符串化输出

**验证：** `tsc --noEmit` 通过

## T17: Code Review Handler — `src/code-review/handler.ts`**文件：** `src/code-review/handler.ts`
**依赖：** T15、T16
**步骤：**
1. import `CommandContext` from `../commands/commands.js`、`CodeReviewManager` from `./manager.js`、`ReviewSession` from `./session.js`
2. `export function handleCodeReviewCommand(ctx, manager, session): string`：
   - `args = ctx.args.trim().split(/\s+/); command = args[0]?.toLowerCase(); params = args.slice(1).join(" ")`
   - `try { switch(command) { case "create": ... case "add": ... ... } } catch (e) { return \`Error: ${msg}\` }`
3. 18 个 handler 函数（`handleCreate` / `handleAddMember` / `handleAddCritic` / `handleRemoveMember` / `handleListTeams` / `handleTeamStatus` / `handleActivateMember` / `handleDeactivateMember` / `handleCreateRequest` / `handleListRequests` / `handleAddComment` / `handleAcceptComment` / `handleRejectComment` / `handleGenerateReport` / `handleApproveRequest` / `handleRejectRequest` / `handleCriticEvaluate` / `handleCriticSummary`），每个 split params、校验必填、调底层方法、返回字符串
4. `showCodeReviewHelp(): string` —— 多行帮助文本

**验证：** `tsc --noEmit` 通过；`handleCodeReviewCommand({args:"create review-A"}, ...)` 返回创建成功提示

## T18: `tests/file-mailbox.test.ts`**文件：** `tests/file-mailbox.test.ts`
**依赖：** T2
**步骤：**
1. import `describe`、`it`、`expect` from `bun:test`、`mkdtempSync` from `node:fs`、`tmpdir` from `node:os`、`join` from `node:path`、`FileMailbox` from `../src/teams/file-mailbox.js`
2. `describe("FileMailbox", () => { ... })`：
   - `it("delivers only unread messages and advances the cursor")` —— send → receive 拿到；再 receive 空；再 send → receive 拿新
   - `it("persists the read cursor across instances (process restart)")` —— writer send 两条，reader1 receive 两条；再 send 第三条；reader2 实例 `unreadCount === 1`，receive 仅第三条
   - `it("markAllRead consumes without returning")` —— send 两条，`markAllRead()`，`unreadCount === 0`，receive 空

**验证：** `bun test tests/file-mailbox.test.ts` 通过

## T19: `tests/teams.test.ts`**文件：** `tests/teams.test.ts`
**依赖：** T5、T8
**步骤：**
1. import `describe`、`it`、`expect`、`TeamManager` from `../src/teams/team.js`、`TeamCreateTool` / `SpawnTeammateTool` / `SendMessageTool` / `ListTeamsTool` from `../src/teams/tools.js`
2. helper `wait(ms)`、`workDir = () => mkdtempSync(join(tmpdir(), "mewcode-team-"))`
3. `describe("teams orchestration")`：
   - spawn → drainLeads 含 `[idle]` 与 name
   - 失败队员 → drainLeads 含 `failed`
   - 5 工具 happy path（create → spawn → sendMessage → list）
   - 必填校验（空 args 触发 `isError: true`）

**验证：** `bun test tests/teams.test.ts` 通过

## T20: `tests/code-review.test.ts`**文件：** `tests/code-review.test.ts`
**依赖：** T15、T16
**步骤：**
1. import `describe`、`it`、`expect`、`TeamManager`、`CodeReviewManager`、`ReviewSession`
2. 用例：
   - `createTeam` 后 `listTeams` 含该 team；底层 `teamManager.get(name)` 非空
   - `addMember` / `removeMember` / `activateMember` / `deactivateMember` 更新 `lastActive` 与 `active` 字段
   - `createReviewRequest` 在无活跃 reviewer 时抛错
   - `addComment` + `addCriticAssessment` + `generateFinalReport` 链路

**验证：** `bun test tests/code-review.test.ts` 通过

## T21: 示例脚本 — `examples/create-code-review-team.ts` / `create-custom-team.ts`**文件：** 两个新文件
**依赖：** T15、T5
**步骤：**
1. `create-code-review-team.ts`：构造 `TeamManager` + `CodeReviewManager`，调 `createTeam("demo-review", [...])`，打印团队摘要
2. `create-custom-team.ts`：构造 `TeamManager`，调 `mgr.create("custom")`，`team.addMember("alice")` / `team.addMember("bob")`，打印 `listMembers`

**验证：** `bun run examples/create-code-review-team.ts` 与 `bun run examples/create-custom-team.ts` 跑通

## T22: 全量测试与类型检查**依赖：** T1-T21
**步骤：**
1. `tsc --noEmit` 无错误
2. `bun test` 全绿
3. 手动 `bun run src/main.tsx` 启动 TUI 验证 Ctrl+T、SpawnTeammate 流程

**验证：** 三项全过

## 执行顺序

```text
T1 (lock) ──► T2 (FileMailbox) ──┐
                                 │
T3 (progress) ───────────────────┼──► T5 (Team / TeamManager) ──► T7 (coordinator)
                                 │                            └──► T8 (5 tools)
T4 (backend) ────────────────────┘                                     │
                                                                       │
T6 (transcript) ──► T5 finally 块                                       │
                                                                       │
T9 (teammate.ts) ──► T10 (main.tsx)                                    │
                                                                       │
T11 (team-status, teammate-message) ──┐                                │
T12 (spinner-line/tree) ───────────────┼──► T14 (app.tsx 集成) ◄────────┘
T13 (teams-dialog) ────────────────────┘

T15 (code-review/manager) ──► T16 (code-review/session) ──► T17 (code-review/handler)

T18 (file-mailbox.test) ┐
T19 (teams.test) ───────┼──► T22 (全量验证)
T20 (code-review.test) ─┘

T21 (examples) ─► 可选
```

并行机会：
- T1/T3/T4 互不依赖，可同时铺
- T11/T12/T13 互不依赖（都依赖 T3），可分开实现
- T15 完成后 T16/T17 串行；T18/T19/T20 互不依赖可并行写
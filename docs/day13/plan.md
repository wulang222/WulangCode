# Agent Team Plan## 技术栈

- 运行时：bun
- 语言：TypeScript 5.x（`tsc --noEmit` 校验）
- TUI：Ink（React 渲染到终端）、ink-spinner、ink-text-input
- LLM SDK：@anthropic-ai/sdk、openai
- MCP：@modelcontextprotocol/sdk
- 配置：js-yaml（`.mewcode/config.yaml`）
- 模糊搜索：fuse.js
- 终端样式：chalk
- 测试：bun test
- 入口：`bun run src/main.tsx`

## 架构概览

本章在仓库内引入 `src/teams/` 目录与独立子模块 `src/code-review/`，把 ch13 的「子 Agent 一次性 spawn」扩展为「长期存在的队员 + 文件信箱 + 进度可视化」。整体分四层：

1. **数据模型层**（`src/teams/team.ts`）——`Team`、`TeamManager`、`Member`、`TeamMode` 数据结构与生命周期
2. **存储层**（`src/teams/file-mailbox.ts`、`src/teams/transcript.ts`）——`FileMailbox` 与 `.lock` 文件锁、`.read` 游标；`saveTranscript` / `loadTranscript` 持久化队员对话历史
3. **运行时层**（`src/teams/backend.ts`、`src/teams/progress.ts`、`src/teammate.ts`）——后端检测与 spawn 工厂、`TeammateUIState` 进度状态机、`--teammate` CLI 自治循环
4. **集成层**（`src/teams/tools.ts`、`src/teams/coordinator.ts`、`src/tui/*`、`src/code-review/*`）——5 个工具、Coordinator 工具过滤谓词、TUI Spinner Tree / Teams Dialog / 队员消息组件、代码评审场景化封装

依赖方向（单向）：

```
src/tui/app.tsx ──► src/teams/{team, tools, coordinator, progress, backend}
                       └────► src/teams/file-mailbox
                       └────► src/teams/transcript ──► src/conversation/conversation
src/teammate.ts ──► src/teams/file-mailbox + src/agent/agent
src/code-review/* ──► src/teams/{team, backend}
```

`src/teams/team.ts` 不反向依赖 `src/agent/`——所有「跑一轮 Agent」的能力通过外部传入的 `RunAgent` 闭包注入（依赖反转），让 `team.ts` 可单测且不耦合 LLM 协议。

## 数据流1. **创建 Team**：LLM 调 `TeamCreate(name)` → `TeamCreateTool.execute` → `TeamManager.create(name)` → `new Team(name, "in-process", workDir)` → 构造时 `mkdirSync(<workDir>/.mewcode/teams/<name>)` + `leadMailbox = new FileMailbox(...)`
2. **spawn 队员**：LLM 调 `SpawnTeammate(team, name, task)` → `SpawnTeammateTool.execute` → `team = mgr.get(team) ?? mgr.create(team)` → `team.spawnTeammate(name, task, runAgent)` → 内部 `addMember` 构造 `Member { mailbox: FileMailbox }` → 异步主循环
3. **队员主循环**：`runAgent(prompt, onEvent)` 跑一轮 → `lastMessage = result` → `leadMailbox.send(name, "[idle] <name> (reason: available)")` → `waitForNextPromptOrShutdown` 每 500ms 轮询自己的信箱 → 收到非 shutdown 消息后拼成 `"From <from>: <text>"` 包在 `"You have new messages from your team:\n\n"` 前后 → 作为下一轮 `nextPrompt` 继续
4. **Lead 发消息**：LLM 调 `SendMessage(team, to, message)` → `team.sendMessage("lead", to, message)` → `member.mailbox.send("lead", message)` → 写入 `<dir>/<member>.jsonl`
5. **Lead 收消息**：TUI Agent 主循环每轮调 `notificationFn = () => teamMgr.drainLeads()` → `TeamManager.drainLeads` 遍历所有 Team 的 `leadMailbox.receiveSync` → 拼成 `<team-notification team="<name>">\nfrom=<from>: <text>\n</team-notification>` 字符串数组 → 注入到 LLM 输入作为 reminder
6. **进度更新**：队员的 `onEvent` 闭包在每个 `tool_use` / `usage` / `stream_text` 事件触发时更新 `uiState.progress`；TUI `setInterval(500ms)` 拷贝 `teamMgr.getAllTeammateStates()` 到 state，Spinner Tree 重渲染
7. **Coordinator 过滤**：每轮 LLM 请求前 `Agent` 取 `toolFilter` 判断每个工具是否可见；`coordinatorToolFilter` 看到 `teamMgr.list().length > 0` 时收窄到白名单 ∪ `mcp__*`
8. **退出与持久化**：`member.active = false` 触发主循环退出 → `finally` 块若 `member.conversation` 非空调 `saveTranscript` 写 JSON
9. **`--teammate` 子进程**（tmux 后端）：`main.tsx` 解析 `parseTeammateFlags` → `runTeammate(args)` → 跑初始 task → `mailbox.poll(2000)` 等后续消息 → 收到 `[shutdown]` 退出

## 核心数据结构与接口### `TeamMode`

```typescript
export type TeamMode = "in-process" | "tmux" | "iterm";
```

### `Member`

```typescript
export interface Member {
  name: string;
  active: boolean;
  cancel?: () => void;
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  conversation?: ConversationManager;
}
```

### `Team`

```typescript
export class Team {
  name: string;
  mode: TeamMode;
  members = new Map<string, Member>();
  leadMailbox: FileMailbox;
  private mailboxDir: string;
  private workDir: string;

  static readonly IDLE_POLL_INTERVAL_MS = 500;
  static readonly SHUTDOWN_PREFIX = "[shutdown]";

  constructor(name: string, mode: TeamMode, workDir: string);
  addMember(name: string): Member;
  spawnTeammate(name: string, task: string, runAgent: RunAgent): void;
  sendMessage(from: string, to: string, content: string): Promise<void>;
  stopMember(name: string): Promise<void>;
  stopAll(): Promise<void>;
  listMembers(): Member[];
  getMember(name: string): Member | undefined;
  getTeammateStates(): TeammateUIState[];
  private waitForNextPromptOrShutdown(member: Member): Promise<{ prompt: string; shutdown: boolean }>;
}
```

### `TeamManager`

```typescript
export class TeamManager {
  private teams = new Map<string, Team>();
  private workDir: string;

  constructor(workDir: string);
  create(name: string, mode?: TeamMode): Team;
  get(name: string): Team | undefined;
  list(): Team[];
  delete(name: string): Promise<void>;
  getAllTeammateStates(): TeammateUIState[];
  drainLeads(): string[];
}
```

### `RunAgent` / `AgentEventCallback`

```typescript
export type AgentEventCallback = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

export type RunAgent = (task: string, onEvent?: AgentEventCallback) => Promise<string>;
```

`RunAgent` 是依赖反转的关键接口——`Team` 不知道 LLM、Agent、Provider 长什么样，只接收一个「跑任务返回字符串」的闭包；`tui/app.tsx` 在注册 `SpawnTeammateTool` 时把 `spawnSubAgent(BUILTIN_AGENTS[0], task, ...)` 包成闭包传入。

### `FileMailbox`

```typescript
export interface FileMailMessage {
  from: string;
  text: string;
  timestamp: string;
}

export class FileMailbox {
  private filePath: string;
  private readStatePath: string;
  private lastReadLines: number;

  constructor(dir: string, memberName: string);
  send(from: string, text: string): Promise<void>;
  receiveSync(): FileMailMessage[];
  receive(): Promise<FileMailMessage[]>;
  unreadCount(): number;
  markAllRead(): void;
  poll(intervalMs?: number): AsyncGenerator<FileMailMessage>;
}
```

文件结构：

- `<dir>/<member>.jsonl`：消息追加日志，每行一个 `FileMailMessage` JSON
- `<dir>/<member>.read`：游标文件，存 `lastReadLines` 数字
- `<dir>/<member>.jsonl.lock`：写锁，`openSync(..., "wx")` 独占创建

### `AgentProgress` / `TeammateUIState`

```typescript
export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[]; // 最多 5 条
}

export interface TeammateUIState {
  name: string;
  teamName: string;
  status: "running" | "idle" | "completed" | "failed" | "stopped";
  progress: AgentProgress;
  startTime: number;
  spinnerVerb: string;
  lastMessage?: string;
}
```

### `SpawnConfig`

```typescript
export interface SpawnConfig {
  mode: TeamMode;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export function spawnTeammate(config: SpawnConfig): { cancel: () => void; paneId?: string };
```

### Coordinator 谓词

```typescript
export function isCoordinatorTool(name: string): boolean;
export function coordinatorToolFilter(teamMgr: TeamManager): (name: string) => boolean;
```

### Code Review

```typescript
export interface CodeReviewMember {
  name: string;
  email: string;
  role: "reviewer" | "lead" | "junior" | "critic";
  expertise: string[];
  active: boolean;
}

export class CodeReviewManager {
  constructor(workDir: string, teamManager: TeamManager);
  createTeam(name: string, members: Omit<CodeReviewMember, "active">[]): CodeReviewTeam;
  addMember(teamName: string, member: Omit<CodeReviewMember, "active">): void;
  removeMember(teamName: string, memberName: string): void;
  activateMember(teamName: string, memberName: string): void;
  deactivateMember(teamName: string, memberName: string): void;
  deleteTeam(name: string): void;
  getTeam(name: string): CodeReviewTeam | undefined;
  listTeams(): CodeReviewTeam[];
  getActiveReviewers(teamName: string): CodeReviewMember[];
  getTeamSummary(teamName: string): string;
}

export class ReviewSession {
  constructor(workDir: string, manager: CodeReviewManager);
  createReviewRequest(teamName, title, description, author, branch, files): ReviewRequest;
  addComment(requestId, reviewer, content, file?, line?): ReviewComment;
  acceptComment(requestId, commentId, authorResponse?): void;
  rejectComment(requestId, commentId, authorResponse?): void;
  addCriticAssessment(requestId, commentId, criticName, evaluation, reasoning): CriticAssessment;
  generateFinalReport(requestId): ReviewSummary;
  formatFinalReport(summary): string;
}
```

## 模块设计### `src/teams/team.ts`**职责：** `Team` / `TeamManager` / `Member` 数据结构与生命周期；定义 `TeamMode` / `RunAgent` / `AgentEventCallback` 接口；实现队员主循环（`spawnTeammate` 内的异步 IIFE）。
**对外接口：** 上面 `Team` / `TeamManager` 类公开方法；`AgentEventCallback`、`RunAgent`、`Member`、`TeamMode` 类型。
**依赖：** `./file-mailbox.js`、`./backend.js`（`detectBackend`）、`./progress.js`、`./transcript.js`、`../tui/verbs.js`（`randomVerb`）、`../conversation/conversation.js`（仅类型）

### `src/teams/file-mailbox.ts`**职责：** 信箱文件 + 文件锁的读写。
**对外接口：** `FileMailbox` 类、`FileMailMessage` 接口。
**依赖：** Node.js stdlib（`node:fs` / `node:path`）。注意 `acquireLock` 内用 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` 做同步 sleep，避免 `setTimeout` 让出事件循环导致多个锁请求同时进入 stat 阶段。

### `src/teams/backend.ts`**职责：** 后端选择与 spawn 工厂。
**对外接口：** `detectBackend()` / `detectPaneBackend()` / `spawnTeammate(config)` / `SpawnConfig` 接口。
**依赖：** `node:child_process`（`spawn`、`execSync`）。

### `src/teams/progress.ts`**职责：** 队员进度状态机与工具描述生成。
**对外接口：** `AgentProgress` / `ToolActivity` / `TeammateUIState` 接口；`createProgress` / `recordToolUse` / `recordTokens` / `summarizeActivities` / `formatTokens` 函数。
**依赖：** 无。

### `src/teams/transcript.ts`**职责：** 队员对话历史的 JSON 持久化与读取。
**对外接口：** `saveTranscript(workDir, teamName, agentId, conv)` → 路径字符串；`loadTranscript(workDir, teamName, agentId)` → `TranscriptEntry[] | null`。
**依赖：** `node:fs` / `node:path` / `../conversation/conversation.js`（仅类型 `ConversationManager` / `Message` / `ToolUseBlock` / `ToolResultBlock`）。

### `src/teams/tools.ts`**职责：** 5 个工具——`TeamCreateTool` / `SpawnTeammateTool` / `SendMessageTool` / `ListTeamsTool` / `TeamDeleteTool`。
**对外接口：** 5 个 class，全部实现 `Tool` 接口（`src/tools/types.ts`）；构造函数接收 `TeamManager`（`SpawnTeammateTool` 额外接收 `RunAgent`）。
**依赖：** `../tools/types.js`（`Tool` / `ToolResult` / `strArg`）、`./team.js`。

### `src/teams/coordinator.ts`**职责：** Coordinator Mode 的工具白名单与谓词。
**对外接口：** `isCoordinatorTool(name)` / `coordinatorToolFilter(teamMgr)`。
**依赖：** `./team.js`（仅类型 `TeamManager`）。

### `src/teammate.ts`**职责：** `--teammate` CLI 模式入口；为 `tmux` 后端子进程提供独立的「跑初始任务 + 轮询信箱」自治循环。
**对外接口：** `parseTeammateFlags(args: string[]): TeammateArgs | null` / `runTeammate(args: TeammateArgs): Promise<void>`。
**依赖：** `./config/config.js`、`./llm/client.js`、`./conversation/conversation.js`、`./prompt/builder.js`、`./tools/*`、`./permissions/checker.js`、`./agent/agent.js`、`./teams/file-mailbox.js`。

### `src/tui/teammate-message.tsx`**职责：** 把 `<team-notification>` reminder 里的单条消息渲染成 `@<from> ❯ <content>` 块。
**对外接口：** `TeammateMessage({ from, content, type })` 组件、`parseTeammateMessage(raw): { from, content, type } | null`。
**依赖：** `ink`（`Box` / `Text`）、`react`。

### `src/tui/teammate-spinner-line.tsx` & `teammate-spinner-tree.tsx`**职责：** Spinner Tree 视图——`TeammateSpinnerLine` 渲染单个队员的 `name` / `status` / 最近活动 / token 计数；`TeammateSpinnerTree` 把 Lead 与所有队员组成树形 spinner。
**对外接口：** `TeammateSpinnerLine({ state, isLast, isSelected })` / `TeammateSpinnerTree({ teammates, leaderVerb, leaderTokens })`。
**依赖：** `ink`、`react`、`../teams/progress.js`。

### `src/tui/team-status.tsx`**职责：** 状态栏底部 `● N teammate(s)` 计数。
**对外接口：** `TeamStatus({ count })` 组件。
**依赖：** `ink`、`react`。

### `src/tui/teams-dialog.tsx`**职责：** `Ctrl+T` 调出的 Teams Dialog——列表视图 + 详情视图，支持 `↑/↓` 选择、`Enter` 进详情、`k` kill、`s` shutdown。
**对外接口：** `TeamsDialog({ teammates, onClose, onKill, onShutdown })` 组件。
**依赖：** `ink`、`react`、`./styles.js`、`../teams/progress.js`。

### `src/tui/app.tsx`（扩展）**职责：** 整体集成入口。
**变更点：**
- `teamManagerRef = useRef(new TeamManager(workDir))`；`teammateStates` state；`teamsDialogOpen` state
- 启动时注册 5 个 Team 工具到 `registryRef.current`；`SpawnTeammateTool` 的 `RunAgent` 闭包内部调 `spawnSubAgent(BUILTIN_AGENTS[0], task, client, registryRef.current, provider, workDir, undefined, onEvent)`
- `setInterval(500ms)` 拷贝 `teamMgr.getAllTeammateStates()`
- Lead 主循环 `agent.run` 的 options 传 `toolFilter: buildComposedToolFilter(coordinatorToolFilter(teamMgr), skillFilter)` + `notificationFn: () => teamMgr.drainLeads()`
- 渲染 `<TeammateSpinnerTree>`、`<TeamStatus>`、`<TeamsDialog>`（条件渲染）；`useInput` 处理 `Ctrl+T` 切换 dialog

### `src/code-review/manager.ts` / `session.ts` / `handler.ts`**职责：** 代码评审场景化封装，构建在 `TeamManager` 之上。
**对外接口：** `CodeReviewManager` / `ReviewSession` / `handleCodeReviewCommand`。
**依赖：** `../teams/team.js`（`TeamManager` / `Team`）、`../teams/backend.js`（`detectBackend`）、`node:fs` / `node:path`。

### `src/main.tsx`（扩展）**变更点：** 启动前调 `parseTeammateFlags(process.argv.slice(2))`，命中走 `runTeammate(teammateArgs)` 后 `return`，不渲染 TUI。

## 模块交互### 创建 Team → spawn 队员 → 队员循环

```
LLM 调 TeamCreate(name="demo")
  └─► TeamCreateTool.execute
        └─► TeamManager.create("demo")
              └─► new Team("demo", "in-process", workDir)
                    ├─► mkdirSync(<workDir>/.mewcode/teams/demo)
                    └─► leadMailbox = new FileMailbox(dir, "lead")

LLM 调 SpawnTeammate(team="demo", name="alice", task="探索 src/agent")
  └─► SpawnTeammateTool.execute
        ├─► team = mgr.get("demo") ?? mgr.create("demo")
        └─► team.spawnTeammate("alice", task, runAgent)
              ├─► addMember("alice") → member.mailbox = new FileMailbox(...)
              ├─► uiState = { status: "running", progress: createProgress(), spinnerVerb }
              ├─► onEvent = (event) => recordToolUse / recordTokens / lastMessage
              └─► void (async () => {
                    while (member.active) {
                      uiState.status = "running"
                      result = await runAgent(nextPrompt, onEvent)
                      uiState.lastMessage = result.slice(0, 200) + "..."
                      uiState.status = "idle"
                      await leadMailbox.send("alice", "[idle] alice (reason: available)")
                      pollResult = await waitForNextPromptOrShutdown(member)
                      if (pollResult.shutdown) break
                      nextPrompt = pollResult.prompt
                    }
                  })()
```

### Lead 端 reminder 注入

```
TUI Agent.run 每轮迭代开头
  └─► notificationFn() ─► teamMgr.drainLeads()
        └─► for each team: team.leadMailbox.receiveSync() → 拼成
            <team-notification team="demo">
            from=alice: [idle] alice (reason: available)
            </team-notification>

  └─► reminders.push(...drainResults)
  └─► 注入到 LLM 输入

LLM 看到 reminder → 决定下一步（派新任务 / 调 SendMessage / 等更多结果）
```

### 工具过滤与 Coordinator Mode

```
Agent.run 每轮迭代前构建 tool list
  └─► registry.getAvailableTools()
        └─► filter (name) => toolFilter(name)
              └─► buildComposedToolFilter(coordinatorFilter, skillFilter)
                    └─► coordinatorFilter(name) && skillFilter(name)

coordinatorFilter(name):
  if (teamMgr.list().length === 0) return true     // 没 Team 时全集
  if (name.startsWith("mcp__")) return true        // MCP 总是允许
  return COORDINATOR_ALLOWED_TOOLS.has(name)        // 否则只允许白名单
```

### Spinner Tree 与状态轮询

```
TUI 启动后:
  setInterval(() => {
    setTeammateStates(teamManagerRef.current.getAllTeammateStates())
  }, 500)

队员主循环里 onEvent("tool_use", { toolName: "ReadFile", args: { file_path } })
  └─► recordToolUse(uiState.progress, "ReadFile", args)
        └─► uiState.progress.lastActivity = { toolName, input, activityDescription: "Reading <file_path>" }

500ms 后 TUI setInterval 触发
  └─► getAllTeammateStates() 返回包含更新后的 uiState 快照
  └─► React 重渲染 TeammateSpinnerTree
        └─► TeammateSpinnerLine 显示 "@alice: Reading src/foo.ts... · 5 tools · 1.2k tokens"
```

### TeamsDialog 与队员控制

```
用户按 Ctrl+T → setTeamsDialogOpen(true)
TeamsDialog 接管 useInput:
  ↑/↓ 选择队员
  Enter → 进入详情视图
  k → onKill(name, teamName) → team.stopMember(name)
       └─► member.active = false; uiState.status = "stopped"; member.cancel?.()
  s → onShutdown(name, teamName) → team.sendMessage("lead", name, "[shutdown] Please finish and exit")
       └─► 队员下一轮 waitForNextPromptOrShutdown 检测到 SHUTDOWN_PREFIX 返回 shutdown:true
       └─► 主循环 break → finally 块持久化 transcript
```

### `--teammate` 子进程（tmux 后端）

```
tmux backend.spawnTeammate 启动 mewcode 子进程，命令含 --teammate --team-dir <dir> --member-name alice --task "..."
  └─► main.tsx 检测 parseTeammateFlags 命中
  └─► runTeammate(args)
        ├─► loadConfig + createClient + 注册 6 个工具
        ├─► agent.run 跑初始 task → stdout 打印 stream_text
        ├─► leadMailbox.send("alice", "[idle] alice has completed their task and is waiting for new instructions.")
        └─► for await msg of mailbox.poll(2000):
              if (msg.text.startsWith("[shutdown]")) break
              conv.addUserMessage(msg.text)
              agent.run 跑一轮
              leadMailbox.send("alice", "[idle] ...")
```

### Code Review 子系统

```
用户输入 /code-review create review-A
  └─► handleCodeReviewCommand(ctx, manager, session)
        └─► handleCreate(manager, "review-A")
              └─► CodeReviewManager.createTeam("review-A", [reviewer1, reviewer2, reviewer3])
                    ├─► 写 <workDir>/.mewcode/code-review-teams.json
                    └─► 调底层 TeamManager.create("review-A", "in-process")
                          + 对每个 reviewer 调 team.addMember(name) 创建信箱

用户输入 /code-review request review-A "fix bug" "details"
  └─► handleCreateRequest(session, "review-A fix bug details")
        └─► session.createReviewRequest("review-A", "fix bug", "details", "current-user", "main", ["src/"])

用户输入 /code-review comment <reqId> "this looks off"
  └─► session.addComment(reqId, "current-user", "this looks off")

用户输入 /code-review critic <reqId> <commentId> reasonable "good catch"
  └─► session.addCriticAssessment(reqId, commentId, "critic-1", "reasonable", "good catch")

用户输入 /code-review report <reqId>
  └─► summary = session.generateFinalReport(reqId)
  └─► session.formatFinalReport(summary) → 字符串
```

## 文件组织

```text
src/
├── main.tsx                            修改：parseTeammateFlags + runTeammate 分支
├── teammate.ts                         新建：--teammate CLI 自治循环
├── teams/
│   ├── team.ts                         新建：Team / TeamManager / Member / RunAgent
│   ├── file-mailbox.ts                 新建：FileMailbox + acquireLock + withLock
│   ├── backend.ts                      新建：detectBackend / detectPaneBackend / spawnTeammate
│   ├── progress.ts                     新建：TeammateUIState / AgentProgress / 工具描述
│   ├── transcript.ts                   新建：saveTranscript / loadTranscript
│   ├── tools.ts                        新建：5 个工具
│   └── coordinator.ts                  新建：COORDINATOR_ALLOWED_TOOLS + coordinatorToolFilter
├── code-review/
│   ├── manager.ts                      新建：CodeReviewManager
│   ├── session.ts                      新建：ReviewSession + ReviewRequest / Comment / CriticAssessment / Summary
│   └── handler.ts                      新建：/code-review slash 命令分发
└── tui/
    ├── app.tsx                         修改：注册 5 工具 + Spinner Tree + TeamStatus + TeamsDialog + 过滤器
    ├── team-status.tsx                 新建：状态栏 ● N teammates
    ├── teams-dialog.tsx                新建：Ctrl+T 弹出的对话框
    ├── teammate-message.tsx            新建：parseTeammateMessage + @name❯ 渲染
    ├── teammate-spinner-line.tsx       新建：单个队员行
    └── teammate-spinner-tree.tsx       新建：Lead + 队员的树形 spinner

tests/
├── file-mailbox.test.ts                新建：游标、跨实例、markAllRead
├── teams.test.ts                       新建：spawnTeammate + 5 工具
└── code-review.test.ts                 新建：Manager / Session CRUD

examples/
├── create-code-review-team.ts          新建：示例脚本
└── create-custom-team.ts               新建：示例脚本
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Team 包归属 | `src/teams/` 顶层目录 | 与 `src/agents/`、`src/worktree/` 平级，职责清晰 |
| 队员生命周期 | 长存活循环（跑完一轮等下条消息）而非一次性 spawn | 让 Lead 可以多轮派任务给同一队员，复用对话上下文 |
| 默认后端 | `detectBackend()` 直接返回 `"in-process"` | 同进程让 `onEvent` 直接更新 Spinner Tree，UX 最佳；tmux 仅在用户显式配置时启用 |
| `RunAgent` 注入 | 用 `(task, onEvent) => Promise<string>` 闭包，由 `app.tsx` 注入 | 让 `team.ts` 与 `Agent` / `LLMClient` 解耦，单测可用假 `runAgent` |
| 信箱协议 | `.jsonl` 追加 + `.read` 游标 + `.lock` 互斥锁 | 跨进程友好；游标持久化让重启的子进程不会重读已读消息 |
| 锁实现 | `openSync(lockFile, "wx")` 独占创建 + `Atomics.wait` 同步 sleep | `wx` 是 fs 原语级原子，无 race；`Atomics.wait` 避免事件循环让步导致多锁同时进入 stat 阶段 |
| 锁参数 | 10 次重试、5-100ms 随机抖动、10 秒 stale | 与同套信箱协议的其他语言实现保持一致，方便混布 |
| Lead 收信 | TUI 主循环每轮调 `drainLeads()` 注入 reminder | 不引入 watcher 线程；`drainLeads` 本身是消耗读，自带游标 |
| Coordinator 触发 | 「存在至少一个 Team」自动启用 | 不引入 feature flag 或环境变量；语义直观：Lead 一旦开始组队，就转入 Coordinator 模式 |
| Coordinator 工具白名单 | 静态 `Set<string>` 常量 | 编辑器可静态分析；新增工具时强制 review |
| MCP 工具豁免 | `name.startsWith("mcp__")` 直接放行 | MCP 服务器由用户配置，应该尊重；不让 Coordinator 谓词把 MCP 全杀 |
| 进度状态轮询 | `setInterval(500ms)` 在 TUI 层快照 | React 状态需要不可变快照；轮询 + 拷贝最简单 |
| Spinner Verb 多样化 | `randomVerb()` 给每个队员配独立动词 | 视觉上区分多个并行队员，UX 借鉴 Claude Code 风格 |
| Transcript 时机 | 队员 `finally` 块持久化，best-effort | 任何退出路径（自然、失败、shutdown、stopMember）都覆盖；持久化失败不阻塞退出 |
| `--teammate` 模式 | `main.tsx` 检测 flag 不构造 TUI，直接跑自治循环 | tmux 子进程没有 TUI 也无法响应；保持单二进制部署 |
| Code Review 复用 Team | `CodeReviewManager` 持有 `TeamManager` 引用并双写 | 评审场景的「评论 / Critic / Report」是上层语义；底层的信箱、状态可视化、`Coordinator` 直接复用 |
| Critic 角色独立枚举 | `role: "critic"` 与 reviewer / lead / junior 并列 | 评审场景需要「评估评审者意见」的元角色；不混入 reviewer |
| 评论与请求 ID | `comment-<ts>-<counter>` / `review-<ts>` | 时间戳 + 计数器够单进程内唯一；不引入 uuid 依赖 |
| `TeamCreateTool` 已存在策略 | 返回提示「already exists」而非报错 | LLM 多次调用 `TeamCreate` 是常见行为；幂等 UX 更友好 |
| `SpawnTeammate` 自动 create Team | `mgr.get(team) ?? mgr.create(team)` | LLM 经常省略 `TeamCreate` 直接 spawn；自动 create 降低交互成本 |
| 队员失败语义 | 仅给 Lead 发 `[idle] <name> (reason: failed)` 通知，不抛出 | LLM 通过 reminder 看到 `failed` 字段决定怎么补救；不打断 Lead 的主循环 |
| 错误命名 | `Error("Member '<x>' not found in team '<y>'")` 等 | 字符串错误信息直接展示给 LLM，便于诊断；不引入自定义错误类 |
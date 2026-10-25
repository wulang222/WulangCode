# SubAgent 机制 Plan## 技术栈

- 运行时：bun（`bun run src/main.tsx`）；脚本入口 `package.json` 的 `start` / `test` / `typecheck`。
- 语言：TypeScript 5.x（`tsconfig.json` 严格模式、ESM、`module: NodeNext`）。
- TUI：Ink（React → 终端）、ink-spinner、ink-text-input。
- LLM SDK：`@anthropic-ai/sdk`、`openai`（OpenAI-compat 走同一个客户端封装）。
- MCP：`@modelcontextprotocol/sdk`。
- Markdown：`marked` + `marked-terminal`。
- 配置：`js-yaml`（解析 `.mewcode/agents/*.md` frontmatter、`config.yaml`）。
- 模糊搜索：`fuse.js`（与 SubAgent 无直接耦合，但 `loadAgentDefinitions` 在 schema 渲染时可被复用）。
- 终端样式：`chalk`。
- 测试：`bun test`（驱动 `*.test.ts`）。
- 类型检查：`tsc --noEmit`。

## 架构概览

整体分四层：

1. **`src/agents` 子代理核心层**（新增 / 扩展）
   - `definition.ts`：`AgentDefinition` 接口 + `BUILTIN_AGENTS` 数组；
   - `loader.ts`：`loadAgentDefinitions(workDir)` 三层加载 + frontmatter 解析；
   - `tool-filter.ts`：`filterToolsForAgent` 与三个全局工具集合常量；
   - `spawn.ts`：`spawnSubAgent`（一次性同步派生）+ `AgentEventSink` 类型；
   - `task-manager.ts`：`TaskManager` 与 `AgentTask` 接口；
   - `agent-tool.ts`：`AgentTool` 类（实现 `Tool` 接口）+ `FORK_BOILERPLATE` / `FORK_BOILERPLATE_TAG` / `FORK_QUERY_SOURCE` 常量；

2. **`src/teams` 长驻团队层**（已存在，本章被 Agent 工具接入）
   - `team.ts`：`Team` / `TeamManager` / `Member` 类，idle-poll 主循环；
   - `tools.ts`：`TeamCreate` / `SpawnTeammate` / `SendMessage` / `ListTeams` / `TeamDelete` 工具；
   - `file-mailbox.ts`：基于文件的邮箱实现（`.mewcode/teams/<team>/<member>/`）；
   - `progress.ts`：`TeammateUIState` 用于 TUI 渲染。

3. **`src/agent` 主循环层**（不动 schema，但 `spawnSubAgent` 直接复用 `Agent` 类）
   - `agent.ts`：主 Agent 与子 Agent 共用同一个 `Agent` 类，通过 `AgentConfig` 不同字段区分 maxIterations / toolFilter；
   - `events.ts`：事件类型 `AgentEvent`，含 `stream_text` / `tool_use` / `usage` / `turn_complete` / `loop_complete` / `error`；
   - `streaming-executor.ts`：负责把 LLM 流式响应翻译成事件。

4. **集成层**（main / TUI）
   - `src/main.tsx`：启动时构造 `TaskManager` / `TeamManager` / 加载 `loadAgentDefinitions(workDir)`、向 `ToolRegistry` 注册 `AgentTool` 及 Team 系列工具；
   - TUI：主循环里调 `TaskManager.drainNotifications()` 把结果拼成 `<task-notification>` 注入主对话 reminder 区。

## 数据流

```
LLM 产 tool_use {name:"Agent", input:{prompt, subagent_type:"explore"}}
  → Agent.streamingExecutor 派发 → ToolRegistry.get("Agent").execute(args, ctx)
  → AgentTool.execute(args, ctx)
       ├─ team_name 非空 → runAsTeammate → TeamManager.get → Team.spawnTeammate
       │                                   → 队友 idle-poll 主循环（异步）
       │                                   → 立即返回 string output
       ├─ subagent_type 空 → runFork → forkHandler(FORK_BOILERPLATE + prompt, conv, registry, model)
       │                              → 后台注册到 TaskManager（外部 handler 控制）
       │                              → 立即返回 string output
       └─ subagent_type 命中定义 → spawnHandler(definition, prompt, background, model)
                                  → spawnSubAgent → 子 Agent 同步跑完 → 返回 finalText

后台完成：
TaskManager.create 内部 .then/.catch 写回 task.status / task.output
  → TUI 主循环 drainNotifications()
  → 拼 <task-notification> 注入 ConversationManager 的下一轮 reminder
  → 主 Agent 下次 turn 自动消费
```

## 核心数据结构与接口### `AgentDefinition`（`src/agents/definition.ts`）

```ts
import type { PermissionMode } from "../permissions/checker.js";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPromptOverride?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: PermissionMode;
  background?: boolean;
  isolation?: "worktree";
  initialPrompt?: string;
  omitMewcodeMd?: boolean;
  skills?: string[];
  memory?: boolean;
  mcpServers?: string[];
}

export const BUILTIN_AGENTS: AgentDefinition[];
```

### `AgentTool`（`src/agents/agent-tool.ts`）

```ts
export class AgentTool implements Tool {
  name = "Agent";
  description = "Launch a sub-agent to handle complex, multi-step tasks.";
  category = "read" as const;
  system = true;

  querySource = ""; // 被派生时设为 "agent:builtin:fork" 启用嵌套防护

  setTeamManager(mgr: TeamManager, runAgent: RunAgent): void;
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

构造签名：

```ts
constructor(
  workDir: string,
  registry: ToolRegistry,
  spawnHandler: (
    def: AgentDefinition,
    prompt: string,
    bg: boolean,
    modelOverride?: string,
  ) => Promise<string>,
  conversation?: ConversationManager,
  forkHandler?: (
    prompt: string,
    conversation: ConversationManager,
    registry: ToolRegistry,
    modelOverride?: string,
  ) => Promise<string>,
);
```

### `TaskManager` / `AgentTask`（`src/agents/task-manager.ts`）

```ts
export interface AgentTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  output: string;
  cancel: () => void;
}

export class TaskManager {
  create(name: string, runner: () => Promise<string>, cancel: () => void): AgentTask;
  get(id: string): AgentTask | undefined;
  list(): AgentTask[];
  stop(id: string): void;
  drainNotifications(): AgentTask[];
}
```

### `filterToolsForAgent`（`src/agents/tool-filter.ts`）

```ts
export const ALL_AGENT_DISALLOWED_TOOLS: Set<string>;
export const CUSTOM_AGENT_DISALLOWED_TOOLS: Set<string>;
export const ASYNC_AGENT_ALLOWED_TOOLS: Set<string>;

export function filterToolsForAgent(
  registry: ToolRegistry,
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  isAsync: boolean,
  isCustom?: boolean,
): ToolRegistry;
```

### `spawnSubAgent`（`src/agents/spawn.ts`）

```ts
export type AgentEventSink = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

export async function spawnSubAgent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  workDir: string,
  onProgress?: (p: { turn?: number; lastTool?: string }) => void,
  onEvent?: AgentEventSink,
  modelOverride?: string,
): Promise<string>;
```

### `Team` / `TeamManager`（`src/teams/team.ts`）

```ts
export type TeamMode = "in-process" | "tmux" | "iterm";
export type RunAgent = (task: string, onEvent?: AgentEventCallback) => Promise<string>;

export class Team {
  spawnTeammate(name: string, task: string, runAgent: RunAgent): void;
  sendMessage(from: string, to: string, content: string): Promise<void>;
  stopMember(name: string): Promise<void>;
  stopAll(): Promise<void>;
  listMembers(): Member[];
  getMember(name: string): Member | undefined;
}

export class TeamManager {
  create(name: string, mode?: TeamMode): Team;
  get(name: string): Team | undefined;
  list(): Team[];
  delete(name: string): Promise<void>;
}
```

## 模块设计### 模块 A：`src/agents/definition.ts`

- 职责：纯类型 + 内置定义常量；不依赖 IO。
- 对外接口：`AgentDefinition` 接口、`BUILTIN_AGENTS: AgentDefinition[]`。
- 依赖：仅 `src/permissions/checker.ts` 的 `PermissionMode` 类型。
- 关键决策：把内置角色写成静态数组而不是单独的 markdown 文件 + `bun.embed`，避免在 TS 项目里引入运行时资源加载机制。

### 模块 B：`src/agents/loader.ts`

- 职责：把 `~/.mewcode/agents/` 与 `<workDir>/.mewcode/agents/` 下的 `.md` 文件解析为 `AgentDefinition`；同名后加载覆盖；解析失败静默吞错。
- 对外接口：`loadAgentDefinitions(workDir: string): AgentDefinition[]`。
- 内部函数：`loadDir(dir, definitions)` / `parseAgentDefinition(content)`。
- 依赖：`node:fs`（`readdirSync` / `readFileSync` / `existsSync`）、`node:path`、`node:os`、`js-yaml`、`./definition.js`。
- 关键决策：用 `findIndex` + 替换实现"同名覆盖"，避免 `Map` 后续要再转回 `Array` 顺序丢失。

### 模块 C：`src/agents/tool-filter.ts`

- 职责：在子 Agent 构造时按多层规则把 `ToolRegistry` 收窄；定义 3 个全局工具集合。
- 对外接口：`filterToolsForAgent` 与 3 个 `Set<string>` 常量。
- 依赖：`src/tools/registry.ts`。
- 关键决策：
  - 用 `Set<string>` 而不是数组——查找 O(1)，与定义级 `tools` / `disallowedTools` 数组取交集时需要 `new Set(...)` 包装；
  - MCP 工具按命名前缀 `mcp__*` 永久放行，不需要逐个名字写到白名单；
  - `tools: ["*"]` 视为通配，跳过白名单层。

### 模块 D：`src/agents/spawn.ts`

- 职责：一次性同步派生子 Agent，从 LLM client / system prompt / registry / permission / conversation 拼到 `Agent` 实例，跑完返回 finalText。
- 对外接口：`spawnSubAgent` 与 `AgentEventSink` 类型。
- 依赖：`src/llm/client.ts`（`createClient` / `LLMClient`）、`src/llm/model-resolver.ts`（`resolveModelId`）、`src/conversation/conversation.ts`、`src/prompt/builder.ts`（`buildSystemPrompt` / `detectEnvironment`）、`src/tools/registry.ts`、`src/permissions/checker.ts`、`src/agent/agent.ts`、`./tool-filter.js`。
- 关键决策：把 `for await (const event of agent.run())` 的事件透传给两个回调（`onProgress` 用于 TUI 进度行，`onEvent` 用于 Team 进度更新），不依赖具体 LLM 协议。

### 模块 E：`src/agents/task-manager.ts`

- 职责：后台一次性任务的生命周期管理。
- 对外接口：`TaskManager` 类与 `AgentTask` 接口。
- 依赖：无外部依赖；纯内存 `Map<string, AgentTask>`。
- 关键决策：
  - id 用 `String(this.nextId++)` 顺序生成；
  - `stop()` 把状态写为 `"failed"` + `"Stopped by user"` 而不是单独的 `"cancelled"` 状态，简化下游 UI 渲染分支；
  - `drainNotifications()` 不消费 tasks（不删除条目），调用方自行追踪"已通知过哪些 id"避免重复推送。

### 模块 F：`src/agents/agent-tool.ts`

- 职责：把 `Agent` 工具实现为 `Tool` 接口，路由三条派生路径（team / fork / definition）。
- 对外接口：`AgentTool` 类。
- 依赖：`./definition.js`、`./loader.js`、`./tool-filter.js`、`../tools/types.js`、`../tools/registry.js`、`../conversation/conversation.js`、`../teams/team.js`。
- 关键决策：
  - 构造时 eagerly 调 `loadAgentDefinitions(workDir)`，缓存到 `this.definitions`；schema 也只在 schema() 调用时按缓存重建（一次构造内不变）；
  - `spawnHandler` / `forkHandler` 由调用方注入（依赖反转），避免 `AgentTool` 直接 import `spawnSubAgent` 导致循环依赖；
  - `setTeamManager(mgr, runAgent)` 由 main.tsx 在 TaskManager / TeamManager 都构造完后调用一次，启用 `team_name` 路径。

### 模块 G：`src/teams/team.ts`（已存在，本章被 Agent 工具接入）

- 职责：长驻队友 + 邮箱协议；`TeamMode` 支持 `in-process`、`tmux`、`iterm`。
- 关键设计：
  - `spawnTeammate(name, task, runAgent)` 开异步主循环：执行一轮 → 写 `[idle] <name> (reason: <r>)` 到 lead 邮箱 → 轮询自己的邮箱（间隔 `IDLE_POLL_INTERVAL_MS=500ms`）等新消息 → 收到非 `[shutdown]` 消息 → 拼成下一轮 prompt 继续；
  - `cancel` / `stopMember(name)` 把 `member.active=false` 并调可选的 `cancel` 回调；
  - 退出时调 `saveTranscript(workDir, teamName, name, conversation)` 持久化对话用于调试。

## 模块交互### 启动期 wiring（`src/main.tsx`）

```
main.tsx
  ├── createClient(providerCfg, systemPrompt) → llmClient
  ├── new ToolRegistry() → registry
  ├── 注册基础工具（ReadFile/WriteFile/Bash/Grep/Glob/...）
  ├── new TaskManager() → taskMgr
  ├── new TeamManager(workDir) → teamMgr
  ├── new AgentTool(workDir, registry,
  │       spawnHandler = async (def, prompt, bg, model) => {
  │         if (bg) {
  │           // 后台路径：注册到 taskMgr
  │           const ctrl = new AbortController();
  │           const t = taskMgr.create(def.name,
  │             () => spawnSubAgent(def, prompt, llmClient, registry, providerCfg,
  │                                  workDir, undefined, undefined, model),
  │             () => ctrl.abort());
  │           return JSON.stringify({ task_id: t.id, status: "async_launched" });
  │         }
  │         return await spawnSubAgent(def, prompt, llmClient, registry,
  │                                     providerCfg, workDir, undefined, undefined, model);
  │       },
  │       conversation,
  │       forkHandler = async (prompt, conv, reg, model) => { ... taskMgr.create(...) }
  │     ) → agentTool
  ├── agentTool.setTeamManager(teamMgr, runAgentForTeammate)
  ├── 注册 agentTool / TeamCreate / SpawnTeammate / SendMessage / ListTeams / TeamDelete
  └── new Agent({ client, registry, ... }) → 主 Agent
```

### 运行时：主 Agent 调 Agent 工具（定义式，前台）

```
LLM → tool_use {name:"Agent", input:{prompt:"...", subagent_type:"explore"}}
  → StreamingExecutor.execute → registry.get("Agent").execute(args, ctx)
  → AgentTool.execute({ description, prompt, subagent_type:"explore" })
       1. 校验 description/prompt 非空
       2. team_name 空 → 跳过 runAsTeammate
       3. subagent_type 非空 → 跳过 runFork
       4. definitions.find(d => d.name === "explore") → def
       5. spawnHandler(def, prompt, false || def.background=undefined → false, undefined)
            → spawnSubAgent(def, prompt, parentClient, parentRegistry, providerCfg, workDir)
                a. resolveModelId("haiku") → "claude-haiku-4-5-..."
                b. createClient({...providerCfg, model:"claude-haiku-..."}, systemPrompt)
                c. filterToolsForAgent(parentRegistry, undefined, ["EditFile","WriteFile"], false)
                d. new PermissionChecker(workDir, "plan")
                e. new ConversationManager() + addUserMessage(prompt)
                f. new Agent({ client, registry, checker, conversation, workDir, maxIterations: 200 })
                g. for await event of agent.run() {
                     stream_text → output += event.text
                     tool_use   → onEvent({ type:"tool_use", toolName, args })
                     usage      → onEvent({ type:"usage", usage })
                     loop_complete → return output
                   }
       6. 返回 { output: finalText, isError: false }
```

### 运行时：Fork 路径（后台）

```
LLM → tool_use {name:"Agent", input:{prompt:"..." /* 不传 subagent_type */}}
  → AgentTool.execute
       1. 校验
       2. team_name 空 → 跳过
       3. subagent_type 空 → runFork(prompt, description, modelOverride)
            a. this.conversation 与 this.forkHandler 都非空 → 继续
            b. 嵌套防护：querySource !== FORK_QUERY_SOURCE → 继续
            c. 遍历 conversation.getMessages()：无消息含 FORK_BOILERPLATE_TAG → 继续
            d. forkHandler(FORK_BOILERPLATE + "\n\nYour task:\n" + prompt,
                            conversation, registry, modelOverride)
                 → 把任务注册到 TaskManager，立即返回提示字符串
       4. 返回 { output: "Forked agent \"...\" launched in background. Results will arrive via task-notification.", isError: false }
```

### 运行时：team-member 路径

```
LLM → tool_use {name:"Agent", input:{prompt:"...", description:"design API", team_name:"backend"}}
  → AgentTool.execute
       1. 校验
       2. teamManager 已注入 + team_name 非空 → runAsTeammate("backend", "design API", prompt)
            a. teamManager.get("backend") → team；找不到 → 错误
            b. memberName = "design-api"；getMember 命中 → "design-api-2"
            c. team.spawnTeammate("design-api", prompt, this.teamRunAgent!)
                  → 异步启动 idle-poll 主循环，立即返回
       3. 返回 { output: "Teammate 'design-api' spawned in team 'backend' (mode: in-process). ...", isError: false }

team-member idle-poll 主循环（Team.spawnTeammate 内部）：
   while (member.active) {
     await runAgent(nextPrompt, onEvent)
     → 完成一轮 → leadMailbox.send("design-api", "[idle] design-api (reason: available)")
     → waitForNextPromptOrShutdown(member)
        → poll member.mailbox 每 500ms
        → 收到 [shutdown] → break
        → 收到普通消息 → nextPrompt = "You have new messages from your team:\n\nFrom <from>: <text>"
   }
```

### 运行时：后台任务完成 → 主对话注入

```
TaskManager.create 内部 .then(output → status="completed", output=...)
  ↓
TUI 主循环 (Ink render loop)：
   for (const t of taskMgr.drainNotifications()) {
     if (!seenTaskIds.has(t.id)) {
       seenTaskIds.add(t.id);
       reminder.push(`<task-notification>\nTask ${t.id} (name="${t.name}"): ${t.status}\nResult: ${t.output}\n</task-notification>`);
     }
   }
  ↓
下一轮主 Agent.run() → conversation.takePendingReminders() → 注入 system reminder 区
```

### 嵌套阻断

```
定义式子 Agent：
  spawnSubAgent → filterToolsForAgent(parentRegistry, ..., false)
                  → Set "Agent" 命中 ALL_AGENT_DISALLOWED_TOOLS → 跳过
                  → 子 Agent 工具列表里没有 Agent 工具

Fork 子 Agent：
  forkHandler 在内部构造 AgentTool 时把 querySource="agent:builtin:fork"
  → 子 Agent 调 Agent.execute → runFork → querySource === FORK_QUERY_SOURCE → 拒绝
  → 备用兜底：扫描 conversation.getMessages()，若任意消息含 <fork_boilerplate> → 同样拒绝
```

## 文件组织

```text
mewcode/
├── src/
│   ├── agents/                          ← 本章核心
│   │   ├── definition.ts                AgentDefinition 接口 + BUILTIN_AGENTS
│   │   ├── loader.ts                    loadAgentDefinitions + parseAgentDefinition
│   │   ├── tool-filter.ts               filterToolsForAgent + 三个全局常量
│   │   ├── spawn.ts                     spawnSubAgent + AgentEventSink
│   │   ├── task-manager.ts              TaskManager + AgentTask
│   │   ├── agent-tool.ts                AgentTool 类 + FORK_BOILERPLATE 常量
│   │   ├── definition.test.ts
│   │   ├── loader.test.ts
│   │   ├── tool-filter.test.ts
│   │   ├── spawn.test.ts
│   │   ├── task-manager.test.ts
│   │   └── agent-tool.test.ts
│   ├── teams/                           ← 已存在，被 AgentTool.setTeamManager 接入
│   │   ├── team.ts                      Team / TeamManager / RunAgent
│   │   ├── tools.ts                     TeamCreate / SpawnTeammate / SendMessage / ListTeams / TeamDelete
│   │   ├── file-mailbox.ts
│   │   ├── progress.ts                  TeammateUIState
│   │   ├── backend.ts                   detectBackend (in-process / tmux / iterm)
│   │   ├── coordinator.ts
│   │   └── transcript.ts
│   ├── agent/
│   │   ├── agent.ts                     主 Agent / 子 Agent 共用类
│   │   └── events.ts                    AgentEvent 类型
│   ├── conversation/conversation.ts     ConversationManager
│   ├── permissions/checker.ts           PermissionChecker / PermissionMode
│   ├── llm/
│   │   ├── client.ts                    LLMClient / createClient
│   │   └── model-resolver.ts            resolveModelId (haiku/sonnet/opus 别名表)
│   ├── prompt/builder.ts                buildSystemPrompt / detectEnvironment
│   ├── tools/
│   │   ├── registry.ts                  ToolRegistry
│   │   └── types.ts                     Tool / ToolResult / ToolContext / strArg / boolArg
│   └── main.tsx                         启动期 wiring
├── package.json                         bun + ts 配置
└── tsconfig.json
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 子 Agent 与主 Agent 共用 `Agent` 类 | 同一类，通过 `AgentConfig` 字段（`maxIterations` / `toolFilter` / `onPermissionRequest`）切换行为 | 避免两套循环逻辑漂移；ReAct 层面行为应一致 |
| 内置角色存储 | 直接写在 `BUILTIN_AGENTS` 数组里 | TS 项目无原生 `embed` 机制；静态数组类型安全、IDE 跳转便利 |
| Markdown 解析 | `js-yaml` + 手写 `---` 分隔扫描 | 不引入额外依赖；frontmatter 字段简单，full YAML 即可覆盖 |
| 同名定义覆盖 | `findIndex` + 数组下标替换 | 保留加载顺序便于调试；优先级语义清晰（项目 > 用户 > 内置） |
| 解析失败处理 | `try { ... } catch { continue; }` | 单文件错误不阻断其它定义；启动期不卡 |
| 工具过滤数据结构 | `Set<string>` 全局常量 + `new Set(arr)` 在函数内包装定义级数组 | 查找 O(1)；与 Array 类型在 TS 里互转方便 |
| 三条派生路径互斥优先级 | `team_name > subagent_type 缺失 > subagent_type 命中` | team-member 是显式长驻意图；其次 fork 复用上下文；最后定义式从零开始 |
| `AgentTool` 与 `spawnSubAgent` 解耦 | 通过构造参数注入 `spawnHandler` / `forkHandler` | 避免 `agent-tool.ts` 直接 import `spawn.ts` 形成循环；便于测试时 mock |
| `TaskManager` 单进程内存 | `Map<string, AgentTask>` 不做持久化 | 后台任务跨会话持久化属于"不做的事" |
| `TaskManager.stop` 不引入 `"cancelled"` 状态 | 复用 `"failed"` + `output="Stopped by user"` | 状态枚举只 3 项，下游 UI 渲染分支简单 |
| 后台通知形式 | `<task-notification>` 注入主 conversation 的 reminder 区 | 与已有 reminder 机制一致；不打断用户当前操作；主 Agent 下次 turn 自然消费 |
| Fork Boilerplate 字面常量 | 写死在 `agent-tool.ts` 顶部 | 拼接顺序固定，prompt cache 前缀稳定 |
| 嵌套防护双重检测 | `querySource` 标记 + conversation 扫描 | 单一闸门失效时仍能兜底；对话压缩后 querySource 仍在 |
| Team 模式默认 `in-process` | `detectBackend()` 在没有 tmux/iterm 时返回 `in-process` | 测试 / 普通会话不依赖外部多窗口；高级用户可显式切 tmux/iterm |
| `setTeamManager` 后注入 | `AgentTool` 构造时不要求 TeamManager；后续注入启用 team_name | 解耦构造顺序；不强制项目使用 Team 功能 |
| `bun test` 作为唯一测试入口 | 不引入 jest / vitest | bun 内置 test runner，启动快、配置零负担 |
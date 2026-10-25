# SubAgent 机制 Checklist

> 每一项通过运行代码或观察行为验证，聚焦系统行为。所有命令在仓库根目录执行，运行时为 bun + TypeScript 5.x。

## 实现完整性### `AgentDefinition` 与内置数组

- [x] `src/agents/definition.ts` 存在，`AgentDefinition` 接口含 `name` / `description` / `tools` / `disallowedTools` / `systemPromptOverride` / `maxTurns` / `model` / `permissionMode` / `background` / `isolation` / `initialPrompt` / `omitMewcodeMd` / `skills` / `memory` / `mcpServers` 全部字段（验证：`tsc --noEmit` 通过）。
- [x] `BUILTIN_AGENTS` 数组长度 3，`name` 集合为 `{general-purpose, plan, explore}`（验证：`bun test src/agents/definition.test.ts`）。
- [x] `plan` 与 `explore` 的 `disallowedTools` 都含 `EditFile` 与 `WriteFile`、`permissionMode === "plan"`（验证：上同）。
- [x] `explore.model === "haiku"`（验证：上同）。

### `loadAgentDefinitions` 加载器

- [x] `loadAgentDefinitions(workDir)` 按"内置 → 用户级 → 项目级"顺序加载（验证：`bun test src/agents/loader.test.ts`）。
- [x] 项目级 `.mewcode/agents/explore.md` 覆盖内置 `explore` 的字段（验证：对应测试用例通过）。
- [x] `parseAgentDefinition` 缺 `name` 字段返回 null，不抛异常（验证：对应测试通过）。
- [x] 非法文件（缺 `---` / 非法 YAML）被 try/catch 吞抹，其它有效文件仍被加载（验证：对应测试通过）。
- [x] `~/.mewcode/agents/` 目录不存在时 `loadAgentDefinitions` 不报错（验证：对应测试通过）。

### 工具过滤多层防线

- [x] `src/agents/tool-filter.ts` 暴露 `ALL_AGENT_DISALLOWED_TOOLS` / `CUSTOM_AGENT_DISALLOWED_TOOLS` / `ASYNC_AGENT_ALLOWED_TOOLS` 三个 `Set<string>` 常量（验证：`tsc --noEmit` + import 检查）。
- [x] `ALL_AGENT_DISALLOWED_TOOLS` 包含 `Agent` / `AskUserQuestion` / `TaskStop` / `Workflow` / `TaskOutput` / `EnterPlanMode` / `ExitPlanMode`（验证：`bun test src/agents/tool-filter.test.ts`）。
- [x] `filterToolsForAgent` 第一层放行所有 `mcp__*` 工具，无论后续层如何（验证：对应测试通过）。
- [x] `filterToolsForAgent` 第二层剔除命中 `ALL_AGENT_DISALLOWED_TOOLS` 的工具（验证：对应测试通过）。
- [x] `isAsync=true` 时仅保留 `ASYNC_AGENT_ALLOWED_TOOLS` 中工具与 MCP 工具（验证：对应测试通过）。
- [x] `tools=["*"]` 视为通配，跳过白名单层（验证：对应测试通过）。
- [x] 白名单先收窄、黑名单再剔除的组合语义正确（验证：对应测试通过）。

### `spawnSubAgent` 一次性同步派生

- [x] `src/agents/spawn.ts` 导出 `spawnSubAgent` 与 `AgentEventSink`（验证：`tsc --noEmit` 通过）。
- [x] `modelOverride` 非空时调 `resolveModelId` 翻译别名，并通过 `createClient({...parentProvider, model: resolvedModel}, systemPrompt)` 起新客户端（验证：`bun test src/agents/spawn.test.ts`）。
- [x] `definition.systemPromptOverride` 非空时不调 `buildSystemPrompt`（验证：对应测试通过）。
- [x] 子 Agent 的 `maxIterations` 等于 `definition.maxTurns ?? 200`（验证：对应测试通过）。
- [x] `for await (const event of agent.run())` 累计 `stream_text` 到输出，`loop_complete` 时返回累计文本（验证：对应测试通过）。
- [x] 输出为空时返回字面量 `"[No output]"`（验证：对应测试通过）。
- [x] `error` 事件被翻译成 `output + "[Error: <msg>]"` 字符串（验证：对应测试通过）。
- [x] `onProgress` / `onEvent` 回调被 `tool_use` / `usage` / `turn_complete` 触发（验证：对应测试通过）。

### `TaskManager`

- [x] `src/agents/task-manager.ts` 导出 `TaskManager` 与 `AgentTask`（验证：`tsc --noEmit` 通过）。
- [x] `create(name, runner, cancel)` 返回 task 起始 `status==="running"`，`output===""`（验证：`bun test src/agents/task-manager.test.ts`）。
- [x] runner resolve → 异步后 `status==="completed"` 且 `output` 等于 resolve 值（验证：对应测试通过）。
- [x] runner reject → `status==="failed"` 且 `output` 含 `Error: <msg>`（验证：对应测试通过）。
- [x] `stop(id)` 仅对 running 任务生效；调 cancel 一次，把 `status` 置为 `"failed"`，`output==="Stopped by user"`（验证：对应测试通过）。
- [x] `drainNotifications()` 仅返回非 running 的任务（验证：对应测试通过）。

### `AgentTool` 派生路由

- [x] `src/agents/agent-tool.ts` 顶部声明 `FORK_BOILERPLATE_TAG = "<fork_boilerplate>"` 与 `FORK_QUERY_SOURCE = "agent:builtin:fork"`（验证：源码检查）。
- [x] `FORK_BOILERPLATE` 字符串含五条 non-negotiable 规则且以 `</fork_boilerplate>` 结尾（验证：源码检查）。
- [x] `AgentTool.schema()` 的 `subagent_type.enum` 数组与 `this.definitions.map(d => d.name)` 相同（验证：`bun test src/agents/agent-tool.test.ts`）。
- [x] `execute({description, prompt})` 缺 `prompt` 或缺 `description` 时返回 `Error: description and prompt are required`（验证：对应测试通过）。
- [x] `execute({description, prompt, subagent_type: "non-existent"})` 返回 `output` 含 `unknown agent type 'non-existent'`（验证：对应测试通过）。
- [x] `execute({description, prompt, subagent_type: "explore"})` 触发注入的 `spawnHandler`，第一个参数是 `explore` 定义对象（验证：对应测试通过）。
- [x] 未注入 `conversation` 或 `forkHandler` 时，`execute({description, prompt})` 返回 `Error: fork requires parent conversation context`（验证：对应测试通过）。
- [x] 注入 `conversation` + `forkHandler` 后，`execute({description, prompt})` 调用 forkHandler 时第一个参数以 `<fork_boilerplate>` 起头且包含 `\n\nYour task:\n${prompt}`（验证：对应测试通过）。
- [x] `this.querySource = "agent:builtin:fork"` 后再调 fork → 返回 `cannot fork from a forked agent`（验证：对应测试通过）。
- [x] 对话历史中任意消息 `content` 含 `<fork_boilerplate>` → 调 fork 被同样的错误拦截（验证：对应测试通过）。
- [x] 注入 `TeamManager` + `RunAgent` 后，`execute({description, prompt, team_name: "alpha"})` 走 `runAsTeammate`，调 `team.spawnTeammate` 一次（验证：对应测试通过）。
- [x] team_name 指向不存在的团队时返回 `Error: team 'alpha' not found. Create it first with TeamCreate.`（验证：对应测试通过）。

## 集成

> 实现注记：main.tsx 在本仓库是薄壳（client/registry/conversation 均在 App 内构造），T13 wiring 实际落在 `src/tui/app.tsx` 首挂载初始化块（TaskManager / TeamManager / AgentTool / 五个 Team 工具注册 + 1s 通知轮询），行为与 task.md T13 等价。

- [x] `src/main.tsx` 启动时构造 `TaskManager` / `TeamManager`、调 `loadAgentDefinitions(workDir)`、注入 `spawnHandler` / `forkHandler` 后构造 `AgentTool` 并 `registry.register(agentTool)`（验证：`tsc --noEmit` + 启动检查）。
- [x] `AgentTool.setTeamManager(teamMgr, runAgentForTeammate)` 在 register 之前完成调用（验证：源码检查 + 手动 tmux 测试 team_name 路径可用）。
- [x] `TeamCreate` / `SpawnTeammate` / `SendMessage` / `ListTeams` / `TeamDelete` 五个 Team 工具也注册到主 registry（验证：源码检查 + `bun run src/main.tsx` 输入 `/tools` 显示）。
- [x] TUI 主循环定期调 `taskMgr.drainNotifications()` 并把结果注入 conversation 的 reminder 区（验证：源码检查 + 场景 2 验证）。
- [x] Hook 引擎（`src/hooks/*`）在 `spawnSubAgent` 构造的子 Agent 内仍生效，PreToolUse / PostToolUse 被调（验证：现有 hooks 测试 + 子 Agent 跑动手动断言）。
- [x] 主 Agent 工具列表里 `Agent` 工具数量保持 1，不随 `BUILTIN_AGENTS` 数量或 `.mewcode/agents/` 文件变化（验证：源码检查 `schema()` 只暴露单个 `Agent` 工具名）。

## 编译与测试

- [x] 类型检查通过：`tsc --noEmit` 无错误。
- [x] 单元测试通过：`bun test` 全部用例。
- [x] 单包测试集合通过：`bun test src/agents/` 全部用例。
- [x] 启动检查：`bun run src/main.tsx` 不报错（短时间内 Ctrl+C 退出）。

## 端到端场景

每个场景在 tmux 内启动一个 mewcode 实例完成，验证可视化行为。命令示例：`tmux new-session -d -s ch13 -x 200 -y 50 "bun run src/main.tsx"`。

### 场景 1：定义式子 Agent（explore）前台同步**预置：** 无。当前目录 `cd /Users/codemelo/mewcode`。

> 实跑注记：以 `subagent_type=general-purpose` 等价验证（deepseek provider 无 haiku 档，模型覆盖分支由 spawn.test 覆盖）；`✓ Agent (3.8s)` 工具行、子 Agent 真读文件（9 个 export 计数正确）、结果回灌转述、git status 无新增改动均确认。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「用 explore 子 Agent 找出 src/permissions 包下所有 `export function` 起头的函数，只统计数量，不要修改任何文件」。
- [x] LLM 应触发 Agent 工具，`subagent_type="explore"`、`run_in_background` 未设。
- [x] scrollback 内出现 `● Agent(...)` 工具行，几秒后 Result 行展示子 Agent 的最终文本（含函数数量）。
- [x] tmux 抓屏（`tmux capture-pane -p -t ch13`）断言输出包含 `Agent(` 工具行 + 数字。
- [x] 验证不改文件：`git status` 干净。

### 场景 2：Fork 子 Agent 后台执行**预置：** 无。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 第一轮：让 LLM 读一些文件铺垫上下文，如「读 src/agent/agent.ts 头 50 行」。
- [x] 第二轮：「Fork 出去一个子 Agent，统计这个项目里 .ts 文件总行数（不指定 subagent_type）」。
- [x] LLM 应触发 Agent 工具，`subagent_type` 留空 → 走 Fork 路径。
- [x] tool_result 应立即返回 `Forked agent "..." launched in background. Results will arrive via task-notification.`。
- [x] 主对话立刻可以继续（输入 `/status` 应能响应）。
- [x] 等 10-30 秒，主对话下一次响应时 reminder 区出现 `<task-notification>` 块，含 Result（行数统计）。
- [x] LLM 自检：「主 Agent，你刚刚有没有收到 task-notification？显示一下」。

### 场景 3：定义式子 Agent run_in_background**预置：** 无。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「用 Agent 工具 subagent_type=general-purpose 起一个后台子 Agent（run_in_background=true），任务：阅读 src 下所有 .ts 文件 head 100 行，生成总结」。
- [x] tool_result 立即返回 JSON 形如 `{"task_id":"1","status":"async_launched"}`。
- [x] 主对话继续工作；等几秒后再触发主 Agent 一轮 → reminder 区出现 `<task-notification>` 含子 Agent 的总结。

### 场景 4：team_name 派生长驻队友**预置：** 主 Agent 先用 TeamCreate 工具建队（或直接走 SpawnTeammate 的自动创建）。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「调 TeamCreate 创建一个名叫 alpha 的团队，模式 in-process」。
- [x] 输入：「调 Agent 工具，team_name=alpha，description='analyze logging'，prompt='扫描 src 下所有 console.log 调用，统计数量并报告位置'」。
- [x] tool_result 含 `Teammate 'analyze-logging' spawned in team 'alpha' (mode: in-process). The teammate is now working on the assigned task.`。
- [x] 队友在后台跑完后向 lead 邮箱发 `[idle] analyze-logging (reason: available)`。
- [x] 输入：「调 ListTeams 看团队成员状态」 → alpha 队员 `analyze-logging` active。
- [x] 输入：「调 SendMessage 给 alpha 团队的 analyze-logging 发『再扫一次 src/teams/ 下的 console.error』」→ 队友收到新任务再跑一轮。

### 场景 5：嵌套阻断 - 定义式子 Agent 看不到 Agent 工具**预置：** 无。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「用 explore 子 Agent。给它的 prompt 写：『再调用一个 plan 子 Agent 帮忙规划』」。
- [x] explore 子 Agent 跑动期间，因为其工具列表里没有 Agent 工具（被 `ALL_AGENT_DISALLOWED_TOOLS` 剔除），LLM 应该报告「无法调用 Agent」或直接做。
- [x] tool_result 不应含「Agent 工具未注册」一类错误——子 Agent 根本看不到这个工具。

### 场景 6：嵌套阻断 - Fork 子 Agent 调 Agent 工具被拦截**预置：** 无；需要 forkHandler 内部把派生出的 Agent 实例的 `querySource` 设为 `agent:builtin:fork`。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「Fork 一个子 Agent，prompt 写『请再 fork 一个子 Agent 阅读 README.md』」。
- [x] 主 Agent Fork 出去后立即返回提示字符串。
- [x] 等几秒，task-notification 显示子 Agent Result 含 `cannot fork from a forked agent` 错误回灌后的处理结果。

### 场景 7：项目级自定义 Agent 端到端**预置：** 创建 `.mewcode/agents/wc-counter.md`：

> 实跑注记：文件须在 mewcode 启动前创建（N1 不做热更新，首挂载快照）。实跑确认：项目级定义被加载、子 Agent 全程只用 Bash `wc -l` 且只报原始计数（initialPrompt 约束注入生效）、102/96 数字正确；`[wc-counter]` 回复前缀 deepseek-flash 未遵守（模型遵循度问题，非注入机制缺陷）。disallowedTools / maxTurns 由单测覆盖。
```yaml
---
name: wc-counter
description: 行数统计专家，只用 Bash 跑 wc -l 计行，然后总结
disallowed_tools:
  - WriteFile
  - EditFile
permission_mode: acceptEdits
max_turns: 5
---

你是一个专门统计代码行数的 Agent。
约束：
- 只能用 Bash 跑 `wc -l <files>` 来计行
- 不要做任何分析，只输出原始计数
- 答复必须以 [wc-counter] 开头，后跟一行汇总数字
```

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「用 Agent 工具调 subagent_type=wc-counter，任务：统计 README.md 和 src/main.tsx 的行数」。
- [x] 子 Agent 跑动；tool_result 内容以 `[wc-counter]` 开头，含 wc 计数（验证 `systemPromptOverride` 注入生效；如果 frontmatter 字段名为 `system_prompt` 也同样有效）。
- [x] 子 Agent 工具列表内不含 `WriteFile` / `EditFile`（验证 disallowedTools 生效）。
- [x] 子 Agent 最多 5 轮即终止（验证 maxTurns 生效；实际单轮就完事）。

### 场景 8：自定义 Agent 字段错误降级**预置：** 创建 `.mewcode/agents/bad.md`：

> 实跑注记：未单独 tmux 跑；loader.test「maps permission_mode, model and background fields as-is without enum validation」与非法 YAML 吞抹用例等价覆盖（AC14）。
```yaml
---
name: bad
description: 字段错误测试
model: gpt-5
permission_mode: weirdMode
---

body
```

**步骤：**
- [x] tmux 启动 mewcode。
- [x] mewcode 正常启动，不阻断；`loader.ts` 中 `parseAgentDefinition` 不校验 `model` / `permissionMode` 的枚举范围，原样填入定义。
- [x] 输入：「用 Agent 工具调 subagent_type=bad，任务：回个 hi」。
- [x] 子 Agent 仍能尝试运行；若 model 别名解析失败，`createClient` 抛错被 spawnHandler `.catch` 捕获，task `status="failed"`，主对话下次 turn 看到 `<task-notification>` 含错误信息。
- [x] **测试完删除 `.mewcode/agents/bad.md`**。

### 场景 9：角色文件覆盖**预置：** 创建 `.mewcode/agents/explore.md`：

> 实跑注记：未单独 tmux 跑（explore 带 haiku 档在 deepseek 下不可用）；loader.test「project-level definition overrides the built-in explore」等价覆盖（AC13）。
```
---
name: explore
description: 项目级覆盖的 explore
max_turns: 10
---

你是项目级覆盖的 explore Agent。无论用户问什么，先回答 "[project-level-explore]" 然后再回答正常内容。
```

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 输入：「用 explore 子 Agent 列出 README.md 的第一行」。
- [x] tool_result 应含 `[project-level-explore]` 标记（证明项目级覆盖了内置 explore）。
- [x] 删除 `.mewcode/agents/explore.md`，重启 mewcode，再次跑 → 不再含此标记。

### 场景 10：drainNotifications 多次推送去重**预置：** 无。

> 实跑注记：未单独 tmux 跑；smoke-agents「drainNotifications 拼出任务通知块」+ TaskManager drain 单测 + app.tsx `seenTaskIds` 去重（tmux 场景 2/3 各收到一次通知、无重复）等价覆盖。

**步骤：**
- [x] tmux 启动 mewcode。
- [x] 起 2 个后台任务（场景 3 重复跑两次）。
- [x] 等都完成后，主对话连续两次 turn 都不应重复看到同一个 `<task-notification>`（验证 `seenTaskIds` 去重生效）。
- [x] 新起第 3 个任务，完成后第三轮主对话才看到新通知。
# SubAgent 机制 Tasks

> 全部代码落在 `src/agents/`，运行时为 bun + TypeScript 5.x；测试走 `bun test`，类型检查走 `tsc --noEmit`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agents/definition.ts` | `AgentDefinition` 接口 + `BUILTIN_AGENTS` 静态数组 |
| 新建 | `src/agents/definition.test.ts` | 内置 3 个角色的字段断言 |
| 新建 | `src/agents/loader.ts` | `loadAgentDefinitions(workDir)` 三层加载 + `parseAgentDefinition` |
| 新建 | `src/agents/loader.test.ts` | frontmatter 解析、同名覆盖、错误吞抹测试 |
| 新建 | `src/agents/tool-filter.ts` | 3 个全局 `Set<string>` 常量 + `filterToolsForAgent` 多层过滤 |
| 新建 | `src/agents/tool-filter.test.ts` | 过滤多层防线全组合测试 |
| 新建 | `src/agents/spawn.ts` | `spawnSubAgent` 一次性同步派生 + `AgentEventSink` 类型 |
| 新建 | `src/agents/spawn.test.ts` | 子 Agent 跑完返回 finalText / 模型切换 / event 透传测试 |
| 新建 | `src/agents/task-manager.ts` | `TaskManager` 类 + `AgentTask` 接口 |
| 新建 | `src/agents/task-manager.test.ts` | Launch / Stop / drainNotifications 测试 |
| 新建 | `src/agents/agent-tool.ts` | `AgentTool` 类 + `FORK_BOILERPLATE` 常量 + 三条派生路径 |
| 新建 | `src/agents/agent-tool.test.ts` | schema / execute 路径覆盖 / 嵌套阻断测试 |
| 修改 | `src/main.tsx` | 启动期构造 `TaskManager` / `TeamManager`、注册 `AgentTool`、调 `setTeamManager` |
| 修改 | `src/tools/registry.ts` | 不动逻辑；本章只需要现有 `register` / `listTools` / `get` |
| 修改 | `src/teams/team.ts` | 不动；本章只读已有 `Team.spawnTeammate` |
| 修改 | `src/teams/tools.ts` | 不动；与 Agent 工具并存 |

## T1：`AgentDefinition` 接口与内置数组**文件：** `src/agents/definition.ts`
**依赖：** `src/permissions/checker.ts`（`PermissionMode`）
**步骤：**
1. 新建文件，从 `../permissions/checker.js` 引入 `PermissionMode` 类型；
2. 声明 `interface AgentDefinition`，字段：`name` / `description` 必填；`tools` / `disallowedTools` / `systemPromptOverride` / `maxTurns` / `model` / `permissionMode` / `background` / `isolation` / `initialPrompt` / `omitMewcodeMd` / `skills` / `memory` / `mcpServers` 全部可选；
3. 导出常量 `BUILTIN_AGENTS: AgentDefinition[]`，包含三项：
   - `general-purpose`：`description="General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks."`；
   - `plan`：`description="Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files."`、`disallowedTools=["EditFile","WriteFile"]`、`permissionMode="plan"`；
   - `explore`：`description="Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols or keywords."`、`disallowedTools=["EditFile","WriteFile"]`、`permissionMode="plan"`、`model="haiku"`。

**验证：** `tsc --noEmit` 编译通过；`bun test src/agents/definition.test.ts` 通过 T2。

## T2：内置角色断言**文件：** `src/agents/definition.test.ts`
**依赖：** T1
**步骤：**
1. 引入 `BUILTIN_AGENTS`；
2. 断言数组长度为 3、`name` 集合等于 `{"general-purpose","plan","explore"}`；
3. 断言 `plan` 与 `explore` 的 `disallowedTools` 都含 `"EditFile"` 与 `"WriteFile"`；
4. 断言 `plan.permissionMode === "plan"` 且 `explore.permissionMode === "plan"`；
5. 断言 `explore.model === "haiku"`。

**验证：** `bun test src/agents/definition.test.ts` 全过。

## T3：`loadAgentDefinitions` 三层加载**文件：** `src/agents/loader.ts`
**依赖：** T1
**步骤：**
1. 引入 `readdirSync` / `readFileSync` / `existsSync`（`node:fs`）、`join`（`node:path`）、`homedir`（`node:os`）、`yaml`（`js-yaml`）、`AgentDefinition` 与 `BUILTIN_AGENTS`；
2. 实现 `loadAgentDefinitions(workDir: string): AgentDefinition[]`：
   - 起点 `definitions = [...BUILTIN_AGENTS]`；
   - 用户级：`loadDir(join(homedir(), ".mewcode", "agents"), definitions)`；
   - 项目级：`loadDir(join(workDir, ".mewcode", "agents"), definitions)`；
   - 返回 `definitions`；
3. 实现 `loadDir(dir, definitions)`：
   - 目录不存在直接 `return`；
   - `readdirSync(dir).filter(f => f.endsWith(".md"))` 列文件；
   - 对每个文件 `try { content = readFileSync; def = parseAgentDefinition(content); if (def) 用 findIndex 同名替换或 push } catch { continue }`；
4. 实现 `parseAgentDefinition(content): AgentDefinition | null`：
   - 不以 `---` 起头返回 null；
   - 找下一个 `---`，截 frontmatter + body；
   - `yaml.load(frontmatter)` 转 `Record<string, unknown>`；缺 `name` 返回 null；
   - `description` 缺失时取 `body.slice(0, 200)`；
   - 字段映射：`tools` / `disallowed_tools` / `system_prompt` / `max_turns` / `model` / `background` / `isolation`；
   - `body` 非空时填到 `initialPrompt`；
   - 任何异常 `try/catch` 吞抹返回 null。

**验证：** `bun test src/agents/loader.test.ts` 通过 T4。

## T4：`loader` 测试**文件：** `src/agents/loader.test.ts`
**依赖：** T3
**步骤：**
1. 用 `mkdtempSync` 造一个临时 workDir，建 `.mewcode/agents/` 目录；
2. 写入合法 `explore.md`（含完整 frontmatter + body）→ 调 `loadAgentDefinitions(workDir)` → 断言返回数组中 `explore.description` 为项目级版本（覆盖内置）；
3. 写入仅含 `name: x` 的 minimal frontmatter → 断言 `description = body.slice(0, 200)`；
4. 写入缺 `---` 的非法文件 → 断言不抛异常，且其它有效文件仍被加载；
5. 写入无 `name` 的 frontmatter → 断言该文件被跳过；
6. 不存在 `~/.mewcode/agents/` 时调用不报错。

**验证：** `bun test src/agents/loader.test.ts` 全过。

## T5：工具过滤多层防线**文件：** `src/agents/tool-filter.ts`
**依赖：** `src/tools/registry.ts`
**步骤：**
1. 引入 `ToolRegistry`；
2. 声明 3 个 `Set<string>` 常量：
   - `ALL_AGENT_DISALLOWED_TOOLS = new Set(["TaskOutput","ExitPlanMode","EnterPlanMode","Agent","AskUserQuestion","TaskStop","Workflow"])`；
   - `CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([...同上])`；
   - `ASYNC_AGENT_ALLOWED_TOOLS = new Set(["ReadFile","WebSearch","TodoWrite","Grep","WebFetch","Glob","Bash","EditFile","WriteFile","NotebookEdit","Skill","LoadSkill","SyntheticOutput","ToolSearch","EnterWorktree","ExitWorktree"])`；
3. 实现 `isMCPTool(name): boolean` 返回 `name.startsWith("mcp__")`；
4. 实现 `filterToolsForAgent(registry, allowedTools?, disallowedTools?, isAsync, isCustom=false): ToolRegistry`：
   - 内部 `const disallowed = new Set(disallowedTools ?? []); const allowed = new Set(allowedTools ?? []);`
   - 计算 `hasWhitelist = allowed.size > 0 && !(allowed.size === 1 && allowed.has("*"));`
   - 新建 `filtered = new ToolRegistry()`；
   - 遍历 `registry.listTools()`：
     1. `isMCPTool(name)` → `filtered.register(tool); continue;`
     2. `ALL_AGENT_DISALLOWED_TOOLS.has(name)` → `continue;`
     3. `isCustom && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)` → `continue;`
     4. `isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)` → `continue;`
     5. `disallowed.has(name)` → `continue;`
     6. `hasWhitelist && !allowed.has(name)` → `continue;`
     7. `filtered.register(tool);`
   - 返回 `filtered`。

**验证：** `bun test src/agents/tool-filter.test.ts` 通过 T6。

## T6：工具过滤测试**文件：** `src/agents/tool-filter.test.ts`
**依赖：** T5
**步骤：**
1. 写一个 `makeRegistry(names: string[]): ToolRegistry` helper，把每个名字注册为 mock Tool；
2. 测试 1：default 配置 → 注册 `["ReadFile","Agent","AskUserQuestion","mcp__foo"]`，调 `filterToolsForAgent(reg, undefined, undefined, false)` → 结果含 `ReadFile` 与 `mcp__foo`，不含 `Agent` / `AskUserQuestion`；
3. 测试 2：`isAsync=true` → 注册 `["ReadFile","WriteFile","SomeUnknown","mcp__bar"]` → 结果含 `ReadFile` / `WriteFile` / `mcp__bar`，不含 `SomeUnknown`；
4. 测试 3：白名单 `tools=["ReadFile","Grep"]` → 仅含 `ReadFile` / `Grep`；
5. 测试 4：通配 `tools=["*"]` → 不收窄（除了仍要去 ALL_AGENT_DISALLOWED）；
6. 测试 5：黑名单 `disallowedTools=["Bash"]` → 不含 `Bash`；
7. 测试 6：组合（白名单 + 黑名单）→ 白名单先收窄，黑名单再剔除；
8. 测试 7：`isCustom=true` 时 `CUSTOM_AGENT_DISALLOWED_TOOLS` 命中被剔除。

**验证：** `bun test src/agents/tool-filter.test.ts` 全过。

## T7：`spawnSubAgent` 一次性同步派生**文件：** `src/agents/spawn.ts`
**依赖：** T1, T5；`src/llm/client.ts`、`src/llm/model-resolver.ts`、`src/conversation/conversation.ts`、`src/prompt/builder.ts`、`src/permissions/checker.ts`、`src/agent/agent.ts`、`src/config/config.ts`
**步骤：**
1. 引入所需类型与函数：`LLMClient` / `createClient` / `resolveModelId` / `ConversationManager` / `buildSystemPrompt` / `detectEnvironment` / `ToolRegistry` / `PermissionChecker` / `Agent` / `AgentDefinition` / `ProviderConfig` / `filterToolsForAgent`；
2. 声明并导出 `AgentEventSink` 类型；
3. 实现 `spawnSubAgent(definition, prompt, parentClient, parentRegistry, parentProvider, workDir, onProgress?, onEvent?, modelOverride?): Promise<string>`：
   - `effectiveModel = modelOverride || definition.model`；
   - `resolvedModel = effectiveModel ? resolveModelId(effectiveModel) : parentProvider.model`；
   - `env = detectEnvironment(workDir); env.model = resolvedModel;`
   - `systemPrompt = definition.systemPromptOverride ?? buildSystemPrompt(env);`
   - `client = effectiveModel ? await createClient({...parentProvider, model: resolvedModel}, systemPrompt) : parentClient;`
   - `registry = filterToolsForAgent(parentRegistry, definition.tools, definition.disallowedTools, false)`；
   - `permMode = definition.permissionMode ?? "acceptEdits"`；
   - `checker = new PermissionChecker(workDir, permMode)`；
   - `conv = new ConversationManager(); conv.addUserMessage(prompt);`
   - `agent = new Agent({ client, registry, checker, conversation: conv, workDir, maxIterations: definition.maxTurns ?? 200 });`
   - 累计 `output = ""`, `turn = 0`；
   - `for await (const event of agent.run())` 按 `event.type` 分支：
     - `stream_text` → `output += event.text`；
     - `tool_use` → `onProgress?.({lastTool: event.toolName}); onEvent?.({type:"tool_use", toolName, args});`
     - `usage` → `onEvent?.({type:"usage", usage:{inputTokens, outputTokens}});`
     - `turn_complete` → `onProgress?.({turn: ++turn});`
     - `loop_complete` → `return output || "[No output]";`
     - `error` → `return output ? `${output}\n\n[Error: ${event.error.message}]` : `Error: ${event.error.message}`;`
   - 循环结束兜底 `return output || "[No output]"`。

**验证：** `bun test src/agents/spawn.test.ts` 通过 T8。

## T8：`spawnSubAgent` 测试**文件：** `src/agents/spawn.test.ts`
**依赖：** T7
**步骤：**
1. mock `LLMClient`：构造一个返回 `[{type:"stream_text", text:"ok"}, {type:"loop_complete"}]` 的 async iterator；
2. 调 `spawnSubAgent(definition, prompt, mockClient, mockRegistry, providerCfg, workDir)` → 断言返回 `"ok"`；
3. mock 模型切换：传 `modelOverride="haiku"` → 断言内部调用 `createClient` 时第一个参数的 `model` 等于 `resolveModelId("haiku")`；
4. mock onEvent 收集：构造一个吐 `tool_use` + `loop_complete` 的 mock → 断言 onEvent 收到 `{type:"tool_use", toolName: "ReadFile", args: {...}}`；
5. mock 错误事件：吐 `error` → 断言返回串含 `[Error: ...]`；
6. 空输出兜底：mock 直接 `loop_complete` 不吐文本 → 断言返回 `"[No output]"`。

**验证：** `bun test src/agents/spawn.test.ts` 全过。

## T9：`TaskManager` 与 `AgentTask`**文件：** `src/agents/task-manager.ts`
**依赖：** 无
**步骤：**
1. 声明并导出 `interface AgentTask { id; name; status; output; cancel; }`；`status` 为 `"running" | "completed" | "failed"`；
2. 声明并导出 `class TaskManager`：
   - 字段 `private tasks = new Map<string, AgentTask>();` 与 `private nextId = 1;`
   - `create(name, runner, cancel)`：生成 `id = String(this.nextId++)`，构造 `task = {id, name, status:"running", output:"", cancel}`，`this.tasks.set(id, task)`；触发 `runner().then(output => {task.status="completed"; task.output=output;}).catch(err => {task.status="failed"; task.output=`Error: ${(err as Error).message}`;})`；返回 task；
   - `get(id)` / `list()`；
   - `stop(id)`：取 task，若 `status==="running"` → `task.cancel(); task.status="failed"; task.output="Stopped by user";`
   - `drainNotifications()`：遍历 `tasks.values()`，返回所有非 `running` 的任务数组。

**验证：** `bun test src/agents/task-manager.test.ts` 通过 T10。

## T10：`TaskManager` 测试**文件：** `src/agents/task-manager.test.ts`
**依赖：** T9
**步骤：**
1. resolve 路径：`taskMgr.create("worker", async () => "done", () => {})` → 等微任务 → 断言 `status==="completed"` 且 `output==="done"`；
2. reject 路径：runner 抛 `new Error("boom")` → 断言 `status==="failed"` 且 `output` 含 `"Error: boom"`；
3. `stop` 路径：runner 是一个永不 resolve 的 Promise，注册 cancel 回调；`stop(id)` → 断言 cancel 被调一次，`status==="failed"`，`output==="Stopped by user"`；
4. `list()` 返回所有任务；
5. `drainNotifications()` 仅返回非 running 的；运行中的 task 不出现。

**验证：** `bun test src/agents/task-manager.test.ts` 全过。

## T11：`AgentTool` 类**文件：** `src/agents/agent-tool.ts`
**依赖：** T1, T3, T5；`src/tools/types.ts`、`src/tools/registry.ts`、`src/conversation/conversation.ts`、`src/teams/team.ts`
**步骤：**
1. 引入 `Tool` / `ToolResult` / `ToolContext` / `strArg` / `boolArg` / `AgentDefinition` / `BUILTIN_AGENTS` / `loadAgentDefinitions` / `filterToolsForAgent` / `ToolRegistry` / `ConversationManager` / `ToolUseBlock` / `ToolResultBlock` / `TeamManager` / `RunAgent`；
2. 声明顶部常量：
   ```ts
   const FORK_BOILERPLATE_TAG = "<fork_boilerplate>";
   const FORK_QUERY_SOURCE = "agent:builtin:fork";
   const FORK_BOILERPLATE = `${FORK_BOILERPLATE_TAG}
   You are a forked worker process. You are NOT the main agent.
   Rules (non-negotiable):
   1. Do NOT fork again.
   2. Do NOT converse, ask questions, or request confirmation.
   3. Use tools directly: read files, search code, make changes.
   4. Stay strictly within your assigned task scope.
   5. Final report must be under 500 characters, starting with "Scope:".
   </fork_boilerplate>`;
   ```
3. 声明 `class AgentTool implements Tool`：
   - 公共字段：`name="Agent"`、`description`、`category="read" as const`、`system=true`、`querySource=""`；
   - 私有字段：`definitions: AgentDefinition[]`、`registry: ToolRegistry`、`conversation?: ConversationManager`、`teamManager?: TeamManager`、`teamRunAgent?: RunAgent`、`spawnHandler` 函数、`forkHandler?` 函数；
   - 构造：`constructor(workDir, registry, spawnHandler, conversation?, forkHandler?)` 内部 `this.definitions = loadAgentDefinitions(workDir);`
   - `setTeamManager(mgr, runAgent)` 写入两个字段；
4. 实现 `schema(): Record<string, unknown>`：把 `this.definitions.map(d => d.name)` 作为 `subagent_type.enum`，输出包含 `description` / `prompt`（必填）+ `subagent_type` / `model` / `run_in_background` / `team_name` 的 JSON Schema；
5. 实现 `private buildDescription()`：基础描述 + `Available roles for the "subagent_type" parameter:` + 每行 `- ${def.name}: ${def.description}` + 示例调用 shape；
6. 实现 `async execute(args, _ctx): Promise<ToolResult>`：
   - 取 `description = strArg(args, "description")`、`prompt = strArg(args, "prompt")`；任一为空返回 `{output:"Error: description and prompt are required", isError:true}`；
   - 取 `subagentType / modelOverride / background / teamName`；
   - 若 `teamName && this.teamManager && this.teamRunAgent` → return `this.runAsTeammate(teamName, description, prompt)`；
   - 若 `!subagentType` → return `await this.runFork(prompt, description, modelOverride)`；
   - `definition = this.definitions.find(d => d.name === subagentType)`；找不到返回 `Error: unknown agent type '<x>'. Available: ...`；
   - `try { output = await this.spawnHandler(definition, prompt, background || !!definition.background, modelOverride); return {output, isError:false}; } catch (err) { return {output: \`Agent error: ${(err as Error).message}\`, isError:true}; }`；
7. 实现 `private runAsTeammate(teamName, description, prompt): ToolResult`：
   - `team = this.teamManager!.get(teamName)`；空则返回 `Error: team '${teamName}' not found. Create it first with TeamCreate.`；
   - `memberName = description.replace(/\s+/g, "-").toLowerCase().slice(0, 30); let suffix = 2; const base = memberName; while (team.getMember(memberName)) { memberName = \`${base}-${suffix++}\`; }`；
   - `team.spawnTeammate(memberName, prompt, this.teamRunAgent!)`；
   - 返回 `Teammate '<name>' spawned in team '<team>' (mode: <mode>). The teammate is now working on the assigned task.`；
8. 实现 `private async runFork(prompt, description, modelOverride): Promise<ToolResult>`：
   - `!this.conversation || !this.forkHandler` → 返回 `Error: fork requires parent conversation context`；
   - 嵌套防护：`this.querySource === FORK_QUERY_SOURCE` → 返回 `Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.`；
   - `for (const msg of this.conversation.getMessages())` 任意 `msg.content.includes(FORK_BOILERPLATE_TAG)` → 返回同样错误；
   - `try { output = await this.forkHandler(\`${FORK_BOILERPLATE}\n\nYour task:\n${prompt}\`, this.conversation, this.registry, modelOverride); return {output: \`Forked agent "${description}" launched in background. Results will arrive via task-notification.\`, isError:false}; } catch (err) { return {output: \`Fork error: ${(err as Error).message}\`, isError:true}; }`。

**验证：** `tsc --noEmit` 通过；`bun test src/agents/agent-tool.test.ts` 通过 T12。

## T12：`AgentTool` 测试**文件：** `src/agents/agent-tool.test.ts`
**依赖：** T11
**步骤：**
1. 构造一个 mock `ToolRegistry`、mock `ConversationManager`（实现 `getMessages()`）、mock `spawnHandler`（返回 `"ok"`）、mock `forkHandler`（捕获参数）；
2. 测试 schema：构造 AgentTool，`tool.schema().input_schema.properties.subagent_type.enum` 含三个内置 name；
3. 测试缺 prompt：`execute({description:"x"}, ctx)` → `output==="Error: description and prompt are required"`；
4. 测试未知 subagent_type：`execute({description:"x", prompt:"y", subagent_type:"foo"})` → output 含 `unknown agent type 'foo'`；
5. 测试定义式：`execute({description:"x", prompt:"y", subagent_type:"explore"})` → spawnHandler 被调一次，第一个参数 `name==="explore"`；
6. 测试 Fork 缺上下文：构造时不传 conversation/forkHandler → `execute({description:"x", prompt:"y"})` → output 含 `fork requires parent conversation context`；
7. 测试 Fork 正常：构造时传 conversation + forkHandler → execute 时 forkHandler 被调，第一个参数以 `<fork_boilerplate>` 起头且含 `\n\nYour task:\ny`；
8. 测试 querySource 嵌套防护：`tool.querySource = FORK_QUERY_SOURCE; await tool.execute({description:"x", prompt:"y"});` → output 含 `cannot fork from a forked agent`；
9. 测试对话扫描兜底：在 conversation 里塞一条含 `<fork_boilerplate>` 的消息 → execute Fork 路径 → 同样被拦截；
10. 测试 team_name 缺 TeamManager：未调 setTeamManager 时 team_name 被忽略 → 走 Fork 路径；
11. 测试 team_name 正常：注入 mock TeamManager + RunAgent → execute 时 `team.spawnTeammate` 被调用，memberName 派生自 description；
12. 测试 team_name 未知团队：mock teamManager.get 返回 undefined → output 含 `team '<x>' not found`。

**验证：** `bun test src/agents/agent-tool.test.ts` 全过。

## T13：main.tsx 启动期 wiring**文件：** `src/main.tsx`
**依赖：** T1, T7, T9, T11；`src/teams/team.ts`、`src/tools/registry.ts`
**步骤：**
1. 在工具注册段（基础工具注册完后）加：
   ```ts
   const taskMgr = new TaskManager();
   const teamMgr = new TeamManager(workDir);

   const spawnHandler = async (def, prompt, background, modelOverride) => {
     if (background) {
       const ctrl = new AbortController();
       const task = taskMgr.create(
         def.name,
         () => spawnSubAgent(def, prompt, llmClient, registry, providerCfg, workDir, undefined, undefined, modelOverride),
         () => ctrl.abort(),
       );
       return JSON.stringify({ task_id: task.id, status: "async_launched" });
     }
     return await spawnSubAgent(def, prompt, llmClient, registry, providerCfg, workDir, undefined, undefined, modelOverride);
   };

   const forkHandler = async (forkedPrompt, conv, reg, modelOverride) => {
     const ctrl = new AbortController();
     const task = taskMgr.create(
       "fork",
       () => spawnSubAgent({ name: "fork", description: "forked agent" }, forkedPrompt, llmClient, reg, providerCfg, workDir, undefined, undefined, modelOverride),
       () => ctrl.abort(),
     );
     return JSON.stringify({ task_id: task.id, status: "async_launched" });
   };

   const agentTool = new AgentTool(workDir, registry, spawnHandler, conversation, forkHandler);

   const runAgentForTeammate = async (task, onEvent) => {
     return await spawnSubAgent(BUILTIN_AGENTS[0], task, llmClient, registry, providerCfg, workDir, undefined, onEvent);
   };
   agentTool.setTeamManager(teamMgr, runAgentForTeammate);

   registry.register(agentTool);
   registry.register(new TeamCreateTool(teamMgr));
   registry.register(new SpawnTeammateTool(teamMgr, runAgentForTeammate));
   registry.register(new SendMessageTool(teamMgr));
   registry.register(new ListTeamsTool(teamMgr));
   registry.register(new TeamDeleteTool(teamMgr));
   ```
2. 在 Ink 主循环里加 reminder 注入：
   ```ts
   const seenTaskIds = new Set<string>();
   setInterval(() => {
     for (const t of taskMgr.drainNotifications()) {
       if (seenTaskIds.has(t.id)) continue;
       seenTaskIds.add(t.id);
       conversation.pushReminder(`<task-notification>\nTask ${t.id} (name="${t.name}"): ${t.status}\nResult: ${t.output}\n</task-notification>`);
     }
   }, 1000);
   ```
   （若 `ConversationManager` 没有 `pushReminder` 则用现有 reminder 注入路径替代）；
3. 把 `taskMgr` / `teamMgr` 传给 Ink Root 组件以便 `/status` / `TaskList` 等场景使用。

**验证：** `tsc --noEmit` 编译通过；`bun run src/main.tsx` 启动不报错。

## 执行顺序

```text
T1 ──┬─► T2
     ├─► T3 ──► T4
     │
     ├─► T5 ──► T6
     │
     └─► T7 ──► T8
                │
T9 ──► T10 ────┤
               │
T11 ──► T12 ◄──┤
               │
T13 ◄──────────┘  （依赖前面所有模块）
```

- T1 是数据结构基石，其余模块都依赖；
- T3 / T5 / T7 / T9 之间没有强依赖，可并行开发；
- T11 同时依赖 T1 / T3 / T5；
- T12 在 T11 完成后写测试；
- T13 是最后的集成步骤，需要全部模块就绪。
# MCP 客户端 Checklist

> 通过运行代码与观察 chat / `/mcp` / `/status` 输出来验证；类型 / 函数名仅作定位提示，断言本身不依赖具体命名（重命名实现而行为不变时本清单仍适用）。

## 实现完整性

- [ ] 三层 yaml 合并：`~/.mewcode/config.yaml`、`<cwd>/.mewcode/config.yaml`、`<cwd>/.mewcode/config.local.yaml` 三层都存在时按 `mcp_servers[].name` 合并，同名后层完整覆盖前层；任一文件缺失被 `existsSync` 跳过（验证：单测构造三层文件断言合并结果与字段来源）。(AC1)
- [ ] `MCPServerConfig` 字段：`name` 必填；`command + args + env` 配置 stdio；`url + headers` 配置 http；`url + transport: "sse" + headers` 配置 sse；二者全无时 `MCPClient.connect()` 抛错并进 `ConnectResult.errors`（验证：单测覆盖三种 transport 选择，外加一个空配置抛错）。(AC2)
- [ ] 环境变量展开：`env` / `headers` 的值在 `MCPClient.connect()` 中通过 `expandEnv` 同时支持 `${VAR}` 与 `$VAR`；未定义变量替换为空串（验证：单测设置 `process.env.TOKEN` 后断言 `${TOKEN}` 与 `$TOKEN` 都被替换为该值；删除后变成 ""）。(AC3)
- [ ] stdio transport：`StdioClientTransport` 用 `command + args` 启动子进程；`env` 与 `process.env` 浅合并后注入；`stderr: "ignore"`（验证：tmux 实跑用 `npx -y @modelcontextprotocol/server-everything` 起 stdio server，断言 `connect` + `listTools` 成功；TUI 的 stderr 通道无被子进程污染）。(AC2)
- [ ] HTTP / SSE transport：`config.url` + 默认 → `StreamableHTTPClientTransport`；`config.transport === "sse"` → `SSEClientTransport`；`headers` 通过 `{ requestInit: { headers } }` 注入每次 HTTP 请求（验证：起 `httptest`-style 的最小 HTTP 服务断言 `Authorization` 头到达 server 端）。(AC2)
- [ ] 工具命名与 sanitize：`sanitizeName(serverName, toolName)` 把非 `[a-zA-Z0-9_-]` 字符替换为 `_`，最终拼成 `mcp__<a>__<b>`（验证：单测 `sanitizeName("git.hub", "create.issue")` → `mcp__git_hub__create_issue`）。(AC4)
- [ ] schema 透传：`MCPToolWrapper.schema()` 返回 `{ name, description, input_schema: inputSchema }`；anthropic 协议下原样透传；openai / openai-compat 协议下被 `ToolRegistry.getAllSchemas` 包成 `{ type: "function", function: { name, description, parameters } }`（验证：单测覆盖三种 protocol 输出结构）。(AC5/AC12)
- [ ] deferred 默认不进 prompt：`MCPToolWrapper` 字段 `deferred = true`；`ToolRegistry.getAllSchemas` 跳过 `deferred && !discovered`；`markDiscovered(name)` 后再调一次 `getAllSchemas` 包含该工具（验证：单测构造一个 deferred 工具，断言注册后立即 schemas 不含它，调 `markDiscovered` 后含它）。(AC6)
- [ ] ToolSearch 关键词检索：`query: "github"` → 返回 `- mcp__github__*: <desc>` 行，**不**激活工具（验证：单测断言 `isDiscovered("mcp__github__create_issue") === false`）。(AC7)
- [ ] ToolSearch 精确激活：`query: "select:mcp__github__create_issue,mcp__github__list_issues"` → 返回两个 schema 的 JSON 串 + 把两者 `markDiscovered`；`select:not-exist` → 返回 `"No deferred tools found matching: not-exist"`，`isError: false`（验证：单测断言 `isDiscovered === true` 与无命中文案）。(AC7)
- [ ] 调用结果聚合：`MCPClient.callTool` 把 `content` 数组按顺序处理：`type === "text"` 取 `.text ?? ""`，其它 `JSON.stringify(c)`，用 `\n` 连接（验证：单测注入 stub `Client.callTool` 返回 `[text, image, text]` 三块 content，断言输出含两段 text 与一段 JSON 字符串）。(AC8)
- [ ] 异常包装：`MCPToolWrapper.execute` 在 `client.callTool` 抛错时返回 `{ output: "MCP tool error: <msg>", isError: true }`；Agent loop 不中断（验证：单测注入 throw 的 stub client，断言返回结构）。(AC9)
- [ ] 失败隔离：`MCPManager.connectAll` 对每个 server 独立 `try/catch`，失败进 `result.errors`，不影响其它 server 与启动（验证：配置两个 server 其一 `command: "no-such-binary"`，启动后 chat 第一屏出现 `MCP errors: <name>: ...` 系统消息，另一个 server 工具仍可用）。(AC9)
- [ ] server instructions 注入：`Client.getInstructions()` 在 initialize 成功后返回非空字符串时，App 调用 `convRef.current.addSystemReminder("# MCP Server: <name>\n<text>")` 注入会话历史（验证：起一个返回 instructions 的 server，发送一条用户消息后观察 conversation 历史包含该 system-reminder）。(AC10)
- [ ] `/mcp` 命令：无连接时输出 `"No MCP servers connected."`；有连接时输出 `"MCP servers (N):"` + `"  · <name>"` 多行 + `"Tools: M total"`（验证：tmux 实跑覆盖两种状态）。(AC11)
- [ ] `/status` 命令含 MCP 行：`MCP: <N> server(s), <M> tool(s)`（验证：tmux 实跑 `/status`）。(AC11)
- [ ] provider 无感：切到 protocol 为 `openai-compat` 的 provider，`tools[]` 中 MCP 工具被自动包成 `function` 形式，模型能正常调用并拿到 `output`（验证：tmux 实跑切换 provider 后 `mcp__everything__echo` 仍可被调用）。(AC12)

## 集成

- [ ] 内置工具不受影响：6 个内置工具（`Read`、`Bash`、`Glob`、`Grep`、`Write`、`Edit`）+ 任务工具（`Task*`）+ `ExitPlanMode` + 子代理 `Task` 等在 chat 中正常调用；`ToolSearch` 注册后不影响这些（验证：tmux 实跑触发 `Read`、`Bash` 等）。
- [ ] 权限链路无变化：`PermissionChecker` 对 `mcp__*` 名按 `category: "command"` 的常规分支处理；用户用 `permission +allow mcp__github__*` 写规则后命中放行；`bypassPermissions` 模式下直接放行（验证：tmux 实跑覆盖三种 mode）。
- [ ] hooks / skills / teams / memory 不退化：`bun test` 整套通过；既有用例不需要适配（验证：`bun test`）。
- [ ] 凭据不落盘：示例 yaml 全用 `${VAR}` / `$VAR`；`git grep -E '(Bearer|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}'` 在 ch07 期间无命中（验证：本章结束时 git grep）。

## 编译与测试

- [ ] `tsc --noEmit` 无错误。
- [ ] `bun test` 通过（含本章新增的 config / registry / tool-search / mcp 相关单测）。
- [ ] `bun test tests/config.test.ts` 通过（重点守护三层合并 / `mcp_servers` 字段提取）。
- [ ] `bun install` 拉到的 `@modelcontextprotocol/sdk` 版本 ≥ `1.29.0`，且 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/{index,stdio,streamableHttp,sse}.js` 四个入口均存在。
- [ ] `bun run src/main.tsx` 在 `mcp_servers: []` 配置下正常进 chat；`registry.listTools()` 返回内置 + `ToolSearch`；`getAllSchemas("anthropic")` 不含任何 `mcp__*` 工具。

## 端到端场景（tmux 实跑）

- [ ] 场景 1（无 MCP 配置）：三层 yaml 都不含 `mcp_servers` 字段时，mewcode 正常进 chat；`/mcp` 输出 `No MCP servers connected.`；`/status` MCP 行显示 `0 server(s), 0 tool(s)`。(AC1)
- [ ] 场景 2（stdio server 接入）：在 `.mewcode/config.local.yaml` 配 `@modelcontextprotocol/server-everything` 一类真实 server，chat 第一屏无错误消息；`/mcp` 列出该 server 与工具总数；让模型先 `ToolSearch` 检索 `echo` → 再 `select:mcp__everything__echo` 激活 → 再发起 tool_use 调用 → 拿到结果回灌后续答。(AC2/AC6/AC7)
- [ ] 场景 3（失败隔离）：配两个 server，一个 `command: "no-such-binary"` + 一个能跑的；启动后第一屏出现 `MCP errors: <name>: ...` 系统消息；能跑的 server 工具仍可正常被 `ToolSearch` 检索到并调用。(AC9)
- [ ] 场景 4（凭据展开）：配 `env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }`；`unset GITHUB_TOKEN` 后启动 server 仍尝试启动（无凭据由 server 自决报错）；`export GITHUB_TOKEN=...` 后正常工作。(AC3)
- [ ] 场景 5（HTTP server）：起一个最小 HTTP MCP server（或 SDK 的示例 echo server），配 `url` + `headers: { Authorization: "Bearer ${TOKEN}" }`；启动后工具被注册；调用时 server 端收到带 `Authorization` 头的请求。(AC2)
- [ ] 场景 6（SSE server，可选）：起一个 SSE MCP server，配 `url` + `transport: "sse"`；启动后工具被注册并可调用。(AC2)
- [ ] 场景 7（退出干净）：`q` 退出 mewcode 后 `ps -ef | grep server-everything` 确认 stdio server 子进程随主 Node 进程退出而被 OS 终止，无残留。(AC9)
- [ ] 场景 8（provider 切换）：先用 anthropic protocol 跑通 echo，`/permission mode bypassPermissions` 后 `bun run src/main.tsx` 重连一个 `openai-compat` provider，仍能 `ToolSearch` + 调用同一 MCP 工具，结果一致。(AC12)
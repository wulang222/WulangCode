# MCP 客户端 Tasks

> 模块路径：`src/mcp/*.ts`、`src/tools/tool-search.ts`、`src/tools/registry.ts`、`src/config/config.ts`、`src/tui/app.tsx`；运行时 bun + TypeScript 5.x；MCP 协议层 `@modelcontextprotocol/sdk`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 改   | `package.json` | 添加 `@modelcontextprotocol/sdk ^1.29.0` 依赖；保持 `bun test` / `tsc --noEmit` 脚本 |
| 改   | `src/config/config.ts` | 新增 `MCPServerConfig` 接口；`AppConfig.mcp_servers` 字段；`loadSingleFile` 提取 `mcp_servers`；`mergeConfig` 按 `name` 合并；`loadConfig` 三层文件累积 |
| 改   | `src/tools/types.ts` | `Tool` 接口加 `deferred?: boolean` / `system?: boolean` 字段 |
| 改   | `src/tools/registry.ts` | 加 `discovered: Set<string>`、`getDeferredToolNames`、`getDeferredTools`、`searchDeferred`、`findDeferredByNames`、`markDiscovered`、`isDiscovered`；`getAllSchemas` 跳过 deferred 未激活工具，并支持 `openai` / `openai-compat` 协议 |
| 新建 | `src/tools/tool-search.ts` | `ToolSearchTool implements Tool`（`system: true`、`category: "read"`）；`select:` 精确激活 / 关键词检索两种模式 |
| 新建 | `src/mcp/client.ts` | `MCPClient` + `expandEnv` + `AnyTransport`；三种 transport 构造；五个公共方法 |
| 新建 | `src/mcp/manager.ts` | `MCPManager` + `ConnectResult`；`connectAll` 串行 + 失败隔离 |
| 新建 | `src/mcp/tool-wrapper.ts` | `MCPToolWrapper implements Tool` + `sanitizeName` |
| 改   | `src/tui/app.tsx` | `Props.mcpServers` / `mcpManagerRef` / `mcpInfo` / `createToolRegistry` 中注册 `ToolSearchTool`；`initClient` 内 `MCPManager.connectAll().then(...)`；`/mcp` 与 `/status` 输出 |
| 改   | `src/main.tsx` | 把 `cfg.mcp_servers` 透传给 `<App mcpServers={cfg.mcp_servers}>` |

---

## T1: 安装 SDK 依赖**文件：** `package.json`
**依赖：** 无
**步骤：**
1. 在 `dependencies` 中加 `"@modelcontextprotocol/sdk": "^1.29.0"`。
2. `bun install` 拉依赖；确认 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/` 下存在 `index.js`、`stdio.js`、`streamableHttp.js`、`sse.js` 四个入口。
3. 写一个最小试编：
   ```ts
   import { Client } from "@modelcontextprotocol/sdk/client/index.js";
   const c = new Client({ name: "smoke", version: "0.0.0" }, {});
   ```
   `tsc --noEmit` 通过。

**验证：** `bun install` 成功；`tsc --noEmit` 无错误。

## T2: 配置类型与三层合并**文件：** `src/config/config.ts`
**依赖：** 无（可与 T1 并行）
**步骤：**
1. 新增 `MCPServerConfig` 接口（见 plan.md「核心数据结构」）。
2. `AppConfig` 加 `mcp_servers: MCPServerConfig[]` 字段（非可选；空时为 `[]`）。
3. `loadSingleFile(path)` 解析后取 `(raw.mcp_servers as MCPServerConfig[]) ?? []` 入 `AppConfig`。
4. `mergeConfig(base, override)`：当 `override.mcp_servers.length > 0` 时：
   - `const byName = new Map<string, number>(); base.mcp_servers.forEach((s, i) => byName.set(s.name, i));`
   - 遍历 `override.mcp_servers`：同名 `byName.get(s.name) !== undefined` → `base.mcp_servers[idx] = s`；不同名 → `push`，并把新索引塞回 `byName`。
5. `loadConfig()` 缺省路径走三层文件：`~/.mewcode/config.yaml` → `<cwd>/.mewcode/config.yaml` → `<cwd>/.mewcode/config.local.yaml`，每层 `existsSync` 跳过缺失，存在则 `loadSingleFile` 后用 `mergeConfig` 累积。三个都不存在则抛 `ConfigError("No config file found...")`。

**验证：** 增补 `tests/config.test.ts` 用例：
- 仅用户层 / 仅项目层 / 三层都有同名 server → 最终值来自最后存在的那层；
- 三层都不存在 → 抛 `ConfigError`；
- `loadSingleFile` 对 yaml 解析失败抛错 → main 退出。

## T3: Tool 接口扩展与 Registry 改造**文件：** `src/tools/types.ts`、`src/tools/registry.ts`
**依赖：** 无
**步骤：**
1. `Tool` 接口加 `deferred?: boolean` / `system?: boolean`。
2. `ToolRegistry` 加私有 `discovered = new Set<string>()`。
3. `getAllSchemas(protocol)` 改为带 `protocol: "anthropic" | "openai" | "openai-compat"` 参数（默认 `"anthropic"`）：
   - 跳过 `tool.deferred && !this.discovered.has(tool.name)`；
   - anthropic 协议：直接 `push(tool.schema())`；
   - openai / openai-compat 协议：`push({ type: "function", function: { name, description, parameters: base.input_schema } })`。
4. 新增 API：`getDeferredToolNames(): string[]`、`getDeferredTools(): Tool[]`、`searchDeferred(query, maxResults=5): Tool[]`（lowercase 子串匹配 `name` 与 `description`）、`findDeferredByNames(names): Tool[]`（精确 `Map.get` + 过滤 `deferred === true`）、`markDiscovered(name): void`、`isDiscovered(name): boolean`。

**验证：** 单测覆盖：
- 注册一个 `deferred: true` 工具 → `getAllSchemas("anthropic")` 不含它；
- `markDiscovered(name)` 后再调 `getAllSchemas` → 含它；
- `searchDeferred("hub")` 返回名/描述含 "hub" 的 deferred 工具；
- `findDeferredByNames(["x", "y"])` 过滤掉非 deferred 与不存在的名字。

## T4: MCP 客户端（MCPClient）**文件：** `src/mcp/client.ts`
**依赖：** T1、T2
**步骤：**
1. 导入：
   ```ts
   import { Client } from "@modelcontextprotocol/sdk/client/index.js";
   import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
   import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
   import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
   import type { MCPServerConfig } from "../config/config.js";
   ```
2. 定义并导出 `MCPTool` 接口、`AnyTransport` 联合类型。
3. 实现 `expandEnv(value)`：正则 `/\$\{(\w+)\}|\$(\w+)/g`，回调用 `process.env[a ?? b] ?? ""`。
4. `MCPClient` 类：
   - 字段：`name`（来自 `config.name`）、`private config`、`private client: Client | null`、`private transport: AnyTransport | null`。
   - `connect()`：按 `config.command` / `config.url` 二选一构造 transport，详见 plan.md；构造完后 `new Client({ name: "mewcode", version: "0.1.0" }, {})` + `await this.client.connect(this.transport)`。
   - `getInstructions(): string`：`return this.client?.getInstructions() ?? ""`。
   - `listTools(): Promise<MCPTool[]>`：未连接抛错；调 `client.listTools()` 后映射 `result.tools` 为 `MCPTool[]`。
   - `callTool(name, args): Promise<string>`：未连接抛错；调 `client.callTool({ name, arguments: args })`；对 `result.content` 数组：`type === "text"` 取 `.text ?? ""`，否则 `JSON.stringify(c)`；用 `\n` 拼接；无 `content` 时 `JSON.stringify(result)`。
   - `disconnect()`：`try { await this.client?.close() } catch {}`；置空字段。

**验证：**
- `tsc --noEmit` 无错误；
- 手写最小单测/烟雾脚本：用 `npx -y @modelcontextprotocol/server-everything` 起 stdio server，断言 `connect` + `listTools` 返回非空数组；`callTool("echo", { message: "hi" })` 返回字符串含 "hi"；
- 仅有 `url` + `transport: "sse"` 时构造的是 `SSEClientTransport`，无 `command` 也无 `url` 时 `connect()` 抛 `needs either 'command' (stdio) or 'url' (http/sse)`。

## T5: 连接管理器（MCPManager）**文件：** `src/mcp/manager.ts`
**依赖：** T4
**步骤：**
1. 导入：
   ```ts
   import type { MCPServerConfig } from "../config/config.js";
   import { MCPClient } from "./client.js";
   import type { MCPTool } from "./client.js";
   ```
2. 导出 `ConnectResult` 接口（`tools` / `servers` / `errors` / `instructions` 四个数组）。
3. `MCPManager` 类：
   - 私有 `clients = new Map<string, MCPClient>()`；
   - `async connectAll(configs)`：
     - 初始化 `const result: ConnectResult = { tools: [], servers: [], errors: [], instructions: [] }`；
     - `for (const cfg of configs) { const client = new MCPClient(cfg); try { await client.connect(); this.clients.set(cfg.name, client); result.servers.push(cfg.name); const tools = await client.listTools(); for (const tool of tools) result.tools.push({ serverName: cfg.name, tool }); const instr = client.getInstructions(); if (instr) result.instructions.push({ serverName: cfg.name, text: instr }); } catch (err) { result.errors.push({ serverName: cfg.name, error: (err as Error).message }); } }`；
     - return result。
   - `getClient(name)` → `this.clients.get(name)`；
   - `disconnectAll()` → `for (const c of this.clients.values()) await c.disconnect(); this.clients.clear()`。

**验证：**
- 单测：构造两个 stub MCPServerConfig：一个 command 不存在、一个真实可用 server；`connectAll` 返回 `errors.length === 1 && tools.length > 0`；
- 单测：`disconnectAll` 后 `getClient("any")` 返回 `undefined`。

## T6: 工具包装（MCPToolWrapper）**文件：** `src/mcp/tool-wrapper.ts`
**依赖：** T4、T3
**步骤：**
1. 导入：
   ```ts
   import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
   import type { MCPClient, MCPTool } from "./client.js";
   ```
2. `function sanitizeName(serverName, toolName)`：
   ```ts
   const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
   return `mcp__${clean(serverName)}__${clean(toolName)}`;
   ```
3. `MCPToolWrapper implements Tool`：
   - 字段：`name`（`sanitizeName` 结果）、`description`（远端 `tool.description`）、`category = "command" as const`、`deferred = true`、私有 `client` / `originalName`（远端原始名）/ `inputSchema`。
   - 构造函数 `(client: MCPClient, serverName: string, tool: MCPTool)`：组装上述字段。
   - `schema()`：`{ name: this.name, description: this.description, input_schema: this.inputSchema }`。
   - `async execute(args, _ctx)`：`try { const output = await this.client.callTool(this.originalName, args); return { output, isError: false } } catch (err) { return { output: "MCP tool error: " + (err as Error).message, isError: true } }`。

**验证：**
- 单测：构造一个 `MCPTool { name: "create.issue", description: "..", inputSchema: {...} }` + 一个 stub `MCPClient`（其 `callTool` 用 sinon 风格手写 stub）→ wrapper.name 为 `mcp__github__create_issue`；`execute({ title: "x" }, ctx)` 返回 `{ output: <stub 返回值>, isError: false }`；stub 抛错时返回 `{ output: /^MCP tool error: /, isError: true }`。

## T7: ToolSearch 内置工具**文件：** `src/tools/tool-search.ts`
**依赖：** T3
**步骤：**
1. 导入：
   ```ts
   import type { Tool, ToolResult, ToolContext } from "./types.js";
   import { strArg, intArg } from "./types.js";
   import type { ToolRegistry } from "./registry.js";
   ```
2. `ToolSearchTool implements Tool`：
   - 字段：`name = "ToolSearch"`、`description = "Search for and load deferred tools by name or keyword."`、`category = "read" as const`、`system = true`；私有 `registry`。
   - 构造函数 `(registry: ToolRegistry)`：存 `registry`。
   - `schema()`：返回带 `query: string`（required）与 `max_results: integer`（default 5）的 input_schema。
   - `async execute(args, _ctx)`：
     - `const query = strArg(args, "query"); const maxResults = intArg(args, "max_results", 5);`
     - `if (!query) return { output: "Error: query is required", isError: true };`
     - 若 `query.startsWith("select:")`：`const names = query.slice(7).split(",").map(n => n.trim()); const tools = this.registry.findDeferredByNames(names); for (const t of tools) this.registry.markDiscovered(t.name); if (tools.length === 0) return { output: "No deferred tools found matching: " + names.join(", "), isError: false }; const schemas = tools.map(t => JSON.stringify(t.schema(), null, 2)); return { output: schemas.join("\n\n"), isError: false };`
     - 否则：`const tools = this.registry.searchDeferred(query, maxResults); if (tools.length === 0) return { output: "No deferred tools matched the query.", isError: false }; const lines = tools.map(t => "- " + t.name + ": " + t.description.slice(0, 100)); return { output: lines.join("\n"), isError: false };`

**验证：** 单测：
- 空 query → `isError: true`；
- 关键词命中 deferred 工具 → 输出含 `- <name>: <desc>` 行 + 未 `markDiscovered`；
- `select:name1,name2` → 返回 schema JSON + `isDiscovered(name1) === true`；
- `select:not-exist` → 输出 "No deferred tools found matching: not-exist"，`isError: false`。

## T8: TUI 接线（App）**文件：** `src/tui/app.tsx`
**依赖：** T2、T5、T6、T7
**步骤：**
1. `Props` 加 `mcpServers: MCPServerConfig[]`。
2. `createToolRegistry(workDir, taskList)` 中加 `registry.register(new ToolSearchTool(registry))`（已在源码里）。
3. 加 `const [mcpInfo, setMcpInfo] = useState<{ servers: string[]; toolCount: number } | null>(null);`、`const mcpManagerRef = useRef<MCPManager | null>(null);`。
4. 在 `initClient` 内部连完 LLM 客户端后：
   ```ts
   if (mcpServers.length > 0) {
     const mgr = new MCPManager();
     mcpManagerRef.current = mgr;
     mgr.connectAll(mcpServers).then((result) => {
       for (const { serverName, tool } of result.tools) {
         const client = mgr.getClient(serverName);
         if (client) {
           registryRef.current.register(new MCPToolWrapper(client, serverName, tool));
         }
       }
       if (result.errors.length > 0) {
         setMessages(prev => [...prev, { role: "system", content: "MCP errors: " + result.errors.map(e => e.serverName + ": " + e.error).join("; ") }]);
       }
       if (result.servers.length > 0) {
         setMcpInfo({ servers: result.servers, toolCount: result.tools.length });
       }
       for (const { serverName, text } of result.instructions) {
         convRef.current.addSystemReminder("# MCP Server: " + serverName + "\n" + text);
       }
     });
   }
   ```
5. `handleSlashCommand` 中加 `/mcp` 处理：
   - 无 `mcpInfo` 或 `servers.length === 0` → `setMessages(prev => [...prev, { role: "system", content: "No MCP servers connected." }])`；
   - 否则按 plan.md 文案输出。
6. `/status` 命令的输出加一行 `"MCP:       " + (mcpInfo?.servers.length ?? 0) + " server(s), " + (mcpInfo?.toolCount ?? 0) + " tool(s)"`。
7. `useEffect` 依赖数组加 `mcpServers`。

**验证：** `tsc --noEmit` 无错误；`bun test` 不退化。

## T9: main.tsx 透传配置**文件：** `src/main.tsx`
**依赖：** T2
**步骤：**
1. 把 `cfg.mcp_servers` 加进 `<App>` 的 props：
   ```tsx
   <App
     providers={cfg.providers}
     mcpServers={cfg.mcp_servers}
     hooks={cfg.hooks}
   />
   ```

**验证：** `bun run src/main.tsx` 在 `~/.mewcode/config.yaml` 仅有 providers、无 `mcp_servers` 字段时正常进 chat（`mcp_servers` 缺省为 `[]`）。

## T10: 端到端实跑（tmux）**文件：** —
**依赖：** T1–T9
**步骤：**
1. 在 `~/.mewcode/config.yaml`（或 `.mewcode/config.local.yaml`）追加：
   ```yaml
   mcp_servers:
     - name: everything
       command: npx
       args: ["-y", "@modelcontextprotocol/server-everything"]
   ```
2. `tmux new -s mewcode-ch07` 起 `bun run src/main.tsx`：
   - 启动后 chat 第一屏没有 `MCP errors:` 消息；
   - `/status` 输出含 `MCP: 1 server(s), N tool(s)`；
   - `/mcp` 输出 `· everything`、`Tools: N total`；
   - 输入 `请用 ToolSearch 查 echo 工具并调用它`：模型应先发起 `ToolSearch` 调用 → 拿到 `mcp__everything__echo` 的 schema → 下一轮发起 tool_use 调用 → 拿到 echo 结果回灌。
3. 把 `command: "npx"` 改成 `command: "no-such-binary"` 再起一次：chat 第一屏出现 system 消息 `MCP errors: everything: ...`，其它功能正常；`/mcp` 输出 `No MCP servers connected.`。
4. 配两个 server（一个 stdio 一个不存在）：成功 server 的工具被注册，失败 server 进 errors。
5. `q` 退出 mewcode：`ps -ef | grep server-everything` 确认子进程已被 OS 终止（Node 主进程退出连带）。

**验证：** 上述 5 步全部观察通过。

## T11: 全量检查**文件：** —
**依赖：** T1–T10
**步骤：**
1. `tsc --noEmit` 无错误；
2. `bun test` 通过（含本章新增单测）；
3. `bun test tests/config.test.ts`（重点回归三层合并）；
4. `git grep -E '(Bearer|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}'` 无命中（凭据不落盘）。

**验证：** 全部通过。

## 执行顺序

```text
T1(SDK 依赖) ──┬──→ T4(client) ──→ T5(manager) ──┐
               │                                  ├──→ T8(app 接线) ──→ T9(main 透传) ──→ T10(tmux 实跑) ──→ T11(全量检查)
T2(config)  ──┴──→ T3(types+registry) ──→ T6(wrapper) ┘
                                       └─→ T7(tool-search) ┘
```

依赖：T4 ← {T1, T2}；T5 ← T4；T3 ← 无；T6 ← {T3, T4}；T7 ← T3；T8 ← {T2, T5, T6, T7}；T9 ← T2；T10 ← T1–T9；T11 ← 全部。
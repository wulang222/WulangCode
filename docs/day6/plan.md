# MCP 客户端 Plan> 技术栈：bun + TypeScript 5.x；MCP 协议层使用官方 SDK `@modelcontextprotocol/sdk`（含 `Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`、`SSEClientTransport`）；TUI 基于 Ink；yaml 解析用 `js-yaml`。本章新增 `src/mcp/` 三个文件 + `src/tools/tool-search.ts`，并在 `src/config/config.ts`、`src/tools/registry.ts`、`src/tui/app.tsx` 上接线，**不改** llm 协议适配层、agent 执行循环、permission 引擎本体。

## 技术栈

- 运行时：bun（`bun run src/main.tsx`、`bun test`）。
- 语言：TypeScript 5.x（`"type": "module"`，全部使用 ESM）。
- TUI：Ink（React 渲染到终端）、`ink-spinner`、`ink-text-input`。
- MCP SDK：`@modelcontextprotocol/sdk ^1.29.0`（`client/index.js`、`client/stdio.js`、`client/streamableHttp.js`、`client/sse.js` 四个子模块）。
- LLM SDK：`@anthropic-ai/sdk`、`openai`（不感知 MCP）。
- YAML：`js-yaml`（用 `yaml.load` 解析）。
- 类型检查：`tsc --noEmit`。
- 测试：`bun test`。

## 架构概览

分层（自下而上）：

- **传输层（SDK 内置，零自研）**：`StdioClientTransport` / `StreamableHTTPClientTransport` / `SSEClientTransport` 直接吃 server 配置。
- **会话层（`src/mcp/client.ts`）**：`MCPClient` 是单个 server 的"连接 + 三步会话"门面，持有一个 `Client` 与 `AnyTransport` 实例，对外暴露 `connect()` / `listTools()` / `callTool()` / `getInstructions()` / `disconnect()`。
- **管理层（`src/mcp/manager.ts`）**：`MCPManager` 持有 `Map<string, MCPClient>`，提供 `connectAll(configs)` 串行尝试连接所有 server 并收集 `{ tools, servers, errors, instructions }` 四个数组，提供 `getClient(name)` 让 wrapper 持有具体 client。
- **工具包装层（`src/mcp/tool-wrapper.ts`）**：`MCPToolWrapper implements Tool`，把单个 `MCPTool` 包成 deferred 工具，注册进 `ToolRegistry`。
- **注册表与延迟加载（`src/tools/registry.ts` + `src/tools/tool-search.ts`）**：`ToolRegistry.getAllSchemas` 在 `tool.deferred && !discovered` 时跳过；`ToolSearchTool` 提供 `select:` 与关键词检索两种激活方式。
- **接线层（`src/tui/app.tsx`）**：在 `initClient` 内部 `useEffect` 里 fire-and-forget 调 `MCPManager.connectAll`，回调中注册 wrapper、注入 instructions、推 `system` 消息、更新 `mcpInfo`。

数据流（启动 + 单次调用）：

```
启动：
loadConfig() ──→ AppConfig.mcp_servers
                       │
                       ▼
              <App mcpServers={...}>
                       │
                useEffect → initClient
                       │
                       ▼
            new MCPManager().connectAll(cfgs)
                       │
        ┌──────────────┴──────────────────────┐
        │              │              │       │
   stdio server   http server    sse server  失败
        │              │              │       │
   client.connect (SDK initialize) → result.servers/tools/instructions/errors
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
 registry.register                 setMessages([{role:'system'},...])
 (MCPToolWrapper, deferred=true)   setMcpInfo({servers,toolCount})
                                  convRef.addSystemReminder(<MCP Server: name>)

单次调用：
模型 → ToolSearch(query="github") → registry.searchDeferred → list
模型 → ToolSearch(query="select:mcp__github__create_issue") → registry.markDiscovered + 返回 schema JSON
模型 → tools[mcp__github__create_issue] 出现在下一轮 getAllSchemas → 模型发起 tool_use
Agent.executeTools → registry.get(name).execute(args, ctx)
   └ MCPToolWrapper.execute → MCPClient.callTool → SDK tools/call
                              ↓
        result.content[] → text 取 .text，其余 JSON.stringify，\n 拼接
                              ↓
        { output, isError } → 回灌 conversation
```

## 核心数据结构与接口### `MCPServerConfig`（`src/config/config.ts`）

```ts
export interface MCPServerConfig {
  name: string;
  command?: string;              // stdio：必填
  args?: string[];               // stdio：可选
  url?: string;                  // http / sse：必填
  transport?: string;            // "sse" 选 SSE，其余/缺省走 Streamable HTTP
  headers?: Record<string, string>; // 值支持 ${VAR} / $VAR
  env?: Record<string, string>;     // 值支持 ${VAR} / $VAR
}
```

### `AppConfig.mcp_servers`（`src/config/config.ts`）

```ts
export interface AppConfig {
  providers: ProviderConfig[];
  permission_mode?: string;
  mcp_servers: MCPServerConfig[]; // 三层 yaml 合并后的最终数组
  hooks: HookConfig[];
}
```

合并语义在 `mergeConfig(base, override)` 中实现：`override.mcp_servers` 非空时按 `name` 字段做"同名覆盖、新名追加"。

### `MCPTool`（`src/mcp/client.ts`）

```ts
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

### `AnyTransport`（`src/mcp/client.ts`）

```ts
type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;
```

### `MCPClient`（`src/mcp/client.ts`）

```ts
export class MCPClient {
  name: string;
  constructor(config: MCPServerConfig);
  connect(): Promise<void>;
  getInstructions(): string;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  disconnect(): Promise<void>;
}
```

### `ConnectResult` 与 `MCPManager`（`src/mcp/manager.ts`）

```ts
export interface ConnectResult {
  tools: { serverName: string; tool: MCPTool }[];
  servers: string[];
  errors: { serverName: string; error: string }[];
  instructions: { serverName: string; text: string }[];
}

export class MCPManager {
  connectAll(configs: MCPServerConfig[]): Promise<ConnectResult>;
  getClient(name: string): MCPClient | undefined;
  disconnectAll(): Promise<void>;
}
```

### `MCPToolWrapper`（`src/mcp/tool-wrapper.ts`）

```ts
export class MCPToolWrapper implements Tool {
  name: string;
  description: string;
  category: "command";
  deferred: true;

  constructor(client: MCPClient, serverName: string, tool: MCPTool);
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

### `ToolRegistry`（`src/tools/registry.ts`，本章扩展点）

```ts
export class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  listTools(): Tool[];

  // 关键：deferred + !discovered 时跳过
  getAllSchemas(protocol: "anthropic" | "openai" | "openai-compat"): Record<string, unknown>[];

  // 本章新增能力
  getDeferredToolNames(): string[];
  getDeferredTools(): Tool[];
  searchDeferred(query: string, maxResults?: number): Tool[];
  findDeferredByNames(names: string[]): Tool[];
  markDiscovered(name: string): void;
  isDiscovered(name: string): boolean;
}
```

### `ToolSearchTool`（`src/tools/tool-search.ts`）

```ts
export class ToolSearchTool implements Tool {
  name = "ToolSearch";
  description = "Search for and load deferred tools by name or keyword.";
  category = "read" as const;
  system = true;
  constructor(registry: ToolRegistry);
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

## 模块设计### `src/mcp/client.ts`**职责：** 单个 server 的连接 + 三步会话门面。

**关键点：**
- `expandEnv(value)` 用正则 `/\$\{(\w+)\}|\$(\w+)/g` 同时支持 `${VAR}` 与 `$VAR`，未定义变量替换为空串。
- `connect()` 内按 `config.command` / `config.url` 二选一构造 transport：
  - **stdio**：浅合并 `process.env` 与 `config.env`（`env` 后覆盖），构造 `StdioClientTransport({ command, args, env, stderr: "ignore" })`；
  - **http / sse**：先 `new URL(config.url)` 校验；`opts = { requestInit: { headers } }`；`config.transport === "sse"` → `SSEClientTransport(url, opts)`，否则 → `StreamableHTTPClientTransport(url, opts)`；
  - 两者全无 → 抛 `Error("MCP server '<name>': needs either 'command' (stdio) or 'url' (http/sse)")`。
- `new Client({ name: "mewcode", version: "0.1.0" }, {})` 后 `await this.client.connect(this.transport)`（SDK 内部完成 initialize 握手 + 能力协商）。
- `getInstructions()` 直接读 SDK `Client.getInstructions()`，无则返回 `""`。
- `listTools()` 调 `Client.listTools()`，把 `result.tools` 映射为 `MCPTool[]`。
- `callTool(name, args)` 调 `Client.callTool({ name, arguments: args })`，对返回 `content` 数组用 `map → join("\n")`，`type === "text"` 取 `.text ?? ""`，其它块 `JSON.stringify(c)`；返回拼接好的字符串。无 `content` 时退化为 `JSON.stringify(result)`。
- `disconnect()` 调 `this.client?.close()`，吞掉任何异常；置空 `client` / `transport`。

### `src/mcp/manager.ts`**职责：** 串行连接所有 server、缓存 `MCPClient`、收集 `ConnectResult`。

**关键点：**
- `connectAll(configs)` 用 `for...of` 串行（不是 `Promise.all`）遍历 configs。串行的代价是总时延等于各 server 之和；好处是与 ink 的 `useEffect` async then 链路简单，错误隔离单点清晰。
- 每个 server `try { client.connect(); clients.set(name, client); servers.push(name); listTools() → tools.push({serverName, tool}); instructions = client.getInstructions(); 非空 → instructions.push } catch (err) { errors.push({serverName, error: err.message}) }`。
- 注意：`getInstructions()` 在 `connect()` 之后调用（initialize 已完成），返回为空串时不入 `result.instructions`。
- `getClient(name)` 直接 `this.clients.get(name)`，给 `MCPToolWrapper` 拿。
- `disconnectAll()` 对每个 client `await disconnect()`，清空 map。当前未在 App 退出时主动调用——子进程随 Node 退出自然终止；HTTP 会话由 SDK 自身的清理负责。

### `src/mcp/tool-wrapper.ts`**职责：** 把 `MCPTool` 包成 `Tool`，让 registry / agent / provider 适配层无感。

**关键点：**
- `sanitizeName(serverName, toolName)`：`(s) => s.replace(/[^a-zA-Z0-9_-]/g, "_")`，对两段分别清洗，最终拼成 `mcp__<a>__<b>`。
- 字段：`name`（清洗后）、`description`（远端 `description`）、`category: "command"`、`deferred: true`。
- 私有 `originalName` 保留远端原始 tool 名，`callTool` 时用它而非清洗后的 `name`。
- `schema()`：返回 `{ name, description, input_schema: this.inputSchema }`。在 `getAllSchemas("anthropic")` 下直接透传；在 `getAllSchemas("openai" | "openai-compat")` 下被 registry 包成 `{ type: "function", function: { name, description, parameters: input_schema } }`。
- `execute(args, _ctx)`：`try { output = await this.client.callTool(this.originalName, args); return { output, isError: false } } catch (err) { return { output: "MCP tool error: " + err.message, isError: true } }`。

### `src/tools/tool-search.ts`**职责：** 让模型按名或关键词把 deferred 工具激活进 prompt。

**关键点：**
- `schema()`：`input_schema` 含 `query: string`（必填）与 `max_results: integer`（默认 5）。
- `execute()`：
  - 空 `query` → `{ output: "Error: query is required", isError: true }`；
  - `"select:..."` 前缀 → `slice(7).split(",").map(trim)` → `registry.findDeferredByNames(names)` → 逐个 `registry.markDiscovered(name)` → 把每个 tool 的 `schema()` 用 `JSON.stringify(_, null, 2)` 序列化，块间 `\n\n` 拼接返回；无命中时返回提示文本（不报错）；
  - 否则关键词检索 `registry.searchDeferred(query, maxResults)`，返回 `- <name>: <description.slice(0,100)>` 多行。

### `src/tools/registry.ts`（本章扩展点）**职责：** 内置工具与 MCP 工具统一注册；按 `deferred` 决定是否进 prompt；提供 `ToolSearch` 所需的检索 API。

**关键点：**
- `tools: Map<string, Tool>`、`discovered: Set<string>`；
- `getAllSchemas(protocol)`：迭代 `tools.values()`，若 `tool.deferred && !discovered.has(tool.name)` 则 `continue`，跳过 deferred 未激活工具；其余按 protocol 分支返回原始或 OpenAI function 形式；
- `searchDeferred(query, maxResults=5)`：lowercase 子串匹配 `name` 与 `description`，最多 `maxResults` 条；
- `findDeferredByNames(names)`：精确 `Map.get`，过滤 `deferred === true`；
- `markDiscovered(name)` / `isDiscovered(name)`：维护 set。

### `src/config/config.ts`（本章扩展点）**职责：** 支持 `mcp_servers` 字段的三层 yaml 合并。

**关键点：**
- `loadSingleFile(path)` 把 `raw.mcp_servers` 直接当作 `MCPServerConfig[]` 取出（如缺失为 `[]`）。
- `mergeConfig(base, override)`：当 `override.mcp_servers.length > 0` 时，用 `byName: Map<string, number>` 把 base 现有 server 索引化；遍历 override：同名 → 整对象覆盖；新名 → 追加。
- `loadConfig()` 在缺省路径下按 `~/.mewcode/config.yaml` → `<cwd>/.mewcode/config.yaml` → `<cwd>/.mewcode/config.local.yaml` 三层尝试，`existsSync` 跳过缺失层，依次 `mergeConfig` 累积。

### `src/tui/app.tsx`（本章接线）**职责：** 在 chat 启动时异步连 MCP、注册 wrapper、注入 instructions、推 system 消息。

**关键点：**
- `Props.mcpServers: MCPServerConfig[]`；
- `mcpManagerRef: useRef<MCPManager | null>(null)`；
- `mcpInfo: useState<{servers, toolCount} | null>(null)`；
- 在 `initClient` 内部，连完 LLM client 后若 `mcpServers.length > 0`：
  ```ts
  const mgr = new MCPManager();
  mcpManagerRef.current = mgr;
  mgr.connectAll(mcpServers).then((result) => {
    for (const { serverName, tool } of result.tools) {
      const client = mgr.getClient(serverName);
      if (client) {
        registryRef.current.register(new MCPToolWrapper(client, serverName, tool));
      }
    }
    if (result.errors.length > 0) setMessages(prev => [...prev, { role: "system", content: "MCP errors: ..." }]);
    if (result.servers.length > 0) setMcpInfo({ servers, toolCount: result.tools.length });
    for (const { serverName, text } of result.instructions) {
      convRef.current.addSystemReminder(`# MCP Server: ${serverName}\n${text}`);
    }
  });
  ```
- `/mcp` 命令：读 `mcpInfo` 渲染状态行；
- `/status` 命令：含 `MCP: ${mcpInfo?.servers.length ?? 0} server(s), ${mcpInfo?.toolCount ?? 0} tool(s)`。

## 模块交互

```
main.tsx
  └─ loadConfig() ──→ AppConfig{ providers, mcp_servers, hooks }
                                 │
                                 ▼
                        <App mcpServers={...}>
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
        createToolRegistry()           useEffect: initClient
          (内置 6+ Tool)                          │
                  │                              ▼
                  │             new MCPManager().connectAll(cfgs)
                  │                              │
                  │                  for cfg of cfgs (串行)
                  │                   ├─ new MCPClient(cfg)
                  │                   ├─ client.connect()  ─ SDK initialize
                  │                   ├─ client.listTools() ─ tools/list
                  │                   └─ client.getInstructions()
                  ▼                              │
        registryRef.current ◄──── register(MCPToolWrapper)
                  │                              │
                  ▼                              ▼
   getAllSchemas(protocol)              setMcpInfo / setMessages
   (deferred 且未激活 → 跳过)             convRef.addSystemReminder
                  │
                  ▼
            LLMClient.tools[]
                  │
   ┌──────────────┴──────────────┐
   ▼                             ▼
  Agent.loop 中模型用       Agent.loop 中模型用具体
  ToolSearch 检索/激活      mcp__server__tool 调用
                                 │
                                 ▼
                       MCPToolWrapper.execute
                            │
                            ▼
                    MCPClient.callTool ─ tools/call
                            │
                            ▼
                       text content 拼接 / 异常包装
                            │
                            ▼
                    { output, isError } 回灌 conversation
```

依赖方向（无环）：

- `main.tsx` → `config/config.ts`、`tui/app.tsx`；
- `tui/app.tsx` → `mcp/manager.ts`、`mcp/tool-wrapper.ts`、`tools/registry.ts`、`tools/tool-search.ts`；
- `mcp/manager.ts` → `mcp/client.ts`；
- `mcp/tool-wrapper.ts` → `mcp/client.ts`、`tools/types.ts`；
- `mcp/client.ts` → `@modelcontextprotocol/sdk` + `config/config.ts`（仅类型）；
- `tools/tool-search.ts` → `tools/registry.ts`、`tools/types.ts`；
- `tools/registry.ts` 完全独立，不反向依赖任何 mcp 模块。

## 文件组织

```text
mewcode/
├── src/
│   ├── mcp/
│   │   ├── client.ts          ─ 新：MCPClient + expandEnv + AnyTransport
│   │   ├── manager.ts         ─ 新：MCPManager + ConnectResult
│   │   └── tool-wrapper.ts    ─ 新：MCPToolWrapper + sanitizeName
│   ├── tools/
│   │   ├── registry.ts        ─ 改：deferred / discovered / searchDeferred 等 API
│   │   ├── tool-search.ts     ─ 新：ToolSearchTool
│   │   └── types.ts           ─ 改：Tool.deferred / Tool.system 字段
│   ├── config/
│   │   └── config.ts          ─ 改：MCPServerConfig + AppConfig.mcp_servers + 三层合并
│   ├── tui/
│   │   └── app.tsx            ─ 改：mcpServers prop / MCPManager 接线 / /mcp / /status
│   └── main.tsx               ─ 改：把 cfg.mcp_servers 透传给 <App>
├── package.json                ─ 改：dependencies + "@modelcontextprotocol/sdk"
├── tsconfig.json
└── docs/typescript/ch07/
    ├── spec.md
    ├── plan.md
    ├── task.md
    └── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 协议层实现 | 官方 `@modelcontextprotocol/sdk` | 避免自研 JSON-RPC / 握手 / 帧；SDK 已含 stdio / Streamable HTTP / SSE 三套 transport |
| 配置文件位置 | 三层 yaml：`~/.mewcode/config.yaml`、`<cwd>/.mewcode/config.yaml`、`<cwd>/.mewcode/config.local.yaml` | 与 providers / hooks 共享配置文件；`.local.yaml` 走 gitignore 放本地凭据 |
| 合并语义 | `mcp_servers` 按 `name` 字段，同名后层完整覆盖前层；新名追加 | 避免字段级半合并出畸形 server；保留新增能力 |
| server 类型判定 | 看 `command` / `url` / `transport` 字段；二者都无 → 抛错 | 不引入额外 `type` 字段；字段名本身已表达意图 |
| 变量展开范围 | `env` / `headers` 的值；同时支持 `${VAR}` 与 `$VAR` | 凭据走环境变量；两种语法兼顾 shell 习惯 |
| 未定义变量 | 静默替换为空串 | 不替 server 拍板；server 自行决定如何处理无凭据 |
| 工具命名 | `mcp__<sanitize(server)>__<sanitize(tool)>`，非 `[a-zA-Z0-9_-]` → `_` | LLM 工具名安全字符；一眼识别来源 |
| deferred 默认值 | MCP 工具 `deferred = true` | 远端工具数量 / schema 长度不可控，默认不进 prompt 避免污染上下文 |
| ToolSearch 检索策略 | 子串关键词 + `select:` 精确加载 | 简单可控；子串匹配对工具 `name` / `description` 即可覆盖大多数场景；无需引入 `fuse.js` |
| 启动连接方式 | `useEffect` 内 fire-and-forget `connectAll().then(...)` | 不阻塞 chat 进入；result 回来时再注册 + 推 system 消息提示用户 |
| 连接并行度 | 串行（`for...of`） | 实现简单 + 错误隔离单点清晰；MCP server 数量通常很少（< 5），串行总时延可接受 |
| 启动超时 | 不主动加 timeout 包装 | SDK transport 自身的连接 promise 在传输错误时会 reject；不引入额外的超时复杂度 |
| 调用错误 | catch 后转 `{ output: "MCP tool error: <msg>", isError: true }` | 与 ch04/ch05 不中断 Agent loop 的契约一致 |
| 非 text 内容块 | `JSON.stringify(c)` 拼入 output | 不丢信息；让模型自行决定如何理解；不引入额外抽象 |
| stderr | `stderr: "ignore"` | 避免 stdio server 的子进程 stderr 污染 TUI 输出 |
| disconnect 时机 | 不在 App 退出时显式调用 | 子进程随 Node 主进程退出由 OS 终止；HTTP / SSE 会话由 SDK 自身在 Node teardown 时清理 |
| provider 适配方式 | `ToolRegistry.getAllSchemas(protocol)` 统一分支 | MCP 工具与内置工具复用同一 `schema()`；provider 适配层零修改 |
| instructions 注入 | `convRef.addSystemReminder("# MCP Server: <name>\n<text>")` | 与 skill / memory / plan 等模块的注入方式一致，统一走 `<system-reminder>` |
| 失败展示 | `setMessages([...prev, { role: "system", content: "MCP errors: ..." }])` | 让用户在 chat 第一屏就能看到失败，不只在 stderr |
| `/mcp` 命令 | 读 `mcpInfo` state 渲染纯文本块 | 与 `/status` 风格一致；无需独立面板 |
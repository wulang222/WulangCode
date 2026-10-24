# 工具系统 Plan

> 基于已批准的 spec.md。运行时 bun，语言 TypeScript 5.x（`tsc --noEmit` 严格模式）。SDK 已对 `@anthropic-ai/sdk@^0.99.0`、`openai@^6.39.0` 实测核对。

## 技术栈

- 运行时：bun（直接执行 `.ts` / `.tsx`，无需构建）。
- 语言：TypeScript 5.x，`tsc --noEmit` 严格类型检查。
- TUI：Ink 5（React 18 渲染到终端）、`ink-spinner`、`ink-text-input`。
- LLM SDK：`@anthropic-ai/sdk`（`messages.stream`）、`openai`（`responses.create` + `chat.completions.create`）。
- 文件 / 进程：Node 内置 `node:fs`、`node:fs/promises`、`node:path`、`node:child_process`（`execSync`）。
- Glob：`Bun.Glob` 内置（`scanSync` 同步迭代）。
- Markdown 渲染：`marked` + `marked-terminal`。
- 测试：`bun test`。
- 类型检查：`tsc --noEmit`。

## 架构概览（分层）

在 ch02 「client → conversation → tui」之上，新增两个目录并扩展三处：

- **`src/tools/`（新建）**：统一 `Tool` 接口、`ToolResult`、`ToolContext`、`ToolRegistry`、6 个工具实现、`descriptions.ts` 模型可见的工具说明。零外部依赖，不感知 LLM 协议。
- **`src/agent/`（新建）**：`Agent.run()` 是 `AsyncGenerator<AgentEvent>`，承载单轮闭环；`StreamingExecutor` 把已完成的工具调用通过 `Promise.all` 并发跑出来；`events.ts` 定义协议无关的 `AgentEvent` 联合类型。
- **`src/llm/`（扩展）**：`StreamEvent` 增加 `tool_call_start` / `tool_call_delta` / `tool_call_complete` / `thinking_delta` / `thinking_complete` 五种事件；`LLMClient.stream(conv, toolSchemas, abortSignal?)` 增加第二参数；三个 client（`AnthropicClient` / `OpenAIClient` / `OpenAICompatClient`）注入工具定义、解析流式工具调用、按各自协议格式回灌工具结果。
- **`src/conversation/`（扩展）**：`Message` 增加 `toolUses?: ToolUseBlock[]` 与 `toolResults?: ToolResultBlock[]`；新增 `addAssistantFull(text, thinking, toolUses)` 与 `addToolResultsMessage(results)`。
- **`src/prompt/`（扩展）**：`sections.ts` 增加 `usingToolsSection` / `executingActionsSection` 等说明 Agent 角色与工具使用规约。
- **`src/tui/`（扩展）**：`tool-display.tsx` 渲染 Claude Code 风格工具行；`chat.tsx` 在 `MessageBlock` 里识别 `tool_use` / `tool_result` 类型；`app.tsx` 在 `for await` 循环里把 `AgentEvent` 翻译成 `ChatMessage` 加进 scrollback。

依赖方向（无环）：`tools → llm`（仅 `getAllSchemas` 返回 `Record<string, unknown>[]`，不导入 `llm` 类型）；`conversation → llm`（共享 `ThinkingBlock` / `ToolUseBlock` / `ToolResultBlock` 接口定义）；`agent → { llm, tools, conversation }`；`tui → { agent, tools, conversation, llm, prompt }`。

## 数据流

```
用户输入 (Ink useInput)
  └─ app.tsx submit:
       conv.addUserMessage(text)
       agent = new Agent({ client, registry, conversation: conv, workDir, ... })
       for await (const ev of agent.run()) { setState 渲染 ev }

  Agent.run (AsyncGenerator):
    while looping:
      stream = client.stream(conv, registry.getAllSchemas(protocol), abortSignal)
      for await (event of stream):
        case "text_delta": yield { type: "stream_text", text }
        case "tool_call_complete": toolUses.push(...); yield { type: "tool_use", ... }
        case "stream_end": stopReason = ...; yield { type: "usage", ... }
      conv.addAssistantFull(fullText, thinkingBlocks, toolUses)
      if toolUses.length === 0:
        yield { type: "loop_complete" }; break
      results = await executeTools(toolUses)         // F5
        └─ StreamingExecutor.submit + collectResults (Promise.all)
        └─ 每个 result → yield { type: "tool_result", ... }
      conv.addToolResultsMessage(results)            // F6
      yield { type: "turn_complete" }
      // 本章在拿到 results 后下一轮 stream 中即使再请求工具，也不再执行
      // → 由 spec 的「不做的事」与 task 收口保证
```

## 核心数据结构与接口### `src/tools/types.ts`

```ts
export type ToolCategory = "read" | "write" | "command";

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface ToolContext {
  workDir: string;
  abortSignal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const SKIP_DIRS: Set<string>;
export function strArg(args: Record<string, unknown>, key: string, fallback?: string): string;
export function intArg(args: Record<string, unknown>, key: string, fallback: number): number;
export function boolArg(args: Record<string, unknown>, key: string, fallback?: boolean): boolean;
```

### `src/tools/registry.ts`

```ts
export class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  listTools(): Tool[];
  getAllSchemas(
    protocol?: "anthropic" | "openai" | "openai-compat"
  ): Record<string, unknown>[];
}
```

`getAllSchemas("anthropic")` 直接平铺每个工具 `schema()` 的 `{ name, description, input_schema }`；OpenAI 系列再包一层 `{ type: "function", function: { name, description, parameters } }`。

### `src/llm/events.ts`

```ts
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | { type: "tool_call_complete"; toolId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };
```

### `src/llm/client.ts`

```ts
export interface LLMClient {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}

export async function createClient(
  cfg: ProviderConfig,
  systemPrompt: string
): Promise<LLMClient>;
```

### `src/conversation/conversation.ts`

```ts
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

export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}

export class ConversationManager {
  addUserMessage(content: string): void;
  addAssistantMessage(content: string): void;
  addAssistantFull(text: string, thinking: ThinkingBlock[], toolUses: ToolUseBlock[]): void;
  addToolResultsMessage(results: ToolResultBlock[]): void;
  getMessages(): Message[];
  len(): number;
}
```

### `src/agent/events.ts`

```ts
export type AgentEvent =
  | { type: "stream_text"; text: string }
  | { type: "thinking_text"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_use"; toolName: string; toolId: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; toolId: string; output: string; isError: boolean; elapsed: number }
  | { type: "turn_complete" }
  | { type: "loop_complete"; stopReason: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error };
```

### `src/agent/agent.ts`

```ts
export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  conversation: ConversationManager;
  workDir: string;
  abortSignal?: AbortSignal;
}

export class Agent {
  constructor(config: AgentConfig);
  run(): AsyncGenerator<AgentEvent>;
}
```

### `src/agent/streaming-executor.ts`

```ts
export class StreamingExecutor {
  constructor(registry: ToolRegistry, ctx: ToolContext);
  submit(toolId: string, toolName: string, args: Record<string, unknown>): void;
  collectResults(): Promise<{
    toolId: string;
    toolName: string;
    result: ToolResult;
    elapsed: number;
  }[]>;
}
```

## 模块设计### `src/tools/types.ts`**职责：** 类型定义 + 安全取参函数 + 忽略目录集合。
**对外接口：** `Tool`、`ToolResult`、`ToolContext`、`ToolCategory`、`SKIP_DIRS`、`strArg` / `intArg` / `boolArg`。
**依赖：** 无（纯类型）。
**关键点：**
- `strArg` / `intArg` / `boolArg` 在 args 中字段缺失或类型错误时回退 fallback；`intArg` 还接受字符串数字并 `parseInt`。
- `SKIP_DIRS` 包含 `.git` / `node_modules` / `__pycache__` / `.next` / `.nuxt` / `dist` / `build` / `.mewcode` / `.claude` / `vendor` / `.venv` / `venv`。

### `src/tools/registry.ts`**职责：** 集中登记、按名查找、按协议导出 schema 列表。
**对外接口：** `ToolRegistry` 类。
**依赖：** `./types.ts`。
**关键点：**
- 内部 `Map<string, Tool>`。
- `getAllSchemas(protocol)` 默认 `protocol = "anthropic"`，对 OpenAI 系列再包一层 `{ type: "function", function: { name, description, parameters } }`。

### `src/tools/read-file.ts`**职责：** 读文件 + 行号。
**关键点：**
- `existsSync` 检查；`statSync` 区分目录；`readFileSync(path, "utf-8")` 读取。
- `lines.slice(offset, offset + limit)` 切片；`numbered = slice.map((line, i) => \`${offset + i + 1}\t${line}\`)`。
- 默认 `offset = 0` / `limit = 2000`。

### `src/tools/write-file.ts`**职责：** 写文件 + 自动建父目录。
**关键点：**
- `mkdirSync(dirname(path), { recursive: true })` 先建父目录。
- `writeFileSync(path, content, "utf-8")` 覆盖写。
- 成功返回 `File written: <path> (N lines)`，其中 N = `content.split("\n").length`。

### `src/tools/edit-file.ts`**职责：** 唯一匹配替换。
**关键点：**
- `content.split(oldString).length - 1` 算匹配数 `count`。
- `count === 0` → `Error: old_string not found in file`。
- `!replaceAll && count > 1` → `Error: old_string found N times in file. It must be unique. Add more surrounding context, or set replace_all to true.`。
- `count === 1` 或 `replaceAll`：用 `content.replace` / `replaceAll` 写回。
- `oldString === newString` 直接报错。

### `src/tools/bash.ts`**职责：** 执行 shell 命令，超时杀进程，按命令语义判定错误。
**关键点：**
- `execSync(command, { shell: "bash", cwd: ctx.workDir, timeout: timeout * 1000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })`。
- 默认 `timeout = 120`，上限 `MAX_TIMEOUT = 600`。
- catch 块判断 `e.killed === true` → 返回超时错误；否则按 `interpretExitCode(command, exitCode)` 决定 `isError`。
- `interpretExitCode` 维护 `commandErrorThresholds: Map<string, number>`（`grep`/`egrep`/`fgrep`/`rg`/`diff`/`test`/`[`/`find` → 阈值 2，退出 1 不算错）；解析管道最后一段命令、跳过 `VAR=value` 前缀、去掉路径前缀拿 basename。

### `src/tools/glob.ts`**职责：** `Bun.Glob` 扫描，按 mtime 倒序。
**关键点：**
- `new Bun.Glob(pattern).scanSync({ cwd: basePath, dot: false })` 同步迭代。
- 跳过任意一段命中 `SKIP_DIRS` 的路径。
- 上限 1000 条；按 `statSync(...).mtimeMs` 倒序，stat 失败 fallback 到 `localeCompare`。

### `src/tools/grep.ts`**职责：** 正则按行搜，自实现目录遍历。
**关键点：**
- `new RegExp(pattern, "i")` 大小写不敏感；编译失败返回错误。
- `walk(dir)` 递归 `readdirSync` + `statSync`；命中 `SKIP_DIRS` 跳过。
- `include` 参数：若提供，用 `new Bun.Glob(include).match(entry)` 过滤文件名。
- `MAX_RESULTS = 500`，每收集一条检查上限提前返回；超出时尾部加 `(results truncated at 500 matches)`。

### `src/agent/streaming-executor.ts`**职责：** 把已完成的工具调用入队并并发执行。
**关键点：**
- `submit(toolId, name, args)` 进 `pending`。
- `collectResults()` 把 `pending` swap 出来，`Promise.all` 跑每个调用：未知工具返回 `unknown tool` 错误；`tool.execute` 抛异常被 catch 转 `isError`；用 `Date.now()` 算 `elapsed`（秒）。

### `src/agent/agent.ts`**职责：** 单轮闭环编排，把 `StreamEvent` 翻译成 `AgentEvent`。
**Run 算法（本章版）：**
1. `toolSchemas = registry.getAllSchemas(protocol)`。
2. `for await (event of client.stream(conv, toolSchemas))`：
   - `text_delta` → `yield { type: "stream_text", text }`，累计 `fullText`。
   - `thinking_complete` → 入 `thinkingBlocks`，转发到 UI。
   - `tool_call_complete` → 入 `toolUses`，`yield { type: "tool_use", ... }`。
   - `stream_end` → 拿 `stopReason`、`usage`。
3. `conv.addAssistantFull(fullText, thinkingBlocks, toolUses)`。
4. 若 `toolUses.length === 0`：`yield { type: "loop_complete", stopReason }`；结束。
5. 否则：执行工具
   - `executor = new StreamingExecutor(registry, { workDir })`。
   - `for (const tu of toolUses) executor.submit(tu.toolUseId, tu.toolName, tu.arguments)`。
   - `results = await executor.collectResults()`。
   - 每个 result → `yield { type: "tool_result", ... }`，并收集到 `ToolResultBlock[]`。
   - `conv.addToolResultsMessage(toolResultBlocks)`。
   - `yield { type: "turn_complete" }`。
6. 本章版**只跑一次循环**：拿到工具结果后不再回到步骤 2，直接 `yield { type: "loop_complete", stopReason: "tool_use" }`；连环 Loop 留待下一章打开（删除「只跑一次」的早返回即可）。

### `src/llm/anthropic.ts`**职责：** 注入工具定义、解析流式工具调用、按 Anthropic 格式回灌历史。
**关键点：**
- `stream` 参数 `toolSchemas` 转 `Anthropic.Tool[]`：`{ name, description, input_schema: { type: "object", properties, required } }`。
- `params.tools = tools`（非空时）。
- 流循环 switch event.type：
  - `content_block_start`：`tool_use` → 记 `currentToolName` / `currentToolId`，发 `tool_call_start`；`thinking` → `inThinking = true`。
  - `content_block_delta`：`text_delta` 上抛；`input_json_delta` 累计 `jsonAccum` 并发 `tool_call_delta`；`thinking_delta` 累计 + 上抛；`signature_delta` 记 signature。
  - `content_block_stop`：`inThinking` 时发 `thinking_complete`；`currentToolName` 非空时 `JSON.parse(jsonAccum)`（fallback `{}`）后发 `tool_call_complete`。
  - `message_delta`：拿 `stop_reason` / 出 token。
  - `message_start`：拿 input/cache token。
- `buildAnthropicMessages(history)` 把 `Message` 转 `Anthropic.MessageParam[]`：
  - assistant 有 `toolUses` → blocks 同时含 `text` + `tool_use`。
  - 含 `toolResults` 的 user → `role: "user"`、content 为 `tool_result` block 数组。
- 错误分类：`Anthropic.APIError` 按 status 转 `ContextTooLongError` / `AuthenticationError` / `RateLimitError` / `LLMError`。

### `src/llm/openai.ts`**职责：** Responses API 与 Chat Completions 兼容端点两套 client；注入工具定义、解析流式工具调用、按各自格式回灌。
**关键点（OpenAIClient，用 Responses API）：**
- `toolSchemas` 转 `OpenAI.Responses.FunctionTool[]`：`{ type: "function", name, description, parameters, strict: false }`。
- 流事件 switch：
  - `response.output_text.delta` → `text_delta`。
  - `response.output_item.added` 且 `item.type === "function_call"` → 记 `name` / `call_id`，发 `tool_call_start`。
  - `response.function_call_arguments.delta` → 累计 `jsonAccum` 并 `tool_call_delta`。
  - `response.output_item.done` 且 `function_call` → `JSON.parse(jsonAccum)` 后发 `tool_call_complete`。
  - `response.completed` → 拿 usage、stop_reason（`incomplete_details.reason === "max_output_tokens"` 转 `"max_tokens"`）。
- `buildOpenAIInput(history)` 把 assistant 的 `toolUses` 转 `{ type: "function_call", name, call_id, arguments: JSON.stringify(args) }` item；`toolResults` 转 `{ type: "function_call_output", call_id, output }` item。

**关键点（OpenAICompatClient，用 Chat Completions）：**
- `toolSchemas` 转 `OpenAI.ChatCompletionTool[]`：`{ type: "function", function: { name, description, parameters } }`。
- 流循环 `delta.tool_calls`：用 `Map<index, { id, name, args }>` 按 index 拼接；首次见到 `index` 时若 `tc.id` 已到，发 `tool_call_start`；累计 `tc.function.arguments`。
- `finish_reason` 到来时遍历 Map，每个 entry `JSON.parse(args)` 后发 `tool_call_complete`；最终 `stopReason` 按 `finishReason === "length"` / `"tool_calls"` / 其他 映射 `"max_tokens"` / `"tool_use"` / `"end_turn"`。
- `buildChatCompletionMessages(history)`：assistant 有 `toolUses` → `{ role: "assistant", content: m.content || null, tool_calls: [...] }`；`toolResults` → 每个 `{ role: "tool", tool_call_id, content }`。

### `src/conversation/conversation.ts`**职责：** 持有 `Message[]`，扩展 tool_use / tool_result 回合的追加方法。
**关键点：**
- `addAssistantFull(text, thinking, toolUses)` 一次性塞 `{ role: "assistant", content, thinkingBlocks?, toolUses? }`（空数组不挂字段）。
- `addToolResultsMessage(results)` 塞 `{ role: "user", content: "", toolResults: results }`。
- `getMessages()` 返回内部数组（注意：本章不深拷贝，调用方不修改）。
- `injectLongTermMemory` 与 `addSystemReminder` 与 ch03 主线无关，保留但本章不展开。

### `src/prompt/sections.ts` + `src/prompt/builder.ts`**职责：** 按章节优先级拼系统提示词。
**关键点：**
- `usingToolsSection` 列举 6 个工具的使用规约（`ReadFile` 用绝对路径、`Bash` 不要用 `cat`/`head`、`Glob`/`Grep` 区分等）。
- `executingActionsSection` 强调「破坏性 git 命令、跳 hooks、`push --force` 等不要默认做」。
- `buildSystemPrompt(env)` 把所有 sections 按 priority 排序、`trim` 拼接。

### `src/tui/tool-display.tsx`**职责：** 渲染单个 / 一组工具块。
**关键点：**
- `ToolBlockInfo { toolName, args, output?, isError?, elapsed?, loading? }`。
- `loading: true` → `<Text>● ToolName argSummary</Text>`（magenta `●`）。
- 结束态 → `<Text>{icon} ToolName argSummary (Ns)</Text>` + `<Box paddingLeft={2}><Text dimColor>{output 截 500 字符}</Text></Box>`，`icon = isError ? ✗ : ✓`。
- `formatArgs(args)` 优先取 `command` / `file_path` / `pattern`，截 80 字符。

### `src/tui/chat.tsx`**职责：** 维护 `ChatMessage[]` 时间线；在 `MessageBlock` 里识别 `tool_use` / `tool_result` 类型并渲染。
**关键点：**
- `ChatMessage.role` 联合扩展为 `"user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary"`。
- `<Static>` 包提交完的消息，避免重渲染抖动。
- 流式中的 assistant 文本（未结束）用 `streamingText` 字段在 `<Static>` 外的动态区渲染。

### `src/tui/app.tsx`**职责：** 装配 `createClient` + `ToolRegistry` + `Agent`，在 `for await (const ev of agent.run())` 里把 `AgentEvent` 翻译成 `ChatMessage` 并 `setMessages`。
**关键点：**
- `createToolRegistry(workDir)` 顺序注册 `ReadFile`、`Bash`、`Glob`、`Grep`、`WriteFile`、`EditFile`。
- 收到 `tool_use` 事件先 push 一条 `role: "tool_use"` 的 `ChatMessage`（loading 态）；收到对应 `tool_result` 时按 `toolId` 找回那条更新为结束态。

## 模块交互

```
用户输入
  └─ app.tsx submit():
        conv.addUserMessage(text)
        agent = new Agent({ client, registry, conversation: conv, workDir })
        for await (ev of agent.run()):
          if ev.type === "stream_text":  setStreamingText(prev + ev.text)
          if ev.type === "tool_use":     setMessages(prev => [...prev, { role: "tool_use", ... loading }])
          if ev.type === "tool_result":  setMessages(prev => prev.map(m => m.toolId === ev.toolId ? { ...m, output, isError, elapsed } : m))
          if ev.type === "loop_complete":finalize 当轮 → flush streamingText 为 assistant 消息

agent.run():
  ┌── stream = client.stream(conv, registry.getAllSchemas(protocol))
  │       └── anthropic.ts / openai.ts：注入 tools，逐分片解析，归一化成 StreamEvent
  ├── for await (event of stream):
  │     text_delta → yield stream_text
  │     tool_call_complete → toolUses.push + yield tool_use
  │     stream_end → 记 stopReason + yield usage
  ├── conv.addAssistantFull(fullText, thinkingBlocks, toolUses)
  ├── if toolUses.length === 0: yield loop_complete; return
  ├── executor = new StreamingExecutor(registry, { workDir })
  │   for tu of toolUses: executor.submit(...)
  │   results = await executor.collectResults()    ← Promise.all 并发跑
  ├── for r of results: yield tool_result
  ├── conv.addToolResultsMessage(toolResultBlocks)
  ├── yield turn_complete
  └── 本章版直接 yield loop_complete（不再回到 stream）
```

## 文件组织

```text
mewcode/
├── src/
│   ├── main.tsx                       — 修改：装配 ToolRegistry 注入 App
│   ├── tools/                         — 新建
│   │   ├── types.ts                   — Tool / ToolResult / ToolContext / SKIP_DIRS / strArg / intArg / boolArg
│   │   ├── registry.ts                — ToolRegistry，getAllSchemas(protocol)
│   │   ├── descriptions.ts            — 6 个工具的 description 常量（给模型看）
│   │   ├── read-file.ts               — ReadFileTool
│   │   ├── write-file.ts              — WriteFileTool
│   │   ├── edit-file.ts               — EditFileTool
│   │   ├── bash.ts                    — BashTool + interpretExitCode
│   │   ├── glob.ts                    — GlobTool（Bun.Glob）
│   │   └── grep.ts                    — GrepTool（手写 walk）
│   ├── agent/                         — 新建
│   │   ├── events.ts                  — AgentEvent 联合类型
│   │   ├── agent.ts                   — Agent.run() AsyncGenerator
│   │   └── streaming-executor.ts      — StreamingExecutor.submit / collectResults
│   ├── llm/
│   │   ├── client.ts                  — 修改：LLMClient.stream 加 tools 参数
│   │   ├── events.ts                  — 修改：StreamEvent 增 5 种工具/思考事件
│   │   ├── anthropic.ts               — 修改：tools 注入、流式解析、buildAnthropicMessages 支持 tool_use/tool_result
│   │   └── openai.ts                  — 修改：OpenAIClient + OpenAICompatClient 双实现
│   ├── conversation/
│   │   └── conversation.ts            — 修改：Message 增 toolUses/toolResults；addAssistantFull / addToolResultsMessage
│   ├── prompt/
│   │   ├── sections.ts                — 修改：usingToolsSection / executingActionsSection
│   │   └── builder.ts                 — 维持现状（已按 priority 排序拼接）
│   └── tui/
│       ├── app.tsx                    — 修改：装配 registry + Agent；事件循环映射 ChatMessage
│       ├── chat.tsx                   — 修改：ChatMessage 联合增 tool_use/tool_result
│       └── tool-display.tsx           — 新建：ToolDisplay / ToolBlock / formatArgs
└── tests/
    └── tools/
        ├── registry.test.ts           — getAllSchemas 长度 / 协议格式
        ├── read-file.test.ts          — 存在 / 不存在 / 目录三情形
        ├── write-file.test.ts         — 嵌套路径自动建目录
        ├── edit-file.test.ts          — 0 / 1 / N / replace_all 四情形
        ├── bash.test.ts               — echo / 超时 / grep 退出 1 不报错
        ├── glob.test.ts               — **/*.ts 命中
        └── grep.test.ts               — 关键字命中 / 上限截断
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 工具调用循环放哪 | 新建 `src/agent/`，TUI 退化为渲染器 | 单轮闭环（stream → 工具执行 → stream）的状态机不该塞进 React 组件；`AsyncGenerator<AgentEvent>` 让 TUI 用 `for await` 直接消费、可独立单测、不依赖 Ink。 |
| `Agent.run` 的产物形式 | `AsyncGenerator<AgentEvent>` | TS 异步生成器天然契合「按事件驱动 UI」；比回调更易写、比 EventEmitter 更易类型化。 |
| 工具定义传哪一层 | `LLMClient.stream` 第二参数 `Record<string, unknown>[]` | 三种协议都需在 per-request params 上挂 `tools`；让 client 自身完成「平铺 schema → 协议格式」的翻译，注册中心只输出语义化结构。 |
| 工具参数 Schema 生成 | 每个工具 `schema()` 手写返回 `Record<string, unknown>` | 6 个固定工具手写最直白；OpenAI 兼容端点的 `parameters` 直接吃整个 `input_schema`；Anthropic 取 `properties` / `required`；无需 JSON Schema 反射库。 |
| 流式工具参数拼接 | Anthropic 用 `jsonAccum` + `content_block_stop` 时 `JSON.parse`；OpenAI Responses 同款；OpenAI Chat Completions 用 `Map<index, ...>` 按 `tc.index` 拼 | 三种协议的分片节奏不同；用各自最直接的 SDK 字段拼接，比一刀切的 partial-json parser 更稳。 |
| Glob 实现 | `Bun.Glob.scanSync` | bun 自带、零依赖、跨平台、支持 `**`；比手撸 `walkDir` + 段匹配简单得多。注意 bun 锁定运行时（即 `package.json bin: ./src/main.tsx` 期望 bun）。 |
| Grep 实现 | 手写 `readdirSync` + `statSync` + `new RegExp(pattern, "i")` | `Bun.Glob` 只擅长文件名匹配，按行扫内容仍需手撸；目录跳过用 `SKIP_DIRS` 共享集合，避免重复定义。 |
| Bash 实现 | Node `execSync({ shell: "bash", timeout, maxBuffer })` 同步 | 同步阻塞在 `tool.execute` 这一 promise 里，对 Ink 渲染线程没影响；`timeout` 由 child_process 直接杀；不引入 `node-pty`。 |
| 退出码语义 | `interpretExitCode` 维护命令 → 阈值表 | `grep` / `diff` / `test` / `find` 退出 1 是「正常的没匹配 / 有差异 / 假」，盲目当 error 会误导模型；管道命令取最后一段 basename 判定。 |
| 工具失败的表达 | `Tool.execute` 永远 resolve `ToolResult`，不抛异常 | `StreamingExecutor` 再加一层 try/catch 兜底；F9 / N4 要求所有失败结构化回灌、程序不退；上层无需区分 throw / result。 |
| 工具结果在 Message 的形态 | `Message.toolUses?: ToolUseBlock[]` + `Message.toolResults?: ToolResultBlock[]` 两个独立字段 | 三种 SDK 的工具语义本就是 assistant 一回合可含多个 `tool_use`、user 一回合可含多个 `tool_result`；可选字段保持向后兼容 ch02 的 `addAssistantMessage`。 |
| UI 截断 vs 回灌截断 | 分两层：UI 取 `output.slice(0, 500)`；Agent 层 `MAX_OUTPUT_CHARS = 10000` 兜底；工具自身另有上限（read 2000 行 / bash 10MB / glob 1000 / grep 500） | 界面要省屏，模型要细节；分层各自截断、各加 `…` / `(truncated)` 标注。 |
| 续答请求是否带 tools | 带 | OpenAI Responses / Chat Completions 在跟进消息中省略 `tools` 也能跑，但带上更稳；Anthropic 必须带（要求 tool_use 后的 tool_result 仍在同一对话）。本章靠「不发起第二轮工具执行」收口单轮，不靠不传 tools。 |
| 思考增量与工具组合 | `thinking_delta` 立即上抛但不存入 `fullText`；`thinking_complete` 携带 signature 入 `thinkingBlocks` 在 `addAssistantFull` 一起落库 | Anthropic 在多轮工具流程中要求回灌带签名的思考块；OpenAI / 兼容端点没有此事件，自动空跳。 |
| 空 arguments 归一 | `JSON.parse` 失败 fallback `{}` | OpenAI 兼容端点对无参工具可能发空字符串；强行 parse 会扔异常，fallback `{}` 让工具 `execute` 按缺省参数走默认错误处理（如 `file_path is required`）。 |
| Grep 上限 | 500 条；尾部加 `(results truncated at 500 matches)` | N5 要求结果体量受控；500 足够覆盖典型代码定位，再多模型也用不上。 |
| 工具命名 | `ReadFile` / `WriteFile` / `EditFile` / `Bash` / `Glob` / `Grep` | PascalCase 与 Claude Code 习惯一致；OpenAI 函数命名规则（`[a-zA-Z0-9_-]+`）允许；TUI 工具行直接显示工具名。 |
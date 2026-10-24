# 工具系统 Tasks

> 基于已批准的 spec.md + plan.md。模块路径以 `src/`、测试以 `tests/` 为根；运行时 bun + TypeScript 5.x。任务有序，每步留绿（`tsc --noEmit` 通过、`bun test` 已有用例不回归）。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/tools/types.ts` | `Tool` / `ToolResult` / `ToolContext` / `ToolCategory` / `SKIP_DIRS` / `strArg` / `intArg` / `boolArg` |
| 新建 | `src/tools/registry.ts` | `ToolRegistry`，`register` / `get` / `listTools` / `getAllSchemas(protocol)` |
| 新建 | `src/tools/descriptions.ts` | 6 个工具的 description 常量（给模型看） |
| 新建 | `src/tools/read-file.ts` | `ReadFileTool` |
| 新建 | `src/tools/write-file.ts` | `WriteFileTool` |
| 新建 | `src/tools/edit-file.ts` | `EditFileTool` |
| 新建 | `src/tools/bash.ts` | `BashTool` + `interpretExitCode` |
| 新建 | `src/tools/glob.ts` | `GlobTool`（`Bun.Glob`） |
| 新建 | `src/tools/grep.ts` | `GrepTool`（手写 `walk`） |
| 新建 | `src/agent/events.ts` | `AgentEvent` 联合类型 |
| 新建 | `src/agent/streaming-executor.ts` | `StreamingExecutor.submit` / `collectResults` |
| 新建 | `src/agent/agent.ts` | `Agent.run()` AsyncGenerator（单轮闭环） |
| 修改 | `src/llm/events.ts` | `StreamEvent` 增 `tool_call_start` / `tool_call_delta` / `tool_call_complete` / `thinking_delta` / `thinking_complete` |
| 修改 | `src/llm/client.ts` | `LLMClient.stream` 第二参数 `toolSchemas` |
| 修改 | `src/llm/anthropic.ts` | 注入 `params.tools`、流式解析 `tool_use` / `thinking`、`buildAnthropicMessages` 支持 `tool_use` / `tool_result` |
| 修改 | `src/llm/openai.ts` | `OpenAIClient`（Responses）+ `OpenAICompatClient`（Chat Completions）解析工具调用 + 回灌历史 |
| 修改 | `src/conversation/conversation.ts` | `Message` 增 `toolUses?` / `toolResults?` / `thinkingBlocks?`；`addAssistantFull` / `addToolResultsMessage` |
| 修改 | `src/prompt/sections.ts` | `usingToolsSection` / `executingActionsSection` |
| 新建 | `src/tui/tool-display.tsx` | `ToolDisplay` / `ToolBlock` / `formatArgs` |
| 修改 | `src/tui/chat.tsx` | `ChatMessage` 联合加 `tool_use` / `tool_result`；`MessageBlock` 分派 |
| 修改 | `src/tui/app.tsx` | 装配 `ToolRegistry` + `Agent`；`for await (ev of agent.run())` 映射 `ChatMessage` |
| 新建 | `tests/tools/*.test.ts` | 注册中心 + 6 个工具单测 |

## T1: 工具类型与取参工具函数**文件：** `src/tools/types.ts`
**依赖：** 无
**步骤：**
1. 定义 `type ToolCategory = "read" | "write" | "command"`。
2. 定义 `interface ToolResult { output: string; isError: boolean }`。
3. 定义 `interface ToolContext { workDir: string; abortSignal?: AbortSignal }`。
4. 定义 `interface Tool { name: string; description: string; category: ToolCategory; schema(): Record<string, unknown>; execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> }`。
5. 导出 `SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".next", ".nuxt", "dist", "build", ".mewcode", ".claude", "vendor", ".venv", "venv"])`。
6. 导出 `strArg(args, key, fallback = "")`、`intArg(args, key, fallback)`、`boolArg(args, key, fallback = false)`：对 args 中字段做类型检查并回退；`intArg` 接受字符串数字 `parseInt`。

**验证：** `bun x tsc --noEmit` 无错误。

## T2: 工具描述常量**文件：** `src/tools/descriptions.ts`
**依赖：** T1
**步骤：**
1. 导出 6 个 description 常量：`BashDescription`、`ReadFileDescription`、`WriteFileDescription`、`EditFileDescription`、`GlobDescription`、`GrepDescription`。
2. 每个描述用「用法说明 + 注意事项」格式给模型看；`BashDescription` 强调不要用 `cat`/`head`/`tail`/`sed`、引号包含空格的路径、git 安全规约等。

**验证：** `bun x tsc --noEmit` 无错误。

## T3: ToolRegistry 骨架**文件：** `src/tools/registry.ts`
**依赖：** T1
**步骤：**
1. `class ToolRegistry`：私有 `tools = new Map<string, Tool>()`。
2. `register(tool: Tool): void` → `this.tools.set(tool.name, tool)`。
3. `get(name: string): Tool | undefined`。
4. `listTools(): Tool[]` → `[...this.tools.values()]`。
5. `getAllSchemas(protocol: "anthropic" | "openai" | "openai-compat" = "anthropic"): Record<string, unknown>[]`：遍历 `tools.values()`，对 OpenAI 系列包成 `{ type: "function", function: { name: base.name, description: base.description, parameters: base.input_schema } }`；anthropic 直接 push `base`。

**验证：** `bun x tsc --noEmit` 无错误；可临时手测 `new ToolRegistry().getAllSchemas() == []`。

## T4: ReadFile 工具**文件：** `src/tools/read-file.ts`
**依赖：** T1, T2
**步骤：**
1. `class ReadFileTool implements Tool`：`name = "ReadFile"`、`description = ReadFileDescription`、`category = "read"`。
2. `schema()` 返回 `{ name, description, input_schema: { type: "object", properties: { file_path: { type: "string", ... }, offset: { type: "integer", default: 0 }, limit: { type: "integer", default: 2000 } }, required: ["file_path"] } }`。
3. `execute(args, ctx)`：
   - `filePath = strArg(args, "file_path")`；空 → `{ output: "Error: file_path is required", isError: true }`。
   - `!existsSync(filePath)` → file not found 错误。
   - `statSync(filePath).isDirectory()` → 报错并建议 `Glob`。
   - 读 `readFileSync(filePath, "utf-8")`、`split("\n")`、`slice(offset, offset + limit)`。
   - `numbered = slice.map((line, i) => \`${offset + i + 1}\t${line}\`).join("\n")`。
   - try/catch 包成 `Error reading file: <msg>` 错误。

**验证：** `bun x tsc --noEmit`；T11 后用 `bun test tests/tools/read-file.test.ts` 验三情形。

## T5: WriteFile 工具**文件：** `src/tools/write-file.ts`
**依赖：** T1, T2
**步骤：**
1. `class WriteFileTool implements Tool`：`name = "WriteFile"`、`category = "write"`。
2. `schema()`：`file_path` + `content` 均必填。
3. `execute`：
   - 取参，空字段错误。
   - `mkdirSync(dirname(filePath), { recursive: true })`。
   - `writeFileSync(filePath, content, "utf-8")`。
   - 成功返回 `File written: <path> (N lines)`，N = `content.split("\n").length`。
   - try/catch 包错。

**验证：** `bun x tsc --noEmit`；T11 后单测写嵌套路径 `t/a/b/c.txt`。

## T6: EditFile 工具**文件：** `src/tools/edit-file.ts`
**依赖：** T1, T2
**步骤：**
1. `class EditFileTool implements Tool`：`name = "EditFile"`、`category = "write"`。
2. `schema()`：`file_path` / `old_string` / `new_string` 必填；`replace_all` 可选默认 false。
3. `execute`：
   - 校验三必填字段非空。
   - `oldString === newString` → 报错。
   - 读 `content = readFileSync(filePath, "utf-8")`；失败包错。
   - `count = content.split(oldString).length - 1`。
   - `count === 0` → `Error: old_string not found in file`。
   - `!replaceAll && count > 1` → `Error: old_string found ${count} times in file. It must be unique. Add more surrounding context, or set replace_all to true.`。
   - 否则 `replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)` 写回；成功返回 `File edited: <path>`（多次替换附带 `(N replacements)`）。

**验证：** `bun x tsc --noEmit`；T11 后单测覆盖 0/1/多/replace_all 四情形。

## T7: Bash 工具**文件：** `src/tools/bash.ts`
**依赖：** T1, T2
**步骤：**
1. 顶部 `import { execSync } from "node:child_process"`。
2. `const MAX_TIMEOUT = 600`。
3. `const commandErrorThresholds = new Map<string, number>([["grep", 2], ["egrep", 2], ["fgrep", 2], ["rg", 2], ["diff", 2], ["test", 2], ["[", 2], ["find", 2]])`。
4. `function interpretExitCode(command, exitCode)`：取 `command.split("|").pop()?.trim()`、按空格 tokens 跳过 `VAR=value`、basename 去路径前缀、查表得 threshold；命中 `exitCode >= threshold` 为 error，未命中按 `exitCode !== 0` 判定。
5. `class BashTool implements Tool`：`name = "Bash"`、`category = "command"`。
6. `schema()`：`command` 必填，`timeout`（integer，默认 120）可选。
7. `execute`：
   - 取 `command` / `timeout`（`Math.min(intArg(...), MAX_TIMEOUT)`）。
   - try `execSync(command, { shell: "bash", cwd: ctx.workDir, timeout: timeout * 1000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 })`。
   - 成功 → `{ output: \`$ ${command}\n${result}(exit code 0)\`, isError: false }`。
   - catch：`e.killed === true` → 超时错误；否则拼 `$ <cmd>\n<stdout>STDERR: <stderr>(exit code N)`，按 `interpretExitCode` 决定 `isError`。

**验证：** `bun x tsc --noEmit`；T11 后单测 `echo hi` / 超时（极短 `timeout: 1` 跑 `sleep 5`）/ `grep nothing somefile` 退出 1 不报 error。

## T8: Glob 工具**文件：** `src/tools/glob.ts`
**依赖：** T1, T2
**步骤：**
1. `class GlobTool implements Tool`：`name = "Glob"`、`category = "read"`。
2. `schema()`：`pattern` 必填，`path` 可选默认 `"."`。
3. `execute`：
   - `pattern` 空 → 报错。
   - `basePath = strArg(args, "path", ctx.workDir)`。
   - try `const glob = new Bun.Glob(pattern); for (const entry of glob.scanSync({ cwd: basePath, dot: false }))`：
     - `entry.split("/")` 任一段命中 `SKIP_DIRS` → 跳过。
     - push 到 `matches`，超 1000 break。
   - 按 `statSync(join(basePath, a)).mtimeMs` 倒序排序（stat 失败 fallback `localeCompare`）。
   - 空 → `No files matched the pattern.`（`isError: false`）；非空 → `matches.join("\n")`。

**验证：** `bun x tsc --noEmit`；T11 后单测 `**/*.ts` 在 `src/` 下命中 ReadFileTool 等文件。

## T9: Grep 工具**文件：** `src/tools/grep.ts`
**依赖：** T1, T2
**步骤：**
1. `const MAX_RESULTS = 500`。
2. `class GrepTool implements Tool`：`name = "Grep"`、`category = "read"`。
3. `schema()`：`pattern` 必填（正则）、`path` 可选默认 `"."`、`include` 可选（文件名 glob）。
4. `execute`：
   - 参数取值；`new RegExp(pattern, "i")`，编译失败包错。
   - `includeGlob = include ? new Bun.Glob(include) : null`。
   - 自实现 `walk(dir)`：`readdirSync(dir)`，遍历每项：
     - `results.length >= MAX_RESULTS` 早返回。
     - `SKIP_DIRS.has(entry)` 跳过。
     - `statSync` 失败 continue。
     - 目录 → `walk(fullPath)` 递归；文件 → `includeGlob && !includeGlob.match(entry)` 跳过，否则 `searchFile(fullPath)`。
   - `searchFile(path)`：`readFileSync(path, "utf-8")`、`split("\n")`，对每行 `regex.test`，push `${rel}:${i+1}:${line}`；try/catch 跳过二进制 / 不可读。
   - 起点 stat 若为文件直接 `searchFile`，否则 `walk(searchPath)`。
   - 空 → `No matches found.`；非空 → `results.join("\n")`，若达上限追加 `(results truncated at MAX_RESULTS matches)`。

**验证：** `bun x tsc --noEmit`；T11 后单测搜一个已知关键字命中。

## T10: 三个 LLM 类型扩展**文件：** `src/llm/events.ts`、`src/llm/client.ts`、`src/conversation/conversation.ts`
**依赖：** 无
**步骤：**
1. `src/llm/events.ts`：扩展 `StreamEvent` 联合类型，加入 `thinking_delta` / `thinking_complete` / `tool_call_start` / `tool_call_delta` / `tool_call_complete` 共 5 种事件；`UsageInfo` 增 `cacheReadInputTokens` / `cacheCreationInputTokens`。
2. `src/llm/client.ts`：`LLMClient.stream` 签名改为 `stream(conv: ConversationManager, tools: Record<string, unknown>[], abortSignal?: AbortSignal): AsyncGenerator<StreamEvent>`。
3. `src/conversation/conversation.ts`：
   - 导出 `ToolUseBlock { toolUseId, toolName, arguments }`、`ToolResultBlock { toolUseId, content, isError }`、`ThinkingBlock { thinking, signature }`。
   - `Message` 增可选字段 `thinkingBlocks?`、`toolUses?`、`toolResults?`。
   - 增 `addAssistantFull(text, thinking, toolUses)`：仅在 `thinking.length > 0` / `toolUses.length > 0` 时挂字段。
   - 增 `addToolResultsMessage(results)`：push `{ role: "user", content: "", toolResults: results }`。

**验证：** `bun x tsc --noEmit` 无错误（旧调用点暂不接 `tools` 参数也能编译，因第二参数有默认 `[]` 或在 T12-T13 之前临时 `// @ts-ignore`；推荐 T11-T13 后再消化 ts 报错）。

## T11: 工具单测**文件：** `tests/tools/registry.test.ts`、`tests/tools/read-file.test.ts`、`tests/tools/write-file.test.ts`、`tests/tools/edit-file.test.ts`、`tests/tools/bash.test.ts`、`tests/tools/glob.test.ts`、`tests/tools/grep.test.ts`
**依赖：** T3–T9
**步骤：**
1. `registry.test.ts`：注册 6 个工具后 `getAllSchemas("anthropic").length === 6` 且每项有 `name`/`description`/`input_schema`；`getAllSchemas("openai")` 每项为 `{ type: "function", function: { name, description, parameters } }`；`get("Bash")` 命中、`get("Nope")` undefined。
2. `read-file.test.ts`：用 `Bun.file` / `fs.mkdtempSync` 造临时文件验存在 + 行号；不存在 / 目录两种错误情形断言 `isError === true`。
3. `write-file.test.ts`：`mkdtempSync` 下写嵌套 `a/b/c.txt`，断言 `existsSync` + `readFileSync` 内容一致 + 输出含 `(N lines)`。
4. `edit-file.test.ts`：四情形（0 / 1 / N 不带 replaceAll / N 带 replaceAll）；断言 `output` 文案各不相同、`>1` 时含数字 N。
5. `bash.test.ts`：`echo hi` 输出含 `hi` + `(exit code 0)`；`{ command: "sleep 5", timeout: 1 }` 触发超时返回 `Error: command timed out after 1s` 且 `isError: true`；`grep nothing /tmp/<unique>` 退出 1 不被标 error。
6. `glob.test.ts`：`{ pattern: "**/*.ts", path: <repo root> }` 命中 `src/tools/read-file.ts`。
7. `grep.test.ts`：`{ pattern: "ReadFile", path: "src/tools" }` 至少命中一条 `read-file.ts:N:`。

**验证：** `bun test` 全部通过。

## T12: Anthropic client 工具支持**文件：** `src/llm/anthropic.ts`
**依赖：** T10
**步骤：**
1. `stream` 函数签名加 `toolSchemas: Record<string, unknown>[]`。
2. `tools = toolSchemas.map(s => ({ name: s.name, description: s.description ?? "", input_schema: { type: "object", properties: s.input_schema?.properties ?? {}, required: s.input_schema?.required ?? [] } }))`；非空时 `params.tools = tools`。
3. 流循环 switch `event.type`：
   - `content_block_start`：`block.type === "tool_use"` → 记 `currentToolName`/`currentToolId` + `jsonAccum = ""` + yield `tool_call_start`；`block.type === "thinking"` → `inThinking = true`。
   - `content_block_delta`：分派 `text_delta` / `thinking_delta` / `signature_delta` / `input_json_delta`（累计 `jsonAccum` 后 yield `tool_call_delta`）。
   - `content_block_stop`：`inThinking` → yield `thinking_complete`；`currentToolName` 非空 → `JSON.parse(jsonAccum)` fallback `{}` 后 yield `tool_call_complete`，清空状态。
   - `message_delta`：拿 `stop_reason` / `output_tokens`。
   - `message_start`：拿 `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`。
4. 流结束 yield `stream_end` 带 `stopReason` + `usage`。
5. `buildAnthropicMessages(history)`：
   - assistant：把 `thinkingBlocks` 转 `{ type: "thinking", thinking, signature }`；`content` 非空 → `{ type: "text", text }`；`toolUses` → `{ type: "tool_use", id, name, input }`。blocks 空时塞一个空 text。
   - 含 `toolResults` 的消息 → `{ role: "user", content: toolResults.map(tr => ({ type: "tool_result", tool_use_id, is_error, content })) }`。
   - 其余 user 文本沿用现有合并策略。

**验证：** `bun x tsc --noEmit`；启动 `bun run src/main.tsx` 与 Anthropic 配置发一条纯文本仍正常。

## T13: OpenAI client（Responses + Chat Completions）工具支持**文件：** `src/llm/openai.ts`
**依赖：** T10
**步骤：**
1. **OpenAIClient（Responses API）**：
   - `tools = toolSchemas.map(s => ({ type: "function", name: s.name, description: s.description ?? "", parameters: s.input_schema, strict: false }))`。
   - 流循环：
     - `response.output_text.delta` → `text_delta`。
     - `response.output_item.added` + `item.type === "function_call"` → 记 `name` / `call_id`，yield `tool_call_start`。
     - `response.function_call_arguments.delta` → 累计 `jsonAccum` + yield `tool_call_delta`。
     - `response.output_item.done` + `function_call` + `currentToolName` 非空 → `JSON.parse(jsonAccum)` fallback `{}` → yield `tool_call_complete`，清状态。
     - `response.completed` → 拿 `usage`，处理 `status === "incomplete"` 且 `incomplete_details.reason === "max_output_tokens"` 转 `stopReason = "max_tokens"`，yield `stream_end`。
   - `buildOpenAIInput(history)`：assistant 有 `toolUses` → 若 `content` 非空 push `{ role: "assistant", content }`，再为每个 `tu` push `{ type: "function_call", name, call_id, arguments: JSON.stringify(args) }`；`toolResults` → 每个 push `{ type: "function_call_output", call_id, output: content }`。

2. **OpenAICompatClient（Chat Completions）**：
   - `tools = toolSchemas.map(s => ({ type: "function", function: { name: s.name, description: s.description ?? "", parameters: s.input_schema } }))`。
   - 流循环：
     - `delta.content` → `text_delta`。
     - `delta.tool_calls`：用 `Map<number, { id, name, args }>` 按 `tc.index` 拼；首次见 index 且 `tc.id` 已到 → yield `tool_call_start`；累计 `tc.function.arguments`，yield `tool_call_delta`。
     - `chunk.choices[0].finish_reason` 到达 → 对 Map 中每个 entry `JSON.parse(args)` fallback `{}` → yield `tool_call_complete`。
   - `stopReason = finishReason === "length" ? "max_tokens" : (finishReason === "tool_calls" || toolCalls.size > 0) ? "tool_use" : "end_turn"`。
   - `buildChatCompletionMessages(history)`：assistant 有 `toolUses` → `{ role: "assistant", content: m.content || null, tool_calls: m.toolUses.map(tu => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) }`；`toolResults` → 每个 `{ role: "tool", tool_call_id, content }`。

**验证：** `bun x tsc --noEmit`；用 `protocol: openai-compat` 配置 + 兼容端点发一条纯文本仍正常。

## T14: AgentEvent + StreamingExecutor**文件：** `src/agent/events.ts`、`src/agent/streaming-executor.ts`
**依赖：** T1, T3
**步骤：**
1. `events.ts`：定义 `AgentEvent` 联合类型（共 9 个 type：`stream_text` / `thinking_text` / `thinking_complete` / `tool_use` / `tool_result` / `turn_complete` / `loop_complete` / `usage` / `error`）。
2. `streaming-executor.ts`：
   - `class StreamingExecutor`：构造接受 `registry` + `ctx: ToolContext`；私有 `pending: PendingCall[]`。
   - `submit(toolId, toolName, args)` push 到 pending。
   - `collectResults()`：把 pending swap 出来；`Promise.all` 跑每个 call：
     - `tool = registry.get(call.toolName)`；未命中 → `{ output: \`Error: unknown tool '${call.toolName}'\`, isError: true }`。
     - try `await tool.execute(args, ctx)`；catch 包成 `Error executing <name>: <msg>` 错误。
     - 都附 `elapsed = (Date.now() - start) / 1000`。

**验证：** `bun x tsc --noEmit`；可写一个临时单测：提交一个未知工具名 + 一个真实 `ReadFile`，断言并发返回两条结果。

## T15: Agent.run（单轮闭环）**文件：** `src/agent/agent.ts`、`tests/agent/agent.test.ts`
**依赖：** T11, T12, T13, T14
**步骤：**
1. `agent.ts`：
   - `class Agent`：构造接 `AgentConfig { client, registry, conversation, workDir, abortSignal? }`。
   - `async *run(): AsyncGenerator<AgentEvent>`：
     ```ts
     const toolSchemas = this.registry.getAllSchemas();
     while (true) {
       let fullText = "";
       const thinkingBlocks: ThinkingBlock[] = [];
       const toolUses: ToolUseBlock[] = [];
       let stopReason = "end_turn";

       const stream = this.client.stream(this.conversation, toolSchemas, this.abortSignal);
       for await (const event of stream) {
         switch (event.type) {
           case "text_delta":
             fullText += event.text;
             yield { type: "stream_text", text: event.text };
             break;
           case "thinking_complete":
             thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
             yield { type: "thinking_complete", thinking: event.thinking, signature: event.signature };
             break;
           case "tool_call_complete":
             toolUses.push({ toolUseId: event.toolId, toolName: event.toolName, arguments: event.arguments });
             yield { type: "tool_use", toolName: event.toolName, toolId: event.toolId, args: event.arguments };
             break;
           case "stream_end":
             stopReason = event.stopReason;
             yield { type: "usage", usage: event.usage };
             break;
         }
       }

       this.conversation.addAssistantFull(fullText, thinkingBlocks, toolUses);

       if (toolUses.length === 0) {
         yield { type: "loop_complete", stopReason };
         return;
       }

       const executor = new StreamingExecutor(this.registry, { workDir: this.workDir, abortSignal: this.abortSignal });
       for (const tu of toolUses) executor.submit(tu.toolUseId, tu.toolName, tu.arguments);
       const results = await executor.collectResults();

       const toolResultBlocks: ToolResultBlock[] = [];
       for (const r of results) {
         yield { type: "tool_result", toolName: r.toolName, toolId: r.toolId, output: r.result.output, isError: r.result.isError, elapsed: r.elapsed };
         toolResultBlocks.push({ toolUseId: r.toolId, content: r.result.output, isError: r.result.isError });
       }
       this.conversation.addToolResultsMessage(toolResultBlocks);
       yield { type: "turn_complete" };

       // 本章单轮收口：拿到工具结果后直接结束，不再回到 stream
       yield { type: "loop_complete", stopReason: "tool_use" };
       return;
     }
     ```
2. `tests/agent/agent.test.ts`：实现一个 `FakeLLMClient implements LLMClient`：可配置两次 `stream` 调用各自吐什么事件。
   - 脚本 (a)：第一次吐 `tool_call_complete(ReadFile, { file_path: <tmp> })` + `stream_end` → 第二次吐 `text_delta("ok")` + `stream_end` → 由于单轮收口，本章 agent 第二次 stream 应不被调用。修正断言：第一次 stream 产生 `tool_use` + `tool_result` 后直接 `loop_complete`。
   - 脚本 (b)：第一次吐 `text_delta("hi") + stream_end`（无工具）→ 断言只跑一遍 stream、`loop_complete` 出现且 `conv.getMessages()` 最后是 `role: "assistant", content: "hi"`。

**验证：** `bun test tests/agent/agent.test.ts` 通过。

## T16: 系统提示词 sections 扩展**文件：** `src/prompt/sections.ts`
**依赖：** 无
**步骤：**
1. 新增 `usingToolsSection()`（priority ~40）：说明 MewCode 是能调用 6 个工具的 Agent，逐个列出何时用、何时不用（`ReadFile` 优先用绝对路径；`Bash` 不要用 `cat`/`head`；改文件先 `ReadFile` 后 `EditFile`；`Glob` 找文件名、`Grep` 找内容）。
2. 新增 `executingActionsSection()`（priority ~50）：列写文件 / Bash 的安全规约（不要破坏性 git、不要 `--no-verify`）。
3. `builder.ts` 的 `buildSystemPrompt` 把这两个 section 加入排序拼接（若 ch02 已有 `PromptBuilder` 通过 `.add(s)` 链式调用，则在工厂函数里 `.add(usingToolsSection()).add(executingActionsSection())`）。

**验证：** `bun x tsc --noEmit`；启动 app 后问「你能做什么」答复体现工具能力。

## T17: TUI 工具行渲染**文件：** `src/tui/tool-display.tsx`、`src/tui/chat.tsx`
**依赖：** T15
**步骤：**
1. `tool-display.tsx`：
   - 导出 `interface ToolBlockInfo { toolName, args, output?, isError?, elapsed?, loading? }`。
   - `ToolDisplay({ tools }: { tools: ToolBlockInfo[] })`：`<Box flexDirection="column" paddingLeft={1}>` 渲染。
   - `ToolBlock`：`loading` → `<Text>● ToolName argSummary</Text>` magenta `●`；结束态 → `{icon} ToolName argSummary (Ns)` + 缩进 dimmed output；icon = `isError ? ✗ : ✓`。
   - `formatArgs(args)` 优先取 `command` / `file_path` / `pattern`，`truncate(s, 80)`。
2. `chat.tsx`：
   - `ChatMessage.role` 联合扩展为 `"user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary"`；新增可选字段 `toolName` / `argsSummary` / `isError` / `elapsed`。
   - `MessageBlock` switch role 分派；`tool_use` / `tool_result` 内部调 `ToolDisplay`（单个块）。

**验证：** `bun x tsc --noEmit`；启动 app 不报错。

## T18: App.tsx 装配 + 事件循环**文件：** `src/tui/app.tsx`、`src/main.tsx`
**依赖：** T15, T16, T17
**步骤：**
1. `app.tsx`：
   - 新增 `createToolRegistry(workDir)`：顺序 `register` 6 个工具。
   - 在 submit 流程里：
     ```tsx
     conv.addUserMessage(text);
     const agent = new Agent({ client, registry, conversation: conv, workDir });
     for await (const ev of agent.run()) {
       switch (ev.type) {
         case "stream_text": setStreamingText(prev => prev + ev.text); break;
         case "tool_use":
           setMessages(prev => [...prev, { role: "tool_use", content: "", toolName: ev.toolName, toolId: ev.toolId, argsSummary: formatArgs(ev.args) }]);
           break;
         case "tool_result":
           setMessages(prev => prev.map(m => m.toolId === ev.toolId ? { ...m, role: "tool_result", content: ev.output, isError: ev.isError, elapsed: ev.elapsed } : m));
           break;
         case "loop_complete":
           // flush streamingText 为一条 assistant 消息
           setMessages(prev => streamingText ? [...prev, { role: "assistant", content: streamingText }] : prev);
           setStreamingText("");
           break;
       }
     }
     ```
2. `main.tsx`：`render(<App providers={...} />)`，不需要直接动 registry（registry 在 `app.tsx` 内部构造）。

**验证：** `bun x tsc --noEmit`；`bun run src/main.tsx` 启动正常进入对话。

## T19: 全量验证与端到端冒烟**文件：** 无（验证）
**依赖：** T1–T18
**步骤：**
1. `bun x tsc --noEmit`；`bun test`。
2. 用当前 `.mewcode/config.yaml`（openai-compat 端点）跑：问「读 docs/typescript/ch03/spec.md 并用一句话总结」→ 观察工具行 `● ReadFile docs/typescript/ch03/spec.md` + 结果摘要 + 最终答复。
3. 触发各错误：读不存在文件、edit 匹配不到、bash 非零退出 → 结构化错误回灌、UI `✗` 红色标记、程序不退出。
4. 若有 anthropic 配置，重复步骤 2 验证跨协议一致。

**验证：** 全部命令通过；端到端链路与错误恢复符合预期。

## 执行顺序

```text
T1 ──┬─ T2 ─┬─ T3 ──────────────────┐
     │      ├─ T4 ─┐                │
     │      ├─ T5 ─┤                │
     │      ├─ T6 ─┼─ T11 ──┐       │
     │      ├─ T7 ─┤        │       │
     │      ├─ T8 ─┤        │       │
     │      └─ T9 ─┘        │       │
     │                      │       │
     └─ T10 ─┬─ T12 ────────┤       │
             └─ T13 ────────┤       │
                            │       │
                          T14 ──┬───┘
                                │
                          T11,T12,T13,T14 ─→ T15 ─→ T17 ─→ T18 ─→ T19
                          T16 ──────────────────────────┘
```
# Agent Loop Tasks

> 模块路径 `src/agent/*`、`src/llm/*`、`src/tools/*`、`src/conversation/*`、`src/prompt/*`、`src/permissions/*`、`src/tui/*`，运行时 bun + TypeScript 5.x。任务有序，每步留绿 `tsc --noEmit`。验证一律「先跑命令看输出，再下结论」。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/agent/events.ts` | `AgentEvent` discriminated union |
| 新增 | `src/agent/streaming-executor.ts` | `StreamingExecutor` 工具批执行器 |
| 新增 | `src/agent/agent.ts` | `Agent` 类与 `run()` AsyncGenerator |
| 修改 | `src/llm/events.ts` | `StreamEvent` 增 `stream_end`、`UsageInfo` 类型 |
| 修改 | `src/llm/client.ts` | `LLMClient.stream(conv, tools, abortSignal)` 签名 |
| 修改 | `src/llm/anthropic.ts` | `AsyncGenerator<StreamEvent>`，`stream_end` 携带 usage |
| 修改 | `src/llm/openai.ts` | `stream_options.include_usage`，OpenAICompat 同步 |
| 新增 | `src/llm/errors.ts` | `ContextTooLongError`、`RateLimitError` 等错误类 |
| 修改 | `src/tools/types.ts` | `Tool` 接口加 `category: ToolCategory` |
| 修改 | `src/tools/registry.ts` | `getAllSchemas(protocol)` 协议适配 |
| 修改 | `src/tools/{read-file,glob,grep,write-file,edit-file,bash}.ts` | 各打 `category` |
| 修改 | `src/conversation/conversation.ts` | `addAssistantFull` / `addToolResultsMessage` / `addSystemReminder` |
| 新增 | `src/prompt/plan-mode.ts` | `buildPlanModeReminder` + 完整/精简模板 |
| 新增 | `src/permissions/checker.ts` | `PermissionChecker` 占位实现 |
| 修改 | `src/tui/app.tsx` | `useEffect` 消费 `agent.run()`、`useInput` 取消 |
| 新增 | `src/agent/agent.test.ts` | 多轮 fake client、并发分批、停止条件、Plan 工具集 |

## T1: 定义 `AgentEvent` 与 `UsageInfo`（纯新增，向后兼容）

**文件：** `src/agent/events.ts`、`src/llm/events.ts`
**依赖：** 无
**步骤：**
1. `src/llm/events.ts`：新增 `interface UsageInfo { inputTokens; outputTokens; cacheReadInputTokens; cacheCreationInputTokens }`；扩展 `StreamEvent` 联合类型加 `tool_call_start` / `tool_call_delta` / `tool_call_complete` / `stream_end { stopReason, usage }`。
2. `src/agent/events.ts`：定义 `AgentEvent` discriminated union（spec 列出的全部 9 个 `type` 分支）。

**验证：** `tsc --noEmit` 通过（纯新增类型）。

## T2: 工具 `category` 分类与多协议 schema

**文件：** `src/tools/types.ts`、`src/tools/registry.ts`、`src/tools/{read-file,glob,grep,write-file,edit-file,bash}.ts`
**依赖：** 无
**步骤：**
1. `types.ts`：`export type ToolCategory = "read" | "write" | "command"`；`Tool` 接口加 `category: ToolCategory` 字段（必填，编译器会强制每个工具实现都补上）。
2. 6 个工具实现里各加一行 `category = "read" as const` 或 `"write"` / `"command"`：
   - `read-file.ts` / `glob.ts` / `grep.ts` → `"read"`
   - `write-file.ts` / `edit-file.ts` → `"write"`
   - `bash.ts` → `"command"`
3. `registry.ts`：`getAllSchemas(protocol: "anthropic" | "openai" | "openai-compat" = "anthropic")`——`"anthropic"` 直返 `tool.schema()`；`"openai"` / `"openai-compat"` 包装成 `{ type: "function", function: { name, description, parameters: base.input_schema } }`。

**验证：** `bun test` 全通过（接口加必填字段后 6 工具均实现，编译即证明完整）；`tsc --noEmit` 通过。

## T3: `ConversationManager` 三个新方法

**文件：** `src/conversation/conversation.ts`、`src/conversation/conversation.test.ts`（已有）
**依赖：** 无
**步骤：**
1. `addAssistantFull(text, toolUses, thinkingBlocks)`：push `{ role: "assistant", content: text, thinkingBlocks: thinking.length > 0 ? thinking : undefined, toolUses: toolUses.length > 0 ? toolUses : undefined }`。
2. `addToolResultsMessage(results: ToolResultBlock[])`：push `{ role: "user", content: "", toolResults: results }`。
3. `addSystemReminder(content: string)`：push `{ role: "user", content: \`<system-reminder>\n${content}\n</system-reminder>\` }`。
4. 测试：每个新方法补 1 条单测——`getMessages()` 返回的最后一条结构正确（含 `toolResults` 数组、`toolUses` 数组、`<system-reminder>` 包裹标签）。

**验证：** `bun test src/conversation` 通过。

## T4: `buildPlanModeReminder` 与 plan 模板

**文件：** `src/prompt/plan-mode.ts`
**依赖：** 无
**步骤：**
1. 定义两个模板常量：`planModeFullReminder`（含 5 阶段 Workflow：Initial Understanding / Design / Review / Final Plan / `ExitPlanMode`）、`planModeSparseReminder`（只剩关键规则）。
2. `buildPlanModeReminder(planPath, planExist, iteration)`：
   - 构造 `planFileInfo`：`"Plan file: ${planPath}"` + （存在则提示「可继续编辑」 / 不存在则提示「用 WriteFile 创建」）。
   - `iteration === 1` 返回 `planModeFullReminder.replace("%PLAN_FILE_INFO%", planFileInfo)`。
   - 其余按 `reminderInterval = 5` 切换完整/精简（精简版替换 `%PLAN_PATH%`）。
3. 顺便补 `buildPlanModeExitReminder` / `buildPlanModeReentryReminder`（TUI 切换 plan/normal 时用）。

**验证：** `bun test src/prompt` 通过；`tsc --noEmit` 无错误。

## T5: `LLMClient.stream()` 签名升级与适配器扩展

**文件：** `src/llm/client.ts`、`src/llm/anthropic.ts`、`src/llm/openai.ts`、`src/llm/errors.ts`
**依赖：** T1
**步骤：**
1. `src/llm/errors.ts`：导出错误类——`LLMError`（基类）、`AuthenticationError`、`ContextTooLongError`、`RateLimitError`（带 `retryAfter?: string` 字段）、`NetworkError`。
2. `client.ts`：`LLMClient.stream(conv, tools, abortSignal?)` 返回 `AsyncGenerator<StreamEvent>`；保留 `MaxTokensSetter` 副接口（占位，后续章节用）；`createClient(cfg, systemPrompt)` 工厂按 `cfg.protocol` 动态 `await import("./anthropic.js")` / `await import("./openai.js")`。
3. `anthropic.ts`：`async *stream(...)`——
   - 构造 `params`：`model`、`max_tokens`、`system: this.systemPrompt`、`tools`、`messages: toAnthropicMessages(conv.getMessages())`、`signal: abortSignal`。
   - 用 `for await (const event of this.client.messages.stream(params))` 翻译事件：`content_block_delta.text_delta` → `text_delta`、`content_block_delta.input_json_delta` 拼到该 tool 的 args buffer、`content_block_stop` 把 buffer JSON.parse 后 yield `tool_call_complete`、`message_stop` 读 `event.message.stop_reason` 与 `event.message.usage` yield `stream_end`。
   - 把 SDK 错误归一化为 `ContextTooLongError` / `RateLimitError` / `AuthenticationError` / `NetworkError` 再 throw。
4. `openai.ts`：同结构——
   - 构造请求：`stream: true`、`stream_options: { include_usage: true }`、`tools`、`signal: abortSignal`。
   - 翻译 `chunk.choices[0].delta.content` → `text_delta`；`delta.tool_calls[i].function.arguments` 拼分片；末尾 `finish_reason` + `chunk.usage` yield `stream_end`。

**验证：** `tsc --noEmit` 通过；`bun test src/llm` 通过（含 fake provider 用 `AsyncGenerator` 模拟流的单测）。

## T6: `Agent` ReAct 循环主体（核心）

**文件：** `src/agent/agent.ts`、`src/agent/streaming-executor.ts`、`src/permissions/checker.ts`、`src/agent/agent.test.ts`
**依赖：** T1, T2, T3, T4, T5
**步骤：**
1. `streaming-executor.ts`：按 plan 给出的签名实现 `submit()` / `collectResults()`——`Promise.all` 跑工具，未注册返回 `"Error: unknown tool '...'"`、`execute` throw 时返回 `"Error executing ${name}: ${err.message}"`，记录 `elapsed = (Date.now() - start) / 1000`。
2. `checker.ts`：定义 `PermissionMode` / `Decision` 类型；`PermissionChecker` 类含 `mode` 字段与 `check()` 方法，本章 `"plan"` 模式 deny 非 read 工具、其余 `allow`；保留 `allowAlways()` 占位。
3. `agent.ts`：
   - 导入 `AgentEvent`、`LLMClient`、`ConversationManager`、`ToolRegistry`、`PermissionChecker`、`StreamingExecutor`、`buildPlanModeReminder`。
   - 定义 `AgentConfig` 接口 + `Agent` 类（按 plan 给出的字段列表）。
   - `MAX_OUTPUT_CHARS = 10000` 常量。
   - `async *run(): AsyncGenerator<AgentEvent>`：按 plan 「`run()` 算法」逐步实现：
     1. 取 `toolSchemas = this.registry.getAllSchemas()`。
     2. `iteration`、`consecutiveUnknown`、`looping` 状态变量。
     3. `while (looping)` 内：iteration 上限检查 → plan 模式 `addSystemReminder` → 创建 `stream` → `for await` 收集 → `catch` 错误（区分 `aborted` / 其他错误 / `ContextTooLongError`：本章只把 `ContextTooLongError` 当普通 error 处理，留 ch07 接 `forceCompact`）→ 取消检测 → `addAssistantFull` → 有工具走 `executeTools` 路径、无工具 yield `loop_complete`。
   - `executeTools(toolUses)`：按 `category` 切两组、只读批 `executeBatch(readSafe, true)`、写入批 `executeBatch([tu], false)`。
   - `executeBatch(toolUses, parallel)`：循环 submit；`parallel === true` 末尾 `await executor.collectResults()`，否则每次 submit 后立即 collect；每个 result 经 `processToolResult` 转成 `AgentEvent.tool_result` push 进 `events`。
   - `processToolResult(r, toolUses, events)`：本章只做 push（后续章节接 file snapshot / hooks）。
4. `agent.test.ts`：写 6 个场景用例（用 `mock` 的 `LLMClient` 与自定义工具）。
   - **场景 A（多轮 AC1）**：`fakeClient` 维护 `scripts: StreamEvent[][]`，第一次 yield 一个 `tool_call_complete` (ReadFile) + `stream_end`，第二次 yield `text_delta` + `stream_end`；断言事件序列含 `tool_use`、`tool_result`、`turn_complete`、`stream_text`、`loop_complete`；`conversation.getMessages()` 末尾是 assistant 文本。
   - **场景 B（上限 AC3）**：`fakeClient` 恒返工具调用；`new Agent({ maxIterations: 5, ... })`；断言收到 `{ type: "error" }`、`fakeClient.callCount === 5`。
   - **场景 C（未知工具 AC4）**：`fakeClient` 连续返回未注册工具名 3 次；断言第 3 轮后 yield `error`；另一用例第 2 轮混入一个 ReadFile 调用、断言计数重置、不提前停。
   - **场景 D（保序分批 AC8）**：自定义 registry 注册两个插桩工具：`SlowRead`（`category: "read"`，execute 内记录开始时间并 sleep 50ms）、`SlowWrite`（`category: "write"`，记录开始时间并 sleep 50ms）。脚本一轮返回 `[SlowRead, SlowRead, SlowWrite]`；断言两 SlowRead 的执行时间窗重叠（`endA > startB && endB > startA`）、SlowWrite 的 `startTime` 晚于两个 SlowRead 的 `endTime`、`events` 内 `tool_result` 顺序匹配调用序。
   - **场景 E（取消 AC9 AC10）**：插桩工具 execute 中阻塞 1s；测试侧在 100ms 后调 `abortController.abort()`；断言 generator 最终 yield `{ type: "loop_complete", stopReason: "interrupted" }`、`conversation.getMessages()` 末尾配对合法（最后一条是 assistant 文本，无悬空 tool_use）。
   - **场景 F（Plan Mode AC13）**：`checker.mode = "plan"`；`fakeClient` 把收到的 `messages` 记录下来；断言最后一条 message 的 content 含 `"<system-reminder>"` + `"Plan mode is active"`；模拟模型调用 `ExitPlanMode` → 断言下一轮不再继续，yield `loop_complete`。

**验证：** `bun test src/agent` 全通过；`tsc --noEmit` 无错误。

## T7: TUI 接入 `agent.run()` 事件流

**文件：** `src/tui/app.tsx`
**依赖：** T6
**步骤：**
1. `useState` 维护：`messages: ChatMessage[]`、`currentReply: string`、`currentTools: ToolBlockInfo[]`、`streaming: boolean`、`iteration: number`、`usage: { in: number; out: number }`。
2. `useRef<AbortController | null>(null)` 持本轮 controller。
3. `useInput((input, key) => { ... })`：
   - `key.ctrl && input === "c"`：`streaming` 为真则 `abortRef.current?.abort()`（不退应用）；否则 `exit()`（退应用）。
   - `key.escape && streaming`：`abortRef.current?.abort()`。
4. `submit(text)` 异步函数：
   - `conversation.addUserMessage(text)`；`setStreaming(true)`；新建 `AbortController`。
   - `const agent = new Agent({ client, registry, checker, conversation, workDir, abortSignal })`。
   - `for await (const ev of agent.run())` 按 `switch (ev.type)` 分派：
     - `stream_text` → `setCurrentReply(s => s + ev.text)`。
     - `tool_use` → `setCurrentTools(ts => [...ts, { name: ev.toolName, id: ev.toolId, args: ev.args, status: "running" }])`；若 `currentReply` 非空先把 preamble 提交 messages 并清空。
     - `tool_result` → 把队首匹配 `ev.toolId` 的工具标 done 并提交一条 `messages` 行；`setCurrentTools` 移除该条。
     - `usage` → `setUsage(u => ({ in: u.in + ev.usage.inputTokens, out: u.out + ev.usage.outputTokens }))`。
     - `turn_complete` → `setIteration(i => i + 1)`。
     - `loop_complete` → `setMessages([..., { role: "assistant", content: currentReply, stopReason: ev.stopReason }])`、清 `currentReply` / `currentTools` / `iteration`。
     - `error` → push 一条灰色错误 message。
   - `finally` 块：`setStreaming(false)`、`abortRef.current = null`。
5. 渲染：`<Static items={messages}>` 历史区不重渲染；动态区里 `currentTools.map(t => <ToolDisplay ... />)`；状态栏组件接收 `usage`、`iteration` 作为 props 显示。

**验证：** `bun run src/main.tsx`（需 `.mewcode/config.yaml` 配好 provider）启动 Ink 应用、跑一条多轮任务、Esc 中断、再发一条继续；`tsc --noEmit` 无错误。

## T8: 全量验证与端到端冒烟

**文件：** 无（验证）
**依赖：** T1–T7
**步骤：**
1. `tsc --noEmit`（编译期类型检查）。
2. `bun test`（全量单测，含 agent / llm / tools / conversation）。
3. 端到端（openai-compat 端点，用 `.mewcode/config.yaml`）：
   - 多轮（AC1）：问「读 `docs/ch03/spec.md`，再据其内容新建 `docs/ch03/summary.txt` 写一句话摘要」→ 观察 ReadFile → WriteFile 跨多轮自动连环、状态栏用量增长、动态区轮次递增、最终答复。
   - 取消（AC10）：发一个会跑多步的任务，中途按 Esc / Ctrl+C → 回空闲态不退出 → 再正常发一条继续对话（验证历史未坏）。
   - 流出错（AC5）：临时改坏 `base_url` 或断网发一条 → 错误提示、Ink 应用不退出、改回后继续。
   - Plan Mode（AC13）：把 `checker.mode` 切到 `"plan"` → 问「给登录功能加单测的方案」→ 观察只出现 Read/Glob/Grep + 计划文本、无 Write/Bash → 模拟 `ExitPlanMode` 工具 → 切回正常模式。
4. （可选）若有 anthropic 配置，重复多轮场景验证跨协议一致（AC14）。

**验证：** 全部命令通过、端到端各场景符合预期；密钥不回显（通读输出，AC/N7）。

## 执行顺序

```text
T1 ─┬─ T5 ─┐
T2 ─┤      │
T3 ─┼──────┼─ T6 ─┬─ T7 ─┐
T4 ─┘      │      │      │
           └──────┘      └─ T8
```

（T1–T4 互相独立可并行；T5 依赖 T1；T6 依赖 T1/T2/T3/T4/T5；T7 依赖 T6；T8 收尾全部。）
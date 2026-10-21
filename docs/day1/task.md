# 多协议 LLM 终端对话客户端 Tasks

> 项目根目录运行 bun + TypeScript 5.x；入口 `src/main.tsx`，源代码放 `src/` 下，
> 配置放 `.mewcode/config.yaml`。所有任务在不开新进程的前提下，最终用
> `bun run src/main.tsx` 真实跑一遍验证。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `package.json` | 声明 bun / TypeScript / ink / SDK 等依赖与 scripts |
| 新建 | `tsconfig.json` | `target: ES2022`，`module: ESNext`，`jsx: react-jsx`，`strict: true` |
| 新建 | `.gitignore` | 忽略 `.mewcode/config.yaml`、`node_modules`、`bun.lock` 的临时产物 |
| 新建 | `.mewcode/config.yaml.example` | YAML 配置模板，含 anthropic 与 openai-compat 两条示例 |
| 新建 | `src/config/config.ts` | `AppConfig` / `ProviderConfig` / `loadConfig` / `resolveAPIKey` 等 |
| 新建 | `src/conversation/conversation.ts` | `ConversationManager`（本章只用 user/assistant 路径）|
| 新建 | `src/prompt/sections.ts` | 各 `Section` 工厂（身份、任务执行、工具使用、语气、环境信息等）|
| 新建 | `src/prompt/builder.ts` | `PromptBuilder` + `buildSystemPrompt` + `detectEnvironment` |
| 新建 | `src/llm/events.ts` | `StreamEvent` 联合类型 + `UsageInfo` |
| 新建 | `src/llm/errors.ts` | `LLMError` 及四个子类 |
| 新建 | `src/llm/client.ts` | `LLMClient` 接口 + `createClient` 动态分派工厂 |
| 新建 | `src/llm/anthropic.ts` | `AnthropicClient` + `fetchModelContextWindow` + `buildAnthropicMessages` |
| 新建 | `src/llm/openai.ts` | `OpenAIClient`（Responses）+ `OpenAICompatClient`（Chat Completions）|
| 新建 | `src/tui/styles.ts` | chalk 颜色与 unicode 符号 |
| 新建 | `src/tui/verbs.ts` | 随机动词与完成短语 |
| 新建 | `src/tui/spinner.tsx` | `<Spinner>`：`ink-spinner` + 秒数 + token |
| 新建 | `src/tui/status-bar.tsx` | `<StatusBar>`：mode 与 token 量 |
| 新建 | `src/tui/provider-select.tsx` | `<ProviderSelect>`：方向键 + Enter 选择 |
| 新建 | `src/tui/input.tsx` | `<InputBox>`：多行、Shift+Enter 换行、Enter 提交 |
| 新建 | `src/tui/chat.tsx` | `<ChatView>`、`<CommittedMessage>`：marked-terminal 渲染 |
| 新建 | `src/tui/app.tsx` | `<App>`：状态机、`handleSubmit`、流式聚合、退出 |
| 新建 | `src/main.tsx` | 入口：`loadConfig` + 光标 hook + `render(<App/>)` |
| 新建 | `tests/config.test.ts` | `bun test` 校验合法/缺字段/非法 protocol 配置 |
| 新建 | `tests/conversation.test.ts` | `bun test` 校验 `ConversationManager` 增删读 |

---

## T1: 初始化 bun + TypeScript 工程**文件：** `package.json`、`tsconfig.json`、`.gitignore`、`src/main.tsx`（临时占位）

**依赖：** 无

**步骤：**
1. `bun init` 后修改 `package.json`：`type: "module"`、`bin.mewcode: "./src/main.tsx"`；
   声明 dependencies：`@anthropic-ai/sdk`、`openai`、`ink`、`ink-spinner`、
   `ink-text-input`、`react@18`、`chalk`、`marked`、`marked-terminal`、`js-yaml`、
   `fuse.js`；devDependencies：`@types/bun`、`@types/react@18`、`@types/js-yaml`、
   `typescript`。
2. `package.json scripts`：`start: bun run src/main.tsx`、`test: bun test`、
   `typecheck: tsc --noEmit`。
3. `tsconfig.json`：`target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、
   `jsx: react-jsx`、`strict: true`、`noEmit: true`、`allowImportingTsExtensions: true`、
   `verbatimModuleSyntax: true`、`paths` 留空。
4. `.gitignore` 追加：`node_modules/`、`.mewcode/config.yaml`、`*.log`、`dist/`、
   保留 `.mewcode/config.yaml.example`。
5. 写一个临时 `src/main.tsx`：仅打印 `MewCode v0.1.0`，确保 `bun run src/main.tsx`
   能起、`tsc --noEmit` 通过。

**验证：** `bun install` 成功；`bun run src/main.tsx` 输出版本号；`tsc --noEmit`
零报错。

---

## T2: config 包**文件：** `src/config/config.ts`

**依赖：** T1

**步骤：**
1. 定义 `ProviderConfig` / `AppConfig` / `MCPServerConfig` / `HookConfig` 接口。本章
   只用到 `providers`，但 `AppConfig.mcp_servers` / `hooks` 需占位字段为
   `[]`，便于后续章节扩展。
2. 实现 `loadSingleFile(path)`：`readFileSync` → `js-yaml.load` → 取
   `providers / permission_mode / mcp_servers / hooks` 四个键，缺则默认 `[]`。
3. 实现 `mergeConfig(base, override)`：override 的 providers 非空时整列覆盖；
   `mcp_servers` 按 `name` 合并；`hooks` 追加。
4. 实现 `loadConfig(path?)`：
   - 显式 `path` → `loadSingleFile + validateProviders`；
   - 否则按顺序合并 `~/.mewcode/config.yaml` → `<cwd>/.mewcode/config.yaml`
     → `<cwd>/.mewcode/config.local.yaml`；三处全无则抛 `ConfigError("No config file
     found...")`。
5. 实现 `validateProviders`：空数组报 "At least one provider must be configured"；
   逐项检查 `name/protocol/base_url/model` 必填；`protocol ∈ {anthropic, openai,
   openai-compat}` 否则抛 `ConfigError("Provider #N: invalid protocol 'X', must be
   one of: ...")`。
6. 实现 `resolveAPIKey(p)`：优先 `p.api_key`，否则按 `ENV_KEY_MAP[p.protocol]`
   读取 `process.env`；都缺返回空字符串（构造 client 时再抛
   `AuthenticationError`）。
7. 实现 `getMaxOutputTokens(p)`：显式 `max_output_tokens > 0` 用之；`thinking` 真
   返回 64000；默认 8192。
8. 实现 `lookupModelContextWindow(model)` + `getContextWindow(p)` 同步版本（四级
   回退的 1、3、4 层）+ `getContextWindowAsync(p, fetcher?)` 异步版本（再加 2
   层：anthropic 协议时调用 `fetcher` 拿 `max_input_tokens`，失败降级，结果以
   `name+model` 为 key 缓存到 module 级 `Map`）；导出 `_resetContextWindowCache`
   方便测试。

**验证：** `tsc --noEmit` 无错；T18 的单测覆盖合法/缺字段/非法 protocol/无文件
四个分支。

---

## T3: 配置模板与忽略**文件：** `.mewcode/config.yaml.example`

**依赖：** T2

**步骤：**
1. 写两条 provider：一条 `protocol: anthropic` 含 `thinking: true`，一条
   `protocol: openai-compat` 指向某兼容端点；包含 `base_url`、`model`、`api_key`
   占位（写 `<your-key>` 字样）与 `# 也可改为 ANTHROPIC_API_KEY 环境变量` 注释。
2. 提示用户 `cp .mewcode/config.yaml.example .mewcode/config.yaml` 并填真 key。

**验证：** 复制成 `.mewcode/config.yaml` 后 `loadConfig()` 通过；`git status`
不再显示 `.mewcode/config.yaml`。

---

## T4: prompt 包**文件：** `src/prompt/sections.ts`、`src/prompt/builder.ts`

**依赖：** T1

**步骤：**
1. 在 `sections.ts` 声明 `Section { name, priority, content }` 与
   `EnvironmentContext`。导出 8 个工厂函数：`identitySection`（priority 0）、
   `systemSection`（10）、`doingTasksSection`（20）、`executingActionsSection`（30）、
   `usingToolsSection`（40）、`toneStyleSection`（50）、`outputEfficiencySection`（60）、
   `environmentSection(env)`（70）。文案用中文（保持与项目语种一致）。
2. 在 `builder.ts` 实现 `PromptBuilder.add(s).build()`：按 priority 升序，`content.trim()`
   非空时用 `"\n\n"` 拼接。
3. 实现 `detectEnvironment(workDir)`：`platform()` / `arch()` 来自 `node:os`，
   `process.env.SHELL ?? "bash"`，用 `execSync("git rev-parse --is-inside-work-tree")`
   判定 git 仓库（失败 catch 静默），是则再 `execSync("git rev-parse --abbrev-ref HEAD")`
   取分支名；`date` 用 `new Date().toISOString().split("T")[0]`。
4. 实现 `buildSystemPrompt(env, opts)`：默认依次 add 8 个内置 section，再按需 add
   `Skills`（90）、`CustomInstructions`（95）、`Memory`（100）三个 opt section。

**验证：** `tsc --noEmit` 无错；在 T17 入口里调用一次，肉眼检查输出包含 "MewCode"、
"# 任务执行"、`workDir`、`date` 等关键字。

---

## T5: llm 公共类型与错误**文件：** `src/llm/events.ts`、`src/llm/errors.ts`

**依赖：** T1

**步骤：**
1. `events.ts` 导出 `UsageInfo { inputTokens, outputTokens, cacheReadInputTokens,
   cacheCreationInputTokens }` 与 `StreamEvent` 联合（七种 type，参见 plan.md）。
2. `errors.ts` 导出 `LLMError extends Error`，四个子类
   `AuthenticationError` / `RateLimitError` / `NetworkError` /
   `ContextTooLongError`。`RateLimitError` 额外携带 `retryAfter?: string`。

**验证：** `tsc --noEmit` 无错。

---

## T6: conversation 包**文件：** `src/conversation/conversation.ts`

**依赖：** T5

**步骤：**
1. 声明 `ToolUseBlock` / `ToolResultBlock` / `ThinkingBlock` / `Message` 接口
   （即便本章只用纯文本字段，也一次性建好结构，后续章节直接复用）。
2. 实现 `ConversationManager`：
   - 私有 `history: Message[] = []`、`ltmInjected = false`；
   - `addUserMessage(content)` / `addAssistantMessage(content)` 直接 push；
   - `getMessages()` 返回 `[...history]` 副本；
   - `len()` / `truncateTo(index)`；
   - 占位 `addAssistantFull` / `addToolUseMessage` / `addAssistantMessageWithTools`
     / `addToolResultMessage` / `addToolResultsMessage` / `addSystemReminder` /
     `injectLongTermMemory` / `replaceWithCompacted`（本章不被 TUI 调用，但其它
     模块的类型签名需要它们）。

**验证：** T18 的单测覆盖 user/assistant 顺序与 `getMessages` 返回副本（修改副本
不影响原历史）。

---

## T7: llm 工厂**文件：** `src/llm/client.ts`

**依赖：** T5、T6、T2

**步骤：**
1. 导出 `LLMClient { stream(conv, tools, signal?): AsyncGenerator<StreamEvent> }`
   与 `MaxTokensSetter { setMaxOutputTokens(n: number): void }`。
2. 导出 `createClient(cfg, systemPrompt): Promise<LLMClient>`：用
   `await import("./anthropic.js")` / `./openai.js` 按 protocol 动态加载，未知
   protocol 抛普通 `Error`（已在配置层过滤过，理论不会触发）。

**验证：** `tsc --noEmit` 无错；占位 stub（在 T8、T9 之前可让 client 类临时返回空
generator）。

---

## T8: anthropic 适配器**文件：** `src/llm/anthropic.ts`

**依赖：** T7、T4

**步骤：**
1. `fetchModelContextWindow(cfg)`：仅 `cfg.protocol === "anthropic"` 时发请求；
   3 秒超时；GET `{base_url}/v1/models/{encodeURIComponent(cfg.model)}`，header 带
   `anthropic-version: 2023-06-01` 与可选 `x-api-key`。任何失败/非数字字段返回 0。
2. `buildAnthropicMessages(history)`：把 `Message[]` 转 `Anthropic.MessageParam[]`：
   - assistant：组合 `thinking` / `text` / `tool_use` 三类 ContentBlock；
   - user 带 `toolResults` 的：转 `tool_result` blocks；
   - 普通 user 文本：与上一条 user 文本合并（避免破坏 user/assistant 交替）。
3. `markLastUserTailForCache(messages)`：把最后一条普通 user 内容数组的最后一块标
   `cache_control: { type: "ephemeral" }`。
4. `AnthropicClient`：
   - 构造时 `resolveAPIKey(cfg)`，空则抛 `AuthenticationError`；
   - `new Anthropic({ apiKey, baseURL: cfg.base_url })`；保存 `maxOutputTokens`
     与 `contextWindow`（来自 T2 的同步推导）；
   - `stream(conv, toolSchemas, signal?)`：构造 `MessageCreateParamsStreaming`，
     `system` 数组里塞 `{type:"text", text: systemPrompt, cache_control:"ephemeral"}`，
     `messages` 用 `buildAnthropicMessages(conv.getMessages())`，最后一个 user 内容块
     打 cache 标。
   - 本章 `toolSchemas` 默认空数组；若非空也支持（不要因此报错）。
   - `thinking === true` 时把 `thinking: { type:"enabled", budget_tokens:
     maxOutputTokens - 1 }` 注入到 params。
   - `for await (const event of client.messages.stream(params, { signal }))`：
     - `content_block_start` type=thinking → 进入 thinking 累积；type=tool_use →
       yield `tool_call_start`；
     - `content_block_delta`：`thinking_delta` → yield `thinking_delta`；
       `signature_delta` → 累积 signature；`text_delta` → yield `text_delta`；
       `input_json_delta` → yield `tool_call_delta`；
     - `content_block_stop`：thinking 收尾 yield `thinking_complete`；tool 收尾
       JSON.parse 后 yield `tool_call_complete`；
     - `message_delta`：取 `stop_reason` 与 `output_tokens`；
     - `message_start`：取 input/output/cache usage。
   - 迭代结束 yield `stream_end`。
   - 异常路径 `classifyAnthropicError`：401→Auth、429→RateLimit（读 `retry-after`
     header）、413 或 message 含 `prompt is too long`→ContextTooLong、其它→
     `LLMError`；非 `Anthropic.APIError`→`NetworkError`。

**验证：** `tsc --noEmit` 无错；用假 key 跑一次预期看到 `AuthenticationError` 在
对话区红字（在 T14、T17 联调时）。

---

## T9: openai 适配器（Responses + Chat Completions）**文件：** `src/llm/openai.ts`

**依赖：** T7、T4

**步骤：**
1. `buildOpenAIInput(history)`：把 `Message[]` 转 Responses API 的输入数组：
   - assistant 有 toolUses：先 push 文本（若有）再 push `function_call`；
   - user 有 toolResults：push 多个 `function_call_output`；
   - 其它：push `{role, content}`。
2. `buildChatCompletionMessages(history)`：转 ChatCompletionMessageParam[]：
   - assistant 有 toolUses：`role:"assistant"` + `tool_calls: [{id, type:"function",
     function: {name, arguments: JSON.stringify(args)}}]`；
   - user 有 toolResults：每条 push `role:"tool", tool_call_id, content`；
   - 其它：`role: m.role === "system" ? "system" : "user" | "assistant"`。
3. `OpenAIClient`（Responses API）：
   - 构造 `new OpenAI({ apiKey, baseURL: cfg.base_url })`；空 key 抛
     `AuthenticationError`。
   - `stream(...)`：input 数组首条塞 `{role:"system", content: systemPrompt}`，
     后接 `buildOpenAIInput(history)`；`stream: true`、`max_output_tokens`、
     可选 `tools`。
   - `for await (event of client.responses.create(params, { signal }))`：关心
     `response.output_text.delta`、`response.function_call_arguments.delta`、
     `response.output_item.added`、`response.output_item.done`、
     `response.completed`。
   - `response.completed` 时读 `usage.output_tokens`、
     `input_tokens_details.cached_tokens`，`inputTokens = max(0, input_tokens -
     cached)`；若 `status === "incomplete" && incomplete_details.reason ===
     "max_output_tokens"` 则 `stopReason = "max_tokens"`，其它 `end_turn`。
   - 末尾 yield `stream_end { stopReason, usage }`。
4. `OpenAICompatClient`（Chat Completions）：
   - 同样构造 OpenAI client；
   - `stream(...)`：messages 数组首条 system + `buildChatCompletionMessages(history)`；
     `stream: true`、`max_tokens`、可选 `tools`。
   - `for await (chunk of client.chat.completions.create(params, { signal }))`：
     - `delta.content` → yield `text_delta`；
     - `delta.tool_calls` → 按 index 维护 `Map<index, {id, name, args}>` 并 yield
       `tool_call_start`/`tool_call_delta`；
     - `finish_reason`：迭代完后映射成 `length → max_tokens` / `tool_calls 或
       toolCalls.size > 0 → tool_use` / else → `end_turn`，并对每个 toolCall yield
       `tool_call_complete`。
     - `usage`：`completion_tokens`、`prompt_tokens_details?.cached_tokens`，
       `inputTokens = max(0, prompt_tokens - cached)`。
   - yield `stream_end`。
5. `classifyOpenAIError(err)`：401→Auth、429→RateLimit、413 或 400 且 message 含
   `context_length_exceeded` / `maximum context length` / `prompt is too long`→
   ContextTooLong、其它→`LLMError`；非 APIError→`NetworkError`。

**验证：** `tsc --noEmit` 无错；联调到 T17 时 anthropic / openai / openai-compat
三个 protocol 各跑一遍。

---

## T10: tui 样式与小组件**文件：** `src/tui/styles.ts`、`src/tui/verbs.ts`、`src/tui/spinner.tsx`、
`src/tui/status-bar.tsx`

**依赖：** T1

**步骤：**
1. `styles.ts`：导出 `brand`（chalk 颜色：primary `#a78bfa`、bright、error、success、
   warning、muted、tool、thinking、user、assistant）与 `symbols`（`❯◆▶✓✗→·`）
   与 `commandIcons` / `borderColors`。
2. `verbs.ts`：导出动词数组 + `randomVerb()` + 完成短语数组 + `randomCompletionVerb()`。
3. `spinner.tsx`：`<Spinner label? inputTokens? outputTokens?>`：内部
   `useEffect` 起 1 秒 setInterval 推进 `elapsed`；用 `<InkSpinner type="dots">`
   + 随机动词 + `(1.2K↓ 240↑ · 5s)` 格式化字符串。
4. `status-bar.tsx`：`<StatusBar model mode? inputTokens outputTokens>`：dim text
   显示 `${mode} · ${tokens}`，全为 0/空时返回 `null`（不渲染）。

**验证：** 在临时 `bun run src/main.tsx` 里 mount 一下，肉眼确认颜色、秒数、token
格式正确。

---

## T11: provider 选择组件**文件：** `src/tui/provider-select.tsx`

**依赖：** T10、T2

**步骤：**
1. `<ProviderSelect providers onSelect>`：内部 `useState<number>(0)` 维护 cursor。
2. `useInput((input, key) => ...)`：上下方向键调 cursor；Enter 调
   `onSelect(providers[cursor])`。
3. 列表项格式：`❯ name (protocol → model)`，未选中行用 dim 颜色。

**验证：** `tsc --noEmit` 无错；T17 联调时配两条 provider 应出现列表。

---

## T12: 输入框组件**文件：** `src/tui/input.tsx`

**依赖：** T10

**步骤：**
1. `<InputBox onSubmit disabled? history? commands? onEscape? inputState? permMode?
   onModeChange? workDir?>`。
2. 内部 `lines: string[]` + `cursorLine: number` 维护多行；`useInput` 处理键事件：
   - Enter（无 Shift / Ctrl+J）→ 拼接 `lines.join("\n").trim()` 调 `onSubmit`，
     清空；
   - Shift+Enter / Ctrl+J → 在当前行后插入空字符串行；
   - Backspace / 方向键 / Tab 各自处理。
3. 渲染：`<Box borderStyle="round" borderTop borderBottom>` + `❯` 前缀 + 多行文本 +
   闪烁光标（`useEffect` 530ms 翻转 `cursorVisible`）。
4. `/` 命令面板与 `@` 文件提示在本章只需保留代码结构；不必为本章流程做更多验证。
5. `disabled === true` 时只渲染 `<Text dimColor>Waiting...</Text>`。

**验证：** `tsc --noEmit` 无错；T17 联调时验证 Shift+Enter 换行、Enter 提交、
disabled 时不可输入。

---

## T13: chat 渲染**文件：** `src/tui/chat.tsx`

**依赖：** T10

**步骤：**
1. 顶部一次性 `chalk.level = 3` 与 `marked.use(markedTerminal({ showSectionPrefix:
   false }))`。
2. 实现 `renderMarkdown(text)`：try `marked.parse(text) as string`，catch 返回原
   文本。
3. 声明 `ChatMessage`（含 `role` 七种 + `content` + 可选 toolName/argsSummary/
   isError/elapsed/thinkingDuration/toolSummary）。
4. `<ChatView messages streamingText? expanded?>`：把 messages 依次走 `MessageBlock`
   渲染；若有 `streamingText` 非空，额外渲染一行 `● ${renderMarkdown(streamingText)}`。
5. `MessageBlock` 按 role 分支：本章主要用 user（`❯ content`）、assistant
   （`renderMarkdown(content)`）、system（dim 文本）。其它 role（thinking / tool_*
   / turn_summary）保留实现但本章流程不触发。
6. 导出 `CommittedMessage` 给 `<Static>` 用，结构同 `MessageBlock` 包一层
   `<Box paddingLeft={1}>`。

**验证：** `tsc --noEmit` 无错；T17 验证流式期间和结束后的渲染差异（结束后整段
markdown 美化）。

---

## T14: App 总组件（状态机 + 流式聚合）**文件：** `src/tui/app.tsx`

**依赖：** T2、T6、T7、T10、T11、T12、T13

**步骤：**
1. 顶部 import：config、conversation、prompt、llm、tui 子组件。
2. 函数组件 `<App providers mcpServers hooks>`：
   - state：`appState`（初值 `providers.length === 1 ? "chat" : "providerSelect"`）、
     `selectedProvider`（初值 `providers[0]`）、`messages`、`streamingText`、
     `isStreaming`、`completionMark`、`inputTokens`、`outputTokens`、`error`。
   - ref：`clientRef`、`convRef = new ConversationManager()`、`abortControllerRef`、
     `streamStartRef`、`streamingTextRef`、`committedIndexRef`。
3. `useEffect`（当 `appState === "chat" && selectedProvider`）：
   - 先用 `getContextWindow(selectedProvider)` 同步种到 `contextWindowRef`；
   - 构造 `systemPrompt = buildSystemPrompt(detectEnvironment(workDir))`；
   - `createClient(selectedProvider, systemPrompt).then(c => clientRef.current = c)`；
   - 后台触发 `getContextWindowAsync(selectedProvider).then(...)` 升级窗口；
     任何 reject 静默吞掉。
4. `handleProviderSelect(p)`：`setSelectedProvider(p); setAppState("chat")`。
5. `handleSubmit(text)`：
   - 写 prompt 历史（本章可简化为 `setPromptHistory((prev)=>[...prev, text])`）；
   - 若 text === "/exit" → `useApp().exit()`；
   - `setMessages([...prev, {role:"user", content:text}])`；
   - `convRef.current.addUserMessage(text)`；
   - `streamStartRef.current = Date.now()`；`setIsStreaming(true)`；`setStreamingText("")`；
     `setError(null)`；
   - `abortControllerRef.current = new AbortController()`；
   - 进入流式循环（见步骤 6）。
6. 流式循环（本章可以直接 inline，不必走 Agent；保留 `runAgentLoop` 命名，方便
   后续章节扩展）：
   ```ts
   const it = clientRef.current.stream(convRef.current, [], abortControllerRef.current.signal);
   let full = "";
   try {
     for await (const ev of it) {
       if (ev.type === "text_delta") {
         full += ev.text;
         streamingTextRef.current = full;
         setStreamingText(full);
       } else if (ev.type === "thinking_delta") {
         // 不渲染
       } else if (ev.type === "stream_end") {
         setInputTokens(ev.usage.inputTokens);
         setOutputTokens(ev.usage.outputTokens);
       }
     }
     setMessages((prev) => {
       const next = [...prev, { role: "assistant", content: full } as ChatMessage];
       committedIndexRef.current = next.length;
       return next;
     });
     convRef.current.addAssistantMessage(full);
     setCompletionMark(randomCompletionVerb());
   } catch (err) {
     // AbortError / LLMError 分类处理
   } finally {
     setIsStreaming(false);
     setStreamingText("");
   }
   ```
7. `useInput` 顶层捕获 Ctrl+C → `useApp().exit()`。
8. 渲染：
   - `appState === "providerSelect"` → `<ProviderSelect>`；
   - 否则：
     - 启动横幅区：彩色 `/\_/\` / `( o.o )` / `> ^ <` + `MewCode v0.1.0` +
       `selectedProvider.model` + `workDir`；
     - `<Static items={messages.slice(0, committedIndexRef.current)}>{<CommittedMessage/>}</Static>`；
     - `<ChatView messages={messages.slice(committedIndexRef.current)}
       streamingText={isStreaming ? streamingText : undefined} />`；
     - `isStreaming` 时 `<Spinner inputTokens outputTokens />`；
     - `error` 时红字 `<Text color="red">{error}</Text>`；
     - `<InputBox onSubmit={handleSubmit} disabled={isStreaming} />`；
     - `<StatusBar model={selectedProvider.model} inputTokens outputTokens />`。

**验证：** `tsc --noEmit` 无错。

---

## T15: 入口装配**文件：** `src/main.tsx`

**依赖：** T2、T14

**步骤：**
1. shebang `#!/usr/bin/env bun`，import react、ink、`loadConfig`、`<App>`。
2. `try { cfg = loadConfig() } catch (err) { console.error(...); process.exit(1) }`。
3. 打开 `/dev/tty`（`openSync(... "w")`，失败置 `ttyFd = null`），写 `\x1b[?25l`
   隐藏光标；hook `cli-cursor.show` 为 no-op，避免 Ink 重新显示。
4. 注册 `process.on("exit", restoreCursor)`：还原 `cli-cursor.show`、写
   `\x1b[?25h`、关 `ttyFd`。
5. `render(<App providers={cfg.providers} mcpServers={cfg.mcp_servers}
   hooks={cfg.hooks} />, { exitOnCtrlC: false })`；`await instance.waitUntilExit()`
   后再 `restoreCursor()`。

**验证：** `bun run src/main.tsx` 单 provider 时直接进对话；多 provider 时出现
`<ProviderSelect>`；缺配置时打印 `Error: ...` 并非零退出。

---

## T16: 单元测试**文件：** `tests/config.test.ts`、`tests/conversation.test.ts`

**依赖：** T2、T6

**步骤：**
1. `tests/config.test.ts`：用 `bun:test` 的 `test`/`expect`，把临时 YAML 写到
   `bun:test` 的 tmp 目录，调 `loadConfig(path)`：合法配置返回正确条数；缺字段、
   非法 protocol、文件不存在分别 expect `toThrow(ConfigError)`；并测试
   `resolveAPIKey` 在 `api_key` 与环境变量两种来源下都能拿到值，两者都缺时返回
   空字符串。
2. `tests/conversation.test.ts`：构造 `ConversationManager`，连续 add user /
   assistant 后 `getMessages()` 顺序与 role 正确；修改返回数组不影响内部
   `history`；`len()` 与 `truncateTo()` 行为正确。

**验证：** `bun test` 全部通过。

---

## T17: 端到端联调**文件：** 无（运行验证）

**依赖：** T1–T16

**步骤：**
1. 准备 `.mewcode/config.yaml`：先放一条 anthropic（`thinking: true`）跑：
   - 多轮对话、流式逐字、Spinner 秒数递增、Done 后 markdown 定型、思考内容不出现。
2. 再加一条 openai-compat（指向兼容端点）：启动出现 `<ProviderSelect>`，选第二条，
   状态栏与启动横幅显示该 model；同样跑两轮对话。
3. 把 anthropic key 改成错的：发送一条消息应在对话区/底部红字看到
   `AuthenticationError` 文本，TUI 不退出，改回正确 key 重启可继续。
4. `/exit` 与 Ctrl+C：分别试一次，退出后终端光标可见、无 raw mode 残留。
5. `tmux send-keys` 跑一遍真实流程，用 `tmux capture-pane` 抓屏作为证据。

**验证：** 逐条对照 checklist.md 记录证据。

---

## 执行顺序

```text
T1 ─┬─ T2 ─┬─ T3
    │      └─ T6
    ├─ T4
    ├─ T5 ─┬─ T7 ─┬─ T8
    │      │      └─ T9
    │      └─ T10 ─┬─ T11
    │              ├─ T12
    │              └─ T13
    └─ (T2+T6+T7+T11+T12+T13) ─ T14 ─ T15
                                ├─ T16（与 T14/T15 可并行）
                                └─ T17
```

（T3 可与 T4/T5 并行；T8、T9 可并行；T11、T12、T13 在 T10 后可并行推进；T16 在
T2/T6 完成后即可起，与 T14/T15 并行写。）
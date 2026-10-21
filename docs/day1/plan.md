# 多协议 LLM 终端对话客户端 Plan## 技术栈
- 运行时：bun（执行 `src/main.tsx`，原生支持 TSX、ESM、`.ts` 解析）
- 语言：TypeScript 5.x（`tsc --noEmit` 做类型检查）
- TUI：Ink 5.x（React 18 渲染到终端）、`ink-spinner`、`ink-text-input`
- 终端样式：chalk 5.x（level 3 真彩色）
- LLM SDK：`@anthropic-ai/sdk` ^0.99、`openai` ^6.39（Responses API + Chat Completions）
- markdown 渲染：marked 15.x + marked-terminal 7.x（适配终端的高亮、列表、代码块）
- 配置：js-yaml 4.x（`yaml.load`）+ `node:fs` / `node:path` / `node:os`
- 模糊匹配（输入框命令面板）：fuse.js 7.x（本章可见，但本章流程不深入）
- 测试：`bun test`

## 架构概览（分层）
1. 入口层 `src/main.tsx` —— 调 `loadConfig()`、hook 光标、`render(<App />)`。
2. 配置层 `src/config/config.ts` —— YAML 加载、字段校验、`resolveAPIKey`、
   `getContextWindow` / `getMaxOutputTokens` 等推导函数。
3. 提示词层 `src/prompt/builder.ts` + `sections.ts` —— `buildSystemPrompt` 把多个
   Section（身份、任务执行、工具使用、语气、环境信息等）按 priority 拼成系统 prompt。
4. LLM 协议层 `src/llm/` —— `LLMClient` 接口 + `StreamEvent` 联合类型 +
   `AnthropicClient` / `OpenAIClient` / `OpenAICompatClient` 三个 `AsyncGenerator`
   实现 + `errors.ts` 分类错误。
5. 会话层 `src/conversation/conversation.ts` —— `ConversationManager` 持有
   `Message[]`，提供 `addUserMessage` / `addAssistantMessage` / `getMessages` 等接口。
6. TUI 层 `src/tui/` —— `app.tsx` 总组件 + `provider-select.tsx` / `input.tsx` /
   `chat.tsx` / `spinner.tsx` / `status-bar.tsx` / `styles.ts` / `verbs.ts` 拆分组件，
   通过 React state + ref 驱动渲染。

## 数据流（一轮对话）
```text
[启动]
  main.tsx → loadConfig() → render(<App providers=... />)

[selecting → chat 切换]
  providers.length > 1 ? <ProviderSelect> : 直接 chat 状态
  用户选定 → setSelectedProvider → useEffect 触发 createClient(...) → clientRef

[用户提交一条消息]
  <InputBox onSubmit={handleSubmit}>
    → handleSubmit(text)
       ├─ historyMod.append(...)         // 命令历史落盘
       ├─ setMessages([...prev, user])   // 立即出现在 <ChatView>
       ├─ convRef.addUserMessage(...)    // 进入历史
       ├─ streamStartRef = Date.now()
       ├─ setIsStreaming(true)
       └─ runAgentLoop()
              └─ Agent 内部调用 client.stream(conv, [], abortSignal)

[流式接收]
  for await (event of client.stream(...)):
    text_delta       → setStreamingText(prev + delta) → <ChatView> 实时渲染 markdown
    thinking_delta   → 累积到 turnThinking 但不渲染
    stream_end       → 把完整文本作为 assistant 消息 push 到 messages
                       并把 committedIndexRef 推进，下次渲染由 <Static> 接管

[结束 / 错误]
  AbortError      → 部分文本作为 assistant 保留 + system 消息提示中断
  LLMError 子类   → setError(...) 红字提示，TUI 继续运行

[退出]
  /exit  → 命令注册表的 exit handler → useApp().exit()
  Ctrl+C → render({ exitOnCtrlC: false }) + useInput 捕获 → 同上
  → process.on("exit", restoreCursor) 还原终端光标
```

## 核心数据结构与接口

```ts
// ───────── config 层 ─────────
export interface ProviderConfig {
  name: string;
  protocol: string;          // "anthropic" | "openai" | "openai-compat"
  base_url: string;
  model: string;
  api_key?: string;
  thinking?: boolean;        // 仅 anthropic 生效
  context_window?: number;
  max_output_tokens?: number;
}
export interface AppConfig {
  providers: ProviderConfig[];
  permission_mode?: string;
  mcp_servers: MCPServerConfig[];
  hooks: HookConfig[];
}
export class ConfigError extends Error {}
export function loadConfig(path?: string): AppConfig;
export function resolveAPIKey(p: ProviderConfig): string;
export function getMaxOutputTokens(p: ProviderConfig): number;
export function getContextWindow(p: ProviderConfig): number;

// ───────── conversation 层 ─────────
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
  getMessages(): Message[];
  len(): number;
}

// ───────── llm 层 ─────────
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | { type: "tool_call_complete"; toolId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };

export interface LLMClient {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}
export async function createClient(cfg: ProviderConfig, systemPrompt: string): Promise<LLMClient>;

// LLMError 体系
export class LLMError extends Error {}
export class AuthenticationError extends LLMError {}
export class RateLimitError extends LLMError { retryAfter?: string }
export class NetworkError extends LLMError {}
export class ContextTooLongError extends LLMError {}

// ───────── prompt 层 ─────────
export interface Section { name: string; priority: number; content: string; }
export interface EnvironmentContext {
  workDir: string; os: string; arch: string; shell: string;
  isGitRepo: boolean; gitBranch: string; model: string; date: string;
}
export function detectEnvironment(workDir: string): EnvironmentContext;
export function buildSystemPrompt(env: EnvironmentContext, opts?: BuildOptions): string;

// ───────── tui 层（关键 props / state） ─────────
type AppState = "providerSelect" | "chat";
interface AppProps {
  providers: ProviderConfig[];
  mcpServers: MCPServerConfig[];
  hooks: HookConfig[];
}
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary";
  content: string;
  // 本章主要用 user/assistant/system；其它角色由后续章节填充
}
// 关键 React state（在 App 函数组件内）：
//   appState, selectedProvider, messages, streamingText, isStreaming,
//   inputTokens, outputTokens, error
// 关键 ref：
//   clientRef, convRef, abortControllerRef, streamStartRef, committedIndexRef
```

## 模块设计### 模块 `src/config/config.ts`
- 职责：从最多三个 YAML 文件中合并出 `AppConfig`；校验 providers；解析 API key 与
  上下文窗口/最大输出。
- 对外接口：`loadConfig(path?)`、`mergeConfig(base, override)`、`resolveAPIKey`、
  `getContextWindow` / `getContextWindowAsync` / `getMaxOutputTokens` /
  `lookupModelContextWindow`、`ConfigError`。
- 关键行为：
  - `loadSingleFile(path)` 用 `js-yaml` 解析得到 raw object，按已知字段写入
    `AppConfig`；空文件返回空 providers/hooks/mcp_servers。
  - `mergeConfig`：override 的 providers 整列覆盖；mcp_servers 按 name 合并；hooks 追加。
  - `validateProviders` 报错时附带条目下标与缺失字段名，例如
    `Provider #2: missing fields: model`。
  - 上下文窗口四级回退：`context_window` 显式 → anthropic `/v1/models/{model}` 异步
    探测（layer 2）→ 内置 `MODEL_CONTEXT_WINDOWS` 子串表 → 200k / 128k 保守值。
- 依赖：`node:fs`、`node:path`、`node:os`、`js-yaml`。

### 模块 `src/prompt/`
- `sections.ts`：分别导出 `identitySection` / `systemSection` / `doingTasksSection` /
  `executingActionsSection` / `usingToolsSection` / `toneStyleSection` /
  `outputEfficiencySection` / `environmentSection`。每个 Section 含 `priority`，
  数字越小越靠前。
- `builder.ts`：`PromptBuilder` 收集 `Section`，`build()` 按 priority 升序拼接。
  `detectEnvironment(workDir)` 用 `node:os.platform/arch`、`process.env.SHELL` 与
  `git rev-parse` 探测仓库状态。`buildSystemPrompt(env, opts)` 注入所有内置 section
  加可选 `skillSection` / `customInstructions` / `memorySection`。
- 依赖：`node:os`、`node:child_process`、自身。

### 模块 `src/llm/`
- `events.ts`：声明 `StreamEvent` 联合类型与 `UsageInfo`。
- `errors.ts`：声明 `LLMError` 及四个子类。
- `client.ts`：声明 `LLMClient` / `MaxTokensSetter` 接口；`createClient(cfg, sys)`
  按协议动态 `import()` 对应 client 类（避免一次性把两个 SDK 全部加载）。
- `anthropic.ts`：
  - 构造 `new Anthropic({ apiKey, baseURL })`。
  - `stream()` 用 `buildAnthropicMessages` 把 `Message[]` 拼成 SDK 的
    `MessageParam[]`（合并连续 user 文本，避免破坏 user/assistant 交替）。
  - 注入 `system: [{ type: "text", text, cache_control: { type: "ephemeral" } }]`，
    最后一个 user 内容块打 `cache_control` 标记，提高 prompt 命中率。
  - `client.messages.stream(params, { signal })` 异步迭代，按事件类型 yield
    `text_delta` / `thinking_delta` / `thinking_complete` 等；结束 yield
    `stream_end` 携带 `usage`。
  - 错误统一走 `classifyAnthropicError`：401 → `AuthenticationError`、429 →
    `RateLimitError`、413 / `prompt is too long` → `ContextTooLongError`、其它 →
    `LLMError`、非 APIError → `NetworkError`。
  - 还导出 `fetchModelContextWindow`：GET `{base_url}/v1/models/{model}`，3s 超时，
    任何失败返回 0（layer 2 由 `getContextWindowAsync` 调用，绝不抛）。
- `openai.ts`：
  - `OpenAIClient` 走 Responses API：`client.responses.create({ model, input,
    stream: true, max_output_tokens, tools? })`。输入由 `buildOpenAIInput` 把
    assistant tool_calls 转成 `function_call` 项、tool_result 转成
    `function_call_output` 项；普通文本沿用 `{role, content}`。
  - `OpenAICompatClient` 走 Chat Completions：`client.chat.completions.create({
    model, messages, stream: true, max_tokens })`，由
    `buildChatCompletionMessages` 转换历史。
  - 两者都通过 `classifyOpenAIError` 把 SDK 错误归类：401 / 429 / 413 /
    `context_length_exceeded`、`prompt is too long` 等都各归各类。
  - 关心的事件：`response.output_text.delta` / `response.completed` /
    `response.output_item.added/done`（Responses）和 `chunk.choices[0].delta` /
    `finish_reason` / `usage`（Chat Completions）。
- 依赖：`@anthropic-ai/sdk`、`openai`、本仓库的 `config` 与 `conversation`。

### 模块 `src/conversation/conversation.ts`
- 职责：进程内维护一个 `Message[]`。
- 关键方法：`addUserMessage(text)` / `addAssistantMessage(text)` / `getMessages()`
  返回副本 / `len()` / `truncateTo(index)`（章节后续会用到）/
  `injectLongTermMemory(...)`（本章 LTM 留空）。
- 本章只用 user/assistant 两种角色 + 纯文本 `content`；其它字段
  （`thinkingBlocks` / `toolUses` / `toolResults`）由后续章节填充。

### 模块 `src/tui/`
- `app.tsx`：函数组件 `<App>`。本章关注的核心 state / ref / 副作用：
  - state：`appState`、`selectedProvider`、`messages`、`streamingText`、
    `isStreaming`、`completionMark`、`inputTokens`、`outputTokens`、`error`。
  - ref：`clientRef`、`convRef`、`abortControllerRef`、`streamStartRef`、
    `streamingTextRef`、`committedIndexRef`。
  - `useEffect` 在 `appState === "chat" && selectedProvider` 时调
    `createClient(cfg, sys)` 写入 `clientRef`；并行 `getContextWindowAsync` 升级
    上下文窗口。
  - `handleSubmit(text)`：判定 slash 命令（本章只有 `/exit` 出现）→ 写消息 →
    `runAgentLoop()`。
  - 渲染：横幅 → `<Static>` 渲染 `messages.slice(0, committedIndexRef.current)`
    → `<ChatView>` 渲染剩余 + `streamingText` → `<Spinner>`（流式中）→
    `<InputBox>` → `<StatusBar>`。
- `provider-select.tsx`：`<ProviderSelect>` 列表 + 方向键 + Enter，回调
  `onSelect(provider)` 切到 chat。
- `input.tsx`：`<InputBox>` 多行编辑、`/` 命令面板（fuse.js 模糊）、`@` 文件提示、
  历史回放、Shift+Enter 换行；`disabled` 时显示 "Waiting..."。
- `chat.tsx`：`<ChatView>` 把 `messages` 与 `streamingText` 用 `marked` 渲染；
  导出 `<CommittedMessage>` 给 `<Static>` 用。
- `spinner.tsx`：`ink-spinner` + 1 秒 setInterval 推进 `elapsed` + 随机动词 + tokens。
- `status-bar.tsx`：dim text 显示 mode 与 token 量；本章流程通常只显示 token。
- `styles.ts`：chalk 颜色与 unicode 符号（`❯` `◆` `▶` `✓` `✗` `→` `·`）。
- `verbs.ts`：动词与完成短语候选列表 + `randomVerb()` / `randomCompletionVerb()`。

### 模块 `src/main.tsx`
- 加载配置 → 错误 `console.error` 后非零退出。
- 打开 `/dev/tty` 写入 `\x1b[?25l` 隐藏光标，并 hook `cli-cursor.show` 防止 Ink
  在重渲染时反复显示光标。
- `render(<App ... />, { exitOnCtrlC: false })`；`waitUntilExit()` 后 `restoreCursor()`。

## 模块交互### 启动调用链
```text
main.tsx
  └─ loadConfig()                              // src/config/config.ts
  └─ render(<App providers=cfg.providers />)   // ink
       └─ initial useEffect
            ├─ buildSystemPrompt(detectEnvironment(workDir))
            ├─ createClient(selectedProvider, systemPrompt)  // 按 protocol 动态导入
            └─ getContextWindowAsync(selectedProvider)        // 后台升级
```

### 多 provider 选择时序
```text
appState === "providerSelect":
  <ProviderSelect providers onSelect>
    ↑/↓  → 移动 cursor
    Enter → onSelect(providers[cursor])
              ├─ setSelectedProvider(p)
              └─ setAppState("chat")
                  → 触发 useEffect → createClient(p, systemPrompt)
```

### 一轮对话时序
```text
<InputBox onSubmit>
  └─ handleSubmit(text)
       ├─ historyMod.append(historyDir, text)
       ├─ setMessages([...prev, {role:"user", content:text}])
       ├─ convRef.current.addUserMessage(expandAtRefs(text, workDir))
       ├─ streamStartRef = Date.now()
       ├─ setIsStreaming(true)
       └─ runAgentLoop()
             └─ new Agent(...).run()   // 内部 for-await client.stream(...)
                  for await (event of clientRef.current.stream(conv, [], signal)):
                     text_delta   → setStreamingText(prev + event.text)
                     thinking_*   → 累积到 turn 数据，不渲染
                     stream_end   → finalize：
                                      fullText 写 messages（assistant）
                                      committedIndexRef ← messages.length
                                      convRef.addAssistantMessage(fullText)
                                      setIsStreaming(false)
                                      setStreamingText("")
                                      setInputTokens/setOutputTokens
```

### 退出时序
```text
任意状态下：
  /exit → command registry 的 exit handler → exit()  (useApp)
  Ctrl+C → ink useInput 捕获 → 同 exit handler
process.on("exit", restoreCursor):
  cli-cursor.show = origShow
  writeTty("\x1b[?25h")
  closeSync(ttyFd)
```

### 数据流图
```text
.mewcode/config.yaml (×3) ──loadConfig──> AppConfig
selectedProvider + systemPrompt ──createClient──> LLMClient

用户输入 ──<InputBox>──> handleSubmit ──> convRef.addUserMessage
                                       ──> setMessages(+user)

client.stream(conv, []) ──AsyncGenerator──> StreamEvent
StreamEvent.text_delta ──setStreamingText──> <ChatView>(marked) 实时渲染
StreamEvent.stream_end ──> messages.push(assistant) + committedIndexRef++
                       ──> convRef.addAssistantMessage
                       ──> <Static> 接管渲染（不再 re-render）
```

## 文件组织
```text
mewcode/
├── src/
│   ├── main.tsx                       # 入口：loadConfig + render(<App/>)
│   ├── config/
│   │   └── config.ts                  # YAML 加载、校验、key/window 推导
│   ├── conversation/
│   │   └── conversation.ts            # ConversationManager（本章只用 user/assistant 路径）
│   ├── llm/
│   │   ├── client.ts                  # LLMClient 接口 + createClient 工厂
│   │   ├── events.ts                  # StreamEvent 联合类型 + UsageInfo
│   │   ├── errors.ts                  # LLMError 体系
│   │   ├── anthropic.ts               # AnthropicClient + fetchModelContextWindow
│   │   ├── openai.ts                  # OpenAIClient / OpenAICompatClient
│   │   └── model-resolver.ts          # 模型别名解析（本章不直接用）
│   ├── prompt/
│   │   ├── builder.ts                 # PromptBuilder + buildSystemPrompt
│   │   ├── sections.ts                # 各 Section 工厂
│   │   └── plan-mode.ts               # Plan Mode 文案（本章不展开）
│   └── tui/
│       ├── app.tsx                    # <App> 总组件 + handleSubmit / runAgentLoop
│       ├── provider-select.tsx        # <ProviderSelect>
│       ├── input.tsx                  # <InputBox>
│       ├── chat.tsx                   # <ChatView> + <CommittedMessage>
│       ├── spinner.tsx                # <Spinner>
│       ├── status-bar.tsx             # <StatusBar>
│       ├── styles.ts                  # chalk 主题与符号
│       └── verbs.ts                   # 随机动词
├── .mewcode/
│   └── config.yaml                    # 真实运行配置（在 .gitignore 中）
├── package.json                       # bun + ink + 两个 LLM SDK 等依赖
├── tsconfig.json
└── bun.lock
```

说明：
- `src/tui/app.tsx` 在完整代码中包含 ch03+ 的工具、权限、记忆等逻辑；本章在文档中
  只覆盖 `appState` 切换、`handleSubmit`、流式聚合、退出这几条主线。
- `src/conversation/conversation.ts` 同时定义了 thinking/tool 相关字段，但本章只在
  spec/acceptance 上验证 user/assistant 纯文本路径。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 运行时 | bun | 原生支持 TSX、ESM；`bun run src/main.tsx` 无需编译；`bun test` 不需配置 |
| 语言 | TypeScript 5.x | 类型驱动开发；用 `tsc --noEmit` 做静态校验，不产物 |
| TUI 框架 | Ink（React 渲染到终端）| 用 React 语法管理终端组件；`<Static>` 把已完成消息固定到滚动历史，避免闪烁 |
| markdown 渲染 | marked + marked-terminal | marked 是 AST 化的解析器；marked-terminal 直接产出带 ANSI 的字符串，配合 chalk level 3 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` 官方 SDK | SDK 内部已处理 SSE 解析、`AbortSignal`、错误分类；省去手写 HTTP/SSE |
| 协议抽象 | 同一 `LLMClient` 接口 + `AsyncGenerator<StreamEvent>` | 同时满足 anthropic、openai Responses、openai-compat Chat Completions；上层只感知事件类型 |
| openai 协议拆两份 client | `OpenAIClient`（Responses API）+ `OpenAICompatClient`（Chat Completions）| 兼容端点几乎都只支持 Chat Completions；OpenAI 官方端点支持更新的 Responses API |
| 流式接入 React | `useState(streamingText)` + `setStreamingText(prev + delta)` | React 自然 diff；`<Static>` 在 `stream_end` 后接管，避免长对话重渲染开销 |
| 流式渲染策略 | 流式过程中也对累积文本调 `marked.parse` | marked-terminal 能处理不完整 markdown；不必等结束再渲染 |
| 配置三层合并 | home → cwd → cwd.local | 全局默认 → 项目级 → 本地私有覆盖；密钥可放本地层 |
| API key 回退环境变量 | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 不强制把 key 写进 YAML；CI / 容器友好 |
| thinking | 仅 anthropic 协议生效 | openai Chat Completions 没有内嵌 thinking；Responses API 的 reasoning 不走相同字段 |
| 错误处理 | 自定义 `LLMError` 子类 + `name` 字段区分 | 上层可以按 `instanceof` 给出不同 UI；不依赖 SDK 内部类 |
| spinner | `ink-spinner` + 1s setInterval | 复用 Ink 重渲染节奏；秒数与 token 由 props 注入 |
| 退出与光标 | `render({ exitOnCtrlC: false })` + 手动 `\x1b[?25l/?25h` + hook `cli-cursor` | Ink 默认会反复 show/hide 光标导致闪烁；手动接管让退出前后终端干净 |
| 多 provider 选择 | 单份直进 / 多份 `<ProviderSelect>` | 满足 spec F3；切换协议在用户视角无差异 |
| 历史 | 进程内 `ConversationManager.history` 数组 | 满足 F7；session 文件本章不展开 |
| system prompt | `PromptBuilder` + 多 Section + priority 排序 | 让后续章节方便插入 skill / memory / custom instruction |
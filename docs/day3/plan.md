# Agent Loop Plan

> 基于已批准的 spec.md。本文档与语言相关（TypeScript 5.x，运行时 bun）。SDK 类型已对 `@anthropic-ai/sdk` ^0.99.0、`openai` ^6.39.0、`ink` ^5.2.0 核对。

## 技术栈

- **运行时**：bun
- **语言**：TypeScript 5.x，ES module（`"type": "module"`），编译用 `tsc --noEmit`
- **TUI**：Ink ^5.2.0（React 18 渲染到终端）、ink-spinner、ink-text-input
- **LLM SDK**：`@anthropic-ai/sdk` ^0.99.0、`openai` ^6.39.0
- **MCP**：`@modelcontextprotocol/sdk`（占位，本章 Agent 不直接依赖）
- **markdown 渲染**：marked + marked-terminal
- **配置**：js-yaml（读 `.mewcode/config.yaml`）
- **终端样式**：chalk
- **测试**：`bun test`

## 架构概览

ch04 不新增包，在 ch03「tools / llm / conversation / prompt / tui」之上**扩展**：

- **src/agent/**（新增）：`Agent` 类承载 ReAct 循环；`AgentEvent` discriminated union 定义对外事件；`StreamingExecutor` 跑工具批。
- **src/llm/**（扩展）：`StreamEvent` 增 `stream_end` 携带 `UsageInfo`；`LLMClient.stream()` 接受 `AbortSignal` 形参。
- **src/tools/**（扩展）：`Tool` 接口增 `category: "read" | "write" | "command"` 字段；`ToolRegistry` 仅暴露 `get()` / `getAllSchemas(protocol)` / `listTools()`。
- **src/conversation/**（扩展）：`ConversationManager.addAssistantFull()` 支持携带 `toolUses` 与 `thinkingBlocks`；`addToolResultsMessage()` 一次性写一组 `ToolResultBlock`；`addSystemReminder()` 写 `<system-reminder>` 包裹的 user 消息。
- **src/prompt/**（扩展）：`buildPlanModeReminder()` 按 iteration 切换完整/精简提示；常量 `planModeFullReminder` / `planModeSparseReminder` 定义在 `src/prompt/plan-mode.ts`。
- **src/permissions/**（占位）：`PermissionChecker.check()` 接口本章默认放行所有调用，仅 `mode` 字段被 `Agent.run()` 读取来决定是否注入 plan 提醒。
- **src/tui/**（扩展）：`<App>` 组件 `useEffect` 启动 `agent.run()`、`useInput` 捕获 Esc / Ctrl+C、`useState` 维护事件累积；`<Static>` 渲染历史消息、动态 `<Box>` 渲染当前流。

依赖方向：`tools → llm`（共享类型）、`agent → { llm, tools, conversation, permissions, prompt }`、`tui → { agent, tools, conversation, llm, prompt, permissions }`、`llm → { config, conversation }`。

## 数据流

```
用户输入 (Ink <TextInput>)
  └─ conversation.addUserMessage(text)
  └─ const agent = new Agent({ client, registry, ... })
  └─ for await (const ev of agent.run()):       # AsyncGenerator
       ├─ stream_text  → setCurrentReply()       # 累积界面文本
       ├─ tool_use     → 追加进行中工具到状态
       ├─ tool_result  → 把工具行 + 摘要提交 <Static>
       ├─ usage        → 状态栏累加
       ├─ turn_complete→ iteration++
       ├─ loop_complete→ 把最终答复提交 <Static>，停泵
       └─ error        → 灰色错误块，停泵

# 被 Esc / Ctrl+C 时
abortController.abort() → abortSignal.aborted 为真
  → client.stream() 内 SDK fetch 抛 AbortError
  → Agent 捕获 → yield { type: "loop_complete", stopReason: "interrupted" } → return
```

## 核心数据结构与接口

### `src/agent/events.ts`

```ts
// AgentEvent 是 Agent.run() AsyncGenerator 唯一的对外事件类型。
// 所有消费方都得 switch (event.type) 分派；新增事件类型时编译期会提示遗漏。
export type AgentEvent =
  | { type: "stream_text"; text: string }
  | { type: "thinking_text"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_use"; toolName: string; toolId: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; toolId: string; output: string; isError: boolean; elapsed: number }
  | { type: "turn_complete" }
  | { type: "loop_complete"; stopReason: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error }
  | { type: "retry"; reason: string; delay: number }
  | { type: "permission_request"; toolName: string; args: Record<string, unknown> };
```

### `src/agent/agent.ts`

```ts
export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  abortSignal?: AbortSignal;
  maxIterations?: number;       // 0 表示不限
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision
  ) => Promise<"allow" | "deny" | "allowAlways">;
}

export class Agent {
  constructor(config: AgentConfig);
  async *run(): AsyncGenerator<AgentEvent>;
}
```

### `src/agent/streaming-executor.ts`

```ts
interface PendingCall {
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface ExecutionResult {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

export class StreamingExecutor {
  constructor(registry: ToolRegistry, ctx: ToolContext);
  submit(toolId: string, toolName: string, args: Record<string, unknown>): void;
  async collectResults(): Promise<ExecutionResult[]>;   // Promise.all 一次性收
  hasPending(): boolean;
}
```

### `src/llm/events.ts` 与 `src/llm/client.ts`

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
  | {
      type: "tool_call_complete";
      toolId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };

export interface LLMClient {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}
```

### `src/tools/types.ts`

```ts
export type ToolCategory = "read" | "write" | "command";

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;       // ch04 新增：分批依据
  deferred?: boolean;
  system?: boolean;
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

### `src/conversation/conversation.ts`

```ts
export class ConversationManager {
  addUserMessage(content: string): void;
  addAssistantFull(
    text: string,
    thinking: ThinkingBlock[],
    toolUses: ToolUseBlock[]
  ): void;
  addToolResultsMessage(results: ToolResultBlock[]): void;
  addSystemReminder(content: string): void;     // ch04 新增：plan 提醒
  getMessages(): Message[];
  len(): number;
}
```

## 模块设计

### src/agent/agent.ts（核心：`Agent.run()` ReAct 循环）

**职责：** ReAct 循环编排（F1/F2）、保序分批并发执行（F5）、事件流（F3/F8/F9）、终止历史一致性（F6）、Plan Mode 提醒注入（F10）。

**对外接口：** `Agent`、`AgentConfig`。

**依赖：** `LLMClient`、`ToolRegistry`、`ConversationManager`、`PermissionChecker`、`buildPlanModeReminder`、`StreamingExecutor`。

**`run()` 算法（AsyncGenerator，`finally` 块兜底 lifecycle hook）：**

1. 取工具 schema：`toolSchemas = this.registry.getAllSchemas()`。
2. `let iteration = 0`, `let consecutiveUnknown = 0`, `let looping = true`。
3. `while (looping)`：
   1. `iteration++`；若 `maxIterations > 0 && iteration > maxIterations` → `yield { type: "error" }`、`return`。
   2. 若 `checker.mode === "plan"`：`conversation.addSystemReminder(buildPlanModeReminder(planPath, planExists, iteration))` 注入计划态提醒。
   3. 启流：`const stream = this.client.stream(this.conversation, toolSchemas, this.abortSignal)`。
   4. `for await (const event of stream)` 收集本轮：
      - `text_delta` → 累加 `fullText` 并 `yield { type: "stream_text", text }`。
      - `thinking_delta` → `yield { type: "thinking_text" }`。
      - `thinking_complete` → push 进 `thinkingBlocks`、`yield { type: "thinking_complete" }`。
      - `tool_call_complete` → push 进 `toolUses` 数组、`yield { type: "tool_use" }`。
      - `stream_end` → 记录 `stopReason`、`yield { type: "usage", usage }`。
   5. `catch` 流异常：检查 `abortSignal.aborted`（取消路径见步骤 7）；否则 `yield { type: "error", error }` 并 `return`。
   6. 取消检测：`if (this.abortSignal?.aborted)` → 若 `fullText` 非空则 `conversation.addAssistantFull(fullText, [], [])`、`yield { type: "loop_complete", stopReason: "interrupted" }`、`return`。
   7. 写历史：`conversation.addAssistantFull(fullText, toolUses, thinkingBlocks)`。
   8. **有工具调用** `toolUses.length > 0`：
      1. `const results = await this.executeTools(toolUses)`（保序分批，下述）。
      2. `for (const r of results) yield r`（按 push 顺序逐个吐 `tool_result`）。
      3. 未知工具统计：`for (const tu of toolUses)` 用 `this.registry.get(tu.toolName)` 判断；任一已注册即 `consecutiveUnknown = 0`，否则递增。`if (consecutiveUnknown >= 3)` → `yield { type: "error" }` + `return`。
      4. 把 `results` 转成 `ToolResultBlock[]`（对 `output.length > MAX_OUTPUT_CHARS` 做 10000 字符截断 + `"\n… (output truncated)"`）。
      5. `conversation.addToolResultsMessage(toolResults)`。
      6. 检查是否调用了 `ExitPlanMode`：若是则 `yield { type: "turn_complete" }`、`yield { type: "loop_complete", stopReason: "end_turn" }`、`return`（Plan Mode 退出由 TUI 后续处理）。
      7. `yield { type: "turn_complete" }`，下一轮继续。
   9. **无工具调用**：`looping = false`；`yield { type: "loop_complete", stopReason }`。

**`executeTools(toolUses)` 算法：**

```ts
private async executeTools(toolUses: ToolUseBlock[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const readSafe: ToolUseBlock[] = [];
  const writeDangerous: ToolUseBlock[] = [];

  for (const tu of toolUses) {
    const category = this.registry.get(tu.toolName)?.category ?? "command";
    if (category === "read") readSafe.push(tu);
    else writeDangerous.push(tu);
  }

  if (readSafe.length > 0) {
    events.push(...await this.executeBatch(readSafe, /*parallel=*/ true));
  }
  for (const tu of writeDangerous) {
    events.push(...await this.executeBatch([tu], /*parallel=*/ false));
  }
  return events;
}
```

`executeBatch(toolUses, parallel)` 内部用 `StreamingExecutor`：

- 对每个 `tu` 先过 `PermissionChecker.check()`：`deny` → push `tool_result { isError: true }`；`ask` 且配了 `onPermissionRequest` → `await` 用户决定（本章仅占位）。
- 通过 → `executor.submit(toolId, toolName, args)`。
- `parallel=true`：循环结束后 `await executor.collectResults()`（`Promise.all`，并发）。
- `parallel=false`：每个 submit 后立即 `await executor.collectResults()`（一个一个跑）。

每个 result 经 `processToolResult` 转成 `{ type: "tool_result" }` 事件 push 进 `events`。

### src/agent/streaming-executor.ts（工具批执行器）

**职责：** 提交工具调用、统一并发跑、捕获 throw、记录 elapsed（毫秒级，按秒数）。
**对外接口：** `submit()` / `collectResults()` / `hasPending()`。
**依赖：** `ToolRegistry`、`ToolContext`（`workDir` + 可选 `abortSignal` / `fileHistory` / `fileStateCache`）。

`collectResults()` 用 `[...this.pending]` 复制队列、清空 `this.pending`，对每个调用 `Promise.all` 跑 `tool.execute(args, ctx)`；未注册工具直接返回 `{ output: "Error: unknown tool '...'", isError: true }`，`execute()` throw 时返回 `{ output: "Error executing ...: ...", isError: true }`。

### src/llm/anthropic.ts、src/llm/openai.ts（扩展）

**职责：** 把 ch03 的同步消息收集改为 `AsyncGenerator<StreamEvent>`，在 `stream_end` 上抛 `usage`。

- `AnthropicClient.stream(conv, tools, abortSignal)`：用 `this.client.messages.stream({ ..., tools, system: this.systemPrompt, signal: abortSignal })`；按 SDK 的 `inputJsonDelta` / `contentBlockStop` 拼出 `tool_call_complete.arguments`；流结束读 `acc.usage` 上抛 `stream_end`。
- `OpenAIClient.stream(conv, tools, abortSignal)`：用 `this.client.chat.completions.create({ ..., stream: true, stream_options: { include_usage: true }, signal: abortSignal })`；拼分片 `tool_calls[i].function.arguments`；流结束读 `chunk.usage` 上抛 `stream_end`。
- 错误归一化：`ContextTooLongError`、`RateLimitError`、`AuthenticationError`、`NetworkError`、`LLMError`（`src/llm/errors.ts`）。

### src/tools/registry.ts、src/tools/types.ts（扩展）

```ts
export class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  listTools(): Tool[];
  getAllSchemas(protocol?: "anthropic" | "openai" | "openai-compat"): Record<string, unknown>[];
}
```

`getAllSchemas("openai")` 把每个 `tool.schema()` 包成 `{ type: "function", function: { name, description, parameters } }`；默认 `"anthropic"` 直接返回 schema。

6 个工具（ReadFile / Glob / Grep / WriteFile / EditFile / Bash）按语义打 `category`：
- `category: "read"` → ReadFile / Glob / Grep。
- `category: "write"` → WriteFile / EditFile。
- `category: "command"` → Bash。

### src/conversation/conversation.ts（扩展）

新增 `addAssistantFull(text, toolUses, thinking?)`：把 assistant 回合的文本、推理块、工具调用一次性写入历史（`thinkingBlocks` / `toolUses` 为空数组时不挂字段，节省内存）。

新增 `addToolResultsMessage(results)`：把一组 `ToolResultBlock` 作为一条 user 回合写入（`content: ""`，`toolResults: results`），保证多工具结果合并在同一条消息里。

新增 `addSystemReminder(content)`：包成 `<system-reminder>\n${content}\n</system-reminder>` 写入 user 回合。

### src/prompt/plan-mode.ts（新增）

```ts
export function buildPlanModeReminder(
  planPath: string,
  planExist: boolean,
  iteration: number
): string;
```

`iteration === 1` 返回完整 `planModeFullReminder`，包含 5 阶段工作流（理解 / 设计 / 评审 / 出稿 / `ExitPlanMode`）；中间迭代每隔 `reminderInterval = 5` 轮重复完整提示，其余返回 `planModeSparseReminder` 节省 token。

### src/permissions/checker.ts（占位）

```ts
export type PermissionMode = "default" | "plan" | "bypass";

export interface Decision {
  effect: "allow" | "ask" | "deny";
  reason?: string;
}

export class PermissionChecker {
  mode: PermissionMode;
  planFilePath?: string;
  check(toolName: string, category: ToolCategory, args: Record<string, unknown>): Decision;
  allowAlways(toolName: string, args: Record<string, unknown>): void;
}
```

本章 `check()` 在 `mode === "plan"` 时对非 `"read"` 工具返回 `deny`，否则 `allow`；具体策略与 ask 流程后续章节细化。

### src/tui/app.tsx（扩展）

```tsx
function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [iteration, setIteration] = useState(0);
  const [usage, setUsage] = useState({ in: 0, out: 0 });
  const abortRef = useRef<AbortController | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (streaming) abortRef.current?.abort();
      else exit();
    } else if (key.escape && streaming) {
      abortRef.current?.abort();
    }
  });

  const submit = async (text: string) => {
    conversation.addUserMessage(text);
    setStreaming(true);
    abortRef.current = new AbortController();
    const agent = new Agent({ ...config, abortSignal: abortRef.current.signal });
    try {
      for await (const ev of agent.run()) {
        switch (ev.type) {
          case "stream_text":   /* 累积 currentReply */ break;
          case "tool_use":      /* 工具行追加到 messages */ break;
          case "tool_result":   /* 工具结果摘要追加 */ break;
          case "usage":         setUsage(u => ({ in: u.in + ev.usage.inputTokens, out: u.out + ev.usage.outputTokens })); break;
          case "turn_complete": setIteration(i => i + 1); break;
          case "loop_complete": /* 最终答复提交 */ break;
          case "error":         /* 灰色错误块 */ break;
        }
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };
  // ... Ink 组件树
}
```

## 模块交互

```
用户提交文本
  └─ App.submit:
       ├─ conversation.addUserMessage(text)
       ├─ abortController = new AbortController()
       ├─ agent = new Agent({ ..., abortSignal: abortController.signal })
       └─ for await (ev of agent.run()):
            └─ Agent.run (AsyncGenerator, ReAct 循环):
                 while looping:
                   ├─ iteration++; (若 plan 模式) conversation.addSystemReminder(buildPlanModeReminder(...))
                   ├─ stream = client.stream(conversation, toolSchemas, abortSignal)
                   │    └─ 适配器：把 SDK 流式 chunk 翻译为 StreamEvent
                   │         text_delta / tool_call_complete / stream_end{ usage }
                   │    → Agent 转发 stream_text、累积 toolUses、记录 usage、stopReason
                   ├─ yield usage
                   ├─ if abortSignal.aborted:
                   │    conversation.addAssistantFull(fullText, [], [])
                   │    yield loop_complete{ stopReason: "interrupted" }; return
                   ├─ conversation.addAssistantFull(fullText, toolUses, thinkingBlocks)
                   ├─ 有 toolUses:
                   │    ├─ executeTools:
                   │    │     readSafe (category==="read") 并发批 (Promise.all)
                   │    │     writeDangerous 串行批 (await 单个)
                   │    │     PermissionChecker.check → allow/ask/deny
                   │    │     StreamingExecutor.collectResults
                   │    ├─ yield tool_result × N (按 events.push 顺序)
                   │    ├─ 未知工具计数 >= 3 → yield error; return
                   │    ├─ 截断 output 写入 toolResults
                   │    ├─ conversation.addToolResultsMessage(toolResults)
                   │    ├─ ExitPlanMode 检测 → yield turn_complete + loop_complete; return
                   │    └─ yield turn_complete
                   └─ 无 toolUses:
                        looping = false
                        yield loop_complete{ stopReason }
  └─ App: 按事件 setState，Ink 自动重渲染

# Esc / Ctrl+C(streaming) → abortController.abort()
#   → SDK fetch 抛 AbortError → Agent 在 catch / abortSignal.aborted 分支收尾
```

并发模型：`conversation` 在 `Agent.run()` 的单 AsyncGenerator 内串行操作；`Promise.all` 跑的只读批由 `StreamingExecutor` 各自调用独立 `Tool.execute()`，互不写 `conversation`；result 收集回主流程后再批量 `addToolResultsMessage`。满足 N2/N6。

## 文件组织

```text
mewcode/
├── src/
│   ├── agent/
│   │   ├── agent.ts                  — 新增：Agent 类、AgentConfig，承载 run() AsyncGenerator
│   │   ├── events.ts                 — 新增：AgentEvent discriminated union
│   │   └── streaming-executor.ts     — 新增：StreamingExecutor，工具批执行器
│   ├── llm/
│   │   ├── client.ts                 — 扩展：LLMClient.stream(conv, tools, abortSignal)；createClient 工厂
│   │   ├── events.ts                 — 扩展：StreamEvent + UsageInfo
│   │   ├── anthropic.ts              — 扩展：AsyncGenerator<StreamEvent>、stream_end 携带 usage
│   │   ├── openai.ts                 — 扩展：stream_options: { include_usage: true }
│   │   └── errors.ts                 — 新增：ContextTooLongError 等错误类（占位）
│   ├── tools/
│   │   ├── types.ts                  — 扩展：Tool 接口加 category
│   │   ├── registry.ts               — 扩展：getAllSchemas(protocol) 按协议输出 schema
│   │   ├── read-file.ts              — 修改：category = "read"
│   │   ├── glob.ts                   — 修改：category = "read"
│   │   ├── grep.ts                   — 修改：category = "read"
│   │   ├── write-file.ts             — 修改：category = "write"
│   │   ├── edit-file.ts              — 修改：category = "write"
│   │   └── bash.ts                   — 修改：category = "command"
│   ├── conversation/
│   │   └── conversation.ts           — 扩展：addAssistantFull / addToolResultsMessage / addSystemReminder
│   ├── prompt/
│   │   └── plan-mode.ts              — 新增：buildPlanModeReminder + 完整/精简模板
│   ├── permissions/
│   │   └── checker.ts                — 占位：PermissionChecker 接口与默认实现
│   └── tui/
│       └── app.tsx                   — 扩展：useEffect 消费 agent.run()、useInput 取消
├── package.json                      — 已有 dependencies
└── tsconfig.json                     — strict: true
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Loop 放哪 | `Agent.run()` 返回 `AsyncGenerator<AgentEvent>` | AsyncGenerator 天然把「事件流 + 取消传播」收敛在一个抽象里，Ink 端 `for await` 就能消费；改成回调或 EventEmitter 都得手动管 unsubscribe。 |
| 事件分派类型 | `AgentEvent` 用 discriminated union（按 `type` 字段） | TS 编译器对 `switch (ev.type)` 做穷尽性检查，新增事件类型时所有 `default` 分支编译报错，避免漏处理。 |
| 取消机制 | 标准 `AbortController` / `AbortSignal` | SDK（`@anthropic-ai/sdk`、`openai`、`fetch`）原生支持 `signal`，无需自造 token；Esc / Ctrl+C 调 `controller.abort()` 即可一路传播到 SDK 内部 fetch。 |
| 工具批结构 | 一次回复内：所有 `category === "read"` 并发一批、其余串行 | 用户选定的「保序分批」：read 之后的 write 不会被提前；只读才并发加速。`bash` 保守归 `"command"`，可执行任意副作用，按串行处理。 |
| 并发实现 | `Promise.all` 在 `StreamingExecutor.collectResults()` 内 | 标准 JS 并发原语；每个 `Tool.execute()` 自己返回 `Promise<ToolResult>`，错误用 try/catch 包成 `{ isError: true }`，不会让 `Promise.all` reject 整批。 |
| 用量统计 | 适配器在 `stream_end` 携带 `UsageInfo`，Agent `yield { type: "usage" }` 透传 | 两 SDK 的流式 usage 都在流尾才完整（Anthropic 在 `message_stop` event、OpenAI 需 `stream_options.include_usage` 后读最后一个 chunk）；统一在 `stream_end` 发一次。 |
| 工具结果截断 | `Agent.run()` 写入历史前对 `output` 做 10000 字符截断 + `"\n… (output truncated)"` 追加 | 兜底安全网：工具内部已截行/截字符，但 `bash` 可能产出未截过的大输出；二次截断防上下文炸掉。 |
| Plan Mode 注入方式 | 每轮 `conversation.addSystemReminder(buildPlanModeReminder(...))` | 把提醒作为 user 回合的 `<system-reminder>` 标签注入，避免单独维护 system prompt 后缀字段；首轮完整提示、之后精简，节省 token。 |
| 未知工具阈值 | 内置 `consecutiveUnknown >= 3` | 单次未知工具靠 `StreamingExecutor` 的 `"Error: unknown tool '...'"` 结构化错误回灌即可让模型纠偏；只有连续多次才说明在对幻觉工具空转。混入任一已注册即重置。 |
| `maxIterations` 配置化 | `AgentConfig.maxIterations` 可传，默认 0（不限） | TUI 默认放开，自动化场景（cron / 脚本）可传一个上限当兜底；本章默认 0 与 ch03 「单轮闭环」语义平滑过渡。 |
| `ExitPlanMode` 工具特判 | `Agent.run()` 检测 `toolUses` 含 `"ExitPlanMode"` 即 `yield loop_complete` 退出 | Plan 模式的语义出口是工具调用而非 LLM 自动停；不特判则模型会继续下一轮触发计划态约束反复。 |
| 工具 schema 多协议 | `ToolRegistry.getAllSchemas(protocol)` 内联协议适配 | anthropic 与 openai 工具 schema 字段名不同（前者 `input_schema`、后者 `function.parameters`）；让 registry 统一暴露，client 只需传 `protocol`。 |
| 文件后缀 | 全部 `.ts` / `.tsx`（TUI 组件） | bun 原生跑 TS/JSX，无构建步骤；测试用 `bun test` 直接吃 `.test.ts`。 |
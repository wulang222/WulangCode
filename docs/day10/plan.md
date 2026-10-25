# Hook 生命周期挂钩系统 Plan## 技术栈

- 运行时：bun（包管理 + 启动 + 测试一体）
- 语言：TypeScript 5.x（`tsc --noEmit` 类型检查）
- TUI：Ink（React 渲染到终端）、ink-spinner、ink-text-input
- LLM SDK：@anthropic-ai/sdk、openai
- MCP：@modelcontextprotocol/sdk
- 配置解析：js-yaml
- 终端样式：chalk
- 模糊搜索：fuse.js
- 命令执行：Node.js 内建 `child_process.execSync`（同步） + 全局 `fetch`（HTTP）
- 测试：bun test

## 架构概览（分层）

Hook 系统横跨配置、引擎、Agent 接入三层：

1. **配置层（`src/config/config.ts`）**
   - `HookConfig` 接口约束单条 hook 的字段形态
   - `loadConfig` 在三个候选路径里读 YAML 并 `mergeConfig`，把 `hooks` 数组叠加合并
   - 不做语义校验，留给 `validate`

2. **引擎层（`src/hooks/hooks.ts`）**
   - `HookEngine` 类持有 `hooks: HookConfig[]`、`firedOnce: Set<string>`、`notifications: string[]`、可选 `agentRunner`
   - 公开方法：`fire(event, ctx)`、`firePreToolHooks(toolName, args)`、`recordNotification(msg)`、`drainNotifications()`
   - 私有方法：`executeAction(hook, ctx)` 按 action.type 派发四类执行器
   - 自由函数：`evaluateCondition` / `evaluateSingleCondition` / `getContextValue`、模块级 `validate(hooks)`

3. **Agent / TUI 接入层**
   - `App` 组件（`src/tui/app.tsx`）首次 mount 时调 `validateHooks(hooks)`，错误以 system 消息上屏，成功后用 `useRef` 持有 `HookEngine` 实例
   - 构造 `Agent` 时把 `hookEngine` 通过 `AgentConfig` 注入
   - `Agent.run`（`src/agent/agent.ts`）在 6 个生命周期点调 `fireLifecycle`、在 `executeBatch` 顶部调 `firePreToolHooks`、在 `processToolResult` 末尾调 `fire("post_tool_use")`
   - 主循环每轮顶部 `drainNotifications()` 把 hook 输出经 `addSystemReminder` 写回对话

## 数据流

```
YAML 配置文件 ──loadConfig──> AppConfig.hooks
                                  │
                                  v
                           App({hooks}) (props)
                                  │
                                  ├──> validateHooks  -> Error? -> system 消息上屏
                                  v
                          new HookEngine(hooks)  (useRef 持有)
                                  │
                                  v
                      AgentConfig.hookEngine = engineRef
                                  │
                                  v
              Agent.run 主循环：
                ├ session_start ──> fireLifecycle("session_start")
                ├ 每轮顶部：
                │   ├ drainNotifications() -> addSystemReminder
                │   ├ fireLifecycle("turn_start")
                │   └ fireLifecycle("pre_send")
                ├ client.stream(...)
                ├ fireLifecycle("post_receive", fullText)
                ├ 工具循环（executeBatch）：
                │   ├ firePreToolHooks(name, args) -> rejected? -> 生成 isError tool_result
                │   ├ 权限检查 / executor 运行
                │   └ processToolResult: fire("post_tool_use")  → notification
                ├ fireLifecycle("turn_end")
                └ finally: fireLifecycle("session_end")
```

## 核心数据结构与接口

```typescript
// src/hooks/hooks.ts
export type EventName =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "pre_send"
  | "post_receive"
  | "pre_tool_use"
  | "post_tool_use"
  | "shutdown";

export interface HookContext {
  event: EventName;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  message?: string;
}

export interface HookResult {
  output: string;
  success: boolean;
  reject: boolean;
}

export class HookEngine {
  private hooks: HookConfig[];
  private firedOnce: Set<string>;
  private notifications: string[];
  agentRunner?: (prompt: string, ctx: HookContext) => Promise<string>;

  constructor(hooks: HookConfig[]);

  recordNotification(message: string): void;
  drainNotifications(): string[];

  fire(event: EventName, context: HookContext): Promise<HookResult[]>;
  firePreToolHooks(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ rejected: boolean; reason: string }>;

  private executeAction(hook: HookConfig, ctx: HookContext): Promise<HookResult>;
}

export function validate(hooks: HookConfig[]): Error | null;
```

```typescript
// src/config/config.ts
export interface HookConfig {
  id?: string;
  event: string;
  condition?: string;
  action: {
    type: string;
    command?: string;
    url?: string;
    method?: string;
    prompt?: string;
  };
  reject?: boolean;
  once?: boolean;
  async?: boolean;
  on_error?: string;
}

export interface AppConfig {
  providers: ProviderConfig[];
  permission_mode?: string;
  mcp_servers: MCPServerConfig[];
  hooks: HookConfig[];
}
```

```typescript
// src/agent/agent.ts
export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  hookEngine?: HookEngine;
  // ... 其它字段
}

export class Agent {
  private hookEngine?: HookEngine;
  async *run(): AsyncGenerator<AgentEvent>;
  private async fireLifecycle(event: EventName, message?: string): Promise<void>;
  private async executeBatch(toolUses: ToolUseBlock[], parallel: boolean): Promise<AgentEvent[]>;
  private async processToolResult(...): Promise<void>;
}
```

## 模块设计### 模块 A：HookConfig（`src/config/config.ts`）**职责：** 定义 hook YAML 字段映射，由 `loadConfig` 解析 / `mergeConfig` 合并。

**对外接口：** `HookConfig` interface、`AppConfig.hooks: HookConfig[]`。

**依赖：** js-yaml。

**实现要点：** 三层 YAML 文件按顺序加载、hooks 字段叠加合并；不做语义校验。

### 模块 B：HookEngine（`src/hooks/hooks.ts`）**职责：** 持有 hook 列表、提供 `fire` / `firePreToolHooks` 派发入口、维护 once 集合与 notification 队列、协调四类动作执行。

**对外接口：** `HookEngine` 类、`HookContext` / `HookResult` 类型、`EventName` 类型、模块级 `validate` 函数。

**依赖：** Node.js `child_process.execSync`、全局 `fetch`、`HookConfig`。

### 模块 C：condition 求值（同文件）**职责：** `evaluateCondition` 把表达式按 `&&` / `||` 切分、`evaluateSingleCondition` 处理 `!` 取反与四种二元算子、`getContextValue` 实现字段路径取值。

**对外接口：** 模块内部使用，不导出。

**依赖：** JavaScript 内置 `RegExp`。

### 模块 D：动作执行器（同文件，私有方法）

- `command`：`execSync` 同步运行命令、注入三个环境变量、30s 固定 timeout
- `prompt`：直接把 `action.prompt` 当作 output
- `http`：`fetch` POST + JSON body=context
- `agent`：调用 `this.agentRunner(prompt, ctx)`，未注入时返回失败结果

### 模块 E：Agent 接入（`src/agent/agent.ts`）**职责：**
- `AgentConfig` 多一个 `hookEngine?: HookEngine` 字段
- `Agent` 类持有 `private hookEngine?: HookEngine`
- `private async fireLifecycle(event: EventName, message?: string)` 把单事件 fire 包成一句话，把输出存入 notification
- `run()` 在 session_start / turn_start / pre_send / post_receive / turn_end / session_end 各调一次 `fireLifecycle`，且 turn_start 之前调 `drainNotifications()` 把上轮 hook 输出注入 `addSystemReminder`
- `executeBatch` 顶部调 `firePreToolHooks`，rejected 时构造 `isError=true` 的 tool_result
- `processToolResult` 末尾调 `fire("post_tool_use", ctx)`，把 output 写入 notification

**对外接口：** 仅扩展构造器签名。

**依赖：** 模块 B。

### 模块 F：TUI 接入（`src/tui/app.tsx`）**职责：**
- `App` 接收 `hooks: HookConfig[]` props
- mount 时 `validate(hooks)` 一次，错误以 system 消息显示
- `useRef<HookEngine>` 持有引擎，整个 App 生命周期共享
- 在 `runAgentLoop` 里把 `hookEngineRef.current ?? undefined` 注入 `Agent` 构造

**对外接口：** App 组件 props 扩展。

**依赖：** 模块 B、Ink。

### 模块 G：入口装配（`src/main.tsx`）**职责：** 从 `loadConfig()` 拿到 `cfg.hooks`，作为 prop 传给 `<App>`。

**对外接口：** 无新增。

**依赖：** 模块 A、模块 F。

## 模块交互（调用链/时序）**启动期：**

```
main.tsx
  loadConfig()                  # 读 ~/.mewcode/config.yaml & .mewcode/config.yaml & .mewcode/config.local.yaml
    └ mergeConfig 把 hooks 数组 append 合并
  render(<App hooks={cfg.hooks} ... />)
        │
        v
  App useEffect (首次 mount)
    validateHooks(hooks)        # 聚合错误返回 Error | null
       ├ Error 非 null → setMessages(prev => [..., {role: "system", content: `Hook warning: ${err.message}`}])
       └ null         → 无提示
    hookEngineRef.current = new HookEngine(hooks)
```

**单轮 Agent 主循环：**

```
runAgentLoop()
  new Agent({ hookEngine: hookEngineRef.current, ... })
  for await ev of agent.run():
     ├ session_start         ──> fireLifecycle("session_start")
     │
     ├ 主循环 iteration++：
     │   ├ manageContext(...)
     │   ├ skillReminder 注入
     │   ├ HookEngine.drainNotifications() → for note: addSystemReminder(note)
     │   ├ fireLifecycle("turn_start")
     │   ├ fireLifecycle("pre_send")
     │   ├ client.stream(apiConv, toolSchemas)
     │   ├ fireLifecycle("post_receive", fullText)
     │   ├ tool calls? → executeBatch(toolUses, parallel)
     │   │     for tu of toolUses:
     │   │        ├ firePreToolHooks(tu.toolName, tu.arguments)
     │   │        │     ├ rejected → push isError tool_result, continue
     │   │        │     └ ok      → 权限检查 → executor.submit
     │   │        └ processToolResult(r, ...)
     │   │              ├ tool_result event
     │   │              └ fire("post_tool_use", ctx) → notification 入队
     │   └ fireLifecycle("turn_end")
     │
     └ finally: fireLifecycle("session_end")
```

**Hook 内部派发：**

```
fire(event, ctx):
   for hook of this.hooks:
     ├ hook.event !== event → continue
     ├ hook.once && firedOnce.has(key) → continue
     │   else firedOnce.add(key)
     ├ hook.condition && !evaluate(cond, ctx) → continue
     ├ hook.async:
     │   executeAction(hook, ctx)
     │      .then(r => recordNotification(r.output))
     │      .catch(err => recordNotification(`Async hook error: ${err.message}`))
     │   results.push({output: "(async)", success: true, reject: false})
     │   continue
     └ try:
         result = await executeAction(hook, ctx)
         results.push(result)
         if result.reject && event === "pre_tool_use" → break
       catch err:
         on_error 决定是否往 results push fail / reject 标记
```

## 文件组织

```text
mewcode/
├── src/
│   ├── config/
│   │   └── config.ts           # HookConfig 接口、loadConfig 加载 hooks 字段
│   ├── hooks/
│   │   └── hooks.ts            # HookEngine、validate、condition 求值、动作执行器
│   ├── agent/
│   │   ├── agent.ts            # AgentConfig.hookEngine、fireLifecycle、executeBatch hook 钩子
│   │   ├── events.ts           # AgentEvent 联合类型
│   │   └── streaming-executor.ts
│   ├── tui/
│   │   └── app.tsx             # 持有 HookEngine、validateHooks 警告、注入到 Agent
│   └── main.tsx                # loadConfig 后把 hooks 作为 props 传给 App
├── tests/
│   ├── agent.test.ts           # surfaces lifecycle-hook output as a system reminder
│   └── config.test.ts          # mergeConfig 合并 hooks 数组
├── package.json                # bun test / tsc --noEmit 脚本
└── docs/typescript/ch12/
    ├── spec.md
    ├── plan.md
    ├── task.md
    └── checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| HookEngine 形态 | 单 class，方法直接挂在实例上 | 简单直接；hook 数量小且 Agent 内只构造一次 |
| 配置入口 | 复用 `AppConfig.hooks` 字段 | 已有 `loadConfig` 多层合并，不再单独维护 hooks.yaml；用户配置面统一 |
| 校验时机 | App mount 时一次性 | 启动期立刻反馈；不阻塞主流程；TUI 显示 system 消息便于用户看到 |
| 错误聚合策略 | 所有错误 `;` 拼成一个 Error | 一次性给用户全部问题列表，不打断启动 |
| condition 解析 | 字符串切片 + `match` 正则 | 简洁单行表达式无需 AST；切片成本可忽略 |
| condition 字段取值 | 固定 5 个保留 key + args 兜底 | hook 场景关心的字段有限；字段穿透到 args 满足扩展性 |
| 命令执行方式 | `execSync` 同步阻塞 | 与 `pre_tool_use` 拦截语义一致——同步等结果才能 reject |
| 命令 timeout | 写死 30 秒 | 用户无法对单条 hook 设 timeout；耗时任务应走 `async: true` |
| HTTP 客户端 | 全局 `fetch` | Bun/Node 18+ 自带，无需额外依赖 |
| HTTP body | `JSON.stringify(context)` 固定 | 简单可预测；用户要灵活 body 时改用 command + curl |
| async hook | `Promise` 不 await、结果进 notification | 不阻塞主流程；与 reject 互斥避免语义混乱 |
| once 跟踪 key | `id ?? "${event}-${actionType}"` | 用户未显式给 id 也能去重；冲突由用户负责 |
| once 状态生命周期 | 跟随 HookEngine 实例 | 当前 App 整生命周期共享一个 HookEngine；`/clear` 不重置 |
| notification 注入位置 | turn_start 之前、`drainNotifications` → `addSystemReminder` | 与 skillReminder / 外部 notification 同位置；保证下一轮 LLM 请求能看到 |
| Hook 输出回灌为 system_reminder | 而非 user 消息 | 不污染对话历史的用户视角；与 plan / skill / memory 提醒同语义 |
| pre_tool_use 拦截语义 | `reject: true` 字段，不依赖退出码 | YAML 字段一眼可读；exit code 协议对 prompt/http/agent 等动作无法统一 |
| `shutdown` 事件 | 保留 EventName 联合但当前不 fire | 预留扩展位；不在主流程上引入未使用的调用 |
| agent 动作 | 通过外部注入 `agentRunner` | 子 Agent 调用链未与 hooks 直接耦合；未注入时返回明确失败信息 |
| 校验失败提示通道 | system 角色 ChatMessage | TUI 已有此渲染路径；避免 stderr 在 Ink 渲染下错位 |
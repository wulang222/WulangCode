# Hook 生命周期挂钩系统 Tasks

> 模块根路径 `src/hooks/`、`src/config/`、`src/agent/`、`src/tui/`、`src/main.tsx`；运行时为 bun + TypeScript 5.x；测试统一走 `bun test`、类型校验走 `tsc --noEmit`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/config/config.ts` | 新增 `HookConfig` 接口、`AppConfig.hooks` 字段、`mergeConfig` 把 hooks 数组叠加合并 |
| 新建 | `src/hooks/hooks.ts` | `HookEngine` 类、`EventName` / `HookContext` / `HookResult` 类型、condition 求值、四类动作执行器、模块级 `validate` |
| 修改 | `src/agent/agent.ts` | `AgentConfig.hookEngine`、`Agent` 持有引擎；`run()` 主循环 6 个生命周期点 `fireLifecycle`、turn_start 之前 `drainNotifications`；`executeBatch` 顶部 `firePreToolHooks`、`processToolResult` 末尾 `fire("post_tool_use")` |
| 修改 | `src/tui/app.tsx` | `App` 接收 `hooks` props、mount 时 `validateHooks` 并把错误以 system 消息显示；`useRef<HookEngine>` 持有引擎；`runAgentLoop` 注入到 `Agent` 构造 |
| 修改 | `src/main.tsx` | `loadConfig()` 之后把 `cfg.hooks` 作为 props 传给 `<App>` |
| 修改 | `tests/config.test.ts` | 覆盖 `mergeConfig` 把 hooks 数组 append 合并的语义 |
| 修改 | `tests/agent.test.ts` | 覆盖"lifecycle hook 输出作为下一轮 system_reminder"路径 |

## T1：定义 HookConfig 与 AppConfig 字段**文件：** `src/config/config.ts`

**依赖：** 无

**步骤：**
1. 新增 `interface HookConfig`，字段：`id?`、`event`、`condition?`、`action: { type, command?, url?, method?, prompt? }`、`reject?`、`once?`、`async?`、`on_error?`
2. `AppConfig` 接口加 `hooks: HookConfig[]` 字段
3. `loadSingleFile` 把 `raw.hooks` 转成 `HookConfig[]`（缺省 `[]`）
4. `mergeConfig` 把 `override.hooks` 直接 append 到 `base.hooks`（不去重）
5. `validateProviders` 不动；hooks 校验留给 hook 模块

**验证：** `tsc --noEmit` 通过、`bun test tests/config.test.ts` 通过

## T2：写 HookEngine 主体（类型与 fire 流程）**文件：** `src/hooks/hooks.ts`

**依赖：** T1

**步骤：**
1. 顶部 `import { execSync } from "node:child_process"` 与 `import type { HookConfig } from "../config/config.js"`
2. 导出 `type EventName = "session_start" | "session_end" | "turn_start" | "turn_end" | "pre_send" | "post_receive" | "pre_tool_use" | "post_tool_use" | "shutdown"`
3. 导出接口 `HookContext`、`HookResult`
4. 导出 `class HookEngine`：
   - 私有字段：`hooks: HookConfig[]`、`firedOnce = new Set<string>()`、`notifications: string[] = []`
   - 公开字段：`agentRunner?: (prompt, ctx) => Promise<string>`
   - 构造接收 `hooks: HookConfig[]`
   - `recordNotification(msg: string)`：trim 后非空入队
   - `drainNotifications(): string[]`：取出并清空
5. `async fire(event: EventName, ctx: HookContext): Promise<HookResult[]>`：
   - 遍历 `hooks`、`hook.event !== event` 跳过
   - `hook.once`：用 `id ?? "<event>-<actionType>"` 作 key，命中 `firedOnce` 跳过，否则 add
   - `hook.condition` 存在 → `evaluateCondition` 不通过跳过
   - `hook.async=true`：`executeAction` 返回 Promise，`.then` 把 output 写 `recordNotification`、`.catch` 把 `Async hook error: <msg>` 写 notification；results 推 `{output: "(async)", success: true, reject: false}`、continue
   - 否则 `await this.executeAction(hook, ctx)`，把 result push 到 results；如果 `result.reject && event === "pre_tool_use"` → break
   - 命令抛错时按 `hook.on_error ?? "ignore"` 决定是否往 results push 失败记录（`fail` / `reject`）

**验证：** `tsc --noEmit` 通过

## T3：实现 executeAction 四类动作**文件：** `src/hooks/hooks.ts`

**依赖：** T2

**步骤：**
1. 私有方法 `executeAction(hook: HookConfig, ctx: HookContext): Promise<HookResult>` 按 `hook.action.type` 分发：
2. `case "command"`：
   - `execSync(action.command, { encoding: "utf-8", timeout: 30000, env: {...process.env, MEWCODE_EVENT: ctx.event, MEWCODE_TOOL: ctx.toolName ?? "", MEWCODE_FILE_PATH: ctx.filePath ?? ""} })`
   - 返回 `{output: output.trim(), success: true, reject: hook.reject ?? false}`
   - 抛错时 `throw err`（交给上层 `try/catch` 路由到 `on_error`）
3. `case "prompt"`：直接返回 `{output: action.prompt ?? "", success: true, reject: false}`
4. `case "http"`：
   - `fetch(action.url, { method: action.method ?? "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(ctx) })`
   - 读 `resp.text()` 作为 output
   - 返回 `{output, success: resp.ok, reject: hook.reject ?? false}`
   - 抛错时 throw
5. `case "agent"`：
   - 若 `!this.agentRunner` → 返回 `{output: "agent-type hook configured but no AgentRunner registered", success: false, reject: hook.reject ?? false}`
   - 否则 `await this.agentRunner(action.prompt ?? action.command ?? "", ctx)`，返回 `{output, success: true, reject}`
   - 异常 catch 后返回 `{output: err.message, success: false, reject: hook.reject ?? false}`
6. 默认 `default` 分支返回空 result

**验证：** `tsc --noEmit` 通过

## T4：实现 firePreToolHooks 包装**文件：** `src/hooks/hooks.ts`

**依赖：** T2、T3

**步骤：**
1. `async firePreToolHooks(toolName: string, args: Record<string, unknown>): Promise<{rejected: boolean; reason: string}>`
2. 构造 `ctx: HookContext = { event: "pre_tool_use", toolName, args, filePath: String(args.file_path ?? args.path ?? "") }`
3. `const results = await this.fire("pre_tool_use", ctx)`
4. 遍历 results 找到第一条 `reject=true` 返回 `{rejected: true, reason: r.output}`
5. 没有被拦截返回 `{rejected: false, reason: ""}`

**验证：** `tsc --noEmit` 通过

## T5：实现 condition 求值**文件：** `src/hooks/hooks.ts`

**依赖：** T2

**步骤：**
1. 自由函数 `evaluateCondition(condition: string, ctx: HookContext): boolean`：
   - `condition.split(/\s*(&&|\|\|)\s*/)` 切成 token 数组
   - 用第 0 项调 `evaluateSingleCondition` 得到初始结果
   - 从 i=1 步进 2，按 op (`&&` / `||`) 与下一原子求值短路 / 累积
2. 自由函数 `evaluateSingleCondition(expr: string, ctx: HookContext): boolean`：
   - trim 后判 `startsWith("!")` → 递归求反
   - `^(\w+)\s*==\s*"([^"]*)"$` → 精确相等
   - `^(\w+)\s*!=\s*"([^"]*)"$` → 精确不等
   - `^(\w+)\s*=~\s*"([^"]*)"$` → `new RegExp(value).test(left)`，编译失败 catch 返回 false
   - `^(\w+)\s*=\*\s*"([^"]*)"$` → 把 `**` / `*` / `?` 翻译成正则后测试
   - 未命中所有规则返回 false
3. `getContextValue(key: string, ctx: HookContext): string`：
   - 5 个保留 key：`tool` / `event` / `file_path` / `message` / 其它走 `ctx.args?.[key]`
   - 不存在时返回空串

**验证：** `tsc --noEmit` 通过

## T6：实现模块级 validate**文件：** `src/hooks/hooks.ts`

**依赖：** T2

**步骤：**
1. 导出 `function validate(hooks: HookConfig[]): Error | null`
2. 维护 `validEvents = new Set<string>([9 个事件名])`、`validActions = new Set(["command", "prompt", "http", "agent"])`
3. 逐条 hook 检查：
   - `event` 必填 + 枚举
   - `action.type` 必填 + 枚举
   - 按 action.type 分支校验 `command` / `prompt` / `url` / `prompt|command` 必填非空
   - `reject && async` 互斥
4. 标签格式：`hook[i]` 或 `hook[i] (id="<id>")`
5. 错误数组用 `; ` join 成单条 Error message；空数组返回 null

**验证：** `tsc --noEmit` 通过

## T7：在 Agent 上引入 hookEngine 字段与 fireLifecycle**文件：** `src/agent/agent.ts`

**依赖：** T2

**步骤：**
1. 顶部 `import type { HookEngine, EventName } from "../hooks/hooks.js"`
2. `AgentConfig` 接口加 `hookEngine?: HookEngine`
3. `Agent` 类加私有字段 `private hookEngine?: HookEngine`
4. 构造里 `this.hookEngine = config.hookEngine`
5. 新增 `private async fireLifecycle(event: EventName, message?: string): Promise<void>`：
   - 引擎为 undefined 直接返回
   - `await this.hookEngine.fire(event, { event, message })`
   - 遍历 results：`r.output` 非空 → `this.hookEngine.recordNotification(r.output)`

**验证：** `tsc --noEmit` 通过

## T8：Agent.run 6 个生命周期点 fireLifecycle**文件：** `src/agent/agent.ts`

**依赖：** T7

**步骤：**
1. `run()` 入口（iteration 初始化之后、`try` 之前）：`await this.fireLifecycle("session_start")`
2. 主 `while (looping)` 入口 + 写完 `skillReminder`、外部 `notificationFn` 之后：
   - `if (this.hookEngine) for (const note of this.hookEngine.drainNotifications()) this.conversation.addSystemReminder(note)`
   - `await this.fireLifecycle("turn_start")`
   - `await this.fireLifecycle("pre_send")`
3. `client.stream` 接收完毕、abort 检查之后：`await this.fireLifecycle("post_receive", fullText)`
4. 工具循环末尾、写完 `addToolResultsMessage` 之后、`yield "turn_complete"` 之后：`await this.fireLifecycle("turn_end")`
5. 整个 `try` 用 `finally` 包住，`finally { await this.fireLifecycle("session_end") }`

**验证：** `tsc --noEmit` 通过

## T9：executeBatch 与 processToolResult 接入 hooks**文件：** `src/agent/agent.ts`

**依赖：** T7

**步骤：**
1. `executeBatch(toolUses, parallel)` 单工具循环顶部：
   - `if (this.hookEngine) { const hookResult = await this.hookEngine.firePreToolHooks(tu.toolName, tu.arguments); if (hookResult.rejected) { events.push({ type: "tool_result", toolName, toolId, output: `Rejected by hook: ${hookResult.reason}`, isError: true, elapsed: 0 }); continue; } }`
2. `processToolResult(r, toolUses, events)` 末尾 `events.push tool_result` 之后：
   - `if (this.hookEngine) { const hookResults = await this.hookEngine.fire("post_tool_use", { event: "post_tool_use", toolName: r.toolName, message: r.result.output }); for (const hr of hookResults) if (hr.output) this.hookEngine.recordNotification(hr.output); }`

**验证：** `tsc --noEmit` 通过

## T10：在 App 组件中持有 HookEngine 并校验**文件：** `src/tui/app.tsx`

**依赖：** T2、T6

**步骤：**
1. 顶部 `import { HookEngine, validate as validateHooks } from "../hooks/hooks.js"` 与 `import type { HookConfig } from "../config/config.js"`
2. `Props` 接口加 `hooks: HookConfig[]`
3. `App` 函数签名解构 `hooks` props
4. `const hookEngineRef = useRef<HookEngine | null>(null)`
5. 首次 mount 的 `useEffect` 内（init providers / memory 之后）：
   - `const hookErr = validateHooks(hooks); if (hookErr) setMessages(prev => [...prev, { role: "system", content: \`Hook warning: ${hookErr.message}\` }]);`
   - `hookEngineRef.current = new HookEngine(hooks)`
6. `runAgentLoop` 构造 `new Agent({...})` 时加 `hookEngine: hookEngineRef.current ?? undefined`

**验证：** `tsc --noEmit` 通过

## T11：main.tsx 把 hooks 透传给 App**文件：** `src/main.tsx`

**依赖：** T1、T10

**步骤：**
1. `const cfg = loadConfig()` 已存在
2. `render(<App providers={cfg.providers} mcpServers={cfg.mcp_servers} hooks={cfg.hooks} />)` 加 `hooks` props

**验证：** `bun run src/main.tsx --help` 或直接 `bun run src/main.tsx`（如果有 provider）启动不报错

## T12：tests/config.test.ts 覆盖 mergeConfig hooks 合并**文件：** `tests/config.test.ts`

**依赖：** T1

**步骤：**
1. 新 `it("appends hooks", ...)` 用例
2. 构造 base、override 两个 `AppConfig`，分别含一条 hook
3. `const result = mergeConfig(base, override)`
4. `expect(result.hooks).toHaveLength(2)`

**验证：** `bun test tests/config.test.ts` 通过

## T13：tests/agent.test.ts 覆盖 lifecycle hook 注入 system reminder**文件：** `tests/agent.test.ts`

**依赖：** T7、T8

**步骤：**
1. import `HookEngine`
2. `runAgent(client, opts)` 辅助函数把 `opts.hookEngine` 透传到 `new Agent({ hookEngine })`
3. 新 `it("surfaces lifecycle-hook output as a system reminder on the next turn", ...)`：
   - 构造 `new HookEngine([{ event: "turn_start", action: { type: "prompt", prompt: "REMINDER_NOTE" } }])`
   - 用 MockClient 触发两轮（一次 tool_use → 一次 end）
   - 跑完 `expect(conv.getMessages().some(m => m.content.includes("REMINDER_NOTE"))).toBe(true)`

**验证：** `bun test tests/agent.test.ts` 通过

## T14：整体编译与测试**文件：** —

**依赖：** T1-T13

**步骤：**
1. `tsc --noEmit`
2. `bun test`
3. 若有失败定位到具体 ch12 改动；其它历史测试不应被破坏

**验证：** 两条命令都通过

## T15：tmux 端到端实跑**文件：** 临时 `.mewcode/config.yaml`

**依赖：** T14

**步骤：**
1. 写一份测试 config.yaml：含 turn_start prompt hook、pre_tool_use command hook（reject + WriteFile 拦截）、post_tool_use async hook
2. tmux 新建 session：`bun run src/main.tsx`
3. 触发：
   - 让模型用中文回答（验证 prompt hook 注入）
   - 让模型尝试 WriteFile（验证拦截）
   - 让模型执行普通工具（验证 async hook 不阻塞）
4. 全程无 panic、Ink 渲染不错位

**验证：** 见 checklist 端到端场景

## 执行顺序

```text
T1                                # config.ts 字段
  └ T2 → T3 → T4 → T5 → T6        # hook 引擎主体（类型 / 动作 / 拦截包装 / 条件求值 / 校验）
T2 → T7 → T8                       # Agent 字段与 6 个生命周期点
       └ T9                        # executeBatch / processToolResult 钩入
T2/T6 → T10                        # App 持有引擎 + 校验提示
T1/T10 → T11                       # main.tsx 透传
T1 → T12                           # config 合并测试
T7/T8 → T13                        # agent 测试
T1-T13 → T14                       # 全量编译测试
T14 → T15                          # tmux 实跑
```

并行机会：
- T3 / T4 / T5 / T6 在 T2 完成后可并行
- T9 必须在 T7 之后但可与 T8 并行
- T12 / T13 在各自依赖项完成后可并行
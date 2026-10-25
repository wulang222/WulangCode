# Hook 生命周期挂钩系统 Checklist

> 每一项通过运行代码或观察行为验证，聚焦系统真实行为；编译走 `tsc --noEmit`、测试走 `bun test`、端到端走 `bun run src/main.tsx`。

## 实现完整性### 配置层

- [ ] `src/config/config.ts` 中 `HookConfig` 接口字段完整（id?/event/condition?/action/reject?/once?/async?/on_error?）（验证：`tsc --noEmit` 通过；`tests/config.test.ts` 中相关用例通过）
- [ ] `AppConfig.hooks` 在 `loadSingleFile` 缺省回退为 `[]`、`mergeConfig` 把两侧 hooks 数组叠加 append（验证：`bun test tests/config.test.ts -t "appends hooks"` 通过）
- [ ] 三层 YAML 文件 (`~/.mewcode/config.yaml`、`<cwd>/.mewcode/config.yaml`、`<cwd>/.mewcode/config.local.yaml`) 同时存在时 hooks 全部生效（验证：本地建三个文件各放一条 hook，启动后总 hook 数 = 三条之和）

### HookEngine 主体

- [ ] `src/hooks/hooks.ts` 暴露 `HookEngine` 类、`EventName` 类型、`HookContext` / `HookResult` 接口、模块级 `validate`（验证：`tsc --noEmit` 通过）
- [ ] `EventName` 联合类型包含 9 个事件名（session_start / session_end / turn_start / turn_end / pre_send / post_receive / pre_tool_use / post_tool_use / shutdown）（验证：源码 grep 确认）
- [ ] `HookEngine.fire(event, ctx)` 按声明顺序遍历，event 不匹配跳过、once 跳过、condition 不通过跳过（验证：单元测试覆盖三个分支）
- [ ] `HookEngine.firePreToolHooks(name, args)` 自动从 args 拼 `filePath`（取 `args.file_path ?? args.path`），返回 `{rejected, reason}`（验证：单元测试用 `WriteFile` 工具入参确认 filePath 命中）
- [ ] `recordNotification` / `drainNotifications` 一进一出，drain 后清空（验证：单元测试 push 两条、drain 拿到长度 2、再 drain 拿到长度 0）

### 动作执行器

- [ ] `command` 动作通过 `execSync` 同步执行，注入 `MEWCODE_EVENT` / `MEWCODE_TOOL` / `MEWCODE_FILE_PATH` 三个环境变量，timeout 30s（验证：单元测试用 `printenv MEWCODE_EVENT` 命令，stdout 含事件名）
- [ ] `prompt` 动作直接把 `action.prompt` 当 output 返回（验证：单元测试断言 result.output 等于 action.prompt）
- [ ] `http` 动作走 `fetch`，默认 POST、Content-Type=application/json、body=`JSON.stringify(ctx)`（验证：临时 `Bun.serve` 拉一个 echo server，验证收到的 body JSON 含 `"event":"<name>"`）
- [ ] `agent` 动作未注入 `agentRunner` 时返回 `{success:false, output:"agent-type hook configured but no AgentRunner registered"}`（验证：单元测试构造一条 agent 类型 hook + 未注入 runner，fire 后 results[0].success === false）

### 条件求值

- [ ] `condition: tool == "WriteFile"` 在 toolName=WriteFile 时返回 true、否则 false（验证：单元测试覆盖）
- [ ] `condition: file_path =* "**/*.txt"` 对 `.txt` 路径命中、对 `.md` 路径不命中（验证：单元测试覆盖）
- [ ] `condition: event =~ "^pre_"` 对 `pre_tool_use` 命中（验证：单元测试覆盖）
- [ ] `condition: !tool == "Bash"` 对 toolName=WriteFile 命中、对 Bash 不命中（验证：单元测试覆盖）
- [ ] `condition: tool == "WriteFile" && file_path =* "**/*.go"` 两个原子都命中时 true（验证：单元测试覆盖）
- [ ] `=~` 表达式正则编译失败时（如 `=~ "["`）返回 false 而不抛错（验证：单元测试覆盖）

### 拦截与异步

- [ ] `pre_tool_use` 事件下 hook `reject=true` 后 `firePreToolHooks` 返回 `rejected=true, reason=hook.output`，且 `fire` 循环 break 跳过后续 hook（验证：构造两条 hook，第一条 reject、第二条 noop，断言第二条未执行）
- [ ] 其它事件下 hook `reject=true` 不产生拦截（`fire` 不 break；调用方也不消费 reject 字段）（验证：单元测试覆盖 turn_start 场景下两条 hook 都执行）
- [ ] `async: true` 的 hook 立即返回 `(async)` 占位 result，不阻塞主调用（验证：单元测试用 sleep 命令 + Date.now 差值断言 < 100ms）
- [ ] `async` 命令完成后 output 进 notification 队列；命令异常时 `Async hook error: <msg>` 进 notification（验证：单元测试 await 短延迟后 drainNotifications 拿到对应字符串）

### once 与错误策略

- [ ] `once: true` 的 hook 首次命中后被加入 `firedOnce`、第二次 fire 同事件不再执行（验证：单元测试两次 fire 后 results 长度 1）
- [ ] `id` 缺省时 once key 为 `<event>-<actionType>`（验证：构造无 id 的两条 once hook，断言它们用同一 key 时第二条被去重；事件或 actionType 不同时各自独立）
- [ ] `on_error: "ignore"`（默认）：命令抛错时 results 不追加失败记录、主流程不变（验证：单元测试用 `false` 命令、断言 results.length=0）
- [ ] `on_error: "fail"`：命令抛错时 results 追加 `success=false, reject=false`（验证：单元测试覆盖）
- [ ] `on_error: "reject"`：命令抛错时 results 追加 `success=false, reject=true`，在 `pre_tool_use` 下导致 rejected=true（验证：单元测试覆盖）

### 校验

- [ ] `validate([])` 返回 `null`（验证：单元测试覆盖）
- [ ] `validate` 对每条非法 hook 生成形如 `hook[i] (id="<id>"): <msg>` 的错误片段，用 `; ` join（验证：单元测试覆盖）
- [ ] `event` 缺失 → `event is required`；非 9 个枚举之一 → `invalid event '<x>'`（验证：单元测试覆盖）
- [ ] `action.type` 缺失 / 非法 → 相应错误（验证：单元测试覆盖）
- [ ] `command` 类型缺少 `action.command` → 错误；prompt / http / agent 同理（验证：单元测试覆盖）
- [ ] `reject && async` 同时为 true → `reject and async are mutually exclusive`（验证：单元测试覆盖）

### Agent 接入

- [ ] `AgentConfig.hookEngine?: HookEngine` 字段存在，`Agent` 构造时赋值（验证：`tsc --noEmit` 通过 + 源码 grep）
- [ ] `Agent.run` 入口调 `fireLifecycle("session_start")`、`finally` 中调 `fireLifecycle("session_end")`（验证：源码 grep + agent.test 覆盖 session_end 触发）
- [ ] 主循环每轮顶部 `drainNotifications()` 把每条经 `addSystemReminder` 写回对话（验证：`tests/agent.test.ts` 中"surfaces lifecycle-hook output as a system reminder on the next turn" 通过）
- [ ] 主循环每轮 `fireLifecycle("turn_start")`、`fireLifecycle("pre_send")`、流式接完 `fireLifecycle("post_receive", fullText)`、工具结果写回后 `fireLifecycle("turn_end")` 均存在（验证：源码 grep 5 处 `fireLifecycle`）
- [ ] `executeBatch` 单工具循环顶部调 `firePreToolHooks`，rejected 时生成 `isError=true`、`output="Rejected by hook: <reason>"` 的 tool_result，跳过权限检查与 executor.submit（验证：单元测试 mock `hookEngine.firePreToolHooks` 返回 rejected，断言权限 checker 未被调）
- [ ] `processToolResult` 末尾调 `fire("post_tool_use", {event, toolName, message})`，把每条非空 output 入 notification 队列（验证：单元测试覆盖）

### TUI / 入口接入

- [ ] `src/tui/app.tsx` 的 `Props` 接口含 `hooks: HookConfig[]`，`App` 函数签名解构（验证：源码 grep + `tsc --noEmit` 通过）
- [ ] 首次 mount 的 `useEffect` 内调 `validateHooks(hooks)`，非 null 时 `setMessages` 追加一条 `role: "system"`、content 形如 `Hook warning: <msg>` 的消息（验证：源码 grep + 启动配置错 hook 后屏幕能看到）
- [ ] `useRef<HookEngine | null>(null)` 在同一 useEffect 内被 `new HookEngine(hooks)` 赋值（验证：源码 grep）
- [ ] `runAgentLoop` 构造 `new Agent({...})` 时传入 `hookEngine: hookEngineRef.current ?? undefined`（验证：源码 grep）
- [ ] `src/main.tsx` 把 `cfg.hooks` 作为 props 传给 `<App>`（验证：源码 grep）

## 集成

- [ ] HookEngine 不在 Agent 之外被复用（验证：`grep -rn "new HookEngine" src/` 仅有 `src/tui/app.tsx` 一处命中）
- [ ] `validateHooks` 返回非 null 时 mewcode 仍能正常进入 chat 状态（验证：写一条非法 hook、`bun run src/main.tsx` 启动后 TUI 渲染出 `Hook warning: ...` 并可继续输入）
- [ ] pre_tool_use 拦截的 tool_result 在下一轮 LLM 请求中可见（验证：`tests/agent.test.ts` 增补一条覆盖 rejected 路径的用例，断言 `events.some(e => e.type === "tool_result" && e.output.startsWith("Rejected by hook:"))` 为 true）
- [ ] notification 队列 drain 出来的字符串通过 `addSystemReminder` 写入对话，下一轮 `conversation.getMessages()` 能匹配到内容（验证：`tests/agent.test.ts` 中现有 REMINDER_NOTE 用例通过）

## 编译与测试

- [ ] 类型检查无错误：`tsc --noEmit`
- [ ] 全量单元测试通过：`bun test`
- [ ] `bun test tests/config.test.ts` 单独通过
- [ ] `bun test tests/agent.test.ts` 单独通过
- [ ] `bun run src/main.tsx` 启动后不抛错、TUI 渲染正常

## 端到端场景（tmux 实跑）

每个场景在 tmux 内启动一个 mewcode 实例完成，验证人工/可视化行为。

### 场景 1：turn_start prompt 注入**预置 `.mewcode/config.yaml`：**
```yaml
providers:
  - name: default
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-3-5-sonnet-latest
hooks:
  - id: zh-default
    event: turn_start
    action:
      type: prompt
      prompt: "请用中文回答"
```

**步骤：**
- [ ] tmux 启动 `bun run src/main.tsx`
- [ ] 输入英文消息 "hi there"
- [ ] LLM 回复使用中文（next turn 的 system_reminder 注入生效）
- [ ] 再发一条 "tell me about TypeScript"，仍然中文回复（每轮都注入）

### 场景 2：pre_tool_use command 拦截 WriteFile**预置：**
```yaml
hooks:
  - id: block-write
    event: pre_tool_use
    condition: tool == "WriteFile"
    reject: true
    on_error: reject
    action:
      type: command
      command: "echo 'blocked by hook policy' >&2; false"
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 输入"创建一个 hello.txt 内容是 hi"
- [ ] LLM 调 WriteFile 时被拦截
- [ ] 对话流中工具结果显示 `Rejected by hook: Hook error (rejecting): ...`
- [ ] 文件未被创建（手动 `ls hello.txt` 不存在）

### 场景 3：post_tool_use async 后台命令**预置：**
```yaml
hooks:
  - id: bg-log
    event: post_tool_use
    async: true
    action:
      type: command
      command: "echo \"$(date) tool_done\" >> /tmp/mewcode-hook.log"
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 让 LLM 执行一个 ReadFile 或 Glob 工具
- [ ] 主对话立即进入下一轮、不停顿
- [ ] `cat /tmp/mewcode-hook.log` 看到时间戳条目

### 场景 4：once + session_start prompt**预置：**
```yaml
hooks:
  - id: first-session-note
    event: session_start
    once: true
    action:
      type: prompt
      prompt: "first-session-only-note"
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 发任意消息——下一轮 LLM 请求里有 `first-session-only-note` 系统提醒
- [ ] 再发一条消息——第二次 Agent.run 时 session_start 不再 fire（once 命中）
- [ ] 重启 mewcode 进程后又会出现一次

### 场景 5：非法 hook 不阻塞启动**预置：**
```yaml
hooks:
  - id: bad-event
    event: not_a_real_event
    action:
      type: command
      command: "echo x"
  - id: good
    event: turn_start
    action:
      type: prompt
      prompt: "ok"
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] TUI 顶部出现 system 消息 `Hook warning: hook[0] (id="bad-event"): invalid event 'not_a_real_event'`
- [ ] 仍能正常输入与对话
- [ ] 合法 hook（good）仍然生效（下一轮里能看到 "ok" 注入）

### 场景 6：http 通知（post_receive）**预置：**
- 另起终端：`python3 -m http.server 9999 --bind 127.0.0.1`（或任意 echo server）
```yaml
hooks:
  - id: notify-receive
    event: post_receive
    action:
      type: http
      url: "http://127.0.0.1:9999/recv"
      method: POST
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 发任意消息触发一轮回复
- [ ] echo server 控制台看到 POST 请求（如 `python3 -m http.server` 日志里的 `POST /recv`）

### 场景 7：reject + async 互斥校验**预置：**
```yaml
hooks:
  - id: bad-combo
    event: pre_tool_use
    reject: true
    async: true
    action:
      type: command
      command: "echo x"
```

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] TUI 顶部出现 system 消息 `Hook warning: hook[0] (id="bad-combo"): reject and async are mutually exclusive`
- [ ] mewcode 仍能进入聊天

### 场景 8：端到端组合**预置：** 把场景 1、2、3 的 hook 合并到一份 config.yaml

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 首轮触发 turn_start prompt 注入、模型中文回答
- [ ] 输入"帮我写 hello.txt 并跑一遍 ls"
- [ ] LLM 调 WriteFile 被拦截 → 改用 Bash 创建文件 → 触发 post_tool_use async log
- [ ] 整个过程不卡顿、`tsc --noEmit` 与 `bun test` 全过、无 panic
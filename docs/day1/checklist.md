# 多协议 LLM 终端对话客户端 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为；括号内为验证方式。运行入口
> 统一为 `bun run src/main.tsx`，编译与测试用 `tsc --noEmit` / `bun test`。

## 实现完整性
- [ ] 配置加载：合法 `.mewcode/config.yaml` 能解析出 providers 列表（验证：单测
      `tests/config.test.ts` + `bun run src/main.tsx` 启动进入对话）。(AC1/F1)
- [ ] 配置合并：同时存在 `~/.mewcode/config.yaml` 与 `<cwd>/.mewcode/config.yaml`
      时，后者的 providers 整列覆盖前者（验证：临时写两份配置，启动状态栏与启动
      横幅显示的 model 来自项目级配置）。(F1)
- [ ] 配置校验：缺字段/非法 protocol/无任何配置文件时分别抛 `ConfigError` 并由
      `main.tsx` `console.error` + `process.exit(1)`，终端无堆栈（验证：删字段/改
      protocol/移走配置目录分别 `bun run src/main.tsx`）。(AC1/N4)
- [ ] API key 回退：`provider.api_key` 缺失但设了 `ANTHROPIC_API_KEY` 或
      `OPENAI_API_KEY` 时能正常请求；两者都缺时构造 client 时抛
      `AuthenticationError`，对话区红字显示（验证：分别 unset/set 环境变量启动）。
      (F2/AC2/N5)
- [ ] 单 provider 直进：`providers.length === 1` 时启动直接进入对话（验证：单条
      配置运行）。(AC3/F3)
- [ ] 多 provider 选择：多条配置时呈现 `<ProviderSelect>`，方向键移动 + Enter 选定
      后状态栏显示所选 model（验证：两条配置运行）。(AC3/F3)
- [ ] 内置 system prompt 与历史随请求发送：anthropic 协议下用 SDK debug log 或抓包
      验证请求 JSON 含 `system[0].text`、`messages` 包含完整历史（验证：让模型回答
      "你是谁/你的规则"看是否对应内置 prompt）。(AC5/F5)
- [ ] thinking 启用：anthropic 配 `thinking: true` 时请求体含
      `thinking.type === "enabled"`，界面不出现任何思考文本（验证：开关 thinking
      对比一次）。(AC5/AC6/F5/F6)
- [ ] 流式逐字：回复以纯文本逐字出现（验证：长回复肉眼可见逐步输出，`streamingText`
      在 `<ChatView>` 中实时更新）。(AC9/F9)
- [ ] markdown 定型：`stream_end` 后整段以 `marked + marked-terminal` 渲染（代码块/
      列表/强调正确）；`committedIndexRef` 把该消息移交 `<Static>` 永久渲染（验证：
      让模型输出含代码块与列表的内容）。(AC9/F9)
- [ ] 多行输入：Shift+Enter 或 Ctrl+J 换行、Enter 提交、提交后输入框清空、`isStreaming`
      时显示 "Waiting..."（验证：输入两行后提交；流式期间再键入不进入 lines）。(AC10/F10)
- [ ] 响应计时：自提交即显示动词 + 秒数 + token 量，秒数每秒递增；`stream_end` 后
      spinner 消失，下一轮重新开始计时（验证：发一条慢回复观察）。(AC13/F13)
- [ ] 错误反馈：错误 key / 不存在 model / 网络断 / 上下文超长时，错误以红色文字
      显示在 chat 区或底部，程序不退出（验证：分别触发四种错误）。(AC12/F12)
- [ ] 退出：`/exit` 与 Ctrl+C 均能安全退出；`process.on("exit", restoreCursor)`
      让终端光标可见、`raw mode` 已还原（验证：两种方式各试一次，退出后看光标是否
      正常闪烁）。(AC11/F11)
- [ ] 界面布局：启动含彩色 `/\_/\` / `( o.o )` / `> ^ <` 猫 banner + `MewCode v0.1.0`
      + 当前 model + `process.cwd()` + 输入框（`❯` 前缀，圆角上下边框）+
      底部 `<StatusBar>`（验证：启动截图）。(AC8/F8)

## 集成
- [ ] 三协议同一接口：`AnthropicClient` / `OpenAIClient` / `OpenAICompatClient` 都
      实现同一 `LLMClient.stream(): AsyncGenerator<StreamEvent>`；TUI 只感知事件
      类型不感知 SDK 差异（验证：分别用 anthropic / openai / openai-compat 跑同一
      组对话，行为一致）。(AC4/N3)
- [ ] base_url 覆盖：在 `provider.base_url` 填兼容端点后能正常收发（验证：把
      openai-compat 指向某兼容端点跑一轮）。(F4)
- [ ] 上下文窗口四级回退：显式 `context_window` → anthropic `/v1/models` → 内置子串
      表 → 200k/128k；anthropic auto-fetch 失败时静默降级，不阻塞启动（验证：故意
      指错 anthropic `base_url`，启动仍能进入对话，`getContextWindow` 同步值落在
      内置表或默认值）。
- [ ] 多轮上下文：在 `ConversationManager.history` 中能看到 user/assistant 交替；
      新一轮请求把全量历史交给 client；进程重启后历史清零（验证：连续两轮 + 重启
      验证）。(AC7/F7)
- [ ] 流式不阻塞 UI：`for await ... of client.stream(...)` 与 React 渲染独立；流式
      期间 `<Spinner>` 仍每秒跳动，`<Static>` 部分不闪烁（验证：长回复期间观察界面
      不冻结，无逐行重绘抖动）。(N1)
- [ ] 输入框历史回放：上下方向键可翻 `promptHistory`（验证：发两条后按 ↑/↓ 回填）。
- [ ] 窗口自适应：缩放终端宽度后 `<Box flexDirection="column">` 重新 wrap，markdown
      代码块按宽度软换行不错版（验证：运行中调整终端宽度）。(N6)
- [ ] 密钥安全：`resolveAPIKey` 的返回值仅传给 SDK 构造器，从未写入 `messages` /
      `streamingText` / 任何 console 输出（验证：通读运行日志、ripgrep 抓不到明文
      key）。(N5)

## 编译与测试
- [ ] `tsc --noEmit` 无错误，无 `any` 漏（除少数注释标注的边界 cast）。
- [ ] `bun test` 通过：
      - `tests/config.test.ts` 覆盖合法/缺字段/非法 protocol/无文件 + `resolveAPIKey`
        三种来源；
      - `tests/conversation.test.ts` 覆盖 add user/assistant 顺序、`getMessages`
        返回副本、`len`、`truncateTo`。
- [ ] `bun run src/main.tsx` 启动无 warning（除 Ink 默认 logger 提示）。
- [ ] `.mewcode/config.yaml` 在 `.gitignore`，`.mewcode/config.yaml.example` 入库
      （验证：`git status` 不显示真配置；`git ls-files` 能看到示例）。

## 端到端场景
- [ ] 场景 1（anthropic 多轮 + thinking）：单条 anthropic 配置（`thinking: true`）启动
      → 连续两轮，第二轮明确引用第一轮（如"刚才那个数字加 5"）→ 流式逐字 +
      spinner 计时 + `stream_end` 后 markdown 定型 → `/exit` 退出后终端光标恢复。
- [ ] 场景 2（openai Responses 流式）：单条 `protocol: openai` 配置 → 发一条要求
      输出含代码块的请求 → 流式逐字、`response.completed` 后整段以 marked-terminal
      高亮渲染 → 状态栏显示 inputTokens/outputTokens 非零。
- [ ] 场景 3（openai-compat 兼容端点）：`protocol: openai-compat` + 自定义
      `base_url` 指向兼容服务 → 跑两轮对话流畅 → 错误 finish_reason `length` 时
      能在错误状态上显示 `max_tokens` 相关信息。
- [ ] 场景 4（多 provider 选择）：两条配置启动 → 出现 `<ProviderSelect>` 列表 →
      ↓ 选第二条 + Enter → 启动横幅与状态栏切到该 provider 的 model → 正常对话。
- [ ] 场景 5（错误恢复）：把 api_key 改错 → 提交一条 → 红色 `AuthenticationError`
      显示、TUI 不退出 → 修正 key 重启后能继续正常对话；中途 Ctrl+C 退出，终端
      光标恢复可见。
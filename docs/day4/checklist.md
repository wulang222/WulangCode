# 系统提示工程化 Checklist

> 每一项通过运行代码或观察行为来验证,聚焦系统行为;括号内为验证方式与对应需求。

## 实现完整性
- [ ] 模块化装配:`buildSystemPrompt(env)` 输出按 Identity(0) → System(10) → DoingTasks(20) → ExecutingActions(30) → UsingTools(40) → ToneStyle(50) → TextOutput(60) → Environment(70) 顺序拼接,以 `\n\n` 分隔(验证:`tests/prompt-builder.test.ts` 断言 Identity 段出现在 UsingTools 段之前、各段以空行分隔)。(AC1/F1)
- [ ] 挂载即扩展:`new PromptBuilder().add({...自定义 Section})` 后 build,该 Section 落在与其 priority 对应的位置,不改 PromptBuilder.build 主逻辑(验证:`tests/prompt-builder.test.ts` 传入额外 Section 断言其位置)。(AC1/F1)
- [ ] 可选空槽:`buildSystemPrompt(env)`(无 opts)输出不含 Skills / CustomInstructions / Memory 段、无连续空行;传入 `opts.skillSection` 等之一才出现(验证:`tests/prompt-builder.test.ts` 断言)。(AC2/F1)
- [ ] 缓存确定性:连续两次 `buildSystemPrompt(sameEnv)` 字符串严格相等;`AnthropicClient.this.systemPrompt` 跨轮不变(验证:`tests/prompt-builder.test.ts` 双调用断言 `===`;手工 console.log 两轮 `params.system[0].text` 相等)。(AC5/F3/N1)
- [ ] 环境信息呈现:`environmentSection(env)` 在系统提示尾部,输出 `# 环境` 段含工作目录 / 平台/架构 / Shell / 是否 Git 仓库 / 日期;git 仓库下含 Git 分支;model 非空时含模型行(验证:`tests/prompt-builder.test.ts` 断言 Render 含各行)。(AC3/F2)
- [ ] 双重强化:`usingToolsSection().content` 含「有专用工具时绝不要用 Bash」+ ReadFile / EditFile / WriteFile / Glob / Grep 对应表;`BashDescription` 含「Avoid using this tool to run cat, head, tail...」;`EditFileDescription` 含「You MUST read the file with ReadFile before editing」(验证:`bun test` + 直接 import descriptions 断言子串)。(AC7/F5)
- [ ] 补充消息注入机制:`addSystemReminder("X")` 后 `getMessages()` 末条 role=user、content === `<system-reminder>\nX\n</system-reminder>`(验证:`tests/conversation.test.ts` 已断言;新增断言精确字符串匹配)。(AC8/F6)
- [ ] 缓存字段解析:`UsageInfo` 含 `cacheReadInputTokens / cacheCreationInputTokens`;Anthropic 路径 `message_start` 事件读 `cache_read_input_tokens / cache_creation_input_tokens`;OpenAI Responses 读 `input_tokens_details?.cached_tokens`;OpenAI Chat 读 `prompt_tokens_details?.cached_tokens`;缺字段 `?? 0` 不抛(验证:三协议 smoke 跑两轮观察字段)。(AC6/F4/N6)
- [ ] Anthropic 缓存断点真实发出:`params.system[0].cache_control === { type:"ephemeral" }`、`params.tools[last].cache_control === { type:"ephemeral" }`(若有 tools)、`messages` 末条 user 的 content 末块 `cache_control === { type:"ephemeral" }`(验证:`tests/anthropic-client.test.ts` 序列化 params 断言)。(AC4/F3)

## 集成
- [ ] 规划模式按轮次注入:iteration=1 注入完整版(含「Plan mode is active」+ 5 阶段工作流);iteration=2 注入精简版(「Plan mode still active」);iteration 命中 `floor((iter-1)/5) % 5 === 0` 重复完整版;reminder 进入持久 history(验证:`tests/plan-mode-reminder.test.ts` 各 iteration 断言 + `tests/agent.test.ts` 多轮脚本)。(AC9/F6/F7)
- [ ] 规划模式工具集:规划模式下 `checker.planFilePath` 被设置;ExitPlanMode 工具可调,其他写工具被 PermissionChecker 拦截(验证:`bun test` 涉及 plan-mode permissions 的用例通过)。(AC9/F7)
- [ ] 稳定系统提示跨模式一致:`/plan` 与 `/do` 切换时 LLMClient 不重建,`this.systemPrompt` 不变(验证:`tests/app.test.tsx` 或手工断点)。(F7/N1)
- [ ] 历史合法:`addSystemReminder` 写入连续 user 后 `buildAnthropicMessages` 自动合并成多 TextBlock 单条 user,Anthropic API 不报 400(验证:`tests/conversation.test.ts` + Anthropic smoke 多轮)。(AC12/N3)
- [ ] 跨协议一致:Anthropic / OpenAI / OpenAI-Compat 三 client 都接收同一份 `systemPrompt` 字符串;`UsageInfo` 字段三家都填充(验证:三 client 单测各跑一次断言 systemPrompt 字符串一致)。(AC10/F8)
- [ ] 不破坏 ch04:多轮连环、用户取消(`abortSignal`)、`ContextTooLongError` 自恢复、自动压缩、`maxTokens` 升级均成立(验证:`bun test` 全量通过)。(AC11/N2)
- [ ] 环境采集降级:在非 git 临时目录 `detectEnvironment` catch 分支生效,`isGitRepo=false / gitBranch=""`,函数返回正常 EnvironmentContext 不抛(验证:`tests/prompt-builder.test.ts` 用 tmp 目录调用)。(AC13/N4)
- [ ] 界面不阻塞:`detectEnvironment` 通过 `execSync` 同步跑 `git rev-parse` 两条短命令,初始化只调一次,不阻塞 TUI 渲染(验证:正常 git 仓库内启动 TUI 观察启动延迟无异常)。(N4)

## 编译与测试
- [ ] `tsc --noEmit` 无错误。
- [ ] `bun test` 通过(`tests/prompt-builder.test.ts`、`tests/plan-mode-reminder.test.ts`、`tests/conversation.test.ts`、`tests/agent.test.ts` 等)。
- [ ] `bun build src/main.tsx --target bun --outdir /tmp/mewcode-build` 编译无错(可选,验证 bundle 不报错)。
- [ ] 文件后缀检查:所有 import 在 TS 源码中带 `.js` 后缀(ESM 规范),`grep -nE "from \"\\./.*[^.][^j][^s]\"" src/prompt/` 无命中。
- [ ] 密钥不回显:对话区、`# 环境` 段与任何输出均不出现 api_key(验证:通读输出、`grep -i "api[_-]key" .mewcode/`无明文;确认 `detectEnvironment` 不读 `ANTHROPIC_API_KEY / OPENAI_API_KEY`)。(AC14/N5)

## 端到端场景(tmux 内 `bun run src/main.tsx` 实跑)
- [ ] 场景 1(缓存命中,Anthropic):同一会话连发两条消息 → 在 debug 日志或临时 console.log 中观察首轮 `cacheCreationInputTokens > 0`、次轮 `cacheReadInputTokens > 0`,证明 system + tools + 历史前缀被 ephemeral 缓存复用。(AC4/F3)
- [ ] 场景 2(规划模式按轮次):`/plan` 发一个需多步只读调研的任务 → 模型仅用只读工具(ReadFile/Glob/Grep/Agent)产出计划;首轮注入完整提醒、第二轮注入精简提醒、第六轮再次完整;`/do` 切回全工具并按 plan 文件执行。(AC9/F7)
- [ ] 场景 3(reminder 不被当用户输入):规划模式下模型不复述 / 不直接回应 `<system-reminder>` 内容,而是按其约束行事(只读、5 阶段)。(AC8/F6)
- [ ] 场景 4(环境感知):问「我现在在哪个目录、什么平台、今天几号」→ 模型据 `# 环境` 段正确回答工作目录、`platform/arch`、ISO 日期。(AC3/F2)
- [ ] 场景 5(取消后可继续):规划模式多轮调研中途按 Esc 取消 → 回空闲态、再发一条继续对话;Anthropic 请求不返回 400(`buildAnthropicMessages` 合并保护)。(AC12/N3)
- [ ] 场景 6(非 git 目录降级):在非 git 目录(如 `/tmp`)启动 `bun run src/main.tsx` → 启动正常、`# 环境` 段不含 Git 分支行、`isGitRepo: false`、对话可正常进行。(AC13/N4)
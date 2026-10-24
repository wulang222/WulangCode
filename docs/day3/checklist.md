# Agent Loop Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为；括号内为验证方式与对应需求。

## 实现完整性

- [ ] 多轮自动连环：需要连续两步工具的任务，Agent 无需中途催促即自动多轮执行工具直到给出最终答复（验证：`bun run src/main.tsx` 跑「读 A 文件 → 据内容新建 B 文件」，观察 ReadFile 与 WriteFile 跨多轮依次出现、最终答复）。(AC1/F1)
- [ ] 自然完成停止：模型给出无工具调用的纯文本即停，`yield { type: "loop_complete" }` 后 AsyncGenerator 结束（验证：agent.test.ts 场景 A 断言收到最终 `stream_text` + `loop_complete`，`fakeClient.callCount` 不再增长）。(AC2/F2)
- [ ] 迭代上限兜底：`AgentConfig.maxIterations = 5` 时第 5 轮后 `yield { type: "error" }` 退出，不无限循环（验证：agent.test.ts 场景 B 断言 error 事件 + `callCount === 5`）。(AC3/F2)
- [ ] 连续未知工具停止：连续 3 轮只产生未注册工具调用即停；混入已注册工具则计数重置（验证：agent.test.ts 场景 C 两路断言）。(AC4/F2)
- [ ] 流出错恢复：`client.stream()` throw 非 `RateLimitError` 异常时 `yield { type: "error" }`、Ink 应用不退出（验证：端到端临时改坏 base_url 发一条，观察错误块 + 仍可继续；agent.test.ts 注入 throw 脚本断言收到 `error` 后 generator 结束）。(AC5/F2)
- [ ] 事件流完备：`AgentEvent` 联合类型覆盖 `stream_text` / `tool_use` / `tool_result` / `usage` / `turn_complete` / `loop_complete` / `error` / `retry` / `permission_request` / `thinking_*` / `compact`（验证：agent.test.ts 收集事件后断言 `new Set(events.map(e => e.type))` 包含上述类型；TypeScript `switch (ev.type)` 全分支编译期穷尽性检查）。(AC6/F3/N6)
- [ ] 流式收集双路：`text_delta` 实时显示的同时，`tool_call_complete.arguments` 拼齐为可用对象（验证：agent.test.ts 断言 `toolUses[0].arguments` 是 JS Object 且字段完整；端到端工具行参数与请求体一致）。(AC7/F4)
- [ ] 保序分批并发：一次回复含多个工具时，`category === "read"` 的工具用 `Promise.all` 并发执行、`"write"` / `"command"` 串行，结果按 `events.push` 顺序回灌（验证：agent.test.ts 场景 D 用插桩工具断言两只读时间窗重叠、写入工具开始时刻晚于两只读完成、`events` 内 `tool_result` 顺序匹配调用序）。(AC8/F5)
- [ ] 取消历史一致：`abortController.abort()` 后 generator 在下一个 `await` 点退出、`fullText` 写入历史保证 assistant 文本回合存在、无悬空 `tool_use`（验证：agent.test.ts 场景 E 断言 `conversation.getMessages()` 最后一条是 assistant、`toolUses` 字段不残留；端到端取消后再发一条不报 400）。(AC9/F6)
- [ ] 用户取消：流式态 Esc 或 Ctrl+C 触发 `AbortController.abort()`、Agent 收尾、Ink 应用不退出；空闲态 Ctrl+C 走 `exit()` 退应用（验证：端到端各按一次观察行为）。(AC10/F7)
- [ ] 用量展示：状态栏显示会话累计 token（输入/输出），随 `usage` 事件递增（验证：端到端跑多轮观察状态栏数值递增；agent.test.ts 断言每轮 yield 一次 `usage` 事件）。(AC11/F8)
- [ ] 进度展示：流式态动态区显示当前迭代轮次（验证：端到端跑多轮任务观察「第 N 轮」递增；TUI 状态由 `turn_complete` 事件驱动）。(AC12/F9)
- [ ] Plan Mode：`checker.mode === "plan"` 时每轮通过 `addSystemReminder(buildPlanModeReminder(...))` 注入计划态提醒；模型调用 `ExitPlanMode` 即停（验证：agent.test.ts 场景 F 断言 message 含 `"<system-reminder>"` + `"Plan mode is active"`、`ExitPlanMode` 后 generator 结束）。(AC13/F10)

## 集成

- [ ] 跨协议一致：anthropic 与 openai（含 openai-compat base_url）跑同一多轮任务，触发/执行/回灌/用量/取消行为一致（验证：两种 `cfg.protocol` 配置各跑多轮场景；`createClient` 工厂动态 import 正确适配器）。(AC14/F11)
- [ ] 多轮历史正确携带：每轮 `addAssistantFull`（含 `toolUses`） + `addToolResultsMessage` 按序入历史并被下一轮 `client.stream()` 读到（验证：agent.test.ts 断言 `conversation.getMessages()` 序列；或在 fakeClient 内记录每轮收到的 messages 数组并断言增长）。(F6)
- [ ] 界面不阻塞：多轮循环与工具执行（含并发批）期间 Ink spinner / 轮次 / 计时持续刷新（验证：跑含稍慢 bash 的任务，观察界面不冻结；`Agent.run()` 是 AsyncGenerator，每个 `yield` 让出事件循环）。(N2)
- [ ] scrollback 顺序正确：跨多轮 preamble → 工具行 → 结果摘要 → 最终答复按序提交到 `<Static>` 区域不交错，并发批的工具行按模型调用序排列（验证：跑一个含并发只读批 + 后续写的多轮任务，回滚 scrollback 肉眼核对各块严格按发生顺序连续）。(N3)
- [ ] 结果体量受控：大文件 / 长输出 / 海量命中被 `Agent.run()` 内 `MAX_OUTPUT_CHARS = 10000` 截断标注 `"\n… (output truncated)"`，多轮累积不撑爆（验证：多轮中读大文件 / 跑长输出命令观察截断）。(N4)
- [ ] 取消无泄漏：取消后无挂起 Promise / 无残留 AsyncGenerator（验证：`bun test` 含取消用例（场景 E）通过、不报 "Worker did not exit"；端到端反复触发取消后继续对话多次，进程内存稳定不增长）。(N5)
- [ ] 类型安全：所有 `switch (ev.type)` 经穷尽性检查（验证：在 `switch` 内加 `default` 返回 `never`，TypeScript 编译期对漏分支报错；`tsc --noEmit` 通过）。(N6)

## 编译与测试

- [ ] `tsc --noEmit` 无错误。
- [ ] `bun test` 全部通过（agent、llm、tools、conversation、prompt 单测）。
- [ ] `bun test src/agent` 通过——含 6 个场景（A 多轮 / B 上限 / C 未知工具 / D 保序分批 / E 取消 / F Plan Mode）。
- [ ] `bun run src/main.tsx` 能正常启动 Ink 应用、提示输入。
- [ ] 密钥不回显：对话区与任何输出均不出现 api_key（验证：通读运行输出、`grep -ri "sk-" .mewcode/` 无明文 key）。(N7)
- [ ] ES module 导入路径全部以 `.js` 后缀写（bun + Node ESM 规则，源码是 `.ts` 但 import 时写 `.js`）；`tsc --noEmit` 不报模块解析错。(N8)

## 端到端场景

- [ ] 场景 1（多轮连环）：openai-compat 端点 → 「读 `docs/ch03/spec.md`，再据内容新建 `docs/ch03/summary.txt` 写一句话摘要」→ ReadFile → WriteFile 跨多轮自动出现 → 状态栏 `usage` 增长、动态区轮次递增 → 最终答复 → Ctrl+C(空闲态) 退应用无残留进程。
- [ ] 场景 2（用户取消）：发一个多步任务，中途按 Esc（再试 Ctrl+C）→ 回空闲态不退出 → 再正常发一条继续对话（`conversation.getMessages()` 末尾配对合法、下一轮 API 请求不报 400）。
- [ ] 场景 3（流出错恢复）：临时改坏 `base_url` 发一条 → 错误块 + Ink 应用不退出 → 改回 `.mewcode/config.yaml` 后继续正常对话。
- [ ] 场景 4（Plan Mode）：把 `checker.mode = "plan"` → 问一个改动类需求 → 只出现 Read/Glob/Grep + 计划文本、无 Write/Bash → 模拟 `ExitPlanMode` 工具调用 → 切回正常模式重新提交可执行 Write/Bash。
- [ ] 场景 5（跨协议，若有 anthropic 配置）：切到 `cfg.protocol: "anthropic"` 重跑场景 1 → 多轮行为与 openai-compat 一致。
- [ ] 场景 6（迭代上限）：主要由 agent.test.ts 场景 B 确定性验证；可选手动复现——`new Agent({ maxIterations: 3, ... })` 跑一个会多步调工具的任务，观察第 3 轮后 yield `error`、Ink 应用仍可继续。
- [ ] 场景 7（连续未知工具）：主要由 agent.test.ts 场景 C 确定性验证；可选手动复现——在 system prompt 临时引导模型调用一个不存在的工具名，观察连续 3 轮后 yield `error`、Ink 应用仍可继续。
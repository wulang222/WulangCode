# Agent Team Checklist

> 验证策略：每一项通过 `tsc --noEmit` / `bun test` / 真实启动 `bun run src/main.tsx` 来核实；仅依赖代码与日志，不做主观判断。

## 实现完整性

- [ ] `TeamManager` 可被实例化：`new TeamManager(workDir)` 返回非 null；`mgr.create("demo")` 在 `<workDir>/.mewcode/teams/demo/` 落地目录（验证：临时目录 ad-hoc 脚本 + `existsSync` 检查）
- [ ] `Team` 构造函数自动 `mkdirSync(<dir>, {recursive:true})`，多次 `new Team` 同名不抛错（验证：tests/teams.test.ts）
- [ ] `TeamMode` 三个值齐全：`"in-process"` / `"tmux"` / `"iterm"`（验证：`tsc --noEmit` 通过 + 单测枚举）
- [ ] `Team.IDLE_POLL_INTERVAL_MS === 500`、`Team.SHUTDOWN_PREFIX === "[shutdown]"`（验证：单测断言）
- [ ] `detectBackend()` 始终返回 `"in-process"`；`detectPaneBackend()` 在 `process.env.TMUX` 非空时返回 `"tmux"`（验证：单测 + `t.Setenv` 等价的 `process.env.TMUX = "1"`）
- [ ] `spawnTeammate({ mode: "iterm", ... })` 抛 `"iTerm backend not supported on this platform"`（验证：单测 `expect(() => ...).toThrow`）
- [ ] `FileMailbox.send` + `receiveSync` 一进一出消息字段一致（`from` / `text` / `timestamp`）（验证：tests/file-mailbox.test.ts）
- [ ] `FileMailbox` 跨实例游标持久化——writer 写两条、reader1 读两条、再写一条，reader2 新实例 `unreadCount === 1` 仅读到第三条（验证：tests/file-mailbox.test.ts）
- [ ] `FileMailbox.markAllRead` 后 `unreadCount === 0`、`receive` 空数组（验证：tests/file-mailbox.test.ts）
- [ ] `acquireLock` 在 stale 10 秒后能被新 writer 抢占（验证：构造 mtimeMs 在 11 秒前的 .lock 文件，新 send 调用成功）
- [ ] 锁等待使用 `Atomics.wait`，不让出事件循环（验证：代码审查 `src/teams/file-mailbox.ts` 的 `sleepSync` 实现）
- [ ] `createProgress()` 返回零值 `{ toolUseCount: 0, tokenCount: 0, lastActivity: undefined, recentActivities: [] }`（验证：单测）
- [ ] `recordToolUse` 第 6 次调用后 `recentActivities.length === 5`（环形缓冲）（验证：单测）
- [ ] `formatTokens(1500) === "1.5k"`、`formatTokens(1500000) === "1.5M"`、`formatTokens(42) === "42"`（验证：单测）
- [ ] `describeToolActivity("ReadFile", { file_path: "x.ts" }) === "Reading x.ts"`；`Bash` 长命令截断到 40 字符 + "..."（验证：单测）
- [ ] `coordinatorToolFilter(mgr)` 在 `mgr.list().length === 0` 时对任意名字返回 `true`；有 Team 时 `WriteFile` 返回 `false`，`Bash` / `Agent` / `mcp__foo` 返回 `true`（验证：tests/teams.test.ts 或单独 coordinator 单测）
- [ ] `COORDINATOR_ALLOWED_TOOLS` 含 `Bash` 但不含 `WriteFile` / `EditFile`（验证：代码审查 + 单测）
- [ ] `TeamCreateTool.execute({ name: "x" })` 在新 Team 时返回 `"Team 'x' created."`；已存在时返回 `"Team 'x' already exists."`（不报错）（验证：tests/teams.test.ts）
- [ ] `SpawnTeammateTool.execute` 在 Team 不存在时自动 `create`，spawn 后返回提示「continue working and watch for it」（验证：tests/teams.test.ts）
- [ ] `SendMessageTool.execute({ team: "nope", to: "a", message: "m" })` 返回 `isError: true`（验证：tests/teams.test.ts）
- [ ] `ListTeamsTool.execute()` 在无 Team 时返回 `"No teams."`；有 Team 时输出每行 `<name> [<mode>]: <members>`（验证：tests/teams.test.ts）
- [ ] `TeamDeleteTool.execute({ name: "x" })` 调 `mgr.delete(name)`，再 `mgr.get(name)` 返回 undefined（验证：tests/teams.test.ts）
- [ ] `saveTranscript` 在 `<workDir>/.mewcode/teams/<team>/transcripts/<agentId>.json` 落地，内容是 `TranscriptEntry[]` JSON（验证：单测/集成）
- [ ] `loadTranscript` 文件不存在或解析失败时返回 null（验证：单测）

## 集成

- [ ] `app.tsx` 启动时把 5 个 Team 工具注册到 `registryRef.current`（验证：代码审查；TUI 启动后 `/status` 或 LLM 调 `ListTeams` 能命中）
- [ ] `SpawnTeammateTool` 的 `RunAgent` 闭包内部调 `spawnSubAgent(BUILTIN_AGENTS[0], task, client, registry, provider, workDir, undefined, onEvent)`（验证：代码审查 `src/tui/app.tsx`）
- [ ] `agent.run` options 含 `toolFilter: buildComposedToolFilter(coordinatorToolFilter(teamMgr), skillFilter)` 与 `notificationFn: () => teamMgr.drainLeads()`（验证：代码审查）
- [ ] `setInterval(500ms)` 把 `teamMgr.getAllTeammateStates()` 写入 `teammateStates` state；TUI 重渲染 Spinner Tree（验证：启动 TUI 后看到 spinner 每 500ms 刷新）
- [ ] 队员主循环跑完一轮后给 Lead 信箱发 `[idle] <name> (reason: available)` 通知（验证：tests/teams.test.ts）
- [ ] 队员 `runAgent` 抛错时 `uiState.status === "failed"`，Lead 信箱收到 `[idle] <name> (reason: failed)`（验证：tests/teams.test.ts）
- [ ] 队员收到以 `[shutdown]` 开头的消息后退出主循环，`member.active === false`（验证：单测：spawn 后 sendMessage `[shutdown] please exit`，等 600ms 看 `member.active`）
- [ ] 队员退出时若 `member.conversation` 非空，自动 `saveTranscript`；写盘失败由 try/catch 静默吞掉（验证：集成测试构造一个 ConversationManager 挂到 member，触发退出后看文件落地）
- [ ] `drainLeads()` 把所有 Team 的 lead 未读消息拼成 `<team-notification team="<name>">\nfrom=<from>: <text>\n...\n</team-notification>` 字符串数组返回；消息被消费（再次调用返回空）（验证：tests/teams.test.ts）
- [ ] `parseTeammateMessage("[team alpha] alice: [idle] alice has completed...")` 返回 `{ from: "alice", type: "idle", content: "alice has completed..." }`；`[shutdown]` 同理；纯文本返回 `type: "text"`（验证：单测）
- [ ] `TeammateMessage` 渲染：`type="idle"` / `"shutdown"` 返回 null；`type="completed"` 渲染绿色 `✓ Task completed`；`type="text"` 渲染 `@<from> ❯ <summary>` + 缩进 rest（验证：组件单测或人工验收）
- [ ] `TeamStatus({ count: 0 })` 返 null；`count === 1` 显示 `● 1 teammate`；`count > 1` 显示 `● N teammates`（验证：组件单测或人工验收）
- [ ] `TeamsDialog` 按 `Esc` 关闭、`↑/↓` 翻、`Enter` 进详情、`k` 调 onKill、`s` 调 onShutdown（验证：人工启动 TUI 按 `Ctrl+T` 体验）
- [ ] `--teammate --team-dir <dir> --member-name alice --task "echo hi"` 跑通：跑完任务后给 `<dir>/lead.jsonl` 追加一条 `from=alice` 的 `[idle]` 消息（验证：手动跑 + `cat <dir>/lead.jsonl`）
- [ ] `parseTeammateFlags(["--teammate"])` 返回 null（缺必填）；`["--teammate", "--team-dir", "/tmp/x", "--member-name", "a", "--task", "echo"]` 返回完整对象（验证：可直接在 `src/teammate.ts` 末尾加临时调试或单测）
- [ ] `runTeammate` 收到 `[shutdown] please exit` 立即 `break` 退出主循环，进程退出码 0（验证：手动启动 `--teammate` 子进程，从另一个终端往 `<dir>/<name>.jsonl` 写入 shutdown 消息）
- [ ] `CodeReviewManager.createTeam("review-X", [...])` 落地 `<workDir>/.mewcode/code-review-teams.json`，同时底层 `TeamManager` 也有同名 Team（验证：tests/code-review.test.ts）
- [ ] `CodeReviewManager` 对 `addMember` / `removeMember` / `activateMember` / `deactivateMember` 操作同步更新 `lastActive`（验证：tests/code-review.test.ts）
- [ ] `ReviewSession.createReviewRequest` 在无活跃 reviewer 时抛 `"No active reviewers in team 'X'"`（验证：tests/code-review.test.ts）
- [ ] `ReviewSession.addCriticAssessment(reqId, commentId, criticName, "reasonable", reasoning)` 写入 `comment.criticAssessments`，可通过 `getCriticSummary` 取出（验证：tests/code-review.test.ts）
- [ ] `/code-review create review-A` 等 18 个子命令逐个走通（验证：`handleCodeReviewCommand` 单测覆盖所有 case 与 help 文本）

## 编译与测试

- [ ] `tsc --noEmit` 无错误（验证：命令退出码 0）
- [ ] `bun test` 全部通过：`tests/file-mailbox.test.ts` + `tests/teams.test.ts` + `tests/code-review.test.ts`（验证：命令退出码 0）
- [ ] `bun run src/main.tsx` 启动 TUI 正常，无 ch15 相关 error（验证：人工启动后看 stderr 干净、TUI 渲染正常）
- [ ] `bun run src/main.tsx --teammate --team-dir /tmp/x --member-name a --task "echo hi"` 不渲染 TUI 直接走 teammate 路径，stdout 流出 agent 事件（验证：人工 + 看输出）

## 端到端场景**场景 1：in-process 后端，Team 全生命周期**

- [ ] 启动 `bun run src/main.tsx`，在 TUI 输入「创建一个名为 demo 的团队」
  - 预期：LLM 调 `TeamCreate({name:"demo"})`；返回 `"Team 'demo' created."`
  - 验证：`<workDir>/.mewcode/teams/demo/` 目录存在，含 `lead.jsonl`（空）与 `lead.read`（初始 0）
- [ ] 在 TUI 输入「派 alice 去看 src/teams 目录有什么文件」
  - 预期：LLM 调 `SpawnTeammate({team:"demo", name:"alice", task:"..."})`
  - 验证 a：状态栏出现 `● 1 teammate`；spinner tree 出现 `@alice: <verb>...`
  - 验证 b：`<workDir>/.mewcode/teams/demo/alice.jsonl` 创建（可能空也可能 Lead 已写入）
  - 验证 c：alice 跑完任务后 `<workDir>/.mewcode/teams/demo/lead.jsonl` 多一行 `from: "alice"` 且 `text: "[idle] alice (reason: available)"`
- [ ] 在 TUI 输入「再让 alice 把 src/teams/team.ts 的行数报给我」
  - 预期：LLM 调 `SendMessage({team:"demo", to:"alice", message:"..."})`
  - 验证 a：`<workDir>/.mewcode/teams/demo/alice.jsonl` 多一行 `from: "lead"` 的消息
  - 验证 b：500ms 内 alice 主循环 `waitForNextPromptOrShutdown` 收到消息，spinner 状态从 `idle` → `running`
  - 验证 c：alice 再次发 `[idle]` 通知到 lead 信箱
- [ ] LLM 这一轮收到的 reminder 应含 `<team-notification team="demo">\nfrom=alice: [idle] alice (reason: available)\n</team-notification>` 字符串（验证：开启 verbose 日志或读 `drainLeads` 输出）
- [ ] 在 TUI 输入「让 alice 写一个 hello world 文件」
  - 预期：由于 Team 存在，Lead 自身的 `WriteFile` / `EditFile` 工具被 `coordinatorToolFilter` 过滤；Lead 必须派 alice 去写
  - 验证：Lead 的 ToolUse 流里不出现 `WriteFile` 直接被调用（必须经过 SpawnTeammate / SendMessage）
- [ ] 按 `Ctrl+T` 打开 Teams Dialog
  - 验证 a：列表显示 `@alice: idle · 5 tools · 1.2k tokens` 类似行
  - 验证 b：按 `s` 调 onShutdown → `<workDir>/.mewcode/teams/demo/alice.jsonl` 新增 `[shutdown] Please finish and exit` 消息
  - 验证 c：alice 主循环检测到 SHUTDOWN_PREFIX，退出循环，`uiState.status` 变 `idle` 或 `stopped`
- [ ] 在 TUI 输入「删除 demo 团队」
  - 预期：LLM 调 `TeamDelete({name:"demo"})` 返回 `"Team 'demo' deleted."`
  - 验证 a：`mgr.get("demo")` 返回 undefined（spinner tree 消失）
  - 验证 b：状态栏 TeamStatus 消失（count === 0）
  - 验证 c：Coordinator 过滤器恢复全集，下一轮 Lead 可见 `WriteFile`

**场景 2：tmux 后端真实子进程**

- [ ] `tmux new-session -s mewcode-ch15` 进入新 tmux 会话
- [ ] 在 .mewcode/config.yaml 加 `teammateMode: "tmux"`（手动覆盖 `detectBackend` 行为，或在代码里临时把 `mgr.create("demo", "tmux")` 写死）
- [ ] 启动 `bun run src/main.tsx`
- [ ] LLM 调 `TeamCreate("demo")` + `SpawnTeammate("demo", "alice", "ls -la")`
  - 验证 a：`tmux list-sessions` 出现 `mewcode-<timestamp>` 新会话
  - 验证 b：新 tmux 会话内运行 `bun src/main.tsx --teammate --team-dir ... --member-name alice --task ...`
  - 验证 c：alice 跑完任务给 lead 信箱发 `[idle]`，主循环切换到 `mailbox.poll(2000)`
- [ ] 在 TUI 调 `SendMessage("demo", "alice", "再列一遍 src/teams")`
  - 验证：alice 在 2 秒内收到（mailbox poll 间隔），再跑一轮 agent
- [ ] 在 TUI 调 `TeamDelete("demo")`
  - 验证：`tmux list-sessions` 不含该 mewcode-xxx 会话（`stopAll → cancel → tmux kill-session`）

**场景 3：Code Review 全流程**

- [ ] 启动 `bun run src/main.tsx`，输入 `/code-review create review-A alice bob charlie`
  - 验证 a：`<workDir>/.mewcode/code-review-teams.json` 含 `review-A` 三人组
  - 验证 b：底层 `TeamManager.get("review-A")` 非空，三个成员的 `.jsonl` / `.read` 都建好
- [ ] `/code-review request review-A "fix login bug" "session token leaked"`
  - 验证：返回 `Created review request 'review-<ts>'` + 3 reviewers
- [ ] `/code-review comment <reqId> "should sanitize input"`
  - 验证：`session.requests.get(reqId).comments` 含一条 reviewer="current-user"
- [ ] `/code-review critic <reqId> <commentId> reasonable "good catch on input validation"`
  - 验证：`comment.criticAssessments` 含一条 critic="critic-1"、evaluation="reasonable"
- [ ] `/code-review report <reqId>`
  - 验证：输出含 `Total Comments`、`Accepted`、`Rejected`、`File-specific Feedback` 等段
- [ ] `/code-review list`
  - 验证：输出 `review-A (3/3 active)`

## 失败回归

- [ ] mewcode 启动时 `<workDir>/.mewcode/teams/` 不存在，`new Team` 自动创建，不报错
- [ ] `~/.mewcode/code-review-teams.json` 内容损坏（手动写入 `{not-json`）时，`CodeReviewManager.loadTeams` 静默回退到空 map
- [ ] 信箱文件锁抢占冲突 10 次仍失败时，`acquireLock` 抛错；`FileMailbox.send` 的 `withLock` 把错误向上抛（验证：构造长持锁的场景）
- [ ] tmux 后端在非 tmux 终端执行 `tmux new-window` 失败时，回退到 `tmux new-session -d`；两者都失败时抛错（验证：在 tmux 外的终端启动并切到 tmux 模式）
- [ ] 队员在没有 `ConversationManager` 时退出，`saveTranscript` 不被调用（验证：spawn 一个不挂 conversation 的 member）
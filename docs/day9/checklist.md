# slash命令体系 Checklist

> 验证策略：单测（bun test）覆盖命令加载器与渲染纯函数；类型层 `tsc --noEmit` 保证 4 类 dispatcher 分支签名一致；端到端 `bun run src/main.tsx` 在真实终端中跑出菜单与分发行为。

## 实现完整性

- [x] `src/commands/commands.ts` 导出 `CommandType` / `CommandContext` / `Command` 三类型与 `CommandRegistry` 类（验证：`grep -nE "export (type|interface|class) (CommandType|CommandContext|Command|CommandRegistry)" src/commands/commands.ts` 至少 4 行命中）
- [x] `CommandRegistry.register` 对名字冲突、别名冲突、name↔alias 交叉冲突四种情况都抛 `Error` 且消息含具体字符串（验证：tests/commands.test.ts + scripts/smoke-commands.ts）
- [x] `CommandRegistry.hasConflict` 非抛版本返回 `boolean`（验证：tests/commands.test.ts）
- [x] `parse` 纯函数实现且覆盖 `/`、`/foo`、`/foo bar baz`、非 `/` 起头四类输入（tests/commands.test.ts）
- [x] `createDefaultRegistry()` 返回的 registry `listCommands().length === 16`（验证：scripts/smoke-commands.ts）
- [x] 16 条内置命令名完整：help / clear / compact / status / session / plan / resume / quit / memory / permission / skills / worktree / code-review / review / rewind / mcp
- [x] `loadUserCommands` 支持两级目录扫描（`~/.mewcode/commands` 与 `<workDir>/.mewcode/commands`），项目级覆盖用户级（验证：smoke 子进程 HOME 隔离实测 + grep 命中 homedir/workDir）
- [x] `renderBody` 在含 `$ARGUMENTS` 时全量替换、不含时按 `body + "\n\n" + args` 拼接、无参数返回 body（tests/command-loader.test.ts）
- [x] `CommandUsageTracker` JSON 文件路径为 `<workDir>/.mewcode/command_usage.json`（smoke 实测读写）
- [x] `commandIcons` 映射 4 类（local / local_ui / skill_fork / prompt）齐全（验证：`grep -n "commandIcons" src/tui/styles.ts`）

## 注册中心行为

- [x] 名字冲突立即 `throw new Error`，消息含 `already registered` 与具体命令名
- [x] 别名与已有命令名冲突时 `throw`，消息含 `collides with existing command name`
- [x] `find` 同时按主名与别名查找命中
- [x] `listCommands()` 输出按 `name.localeCompare` 字典序排序
- [x] `complete(prefix)` 大小写不敏感，覆盖 name 与 alias 前缀匹配
- [x] 动态加载器对 `hasConflict` 命中时 short-circuit 不调 `register`（验证：`grep -nE "hasConflict|find\(meta.name\)" src/tui/app.tsx` 命中 find(meta.name)；smoke 实测同名技能被短路）

## 命令分发与四类执行

- [ ] `handleSlashCommand(text)` 在 `parse(text) === null` 时返回 `false`
- [ ] `parsed.name === "mcp"` 提前短路，直接读 `mcpInfo` 输出，不进 registry 查找
- [ ] `parsed.name === "skill"` 且 args 非空时把 parsed 重写为 `{ name: parts[0], args: rest }`
- [ ] 未命中时 messages 末尾追加 `Unknown command: /<name>` 一条 system 消息
- [ ] `local` 命令：handler 返回字符串直接 push 为 system 消息，`convRef.current.addUserMessage` 未被调用，`runAgentLoop` 未启动
- [ ] `local_ui` 命令：handler 返回动作字符串后 dispatcher 在 `switch` 中按动作触发副作用（`clear`→清 messages、`quit`→`exit()`、`plan`→`setPermMode("plan")`、`compact`→`forceCompact`、`resume`→列/恢复 session 等）
- [ ] `prompt` 命令：handler 返回的文本同时 push 到 messages（role=user）、`convRef.current.addUserMessage` 与 `sessionMod.saveMessage`，然后调一次 `runAgentLoop()`
- [ ] `skill_fork` 命令：dispatcher 从 `skillCatalogRef.current.get(parsed.name)` 取 skill、构造 `SkillForkHost`、调 `runSkillFork`，结果作为 assistant 消息回写
- [ ] 命中任一命令后 `usageTrackerRef.current.record(cmd.name)` 被调一次

## 16 条命令的具体行为

- [x] `/help` 列出全部命令，每行 `/<name>, /<alias>... \n    <description>`，末尾追加 `Type /help <command> for details.`（handler 输出 smoke 实测）
- [x] `/help <name>` 输出单条详情，含 `/<name> — <description>` 与（如有）`Aliases: ...` 行（tests + smoke 实测）
- [ ] `/clear` 清空 messages、归零 `committedIndexRef.current`、重建 `ConversationManager`
- [ ] `/compact` 调 `forceCompact`，结果消息含 `Compact:` 前缀；boundary 通过 `sessionMod.saveCompactBoundary` 持久化
- [ ] `/status` 输出 10 行 key:value，渲染顺序固定为 Mode/Model/Provider/Tokens/Tools/Memories/Skills/MCP/Session/Directory
- [x] `/session` 输出固定提示 `"Session is active. Use /resume to list past sessions."`（tests 实测 handler 返回值）
- [ ] `/plan` 把当前模式保存到 `prePlanMode`、切到 `plan` 模式、写出 plan 文件路径；若本会话曾退出过 plan 模式且 plan 文件存在则注入 `buildPlanModeReentryReminder` 提醒
- [ ] `/resume` 无参列出最近 10 个会话；带 id 时 `loadSession + rebuildFromSession` 还原会话并切换 `taskListRef`
- [ ] `/quit` 调 Ink `useApp().exit()` 关闭 TUI
- [ ] `/memory` 无参列出 `MemoryManager.getMemories()`；`/memory clear` 调 `mgr.clear()` 清空
- [ ] `/permission` 无参显示当前模式与切换说明；`/permission mode <m>` 切到指定模式
- [ ] `/skills` 列出 `SkillCatalog.list()` 全部 skill；空目录给出占位文本
- [ ] `/worktree` 调 `execSync("git worktree list", { cwd })` 输出结果，非 git 仓库时给降级提示
- [x] `/code-review` 无参输出 usage（tests 实测）；带 args 返回 `code-review:<args>` 由 local 分支回显（评审团队子系统未建，按 task.md 字面占位）
- [x] `/review` 注入固定的"审查未提交改动"提示词（tests 实测 handler 含 git status/git diff/Focus on）；触发 `runAgentLoop()` 待实跑验证
- [ ] `/rewind` 从 `FileHistory.getSnapshots()` 拿快照后激活 `RewindDialog`
- [ ] `/mcp` 输出 MCP server 数量、列表、总工具数

## 自动补全菜单（InputBox）

- [ ] 在 `InputBox` 中第一字符输入 `/` 后 `showDropdown=true`，菜单立即出现
- [ ] 空 query 时若提供 `usageTracker`，按 `getRecentlyUsed(5)` 把最近使用命令放到 `RECENTLY USED` 段顶部，其余在 `ALL COMMANDS` 段
- [ ] query 含空格时 `filteredCmds` 为空、菜单消失
- [ ] query 非空时按 5-tier 顺序：精确 name → 精确 alias → name 前缀 → alias 前缀 → Fuse 模糊
- [ ] Fuse 实例 keys 权重为 `name: 3`、`aliases: 2`、`description: 0.5`，`threshold: 0.4`
- [ ] 菜单最多展示 8 行（`slice(0, 8)`）
- [ ] 每行渲染 `<icon> /<name>  <description>`，icon 来自 `commandIcons[cmd.type]`
- [ ] 按 ↑↓ 在候选间循环切换 `dropdownIndex`
- [ ] 按 Enter 或 Tab 把 `"/" + selected.name + " "` 写回 lines[0]，菜单消失等待提交或继续输入参数
- [ ] 按 Esc 关闭菜单（设 `dropdownDismissed=true`），输入框文本保留
- [ ] 第一候选 name lower 以 query lower 开头时显示 dim 颜色 ghost text 补全后缀
- [ ] 删空输入框（全部退格）后菜单立即消失

## 命令使用追踪

- [x] `CommandUsageTracker` 构造时若 `.mewcode/` 不存在自动 `mkdirSync({ recursive: true })`（smoke 在空临时目录实测）
- [x] `record(name)` 同步写盘到 `command_usage.json`，结构为 `{ <name>: { usageCount, lastUsedAt } }`（smoke 读文件实测）
- [x] `getScore` 使用 `count × max(0.5^(daysSince/7), 0.1)` 衰减公式（smoke：30 天前 10 次 → 得分 1 = 10×0.1 地板）
- [x] `getRecentlyUsed(limit)` 仅返回 `score > 0` 的条目，按 score 降序截断（smoke 实测排序）
- [x] JSON 文件损坏或不存在时 `load()` 静默吞错，tracker 起步为空 Map（smoke 写入 `NOT JSON {{{` 实测）
- [ ] `save()` 失败时静默吞错，不阻塞 UI（已实现 try/catch，未模拟写失败场景）

## 用户命令与 Skill 接入

- [x] `<workDir>/.mewcode/commands/foo.md` 自动加载为 `/foo` 命令，type=prompt（smoke 实测 deploy）
- [x] 含 frontmatter `description` / `aliases` / `argument-hint` 三字段的 md 文件能正确解析（tests/command-loader.test.ts 实测）
- [x] 子目录路径以 `:` 命名空间化（`git/sync.md` → `/git:sync`）（smoke 实测）
- [x] 用户命令与内置同名时 try/catch 静默跳过，启动不中断（smoke：compact.md 劫持被跳过，内置保留）
- [ ] `wireSkillsToRegistry` 在 `initClient` 流程内执行一次（代码已接入 useEffect，运行时待实跑验证）
- [ ] `InstallSkillTool` 的 `onInstalled` 回调再次调用 `wireSkillsToRegistry`，新装 skill 立即可用（N/A：InstallSkillTool 属后续 Skill 子系统章节，未引入；接线点已留注释）
- [x] 已注册名字的 skill 通过 `cmdRegistry.find(meta.name)` 短路跳过，不抛（smoke：同名 help 技能被短路，内置保留）
- [x] inline 模式 skill 注册为 `prompt` 类型，handler 调 `runSkillInline`（smoke 实测渲染输出）
- [x] fork 模式 skill 注册为 `skill_fork` 类型（smoke 实测类型；dispatcher 分支调 `runSkillFork` 为占位——派生运行时属后续章节）
- [x] skill 命令 description 自带 `[skill]` 后缀（smoke 实测）

## 编译与测试

- [x] `tsc --noEmit` 整仓零类型错误（实测通过）
- [x] `bun test tests/command-loader.test.ts` 三个 case 全绿（实测 5 case 全绿，覆盖三路径）
- [x] `bun test` 全套测试通过（不引入新失败）（实测 240 pass / 0 fail，含重写后的 tests/commands.test.ts）
- [ ] `bun run src/main.tsx` 正常启动，未抛运行时错误（待真实终端实跑）

## 端到端场景（bun + 真实终端）

> 准备：`bun install` 安装依赖后用 `bun run src/main.tsx` 启动；在 `<workDir>/.mewcode/commands/test.md` 写入测试命令；保留至少一条 MEMORY.md 让 `/memory` 与 `/status` 的 Memories 计数非零。

### 场景 A：启动与 /help- [ ] **A1** 启动 `bun run src/main.tsx`，输入框出现，状态栏显示当前 model 与 mode
- [ ] **A2** 键入 `/help` 回车，messages 区追加一条 system 消息含 `Available commands:` 标题与 16 个命令名
- [ ] **A3** 键入 `/help compact` 回车，输出含 `/compact — Force context compaction` 与 `Aliases: c`

### 场景 B：纯本地命令- [ ] **B1** `/status` 输出 10 行 key:value，Mode 与状态栏徽章一致；Tokens 为当前累计；Tools 为已注册工具数
- [ ] **B2** `/permission` 输出当前模式名（default / acceptEdits / plan / bypassPermissions）
- [ ] **B3** `/memory` 列出 MEMORY 条目；`/memory clear` 后再跑 `/memory` 显示无记忆
- [ ] **B4** `/session` 输出 `Session is active. Use /resume to list past sessions.`
- [ ] **B5** `/mcp` 输出 `MCP servers (N):` 列表或 `No MCP servers connected.`
- [ ] **B6** 上述命令跑完后状态栏 Tokens 计数无增加（local 不消耗 token）

### 场景 C：自动补全菜单- [ ] **C1** 仅按 `/`，补全菜单立即显示且含至少 16 条
- [ ] **C2** 继续按 `s`，菜单过滤为以 `s` 开头匹配的命令（status / session / skills 及别名命中条目）
- [ ] **C3** 按 ↓ 切换高亮，按 Enter 把 `/<name> ` 写回输入框；再按 Enter 提交执行
- [ ] **C4** 输入 `/s` 后按 Esc，菜单消失但输入框仍含 `/s`
- [ ] **C5** 把 `/s` 全部退格删除后，菜单立即消失
- [ ] **C6** 在 `command_usage.json` 已有记录时，按 `/` 看到 `RECENTLY USED` 段顶部为最近用过的命令

### 场景 D：影响界面命令- [ ] **D1** `/plan` 后状态栏切到黄色 `Plan on`；输入框上方 system 消息提示进入计划模式
- [ ] **D2** `/compact` 触发压缩，messages 出现 `Compacting conversation...` 然后 `Compact: ...` 总结
- [ ] **D3** `/clear` 后 messages 清空、状态栏 Tokens 计数归零
- [ ] **D4** `/quit` 关闭进程，shell 提示符回归

### 场景 E：提示词命令- [ ] **E1** `/review` 注入审查请求并触发 `runAgentLoop`；messages 末尾追加 role=user 消息含 `git status` 与 `git diff` 关键字
- [ ] **E2** `/review focus on bash.ts` 注入文本末尾含 `Focus on: focus on bash.ts`

### 场景 F：用户自定义命令- [ ] **F1** 在 `<workDir>/.mewcode/commands/deploy.md` 写入 `---\ndescription: Deploy it\naliases: [d]\n---\nDeploy $ARGUMENTS to production.`
- [ ] **F2** 重启 TUI，按 `/` 看到 `/deploy` 出现在菜单中，描述为 `Deploy it`
- [ ] **F3** 跑 `/deploy staging` 触发 prompt 流程，messages 末尾 user 消息为 `Deploy staging to production.`
- [ ] **F4** 子目录命名空间：`<workDir>/.mewcode/commands/git/sync.md` 加载后 `/git:sync` 可命中

### 场景 G：Skill 接入- [ ] **G1** 在 `<workDir>/.mewcode/skills/example/SKILL.md` 放一个 inline skill，重启后 `/help` 列表含 `/example` 一行，描述末尾 `[skill]`
- [ ] **G2** `/example <args>` 触发 inline skill 渲染并作为 user 消息执行

### 场景 H：未命中与启动期冲突检测- [ ] **H1** 键入未注册 `/foobar` 回车，messages 追加 `Unknown command: /foobar`，且 `convRef.current.addUserMessage` 未被调用、`runAgentLoop` 未启动
- [ ] **H2** 在 `createDefaultRegistry` 中临时把 `/help` 注册两次，启动时 `bun run src/main.tsx` 抛 `Error: Command 'help' already registered`，进程退出；还原后启动恢复正常

### 场景收尾

- [ ] 所有测试场景通过后清理临时改动（`<workDir>/.mewcode/commands/test.md`、`command_usage.json` 测试数据）
- [ ] `git status` 仅显示本期目标内的改动
- [ ] 每个场景至少 1 张终端截屏或 capture 输出作为证据保留

## 完成准则

- 上方所有 checkbox 全部勾选，且每项的验证步骤已实际执行并记录证据
- `tsc --noEmit` 与 `bun test` 均无失败
- `bun run src/main.tsx` 在干净的工作目录下能完整跑完场景 A–H 的全部命令
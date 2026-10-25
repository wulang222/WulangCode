# Worktree 隔离 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。验证命令以 `bun test` / `tsc --noEmit` / `bun run src/main.tsx` 为主。

## 实现完整性### worktree 模块

- [ ] `src/worktree/worktree.ts` 存在并可通过 `tsc --noEmit` 类型检查（验证：`tsc --noEmit`）
- [ ] `SAFE_REF_RE` 与 `SHA_RE` 两个常量按 spec 定义；`SHA_RE` 同时接受 40 与 64 字符 hex（验证：`bun test src/worktree/worktree.test.ts -t "SHA_RE"`）
- [ ] `isSafeRefName("refs/heads/main")` 返回 true（验证：`bun test src/worktree/worktree.test.ts -t "isSafeRefName"`）
- [ ] `isSafeRefName("../etc")` / `"-rf"` / `""` / `"a..b"` / `"a/./b"` 都返回 false（验证：同上）
- [ ] `resolveGitDir(repoRoot)` 在普通仓库返回 `<root>/.git`（验证：`bun test ... -t "resolveGitDir"`）
- [ ] `resolveGitDir` 在 worktree 副本内识别 `.git` 文件并返回 `gitdir:` 指向的路径（验证：同上）
- [ ] `resolveGitDir` 在非 git 目录返回 `""`（验证：同上）
- [ ] `readGitHead(gitDir)` 在分支上返回 `{ branch: <name> }`；detached HEAD 返回 `{ sha: <40 hex> }`（验证：`bun test ... -t "readGitHead"`）
- [ ] `readGitHead` 在 HEAD 文件含不安全 ref 时返回 null（验证：同上）
- [ ] `resolveRef` 优先查 loose ref；fallback 查 `packed-refs`（验证：`bun test ... -t "resolveRef"`）
- [ ] `resolveRef` 在 worktree gitDir 找不到时回退到 `commondir`（验证：同上）
- [ ] `readWorktreeHeadSha(wtPath)` 在合法 worktree 路径返回 40 字符 hex SHA（验证：`bun test ... -t "readWorktreeHeadSha"`）
- [ ] `readWorktreeHeadSha` 在非 worktree 路径返回 `""`（验证：同上）
- [ ] `getCurrentBranch(repoRoot)` 在分支上返回分支名；detached HEAD 返回 `""`（验证：`bun test ... -t "getCurrentBranch"`）
- [ ] `createAgentWorktree("alice")` 在 `<root>/.mewcode/worktrees/alice/` 落地 + 分支 `worktree-alice`（验证：`bun test ... -t "createAgentWorktree"`）
- [ ] `createAgentWorktree` 返回 `{ path, branch, headCommit, gitRoot }` 四字段均非空（验证：同上）
- [ ] 目录已存在时再调 `createAgentWorktree` 走快速恢复——不会重复执行 `git worktree add`，返回耗时 <50ms（验证：mock `execSync` 或断言不再触发 add）
- [ ] `removeAgentWorktree(path, branch, gitRoot)` 成功删除目录与分支（验证：`bun test ... -t "removeAgentWorktree"`）
- [ ] `removeAgentWorktree` 对已不存在的目录与分支保持幂等不抛错（验证：连续调用两次断言不抛）
- [ ] `hasWorktreeChanges(path, sha)` 在干净 worktree 且 SHA 匹配返回 false（验证：`bun test ... -t "hasWorktreeChanges"`）
- [ ] `hasWorktreeChanges` 修改一个文件后返回 true（验证：同上）
- [ ] `hasWorktreeChanges` HEAD 已变更（新 commit）后返回 true（验证：同上）
- [ ] `hasWorktreeChanges` 对不存在路径 fail-closed 返回 true（验证：同上）
- [ ] `buildWorktreeNotice(parentCwd, wtPath)` 输出三行字符串含 "git worktree at"、"parent project is at"、"isolated from the parent"（验证：`bun test ... -t "buildWorktreeNotice"`）

### 创建后设置

- [ ] `performPostCreationSetup` 在主仓 `.mewcode/` 存在时把整目录 `cpSync` 到 Worktree 同位置（验证：`bun test ... -t "copyMewcodeSettings"`）
- [ ] 主仓 `.husky/` 存在时 Worktree 的 `git config core.hooksPath` 含其绝对路径（验证：`execSync("git config --get core.hooksPath", { cwd: wtPath })`）
- [ ] 主仓 `.husky/` 不存在但 `.git/hooks/` 存在时回退使用 `.git/hooks/`（验证：删除 `.husky` fixture 后再断言）
- [ ] 主仓 `node_modules/` 存在时 Worktree 内是软链（验证：`lstatSync(join(wtPath, "node_modules")).isSymbolicLink() === true`）
- [ ] 主仓 `.worktreeinclude` 列出的相对路径被复制到 Worktree（文件 + 目录两种）（验证：`bun test ... -t "copyWorktreeIncludeFiles"`）
- [ ] `.worktreeinclude` 含 `..` 的行被跳过（防路径遍历）（验证：同上）
- [ ] 任一子步骤抛错时 catch 仅 stderr 警告，不阻塞主流程（验证：mock 让 `cpSync` 抛错后 `createAgentWorktree` 仍成功返回）

### EnterWorktreeTool

- [ ] `EnterWorktreeTool` 字段：`name === "EnterWorktree"`、`category === "write"`、`deferred === true`（验证：`bun test src/tools/enter-worktree.test.ts -t "schema"`）
- [ ] `schema()` 含 `slug` 且 `required: ["slug"]`（验证：同上）
- [ ] `execute({ slug: "demo" }, ctx)` 成功返回 output 含 `Worktree created at:` + path + branch + Head（验证：`bun test ... -t "execute success"`）
- [ ] `execute({}, ctx)` 缺 slug 返回 `{ isError: true, output: "Error: slug is required" }`（验证：同上）
- [ ] `execute({ slug: "../etc" }, ctx)` 返回 `{ isError: true }` 且 output 含 `"alphanumeric, hyphen, underscore"`（验证：同上）
- [ ] `execute({ slug: "team/alice" }, ctx)` 同样被拒（含 `/`）（验证：同上）
- [ ] 工具默认不在 `ToolRegistry.getAllSchemas()` 返回值中（因 `deferred: true`）（验证：注册到 registry 后断言）

### ExitWorktreeTool

- [ ] `ExitWorktreeTool` 字段：`name === "ExitWorktree"`、`category === "write"`、`deferred === true`（验证：`bun test src/tools/exit-worktree.test.ts -t "schema"`）
- [ ] `schema()` `required` 含 `path` / `branch` / `git_root`；`head_commit` 为可选（验证：同上）
- [ ] 缺三个必填任一时返回 `{ isError: true, output: "Error: path, branch, and git_root are required" }`（验证：同上）
- [ ] 干净 worktree + 正确 `head_commit` 时清理成功，output 含 `"Worktree cleaned up (no changes)"`（验证：`bun test ... -t "execute cleanup"`）
- [ ] worktree 有变更时不清理，output 含 `"Worktree has changes, kept at"` 与 branch 名（验证：同上）
- [ ] 不传 `head_commit` 时 `hasChanges = false` 走清理路径（验证：同上）

### TUI 注册

- [ ] `src/tui/app.tsx` import `EnterWorktreeTool` 与 `ExitWorktreeTool`（验证：`grep -E "EnterWorktreeTool|ExitWorktreeTool" src/tui/app.tsx`）
- [ ] `createToolRegistry` 内 `registry.register(new EnterWorktreeTool())` 与 `registry.register(new ExitWorktreeTool())` 存在（验证：同上）
- [ ] 启动 TUI 后两个工具能被 `ToolSearch` 查询命中（验证：`bun run src/main.tsx` 后输入引导模型调 ToolSearch query=worktree）

### 异步 SubAgent 白名单

- [ ] `ASYNC_AGENT_ALLOWED_TOOLS` 集合含 `"EnterWorktree"` 与 `"ExitWorktree"`（验证：`grep -E "EnterWorktree|ExitWorktree" src/agents/tool-filter.ts`）
- [ ] `filterToolsForAgent(registry, undefined, undefined, true)` 返回的 registry 中 `get("EnterWorktree") !== undefined`（验证：`bun test src/agents/tool-filter.test.ts`，若文件不存在则补一个用例）

### AgentDefinition 透传

- [ ] `AgentDefinition` 接口含 `isolation?: "worktree"` 字段（验证：`grep -E "isolation\\?:" src/agents/definition.ts`）
- [ ] `parseAgentDefinition` 解析含 `isolation: worktree` frontmatter 的 md 后，结果对象 `isolation === "worktree"`（验证：`bun test src/agents/loader.test.ts -t "isolation"`，若文件不存在则补）
- [ ] 不含 `isolation` 字段的定义解析后 `isolation === undefined`（验证：同上）

### .gitignore

- [ ] `.gitignore` 含 `.mewcode/worktrees/` 或 `.mewcode/`（任一即可让 Worktree 副本不被纳入版本库）（验证：`git check-ignore -v .mewcode/worktrees/test/`）

## 集成

- [ ] `EnterWorktreeTool` + `ExitWorktreeTool` 经 `createToolRegistry` 注册后，`ToolRegistry.searchDeferred("worktree", 5)` 同时命中两者（验证：写一个集成测试）
- [ ] `ToolSearch` 工具调 `markDiscovered` 解锁后，下一次 `getAllSchemas()` 返回值含两个 worktree 工具的 schema（验证：同上）
- [ ] 异步 SubAgent 在 `filterToolsForAgent(..., isAsync=true)` 后能拿到这两个工具（验证：`bun test src/agents/tool-filter.test.ts`）
- [ ] `EnterWorktreeTool` → `ExitWorktreeTool` 端到端：在 worktree 内写一个文件后 ExitWorktree 选择"保留"分支输出；不写文件时选择"清理"输出（验证：tmux 场景 1 + 2）
- [ ] 模块间无导入循环——`src/worktree/worktree.ts` 不引用 `src/tools/*`；`src/tools/enter-worktree.ts` 与 `src/tools/exit-worktree.ts` 只引用 `../worktree/worktree.js` 与 `./types.js`（验证：`tsc --noEmit` 通过即可）

## 编译与测试

- [ ] `tsc --noEmit` 无错误
- [ ] `bun test` 全部用例通过（含 `src/worktree/worktree.test.ts` / `src/tools/enter-worktree.test.ts` / `src/tools/exit-worktree.test.ts`）
- [ ] `bun run src/main.tsx` 启动到 chat 界面无运行时错误
- [ ] `git status` 在干净仓库下不出现 `.mewcode/worktrees/` 路径（已被 .gitignore 排除）

## 端到端场景（tmux 实跑）

每个场景在 tmux 内启动一个 mewcode 实例完成，验证可视化行为。

**通用预置：**
- 当前目录干净 git 仓库
- 已执行 `bun install`
- 启动命令：`tmux new-session -d -s ch14 -x 200 -y 50 "bun run src/main.tsx"`

### 场景 1：模型主动创建 Worktree 并保留有变更的副本**步骤：**
- [ ] tmux 启动 mewcode；先选 provider 进入 chat
- [ ] 输入：「请用 ToolSearch 查询 worktree 相关工具，然后用 EnterWorktree 创建一个 slug 为 demo 的 Worktree，并在 worktree 内用 WriteFile 写文件 `<path>/probe.txt` 内容为 SUBAGENT，最后用 ExitWorktree 退出」
- [ ] 观察 scrollback：先出现 ToolSearch tool_use，再 EnterWorktree tool_use（output 含 `Worktree created at: .mewcode/worktrees/demo`），随后 WriteFile，最后 ExitWorktree
- [ ] ExitWorktree 的 output 含 `Worktree has changes, kept at:` 与 `worktree-demo` 分支名（因为写了 probe.txt 导致 hasWorktreeChanges=true）
- [ ] tmux 外验证：`cat .mewcode/worktrees/demo/probe.txt` 输出 `SUBAGENT`；主目录 `ls probe.txt` 失败（主目录未被影响）
- [ ] 清理：手动 `git worktree remove --force .mewcode/worktrees/demo` + `git branch -D worktree-demo`
- [ ] `tmux kill-session -t ch14`

### 场景 2：模型创建 Worktree 后无变更，ExitWorktree 自动清理**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 输入：「用 ToolSearch 找 worktree，再用 EnterWorktree slug=tmp 创建一个，不做任何修改，立即用 ExitWorktree 退出（传 head_commit）」
- [ ] scrollback：ExitWorktree 的 output 含 `Worktree cleaned up (no changes): .mewcode/worktrees/tmp`
- [ ] tmux 外验证：`ls .mewcode/worktrees/tmp` 失败（目录已被删）；`git branch | grep worktree-tmp` 无匹配
- [ ] `tmux kill-session -t ch14`

### 场景 3：Slug 校验阻止路径遍历**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 输入：「用 ToolSearch 找 worktree，然后用 EnterWorktree slug 设为 `../etc` 试试」
- [ ] scrollback：EnterWorktree 的 output 含 `Error: slug must contain only alphanumeric, hyphen, underscore`，`isError: true`
- [ ] 输入：「再试 slug=team/alice」
- [ ] 同样被拒（slug 含 `/`）
- [ ] 输入：「再试 slug=feature_x-1」
- [ ] 成功创建（合法字符）
- [ ] 清理：`git worktree remove --force .mewcode/worktrees/feature_x-1`、`git branch -D worktree-feature_x-1`
- [ ] `tmux kill-session -t ch14`

### 场景 4：快速恢复路径（重复 EnterWorktree 不重复 git add）**预置：** 手动先创建一个 worktree：`bun run -e "import {createAgentWorktree} from './src/worktree/worktree.ts'; console.log(createAgentWorktree('warm'))"`

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 输入：「用 ToolSearch 找 worktree，再用 EnterWorktree slug=warm（注意这个 slug 的 worktree 已经存在）」
- [ ] scrollback：EnterWorktree 在 1 秒内返回（快速恢复），output 中的 Head SHA 与磁盘上 `.mewcode/worktrees/warm` 的 HEAD 一致
- [ ] tmux 外验证：通过 `git -C .mewcode/worktrees/warm rev-parse HEAD` 取到 SHA 与 EnterWorktree output 中的 Head 字段相等
- [ ] 清理：`git worktree remove --force .mewcode/worktrees/warm`、`git branch -D worktree-warm`
- [ ] `tmux kill-session -t ch14`

### 场景 5：创建后设置 A/B/C/D 全链路**预置：** 在主仓中准备 fixture——
- [ ] `mkdir -p .mewcode && echo "ch14: ok" > .mewcode/test-marker.txt`
- [ ] `mkdir -p .husky && echo "echo hook" > .husky/pre-commit && chmod +x .husky/pre-commit`
- [ ] `mkdir -p node_modules/.fixture && touch node_modules/.fixture/marker`
- [ ] `echo ".env.local" > .worktreeinclude && echo "SECRET=abc" > .env.local`（`.env.local` 通常被 .gitignore 排除）

**步骤：**
- [ ] tmux 启动 mewcode
- [ ] 输入：「用 EnterWorktree slug=setup-check 创建一个 worktree」
- [ ] EnterWorktree 成功返回；tmux 外验证四件事：
  - `cat .mewcode/worktrees/setup-check/.mewcode/test-marker.txt` 输出 `ch14: ok`（设置 A）
  - `git -C .mewcode/worktrees/setup-check config --get core.hooksPath` 含 `.husky` 路径（设置 B）
  - `lstat` 显示 `.mewcode/worktrees/setup-check/node_modules` 是符号链接（设置 C，用 `readlink` 验证）
  - `cat .mewcode/worktrees/setup-check/.env.local` 输出 `SECRET=abc`（设置 D）
- [ ] 清理：`git worktree remove --force .mewcode/worktrees/setup-check`、`git branch -D worktree-setup-check`，删除 fixture 文件
- [ ] `tmux kill-session -t ch14`
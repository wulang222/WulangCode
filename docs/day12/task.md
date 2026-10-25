# Worktree 隔离 Tasks

> 模块路径：`src/worktree/` + `src/tools/enter-worktree.ts` + `src/tools/exit-worktree.ts`；运行时 bun + TypeScript 5.x；测试用 `bun test`，类型检查用 `tsc --noEmit`。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/worktree/worktree.ts` | 纯文件系统 git HEAD 读取 + Worktree 生命周期 + 创建后设置 |
| 新建 | `src/worktree/worktree.test.ts` | worktree 模块单测 |
| 新建 | `src/tools/enter-worktree.ts` | `EnterWorktreeTool` 包装 `createAgentWorktree` |
| 新建 | `src/tools/enter-worktree.test.ts` | EnterWorktreeTool 单测 |
| 新建 | `src/tools/exit-worktree.ts` | `ExitWorktreeTool` 包装 `hasWorktreeChanges` + `removeAgentWorktree` |
| 新建 | `src/tools/exit-worktree.test.ts` | ExitWorktreeTool 单测 |
| 修改 | `src/tui/app.tsx` | `createToolRegistry` 注册 `EnterWorktreeTool` / `ExitWorktreeTool` |
| 修改 | `src/agents/tool-filter.ts` | `ASYNC_AGENT_ALLOWED_TOOLS` 加入两个新工具 |
| 校验 | `src/agents/definition.ts` | 确认 `AgentDefinition.isolation?: "worktree"` 已存在 |
| 校验 | `src/agents/loader.ts` | 确认 `parseAgentDefinition` 已透传 `isolation` 字段 |
| 校验 | `.gitignore` | 确认含 `.mewcode/worktrees/` 行，若无则追加 |

## T1: ref 安全校验与 SHA 正则**文件：** `src/worktree/worktree.ts`
**依赖：** 无
**步骤：**
1. 新建 `src/worktree/` 目录与 `worktree.ts` 文件
2. 顶部加文件级注释（"纯文件系统 git HEAD 读取，避免子进程开销"）
3. 在 import 区引入 `execSync` from `node:child_process`、`cpSync` / `existsSync` / `mkdirSync` / `readFileSync` / `statSync` / `symlinkSync` from `node:fs`、`join` / `dirname` / `isAbsolute` from `node:path`
4. 定义两个常量 `const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;` 与 `const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;`
5. 实现 `function isSafeRefName(name: string): boolean`：非空、不以 `-` 或 `/` 开头、不含 `..`、按 `/` 切段后每段非空且不为 `.`，最后 `SAFE_REF_RE.test(name)`

**验证：** `bun test src/worktree/worktree.test.ts -t "isSafeRefName"`

## T2: HEAD 解析与 ref 解析**文件：** `src/worktree/worktree.ts`
**依赖：** T1
**步骤：**
1. 定义内部接口 `interface GitHead { branch?: string; sha?: string }`
2. 实现 `export function resolveGitDir(root: string): string`：
   - `<root>/.git` 不存在返回 `""`
   - `statSync().isDirectory()` 直接返回该路径
   - 否则读文件，校验 `gitdir:` 前缀，取剩余部分；绝对路径直接用，相对路径与 root 拼接
3. 实现 `function getCommonDir(gitDir: string): string`：读 `<gitDir>/commondir`，绝对/相对处理；抛错返回 `""`
4. 实现 `function readGitHead(gitDir: string): GitHead | null`：
   - 读 `<gitDir>/HEAD`，抛错返回 null
   - `ref:` 前缀：取剩余 ref；`refs/heads/<name>` 且 name 安全 → `{ branch: name }`；否则若 ref 整体安全 → `{ sha: resolveRef(gitDir, ref) }`（空 sha 返回 null）
   - 裸 SHA 匹配 `SHA_RE` → `{ sha: raw }`
   - 其他 → null
5. 实现 `function resolveRefInDir(dir: string, ref: string): string`：
   - 尝试读 `<dir>/<ref>` loose ref 文件；`ref:` 前缀递归调 `resolveRef`；裸 SHA 直接返回
   - 失败再读 `<dir>/packed-refs`，按行扫，跳过 `#` 注释与 `^` peel，按空格切两段匹配 ref
6. 实现 `function resolveRef(gitDir: string, ref: string): string`：先调 `resolveRefInDir(gitDir, ref)`；空则用 `getCommonDir(gitDir)` 拿共享 git 目录，再尝试一次
7. 实现 `export function readWorktreeHeadSha(worktreePath: string): string`：读 `<wtPath>/.git` 文件 → 取 `gitdir:` 后路径 → `readGitHead` → 分支用 `resolveRef("refs/heads/" + branch)`，detached 直接返 `head.sha`
8. 实现 `export function getCurrentBranch(repoRoot: string): string`：`resolveGitDir` → `readGitHead` → `head.branch ?? ""`

**验证：** `bun test src/worktree/worktree.test.ts -t "readWorktreeHeadSha"` / `"getCurrentBranch"` / `"resolveGitDir"`

## T3: Worktree 生命周期函数**文件：** `src/worktree/worktree.ts`
**依赖：** T2
**步骤：**
1. 定义 `export interface WorktreeResult { path: string; branch: string; headCommit: string; gitRoot: string; }`
2. 实现 `export function createAgentWorktree(slug: string, gitRoot?: string): WorktreeResult`：
   - `root = gitRoot ?? execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim()`
   - `wtDir = join(root, ".mewcode", "worktrees", slug)`、`branch = "worktree-" + slug`
   - `existsSync(wtDir)`：先 `readWorktreeHeadSha(wtDir)`，非空直接返；空则 `execSync("git rev-parse HEAD", { cwd: wtDir, encoding: "utf-8" }).trim()` 回退
   - 不存在：`execSync("git worktree add -B \"<branch>\" \"<wtDir>\"", { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })`
   - 调 `performPostCreationSetup(root, wtDir)`
   - 读 head（优先 FS，回退子进程）后返回
3. 实现 `export function removeAgentWorktree(path, branch, gitRoot)`：两步 try/catch
   - `execSync("git worktree remove \"<path>\" --force", { cwd: gitRoot, stdio: ["pipe", "pipe", "pipe"] })`
   - `execSync("git branch -D \"<branch>\"", { cwd: gitRoot, stdio: ["pipe", "pipe", "pipe"] })`
4. 实现 `export function hasWorktreeChanges(path, headCommit): boolean`：
   - 外层 try：`git status --porcelain` 非空 → true
   - `currentHead = readWorktreeHeadSha(path) || execSync("git rev-parse HEAD", { cwd: path, encoding: "utf-8" }).trim()`
   - `currentHead !== headCommit` → true，否则 false
   - catch → 返回 true（保守）
5. 实现 `export function buildWorktreeNotice(parentCwd, wtPath): string`：返回三行字符串（详见 spec F6）

**验证：** `bun test src/worktree/worktree.test.ts -t "createAgentWorktree"` / `"removeAgentWorktree"` / `"hasWorktreeChanges"`

## T4: 创建后设置（四步 best-effort）**文件：** `src/worktree/worktree.ts`
**依赖：** T3
**步骤：**
1. 实现 `function performPostCreationSetup(repoRoot, wtPath): void`：顺序调四个子函数
2. 实现 `function copyMewcodeSettings(repoRoot, wtPath)`：try 内 `existsSync(join(repoRoot, ".mewcode"))` 检查，存在则 `cpSync(src, dst, { recursive: true })`；catch 内 `console.error("Warning: failed to copy .mewcode/ to worktree: <msg>")`
3. 实现 `function configureHooksPath(repoRoot, wtPath)`：候选 `[join(repoRoot, ".husky"), join(repoRoot, ".git", "hooks")]`；依序 `statSync().isDirectory()`，命中即记 `hooksPath` 跳出；命中后 `execSync("git config core.hooksPath \"<hooksPath>\"", { cwd: wtPath, stdio: ["pipe", "pipe", "pipe"] })`
4. 实现 `function symlinkNodeModules(repoRoot, wtPath)`：源 `existsSync` 且目标 `!existsSync` 才 `symlinkSync(src, dst)`
5. 实现 `function copyWorktreeIncludeFiles(repoRoot, wtPath)`：
   - `existsSync(includeFile)` 否则 return
   - 读文件、按行 split、trim、过滤空行与 `#` 注释
   - 对每行：`includes("..")` 直接 continue 跳过
   - 内层 try：源不存在 continue；`mkdirSync(dirname(dst), { recursive: true })`；按 `statSync(src).isDirectory()` 二选一调 `cpSync`
   - 外层 catch 同 copyMewcodeSettings 风格 stderr

**验证：** `bun test src/worktree/worktree.test.ts -t "performPostCreationSetup"`

## T5: worktree 模块单测**文件：** `src/worktree/worktree.test.ts`
**依赖：** T1-T4
**步骤：**
1. 用 `bun:test` 的 `test` / `expect` / `beforeAll` / `afterAll`
2. 构造临时目录 + `git init` + 一次 `git commit` 的 fixture
3. 覆盖：
   - `isSafeRefName`：合法（`refs/heads/main`、`feature/x.y`）、非法（`"../etc"`、`""`、`"-rf"`、`"a..b"`、`"a/./b"`）
   - `resolveGitDir`：在普通仓库返回 `<root>/.git`
   - `readGitHead`：分支与 detached 两种
   - `readWorktreeHeadSha`：在已创建的 worktree 上返回 40 字符 hex
   - `getCurrentBranch`：分支与 detached HEAD 各一次
   - `createAgentWorktree("alice")`：落地 `.mewcode/worktrees/alice/` + 分支 `worktree-alice`
   - 已存在 worktree 时再调返回相同 path 走快速恢复（断言通过 mock execSync 或断言耗时 <50ms）
   - `hasWorktreeChanges`：无变更 false；改文件后 true；HEAD 已变更 true；不存在的 path 返回 true（保守）
   - `removeAgentWorktree`：删除目录与分支
   - 创建后设置：fixture 准备 `.mewcode/config.yaml`、`.husky/`、`node_modules/`、`.worktreeinclude`，断言 Worktree 内对应产物

**验证：** `bun test src/worktree/worktree.test.ts`

## T6: EnterWorktreeTool**文件：** `src/tools/enter-worktree.ts`
**依赖：** T3
**步骤：**
1. import `Tool` / `ToolResult` / `ToolContext` from `./types.js` + `strArg`
2. import `createAgentWorktree` from `../worktree/worktree.js`
3. 实现 `class EnterWorktreeTool implements Tool`：
   - 字段：`name = "EnterWorktree"`、`description = "Create and enter a git worktree for isolated work."`、`category = "write" as const`、`deferred = true`
   - `schema()`：input_schema 只声明 `slug: { type: "string", description: "Short identifier for the worktree" }`，`required: ["slug"]`
   - `async execute(args, _ctx)`：
     - `slug = strArg(args, "slug")`；空 → `{ output: "Error: slug is required", isError: true }`
     - `/^[a-zA-Z0-9_-]+$/.test(slug)` 不通过 → `{ output: "Error: slug must contain only alphanumeric, hyphen, underscore", isError: true }`
     - try `createAgentWorktree(slug)` → `{ output: "Worktree created at: <path>\nBranch: <branch>\nHead: <head>", isError: false }`
     - catch → `{ output: "Error creating worktree: <msg>", isError: true }`

**验证：** `bun test src/tools/enter-worktree.test.ts`

## T7: ExitWorktreeTool**文件：** `src/tools/exit-worktree.ts`
**依赖：** T3
**步骤：**
1. import `Tool` / `ToolResult` / `ToolContext` + `strArg`
2. import `removeAgentWorktree` 与 `hasWorktreeChanges` from `../worktree/worktree.js`
3. 实现 `class ExitWorktreeTool implements Tool`：
   - 字段：`name = "ExitWorktree"`、`description = "Exit and optionally clean up a git worktree."`、`category = "write" as const`、`deferred = true`
   - `schema()`：input_schema 含 `path` / `branch` / `git_root` / `head_commit`；前三个 `required`
   - `async execute(args, _ctx)`：
     - 取 `path` / `branch` / `gitRoot` / `headCommit`
     - 三必填任一为空 → `{ output: "Error: path, branch, and git_root are required", isError: true }`
     - `hasChanges = headCommit ? hasWorktreeChanges(path, headCommit) : false`
     - `!hasChanges` 时 try `removeAgentWorktree(path, branch, gitRoot)` → `{ output: "Worktree cleaned up (no changes): <path>", isError: false }`；catch → `"Error cleaning up worktree: <msg>"` 且 `isError: true`
     - `hasChanges` 时 → `{ output: "Worktree has changes, kept at: <path>\nBranch: <branch>", isError: false }`

**验证：** `bun test src/tools/exit-worktree.test.ts`

## T8: 工具单测**文件：** `src/tools/enter-worktree.test.ts` + `src/tools/exit-worktree.test.ts`
**依赖：** T6 + T7
**步骤：**
1. `enter-worktree.test.ts`：构造临时 git 仓库；调 `tool.execute({ slug: "demo" }, ctx)` 断言 output 含 `path` / `branch` / `Head`；调 `{ slug: "../etc" }` 断言 `isError: true` 且 output 含 "alphanumeric"
2. `exit-worktree.test.ts`：
   - 先 `createAgentWorktree("test")` 拿到 result
   - 调 `tool.execute({ path, branch, git_root, head_commit: headCommit })`：无变更走清理路径，断言 output 含 "Worktree cleaned up"
   - 重新创建一个，写一个文件让其变脏，再调 `tool.execute({ ... })`：断言 output 含 "Worktree has changes, kept at"
   - 不传 `head_commit` 时也能清理（默认 hasChanges=false）

**验证：** `bun test src/tools/enter-worktree.test.ts src/tools/exit-worktree.test.ts`

## T9: 注册工具到 ToolRegistry**文件：** `src/tui/app.tsx`
**依赖：** T6 + T7
**步骤：**
1. 顶部 import 加：
   ```ts
   import { EnterWorktreeTool } from "../tools/enter-worktree.js";
   import { ExitWorktreeTool } from "../tools/exit-worktree.js";
   ```
2. `createToolRegistry` 函数体内，在 `registry.register(new ToolSearchTool(registry));` 之后、`registry.register(new ExitPlanModeTool());` 之前插入：
   ```ts
   registry.register(new EnterWorktreeTool());
   registry.register(new ExitWorktreeTool());
   ```
3. 校验 import 路径解析为 `.js` 后缀（项目 `tsconfig` 模块解析要求）

**验证：** `tsc --noEmit` 无错误；`bun run src/main.tsx` 启动不报错

## T10: 后台 SubAgent 白名单**文件：** `src/agents/tool-filter.ts`
**依赖：** T6 + T7
**步骤：**
1. 在 `ASYNC_AGENT_ALLOWED_TOOLS` Set 字面量内追加两条：
   ```ts
   "EnterWorktree",
   "ExitWorktree",
   ```
2. 校验位置：与现有 `"NotebookEdit"` / `"Skill"` 等并列

**验证：** `tsc --noEmit`；增加一个测试在 `src/agents/tool-filter.test.ts`（若已存在则补充用例）：用 `filterToolsForAgent(registry, undefined, undefined, true)`（isAsync=true）跑过后断言 `filtered.get("EnterWorktree")` 不为 undefined

## T11: 确认 AgentDefinition / loader 兼容**文件：** `src/agents/definition.ts` + `src/agents/loader.ts`
**依赖：** 无
**步骤：**
1. 校验 `AgentDefinition` 接口含 `isolation?: "worktree"` 字段（无需新增）
2. 校验 `parseAgentDefinition` 在返回对象中含 `isolation: raw.isolation as "worktree" | undefined`（无需新增）
3. 若任一缺失，按 spec F21 补全

**验证：** `tsc --noEmit`；可写一个测试：parse 一段含 `isolation: worktree` 的 frontmatter，断言结果对象 `isolation === "worktree"`

## T12: .gitignore 校验**文件：** `.gitignore`
**依赖：** 无
**步骤：**
1. 用 `grep -E "^\.mewcode/worktrees/$" .gitignore` 检查
2. 不存在则在 `.mewcode/` 相关段落后追加 `.mewcode/worktrees/`
3. 同时确认 `.mewcode/` 整体是否已被忽略（若已是 `.mewcode/` 整目录忽略则无需追加子目录条目）

**验证：** `git check-ignore -v .mewcode/worktrees/test/`（应命中 .gitignore 中某条规则）

## T13: 类型检查与全量测试**文件：** 无
**依赖：** T1-T12
**步骤：**
1. 跑 `tsc --noEmit`，0 错误
2. 跑 `bun test`，全部通过
3. 跑 `bun run src/main.tsx`，启动到 chat 界面无运行时错误

**验证：** 上述三条命令全部 0 退出

## T14: tmux 端到端验证**文件：** 无代码修改
**依赖：** T13
**步骤：**
1. 在干净的 git 仓库克隆下 `bun install`
2. `tmux new-session -d -s ch14 -x 200 -y 50 "bun run src/main.tsx"`
3. 等待 TUI 起来后输入 prompt 让模型用 `ToolSearch` 发现 `EnterWorktree`，调用 `EnterWorktree({ slug: "demo" })`
4. 验证 `.mewcode/worktrees/demo/` 落地 + 分支 `worktree-demo` 存在
5. 让模型在 worktree 内写一个文件，再调 `ExitWorktree({ path, branch, git_root, head_commit })`：断言保留路径输出
6. 再次让模型创建无变更的 worktree，`ExitWorktree`：断言清理成功
7. 清理 tmux session

**验证：** 见 checklist.md 的端到端场景

## 执行顺序

```text
T1 (ref 校验)
  ↓
T2 (HEAD/ref 解析)
  ↓
T3 (生命周期函数)
  ↓
T4 (创建后设置)
  ↓
T5 (worktree 单测) — T6 (EnterWorktreeTool) — T7 (ExitWorktreeTool)
                       ↓                          ↓
                       T8 (工具单测)             T8
  ↓
T9 (TUI 注册) — T10 (异步白名单) — T11 (AgentDefinition 校验) — T12 (.gitignore)
  ↓
T13 (tsc + bun test + bun run)
  ↓
T14 (tmux 端到端)
```

T6/T7 可并行（同时依赖 T3）；T8 等两者完成后再跑；T9-T12 可并行（互不依赖）。
# Worktree 隔离 Plan## 技术栈

- 运行时：bun
- 语言：TypeScript 5.x（`tsc --noEmit` 用于类型检查，bun 直接执行 `.ts` / `.tsx`）
- 子进程：`node:child_process.execSync`（同步，避免 Promise 链路）
- 文件系统：`node:fs`（`cpSync` / `symlinkSync` / `readFileSync` / `statSync` / `existsSync` / `mkdirSync`）
- 路径处理：`node:path`（`join` / `dirname` / `isAbsolute`）
- TUI：Ink + React 18（工具注册入口在 `src/tui/app.tsx`）
- LLM SDK：`@anthropic-ai/sdk` / `openai`（无关本章，但工具 schema 由 `ToolRegistry.getAllSchemas` 喂给它们）
- MCP：`@modelcontextprotocol/sdk`（无关本章，但 ToolRegistry 同时托管 MCP 工具）
- 配置：`js-yaml`（用于解析 Agent definition frontmatter）
- 测试：`bun test`

## 架构概览

新增 `src/worktree/worktree.ts` 单文件模块，集中放：
1. 纯文件系统 git HEAD 读取工具（`resolveGitDir` / `readGitHead` / `resolveRef` / `readWorktreeHeadSha` / `getCurrentBranch`）
2. Worktree 生命周期函数（`createAgentWorktree` / `removeAgentWorktree` / `hasWorktreeChanges` / `buildWorktreeNotice`）
3. 创建后设置内部辅助函数（`performPostCreationSetup` 及四个子函数）

新增两个工具文件，把上述函数包装成 LLM 可调用的 Tool：
- `src/tools/enter-worktree.ts`：`EnterWorktreeTool` — 调 `createAgentWorktree`
- `src/tools/exit-worktree.ts`：`ExitWorktreeTool` — 调 `hasWorktreeChanges` + `removeAgentWorktree`

接入点：
- `src/tui/app.tsx` 的 `createToolRegistry` 注册两个工具
- `src/agents/tool-filter.ts` 的 `ASYNC_AGENT_ALLOWED_TOOLS` 加入两个工具名
- `src/agents/definition.ts` 的 `AgentDefinition` 已声明 `isolation?: "worktree"`，loader 已能解析（无需新增改动）

## 数据流**模型主动开 Worktree：**

```
模型 → ToolSearch({ query: "worktree" })
       ↓
ToolRegistry.searchDeferred → 返回 EnterWorktree/ExitWorktree schema
       ↓
ToolRegistry.markDiscovered("EnterWorktree")
       ↓
模型 → EnterWorktree({ slug: "feature-x" })
       ↓
EnterWorktreeTool.execute → createAgentWorktree(slug)
       ↓
git worktree add -B worktree-feature-x .mewcode/worktrees/feature-x
       ↓
performPostCreationSetup:
  - copyMewcodeSettings   (cpSync .mewcode/)
  - configureHooksPath    (git config core.hooksPath)
  - symlinkNodeModules    (symlinkSync)
  - copyWorktreeIncludeFiles (按 .worktreeinclude 列表 cpSync)
       ↓
readWorktreeHeadSha(wtDir) | fallback execSync git rev-parse HEAD
       ↓
返回 { path, branch, headCommit, gitRoot }
       ↓
工具 output 拼接 "Worktree created at: <path>\nBranch: ...\nHead: ..."
       ↓
模型在后续 Bash/Edit/Write 调用中显式把 <path> 作为绝对路径前缀
```

**模型显式退出 Worktree：**

```
模型 → ExitWorktree({ path, branch, git_root, head_commit })
       ↓
ExitWorktreeTool.execute
       ↓
hasChanges = head_commit ? hasWorktreeChanges(path, head_commit) : false
       ├─ true  → 不删，返回 "Worktree has changes, kept at: ..."
       └─ false → removeAgentWorktree(path, branch, gitRoot)
                  ↓
                  git worktree remove --force <path>
                  git branch -D <branch>
                  ↓
                  返回 "Worktree cleaned up (no changes): ..."
```

**纯文件系统 HEAD 读取链路：**

```
readWorktreeHeadSha(wtPath)
  ↓
readFileSync(<wtPath>/.git) → "gitdir: <relPath>"
  ↓
gitDir = resolve relPath against wtPath
  ↓
readGitHead(gitDir):
  ├─ "ref: refs/heads/<name>"   → { branch: name }
  ├─ "ref: <other symref>"       → { sha: resolveRef(other) }
  └─ "<40 hex SHA>"              → { sha }
  ↓
若 branch → resolveRef(gitDir, "refs/heads/" + branch)
   resolveRefInDir(gitDir) → loose ref file | packed-refs
   失败 → resolveRefInDir(commondir)  (worktree 共享 git 目录的回退)
  ↓
返回 40 / 64 字符 hex SHA 或 ""
```

## 核心数据结构与接口### Worktree 返回类型

```typescript
export interface WorktreeResult {
  path: string;        // .mewcode/worktrees/<slug> 的绝对路径
  branch: string;      // worktree-<slug>
  headCommit: string;  // 40 字符 SHA-1（或 SHA-256 64 字符）
  gitRoot: string;     // 主仓 git rev-parse --show-toplevel 输出
}
```

### Worktree 模块导出函数

```typescript
// 纯文件系统读取
export function resolveGitDir(root: string): string;
export function readWorktreeHeadSha(worktreePath: string): string;
export function getCurrentBranch(repoRoot: string): string;

// 生命周期
export function createAgentWorktree(
  slug: string,
  gitRoot?: string
): WorktreeResult;

export function removeAgentWorktree(
  path: string,
  branch: string,
  gitRoot: string
): void;

export function hasWorktreeChanges(
  path: string,
  headCommit: string
): boolean;

export function buildWorktreeNotice(
  parentCwd: string,
  wtPath: string
): string;
```

### 内部 git HEAD 解析类型

```typescript
// 不导出，仅模块内使用
interface GitHead {
  branch?: string;
  sha?: string;
}

function readGitHead(gitDir: string): GitHead | null;
function resolveRef(gitDir: string, ref: string): string;
function resolveRefInDir(dir: string, ref: string): string;
function getCommonDir(gitDir: string): string;
function isSafeRefName(name: string): boolean;

const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
```

### 工具类签名

```typescript
export class EnterWorktreeTool implements Tool {
  name = "EnterWorktree";
  description = "Create and enter a git worktree for isolated work.";
  category = "write" as const;
  deferred = true;
  schema(): Record<string, unknown>;
  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<ToolResult>;
}

export class ExitWorktreeTool implements Tool {
  name = "ExitWorktree";
  description = "Exit and optionally clean up a git worktree.";
  category = "write" as const;
  deferred = true;
  schema(): Record<string, unknown>;
  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<ToolResult>;
}
```

### AgentDefinition 扩展（已存在）

```typescript
export interface AgentDefinition {
  // ... 既有字段 ...
  isolation?: "worktree";   // 本章不在 spawnSubAgent 内消费，保留语义占位
}
```

## 模块设计### `src/worktree/worktree.ts`（新文件）**职责：** 暴露 Worktree 全部底层能力——HEAD 读取、生命周期、变更检测、创建后设置；不做状态管理。

**对外接口：** `WorktreeResult` 类型 + `createAgentWorktree` / `removeAgentWorktree` / `hasWorktreeChanges` / `buildWorktreeNotice` / `resolveGitDir` / `readWorktreeHeadSha` / `getCurrentBranch` 七个函数。

**依赖：** 纯 Node 标准库 + `git` 可执行（通过 `execSync`）。

**关键内部函数：**
- `readGitHead(gitDir)`：解析 HEAD 文件，支持 `ref:` 与裸 SHA 两种形态
- `resolveRef(gitDir, ref)`：先查 loose ref，再查 packed-refs；worktree 自己的 gitDir 找不到时回退到 commondir
- `resolveRefInDir(dir, ref)`：单个目录内的查找（loose → packed-refs）
- `getCommonDir(gitDir)`：读 worktree gitDir 的 `commondir` 文件
- `isSafeRefName(name)`：校验合法 ref 名（防路径遍历与 shell 注入）
- `performPostCreationSetup(repoRoot, wtPath)`：依次调四个 best-effort 子步骤
  - `copyMewcodeSettings(repoRoot, wtPath)`
  - `configureHooksPath(repoRoot, wtPath)`
  - `symlinkNodeModules(repoRoot, wtPath)`
  - `copyWorktreeIncludeFiles(repoRoot, wtPath)`

### `src/tools/enter-worktree.ts`（新文件）**职责：** 把 `createAgentWorktree` 包装成 LLM 可调用工具，加严格 slug 校验。

**对外：** `EnterWorktreeTool` 类。

**依赖：** `../worktree/worktree.js`（`createAgentWorktree`）+ `./types.js`（`Tool` / `ToolResult` / `ToolContext` / `strArg`）。

**关键点：**
- `deferred: true` → 默认不出现在 schema 列表
- slug 校验比 `isSafeRefName` 更严格：`/^[a-zA-Z0-9_-]+$/`，不允许 `/` 与 `.`
- 失败统一返回 `{ output: "Error: ...", isError: true }`

### `src/tools/exit-worktree.ts`（新文件）**职责：** 把 `hasWorktreeChanges` 与 `removeAgentWorktree` 组合成一次工具调用，提供"有变更则保留，否则清理"的策略。

**对外：** `ExitWorktreeTool` 类。

**依赖：** `../worktree/worktree.js`（`removeAgentWorktree` + `hasWorktreeChanges`）+ `./types.js`。

**关键点：**
- `head_commit` 为可选参数；不传时跳过变更检测，直接尝试清理
- 有变更时只输出保留提示，不抛错，让模型自行决定后续合并

### `src/tui/app.tsx` 改动**职责：** 在 `createToolRegistry` 中注册两个新工具。

**改动：**
- 顶部 import：`import { EnterWorktreeTool } from "../tools/enter-worktree.js";` / `import { ExitWorktreeTool } from "../tools/exit-worktree.js";`
- `createToolRegistry` 函数体内 `registry.register(new EnterWorktreeTool());` / `registry.register(new ExitWorktreeTool());`（位置：放在 `ToolSearchTool` 之后、`ExitPlanModeTool` 之前）

### `src/agents/tool-filter.ts` 改动**职责：** 把两个工具加入异步 SubAgent 白名单，让后台 Agent 也能用。

**改动：**
- `ASYNC_AGENT_ALLOWED_TOOLS` 集合追加两条：`"EnterWorktree"` / `"ExitWorktree"`

### `src/agents/definition.ts` / `src/agents/loader.ts`**职责：** `isolation?: "worktree"` 字段已存在（来自 ch13 留出的扩展点）；loader 解析 frontmatter 时已透传，本章不再改动。

### `.gitignore`（已存在）**职责：** 保证 `.mewcode/worktrees/` 与 `.mewcode/worktree_session.*` 不被纳入版本库。

**改动：** 若未含 `.mewcode/worktrees/` 行则追加（mewcode 安装时通常已配 `.mewcode/`，本章可在文档中提示用户校验）。

## 模块交互**工具发现与首次调用：**

```
TUI app.tsx (createToolRegistry)
  ↓ register
ToolRegistry { EnterWorktree, ExitWorktree, ToolSearch, ... }
  ↓
模型一开始看 getAllSchemas() → 不含 EnterWorktree（deferred）
  ↓
模型调 ToolSearch(query="worktree")
  ↓
ToolRegistry.searchDeferred → 命中两个工具
  ↓
ToolSearch 工具体内调 ToolRegistry.markDiscovered("EnterWorktree")
  ↓
下一轮 getAllSchemas() 把它们包含进去
  ↓
模型调 EnterWorktree({ slug })
```

**Worktree 创建链路：**

```
EnterWorktreeTool.execute(args, ctx)
  ↓ slug 校验
createAgentWorktree(slug)
  ↓ exec git rev-parse --show-toplevel (取 root)
  ↓ check existsSync(.mewcode/worktrees/<slug>)
  ├─ 已存在 → readWorktreeHeadSha (FS 快速恢复)
  └─ 不存在 → exec git worktree add -B worktree-<slug> <wtDir>
              ↓
              performPostCreationSetup(root, wtDir)
                ↓
                copyMewcodeSettings        (cpSync)
                configureHooksPath         (statSync + exec git config)
                symlinkNodeModules         (symlinkSync)
                copyWorktreeIncludeFiles   (readFileSync + cpSync)
              ↓
              readWorktreeHeadSha (优先) / exec git rev-parse HEAD (回退)
  ↓
返回 WorktreeResult { path, branch, headCommit, gitRoot }
  ↓
output = "Worktree created at: <path>\nBranch: <branch>\nHead: <sha>"
```

**Worktree 退出链路：**

```
ExitWorktreeTool.execute(args, ctx)
  ↓ 校验 path/branch/git_root 三参非空
  ↓ hasChanges = head_commit ? hasWorktreeChanges(path, head_commit) : false
  ├─ hasChanges=true  → output = "Worktree has changes, kept at: <path>\nBranch: <branch>"
  └─ hasChanges=false → removeAgentWorktree(path, branch, gitRoot)
                          ↓
                          exec git worktree remove --force <path>  (try/catch)
                          exec git branch -D <branch>              (try/catch)
                        ↓
                        output = "Worktree cleaned up (no changes): <path>"
```

**异步 SubAgent 使用 Worktree：**

```
spawnSubAgent (isAsync=true)
  ↓
filterToolsForAgent(registry, ..., isAsync=true)
  ↓
ASYNC_AGENT_ALLOWED_TOOLS 含 EnterWorktree/ExitWorktree → 保留在子 Agent registry
  ↓
子 Agent 自己决定何时调 EnterWorktree
```

## 文件组织

```text
src/worktree/
└── worktree.ts                  — 新文件：纯函数模块（HEAD 读取 + 生命周期 + 创建后设置）

src/tools/
├── enter-worktree.ts            — 新文件：EnterWorktreeTool
├── exit-worktree.ts             — 新文件：ExitWorktreeTool
├── types.ts                     — 已有：Tool / ToolContext / ToolResult / strArg / intArg / boolArg
├── registry.ts                  — 已有：ToolRegistry（支持 deferred / markDiscovered）
└── tool-search.ts               — 已有：ToolSearch 工具（按 query 模糊匹配 deferred 工具）

src/tui/
└── app.tsx                      — 改动：createToolRegistry 注册两个新工具

src/agents/
├── tool-filter.ts               — 改动：ASYNC_AGENT_ALLOWED_TOOLS 追加两条
├── definition.ts                — 已有：AgentDefinition.isolation?: "worktree"
└── loader.ts                    — 已有：parseAgentDefinition 透传 isolation 字段

测试位置（按 bun test 约定）：
src/worktree/worktree.test.ts    — 新文件：worktree 模块单测
src/tools/enter-worktree.test.ts — 新文件：EnterWorktreeTool 单测
src/tools/exit-worktree.test.ts  — 新文件：ExitWorktreeTool 单测
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 暴露形态 | LLM 工具（Tool 接口） | 让模型显式决定何时开 / 关 Worktree，无需在 Agent loop 内做自动 wrap；保持模型与隔离能力的可控性 |
| `deferred: true` | 是 | Worktree 不是高频操作，默认在 schema 列表外避免污染 prompt cache；模型用 ToolSearch 按需加载 |
| Worktree 目录位置 | `<root>/.mewcode/worktrees/<slug>/` | 仓库内 + `.gitignore` 排除；与其他 mewcode 状态文件同级，方便用户清理 |
| Worktree 分支名 | `worktree-<slug>` | 单一前缀便于 `git branch --list "worktree-*"` 检索；slug 简单（无 `/`），不会产生 D/F 冲突 |
| slug 字符集 | `[a-zA-Z0-9_-]` | 比通用 ref 校验更严格，禁掉 `/` 与 `.` 避免任何路径解析歧义；与 LLM 习惯的 kebab-case 一致 |
| `git worktree add -B` | 大写 B | 残留同名分支不会让创建失败；小写 `-b` 在分支已存在时会报错 |
| 快速恢复路径 | 文件系统读 HEAD，子进程回退 | 大仓库 `git rev-parse HEAD` 进程启动 ~15ms；纯文件读 <1ms；失败回退保证正确性 |
| HEAD 解析做安全校验 | 是（`isSafeRefName`） | HEAD 文件可能被外部篡改；任何不安全 ref 立即返回空，绝不传给路径拼接或 shell |
| 创建后设置失败处理 | try/catch 仅 stderr 警告 | 四个子步骤都是 best-effort（hooks / 软链 / 复制），失败 ≠ 不可用 |
| `node_modules` 处理 | symlink（不复制） | `node_modules` 通常巨大，软链共享磁盘与下载缓存；Windows symlink 行为不保证时 try/catch 跳过 |
| `.worktreeinclude` 路径遍历防护 | 含 `..` 立即跳过 | 防止用户提供恶意配置导致写到 Worktree 外部 |
| 退出策略 | 有变更则保留 | 让模型自行决定后续 `git merge` / cherry-pick；mewcode 不替模型做合并决策 |
| `removeAgentWorktree` 错误吞掉 | try/catch | Worktree 或分支可能已被外部清理；幂等优先 |
| `hasWorktreeChanges` 失败时返回 true | fail-closed | 宁可保留也不要误删；git 命令异常通常意味着 worktree 处于异常状态 |
| `AgentDefinition.isolation` 字段保留 | 不消费 | loader 已解析，留作未来扩展（自动 wrap 等）；本章模型显式调工具即足 |
| 同步 `execSync` vs 异步 spawn | 同步 | 工具调用本就是阻塞等待结果的语义；execSync 简单且无 await 链 |
| 测试框架 | `bun test` | 与项目其余测试一致；无需额外配置 |
| 类型检查 | `tsc --noEmit` | bun 运行不强制类型检查，CI 需显式 `tsc --noEmit` 把关 |
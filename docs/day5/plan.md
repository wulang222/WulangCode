# 权限系统 Plan> 技术栈：bun + TypeScript 5.x。权限判定全部落在新增 `src/permissions/checker.ts` 与既有 `src/agent/agent.ts`、`src/tui/app.tsx`/`src/tui/permission-dialog.tsx`，**不改 `src/llm/anthropic.ts` / `src/llm/openai.ts`**（N6 跨协议一致天然成立）。

## 技术栈

- 运行时：bun (>= 1.2)
- 语言：TypeScript 5.x（`tsc --noEmit` 静态检查）
- TUI：Ink 5.x + React 18（`Box` / `Text` / `useInput` / `useState`）
- LLM SDK：`@anthropic-ai/sdk`、`openai`
- 配置解析：`js-yaml`（`yaml.load` 读 `permissions.yaml`，`yaml.dump` 写 `permissions.local.yaml`）
- 路径：Node 内置 `node:path`（`resolve`/`join`/`dirname`）、`node:os`（`homedir`）、`node:fs`（`readFileSync`/`writeFileSync`/`mkdirSync`）
- 测试：`bun test`（`describe`/`it`/`expect`）
- 终端样式：`chalk` + 本仓库自有 `src/tui/styles.ts`（`brand.warning`/`brand.tool` 等）

## 架构概览（分层）

ch06 的判定职责按文件划分如下：

- **`src/permissions/checker.ts`（新增）**：单文件承载所有判定逻辑。导出 `PermissionChecker` 类、`PathSandbox` 类、`RuleEngine` 类、`Decision` 类型、`PermissionMode` 联合类型、`extractContent` 工具函数。`PermissionChecker.check(toolName, category, args)` 是 Agent 唯一调用入口，内部按 Layer 0/2/3/4/4b/5/6 顺序短路返回 `Decision`。
- **`src/agent/agent.ts`（改造）**：`AgentConfig` 增加 `checker: PermissionChecker` 与可选 `onPermissionRequest` 回调；`executeBatch` 在每个 `toolUse` 真正提交给 `StreamingExecutor` 之前先 `checker.check(...)`；`deny` 直接构造 `tool_result` 事件；`ask` `await onPermissionRequest(...)`，对 `"allowAlways"` 调 `checker.allowAlways`、对 `"deny"` 回灌错误结果。
- **`src/tui/permission-dialog.tsx`（新增）**：`PermissionDialog` 函数式组件，渲染多行待批准块，`useInput` 处理 ↑↓ + Enter + Esc + 数字键。
- **`src/tui/app.tsx`（改造）**：根组件 `App` 维护 `permMode` 状态、`permissionRequest` UI 状态、`permissionResolveRef`；构造 Agent 时注入 `onPermissionRequest`，把 Agent 的 Promise 桥接到 Dialog 渲染；监听 `process.stdin` 原始 `\x1b[Z` 序列做 Shift+Tab 模式循环；注册 `/permission` 斜杠命令。
- **`src/tui/input.tsx`（改造）**：在输入框上方显示当前权限模式徽标（`modeDisplay` 表），`useInput` 内也截 `\x1b[Z` 做循环（双重保险）。
- **`src/tui/status-bar.tsx`（改造）**：底部状态栏接收 `mode` prop 并显示。
- **`src/main.tsx`**：不动；`App` 内部按需 `new PermissionChecker(workDir, permMode)`。

## 数据流

单个工具调用从模型响应到真正执行的链路：

```
LLM 流式产出 tool_use block(toolName, args, toolUseId)
  ↓
Agent.executeTools(toolUses)
  ↓ partition by category
read-safe → executeBatch(toolUses, parallel=true)
write/cmd → executeBatch([toolUse], parallel=false)
  ↓ for each tu:
PermissionChecker.check(toolName, category, args)
  ├ Layer 0: plan-mode plan 文件豁免 (mode==="plan" && WriteFile/EditFile && path 含 ".mewcode/plans/") → allow
  ├ Layer 2: category==="command" && isSafeCommand(content) → allow ("Safe read-only command")
  ├ Layer 3: category==="command" && detectDangerous(content) 命中 → deny ("Dangerous command blocked: <reason>")
  ├ Layer 4: (category==="read"|"write") && (args.file_path||args.path) && sandbox.check 拒绝 → deny ("Path … is outside …")
  ├ Layer 4b: sessionAllowed.has(`${toolName}:${content}`) → allow
  ├ Layer 5: ruleEngine.evaluate(toolName, content) → "allow" | "deny" | null
  └ Layer 6: modeDecide(mode, category) → "allow" | "ask"
  ↓
decision.effect === "deny"  → push tool_result { isError:true, output:"Permission denied: …" } → continue
decision.effect === "ask"   → await onPermissionRequest(toolName, args, decision)
                              ↓ App.onPermissionRequest: setPermissionRequest(...) + permissionResolveRef = resolve
                              ↓ <PermissionDialog ↑↓ Enter Esc 1/2/3>
                              ↓ resolve("allow" | "allowAlways" | "deny")
                              "deny"        → push tool_result { isError:true, "Permission denied by user" } → continue
                              "allowAlways" → checker.allowAlways(toolName, args) → 落 fall through 继续执行
                              "allow"       → 继续执行
decision.effect === "allow" → executor.submit(toolUseId, toolName, args) → 真正调用工具
```

## 核心数据结构与接口### `src/permissions/checker.ts`

```ts
export type DecisionEffect = "allow" | "deny" | "ask";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Decision {
  effect: DecisionEffect;
  reason: string;
}

type RuleEffect = "allow" | "deny";

interface Rule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
}

interface DangerousPattern {
  re: RegExp;
  reason: string;
}

// 包级常量，不可配置
const DANGEROUS_PATTERNS: DangerousPattern[];
const SAFE_PREFIXES: string[];
const CONTENT_FIELDS: Record<string, string>;

export function extractContent(toolName: string, args: Record<string, unknown>): string;

export class PathSandbox {
  constructor(projectDir: string);
  addRoot(root: string): void;
  check(filePath: string): Decision | null; // null = 放行
}

export class RuleEngine {
  constructor(workDir: string);
  evaluate(toolName: string, content: string): RuleEffect | null;
  appendLocalRule(rule: Rule): void;
}

export class PermissionChecker {
  mode: PermissionMode;
  planFilePath: string;
  constructor(workDir: string, mode?: PermissionMode);
  check(
    toolName: string,
    category: "read" | "write" | "command",
    args: Record<string, unknown>,
  ): Decision;
  allowForSession(toolName: string, args: Record<string, unknown>): void;
  allowAlways(toolName: string, args: Record<string, unknown>): void;
  describeToolAction(toolName: string, args: Record<string, unknown>): string;
}
```

### `src/agent/agent.ts`（新增字段）

```ts
import type { PermissionChecker, Decision } from "../permissions/checker.js";

export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  // … 既有字段省略 …
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
  ) => Promise<"allow" | "deny" | "allowAlways">;
}
```

### `src/tui/permission-dialog.tsx`

```ts
export type PermissionAction = "allow" | "deny" | "allowAlways";

interface Props {
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

export function PermissionDialog(props: Props): JSX.Element;
```

### `src/tui/app.tsx`（新增 state/ref）

```ts
const [permMode, setPermMode] = useState<PermissionMode>("default");
const [permissionRequest, setPermissionRequest] = useState<{
  toolName: string;
  argsSummary: string;
  reason: string;
} | null>(null);
const permissionResolveRef = useRef<
  ((v: "allow" | "deny" | "allowAlways") => void) | null
>(null);
```

## 模块设计### `src/permissions/checker.ts`**职责：** 全部权限判定（7 层流水线），三级 YAML 规则加载与持久化，工具参数 → content 的提取。

**关键点：**
- **`DANGEROUS_PATTERNS`** 是 `{re: RegExp; reason: string}[]` 数组，14 条模式：`rm -rf [/~]`、`rm -rf *`、`mkfs.*`、`dd if=`、`>/dev/sd`、`chmod -R 777 /`、fork bomb、`curl|sh`、`wget|sh`、`git push --force`、`git reset --hard`、`git clean -f`、`git checkout .`、`git branch -D`。每条都把人类可读 `reason` 一起返回，方便 HITL Dialog 展示。
- **`SAFE_PREFIXES`** 是 ~26 条只读命令前缀（`ls`/`pwd`/`echo`/`cat`/`head`/`tail`/`wc`/`date`/`whoami`/`uname`/`hostname`/`which`/`type`/`file`/`git status`/`git log`/`git diff`/`git branch`/`git show`/`git rev-parse`/`git remote`/`bun test`/`bun run`/`npm test`/`npm run`/`go test`/`go build`/`go vet`/`python -c`/`node -e`）。
- **`isSafeCommand`** 先剔除 6 类 shell 元字符（`>` `|` `;` `&&` `$(` `` ` ``），再用三种方式匹配前缀：完全相等、前缀 + 空格、前缀 + Tab。N2 的核心保证。
- **`CONTENT_FIELDS`** 表：`Bash → "command"`、`ReadFile/WriteFile/EditFile → "file_path"`、`Glob/Grep → "pattern"`。`extractContent` 取对应字段（`typeof v === "string"` 防御非串），未知工具返回空串。
- **`globMatch`** 把 pattern 中的正则元字符通过 `replace(/[.+^${}()|[\]\\]/g, "\\$&")` 字面转义，再把 `*` → `[^/]*`、`?` → `[^/]`，编译成 `^...$` 锚定的 `RegExp`，`try { return new RegExp(re).test(content) } catch { return false }`。
- **`PathSandbox`** 构造时 `allowedRoots = [resolve(projectDir), "/tmp"]`。`check` 用 `path.resolve(filePath)` 后 `startsWith` 比对（这里**不调 `realpath`**，软链接是已知盲区）。
- **`RuleEngine`** 三个文件路径：`user = join(homedir(), ".mewcode/permissions.yaml")`、`project = join(workDir, ".mewcode/permissions.yaml")`、`local = join(workDir, ".mewcode/permissions.local.yaml")`。`evaluate` 顺序 `[user, project, local]`，每文件 `loadRulesFile` 现读现解析（这样 `appendLocalRule` 刚写完就立即生效），**文件内倒序遍历**（last-rule-wins），第一个匹配的 `rule.effect` 返回；都未命中返回 `null`。
- **`loadRulesFile`** 防御 5 层：`readFileSync` 抛错 → `[]`、`yaml.load` 抛错 → `[]`、非数组 → `[]`、`effect` 不在 `{allow,deny}` → 跳过条目、`rule` 不匹配 `^(\w+)\((.+)\)$` → 跳过条目。
- **`appendLocalRule`** 用 `mkdirSync(dirname, { recursive: true })` 确保 `.mewcode/` 目录存在，`loadRulesFile` 取现有规则、push 新规则、`yaml.dump` 后 `writeFileSync` 重写整文件。
- **`allowAlways`** 取 `extractContent`，**60 字符截断** + 末尾追加 `*`（`pattern = content.length > 60 ? content.slice(0,60) + "*" : content + "*"`）。这让 `git push origin main` 持久化为 `Bash(git push origin main*)`，匹配同前缀变体但不放过完全不相关命令。
- **`PermissionChecker.check`** 是流水线主干，顺序：Layer 0 plan 文件豁免 → Layer 2 安全命令 → Layer 3 危险命令 → Layer 4 沙箱（仅当 `args.file_path || args.path` 非空）→ Layer 4b 会话级 → Layer 5 规则引擎 → Layer 6 模式矩阵。每命中一层 `return`。
- **`describeToolAction`** 给 HITL Dialog 用：优先取 `extractContent`，未取到则把所有 `args` key-value 拼成 `k: v, k: v` 形式，每值 80 字符截断。

**依赖：** `js-yaml`、Node 内置 `fs/path/os`、无项目内依赖。

### `src/agent/agent.ts`**职责：** 在 `executeBatch` 工具执行链路前接入权限判定与 HITL 桥接。

**关键点：**
- `AgentConfig.checker` 必填、`onPermissionRequest` 可选。
- `executeBatch(toolUses, parallel)`：对每个 `tu` 先跑 `hookEngine.firePreToolHooks`（若 rejected 写 `Rejected by hook: ...` 错误结果并 `continue`），再 `const decision = this.checker.check(tu.toolName, category, tu.arguments)`。
  - `decision.effect === "deny"` → push `{ type: "tool_result", toolName, toolId: tu.toolUseId, output: \`Permission denied: ${decision.reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。\`, isError: true, elapsed: 0 }`，`continue`。
  - `decision.effect === "ask"` + `onPermissionRequest` 存在 → `const response = await onPermissionRequest(tu.toolName, tu.arguments, decision)`；`response === "deny"` 同样回灌（output 为 `"Permission denied by user"`） + `continue`；`response === "allowAlways"` → `checker.allowAlways(tu.toolName, tu.arguments)`；落地后正常 `executor.submit(...)`。
  - `decision.effect === "allow"`（含模式 allow / 规则 allow / Layer 0~4b 任一 allow）→ `executor.submit(...)`。
- 模式分支：`parallel=true` 在循环全部 submit 后一次性 `await executor.collectResults()`；`parallel=false` 每次 submit 后立即 collect（保持 write/dangerous 类的串行语义与 conversation 写回顺序）。
- 一次模式同步：`if (this.checker.mode === "plan") this.checker.planFilePath = getOrCreatePlanPath(workDir)`，让 Layer 0 的 plan 文件路径判断有数据。

### `src/tui/permission-dialog.tsx`**职责：** Ink 渲染 HITL 多行块、键盘交互、把用户选择回送 `onComplete`。

**关键点：**
- `const options = [{ label: "Yes", action: "allow" }, { label: "Yes, and don't ask again for this pattern", action: "allowAlways" }, { label: "No", action: "deny" }]`。
- `useState<number>` 维护 `cursor`，`useInput`：
  - `key.upArrow` → cursor 循环减 1（到 0 后跳到末尾）；
  - `key.downArrow` → cursor 循环加 1；
  - `key.return` → `onComplete(options[cursor].action)`；
  - `key.escape` → `onComplete("deny")`。
- 渲染：`brand.warning(\`  ${toolName} command\`)` 顶部黄字、`argsSummary`（>120 字符截断 + "…"）灰字、`"This command requires approval"`、`"Do you want to proceed?"`、三行菜单（光标项前缀 `brand.tool(\` ${symbols.prompt} \`)` 高亮 + 青色文本，其他项灰色）。

### `src/tui/app.tsx`**职责：** 持有权限模式状态、桥接 Agent Promise 与 Dialog UI、模式切换。

**关键点：**
- `useState<PermissionMode>("default")` + `useState<{toolName, argsSummary, reason} | null>(null)` + `useRef<resolve>`。
- **Shift+Tab 监听**：`useEffect` 注册 `process.stdin.on("data", handler)`，`handler(data)` 检测 `data.toString() === "\x1b[Z"` 时 `setPermMode(prev => cycle[(cycle.indexOf(prev) + 1) % cycle.length])`，cycle = `["default", "acceptEdits", "plan", "bypassPermissions"]`。`useEffect` 返回 cleanup 解绑。
- **`runAgentLoop(modeOverride?)`**：`const checker = new PermissionChecker(workDir, modeOverride ?? permMode)`（用形参避免 `setPermMode` 后同 tick 闭包过期）；`new Agent({ ...config, checker, onPermissionRequest })`。
- **`onPermissionRequest`** 实现：返回 `new Promise<...>((resolve) => { permissionResolveRef.current = resolve; setPermissionRequest({ toolName, argsSummary: formatToolArgs(args), reason: decision.reason }); })`。
- **`<PermissionDialog>`** 条件渲染：`permissionRequest && <PermissionDialog ... onComplete={(action) => { permissionResolveRef.current?.(action); permissionResolveRef.current = null; setPermissionRequest(null); }} />`。
- **`/permission` 命令**：在 `cmdRegistry` 注册时即可处理 `mode <name>` 子命令；裸 `/permission` 显示当前模式 + 提示。
- **`<InputBox>`** 接受 `permMode` 与 `onModeChange`，让输入框上方的模式徽标也响应同步、`useInput` 内同样检测 `\x1b[Z`（防 Ink focus 抢走）。
- **`<StatusBar>`** 接受 `mode={permMode}` prop 显示底部模式名。

### `src/tui/input.tsx` / `src/tui/status-bar.tsx`

- `input.tsx` 顶部 `modeDisplay: Record<string, {name, color}>`：`default→{name:"default",color:"gray"}`、`acceptEdits→{name:"Accept Edits",color:"green"}`、`plan→{name:"Plan",color:"yellow"}`、`bypassPermissions→{name:"YOLO",color:"red"}`。
- `input.tsx` 渲染：`permMode !== "default"` 时显示 `<Text color>Accept Edits on</Text><Text dimColor>(shift+tab to cycle)</Text>` 类信息行。
- `status-bar.tsx` 底部 `mode` + token 计数：`{ symbols.dot } default · 12.3K↓ 4.5K↑` 风格。

### `tests/permissions.test.ts`**职责：** 守护 Layer 2 元字符防御、Layer 3 危险命令拦截、`allowAlways` 持久化 + 重启加载、`extractContent` 各工具映射、规则范围（pattern 不会泛化到无关命令）。

**关键点（已存在的 6 个 it 用例）：**
- `safe-command metacharacter guard`：3 个 it（直接安全命令 allow / 管道 not allow / 重定向/链式/替换 not allow）。
- `dangerous commands`：1 个 it（`curl|sh` / `wget|bash` 都 deny）。
- `scoped + persisted allowAlways`：2 个 it（写盘 + 新 checker 加载生效 / pattern 不覆盖无关命令）。
- `content extraction`：1 个 it（Bash/ReadFile/Grep/Unknown 四种工具的 content 映射）。

## 模块交互（调用链）

```
main.tsx (render)
  └→ <App>
       ├ useState permMode, permissionRequest
       ├ useEffect process.stdin Shift+Tab listener
       └ runAgentLoop():
            const checker = new PermissionChecker(workDir, permMode)
            new Agent({ checker, onPermissionRequest, ... })
              └→ agent.runLoop()
                   └→ executeTools(toolUses) → partition → executeBatch(...)
                        ├ hookEngine.firePreToolHooks
                        ├ checker.check(toolName, category, args)
                        │   ├ Layer 0 plan-file-exception
                        │   ├ Layer 2 isSafeCommand
                        │   ├ Layer 3 detectDangerous
                        │   ├ Layer 4 sandbox.check
                        │   ├ Layer 4b sessionAllowed.has
                        │   ├ Layer 5 ruleEngine.evaluate
                        │   └ Layer 6 modeDecide
                        ├ if deny  → push tool_result(isError=true) + continue
                        ├ if ask   → await onPermissionRequest
                        │             ↓ setPermissionRequest + ref=resolve
                        │             ↓ <PermissionDialog>
                        │             ↓ ↑↓ Enter Esc 1/2/3
                        │             ↓ resolve("allow"|"allowAlways"|"deny")
                        │             ↓ if "allowAlways" → checker.allowAlways → ruleEngine.appendLocalRule
                        │                                                          └→ writeFileSync(local YAML)
                        └ if allow → executor.submit → 工具执行
```

## 文件组织

```text
mewcode/
├── src/
│   ├── permissions/
│   │   └── checker.ts            — 新增：所有判定逻辑（7 层 + 沙箱 + 规则引擎 + 持久化）
│   ├── tui/
│   │   ├── app.tsx               — 改：useState permMode/permissionRequest + Shift+Tab 监听 + /permission 命令 + Agent onPermissionRequest 桥
│   │   ├── permission-dialog.tsx — 新增：HITL 多行块组件
│   │   ├── input.tsx             — 改：modeDisplay 徽标 + 输入框内 \x1b[Z 双重保险
│   │   └── status-bar.tsx        — 改：底部状态栏 mode prop
│   ├── agent/
│   │   └── agent.ts              — 改：AgentConfig 加 checker/onPermissionRequest；executeBatch 接入 check + ask 桥接
│   └── tools/
│       └── types.ts              — 维持既有 ToolCategory: "read"|"write"|"command"
├── tests/
│   └── permissions.test.ts       — 新增：6 个 it 覆盖元字符/危险/持久化/extractContent
└── package.json                  — 维持 js-yaml + @types/js-yaml 依赖
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 判定落点 | 单文件 `src/permissions/checker.ts`，无子模块拆分 | 7 层逻辑彼此耦合度高、合在一处便于一眼读完；测试也只需一个 spec 文件 |
| 流水线短路 | 单方法 `check` 内 7 个 if early-return | 控制流直白，避免回调地狱；新增/移除一层只需插入/删除一段 |
| 危险命令不可配 | `DANGEROUS_PATTERNS` 为 const 数组 + 无加载入口 | N1：任何配置/模式都碰不到；bypass 也拦 |
| 危险命令完备性 | 启发式 14 条，覆盖最常见的灾难命令 | 无法穷尽所有危险，深度防御靠沙箱 + 模式兜底 + HITL 补 |
| 安全命令防元字符 | `isSafeCommand` 先扫 6 类元字符再匹配前缀 | N2：`cat … > /etc/shadow` 不能被白名单放过 |
| 沙箱解析 | `path.resolve` + `startsWith`（**不解析 symlink**） | 简单可读；symlink 是已知盲区，留给后续章节加固 |
| 沙箱 root | `[workDir, "/tmp"]` 两个 | `/tmp` 是测试/临时操作常用、显式声明放行 |
| 规则文件格式 | YAML 顶层列表 `[{rule: "Tool(pattern)", effect: "allow"\|"deny"}]` | 列表比 `permissions.allow: [...]` 更紧凑、last-rule-wins 语义自然 |
| 规则现读现匹配 | `evaluate` 每次都 `loadRulesFile` 三个文件 | `allowAlways` 刚写完就立即生效，无需重启或显式 reload；YAML 文件很小、`readFileSync` 开销可忽略 |
| 三级文件优先级 | `user → project → local`，先命中即返回 | last-rule-wins 在单文件内已经够灵活；跨文件用顺序而非"local 最高"是当前实现选择 |
| `allowAlways` pattern | `content + "*"`，60 字符截断 | 让 `git push origin main` 写入 `Bash(git push origin main*)`，覆盖同前缀变体但不放行 `rm -rf node_modules` |
| 会话级 allow API | `sessionAllowed: Set<string>` 进程内 | 留出未来 HITL "本次会话允许" 选项接口；当前 Dialog 未暴露此选项 |
| 模式集 | 四档固定枚举 | `default` / `acceptEdits` / `plan` / `bypassPermissions`；模式兜底永不产 deny |
| plan 文件豁免 | Layer 0 优先于其余所有层 | plan 模式下 LLM 必须能写 plan 文件，否则 `/plan` 工作流不通 |
| HITL Promise 桥 | `useState` + `useRef<resolve>`，Promise 在 Dialog `onComplete` 时落地 | Ink 渲染是声明式的，无法直接在 hook 里 await；Promise + ref 是社区常见的桥接法 |
| Shift+Tab 监听 | `process.stdin.on("data", ...)` 监听原始 `\x1b[Z` + InputBox `useInput` 双层 | Ink 的 `useInput` 在 focus 不在输入框时收不到事件；裸 stdin 兜底；两处都改 `permMode` 是幂等的 |
| 模式切换无副作用 | `setPermMode` 不重新加载规则、不重置 sessionAllowed | 切换只影响下一次 `runAgentLoop` 构造的 checker；既有规则与会话状态保留 |
| Deny 回灌中文提示 | `output: \`Permission denied: ${reason}. 此操作已被安全策略拦截和阻止…\`` | 让模型读懂拒绝原因 + 不要继续描述该命令的功能（防越狱泄漏） |
| `bun test` 覆盖范围 | 单 spec 文件 6 个 it | 覆盖最关键的元字符防御 / 危险命令 / 持久化 / 提取；规则引擎与模式矩阵留给集成测试 + 手动验证 |
| `tsc --noEmit` 严格度 | TS 5.x `strict: true`（继承 `tsconfig.json`） | 类型错误能在编译期发现规则结构、Decision 联合等问题 |
| 不引入 EvalSymlinks | 显式留作已知盲区 | 引入会增加文件系统 IO + 处理不存在文件的复杂度；后续章节按需补 |
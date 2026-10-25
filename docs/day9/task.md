# slash命令体系 Tasks

> 模块路径：`src/commands/`（新建）、`src/tui/app.tsx` / `src/tui/input.tsx`（改造）、`tests/command-loader.test.ts`（新建）。运行时：bun + TypeScript 5.x，严格模式。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/commands/commands.ts` | `CommandType` / `CommandContext` / `Command` / `CommandRegistry` / `parse` / `createDefaultRegistry` 一次性注册 16 条内置命令 |
| 新建 | `src/commands/loader.ts` | `loadUserCommands(workDir)` 扫两层目录、frontmatter 解析；`renderBody(body, args)` 渲染 prompt 命令 |
| 新建 | `src/commands/usage-tracker.ts` | `CommandUsageTracker` 类，JSON 文件持久化 + 衰减分数 + 最近使用排序 |
| 新建 | `tests/command-loader.test.ts` | bun:test 覆盖 frontmatter、`$ARGUMENTS` 替换、子目录命名空间三条核心路径 |
| 改造 | `src/tui/styles.ts` | 新增 `commandIcons` 映射（local/local_ui/skill_fork/prompt 对应 ⚙/⚙/★/◇） |
| 改造 | `src/tui/input.tsx` | 新增 `commands` 与 `usageTracker` props；接入 `filteredCmds` useMemo、ghost text、`showDropdown` 渲染块、↑↓/Tab/Enter/ESC 键位 |
| 改造 | `src/tui/app.tsx` | `cmdRegistryRef` / `usageTrackerRef` 实例化；`handleSlashCommand` 分发器；`wireSkillsToRegistry` 顶层函数；`initClient` 流程接入 `loadUserCommands` 与 `wireSkillsToRegistry`；InputBox props 透传 |

## 任务### T1: 定义命令类型与 Registry**文件**：`src/commands/commands.ts`

**依赖**：无

**步骤**：

1. 新建文件，导出 `type CommandType = "local" | "local_ui" | "prompt" | "skill_fork"`
2. 导出 `interface CommandContext`，字段：`workDir: string`、`args: string`、`conversation?: unknown`、`registry?: unknown`、`permissionMode?: () => string`、`tokenCount?: () => [number, number]`、`toolCount?: () => number`、`memoryList?: () => string[]`、`memoryClear?: () => void`、`model?: string`
3. 导出 `interface Command`，字段：`name: string`、`aliases: string[]`、`type: CommandType`、`description: string`、`handler: (ctx: CommandContext) => string`
4. 实现 `class CommandRegistry`：私有 `commands = new Map<string, Command>()`、`aliasMap = new Map<string, string>()`
5. `register(cmd: Command): void`：依次做四道冲突检查，命中即 `throw new Error("...")`，错误信息嵌入具体冲突字符串；通过后 `commands.set(cmd.name, cmd)`，遍历 `aliases` 写 `aliasMap.set(alias, cmd.name)`
6. `hasConflict(cmd: Command): boolean`：`find(cmd.name)` 命中或任一 alias `find` 命中即返回 true
7. `find(name: string): Command | undefined`：先 `commands.get(name)`；落空则 `commands.get(aliasMap.get(name) ?? "")`
8. `complete(prefix: string): Command[]`：prefix lower 后遍历 `commands.values()`，name 或任一 alias 以 prefix lower 开头的入选
9. `listCommands(): Command[]`：`[...commands.values()].sort((a,b) => a.name.localeCompare(b.name))`

**验证**：`bunx tsc --noEmit` 无类型错误

### T2: 实现 parse 纯函数**文件**：`src/commands/commands.ts`（同 T1）

**依赖**：T1

**步骤**：

1. 在同文件导出 `function parse(input: string): { name: string; args: string } | null`
2. `if (!input.startsWith("/")) return null`
3. `const trimmed = input.slice(1).trim()`
4. `const spaceIdx = trimmed.indexOf(" ")`
5. `if (spaceIdx === -1) return { name: trimmed, args: "" }`
6. 返回 `{ name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }`

**验证**：可在 REPL 或临时测试中验证 `parse("/help")` / `parse("/help foo bar")` / `parse("hi")` 的返回

### T3: 实现 createDefaultRegistry —— 16 条内置命令**文件**：`src/commands/commands.ts`（同 T1）

**依赖**：T1、T2

**步骤**：

1. 导出 `function createDefaultRegistry(): CommandRegistry`
2. 内部 `const registry = new CommandRegistry()`
3. 按以下顺序 16 次 `registry.register({...})`，每条 `Command` 字面量含 4 个字段：
   - `help`（aliases: `["h", "?"]`，type: `local`）：handler 闭包捕获 `registry`，`args` 非空时按 `registry.find(args)` 返回单条详情；为空时遍历 `registry.listCommands()` 输出 `Available commands:\n\n` + 每行 `  /name, /alias...\n    description`
   - `clear`（aliases: `[]`，type: `local_ui`）：handler `() => "clear"`
   - `compact`（aliases: `["c"]`，type: `local_ui`）：handler `() => "compact"`
   - `status`（aliases: `["s"]`，type: `local`）：handler 从 ctx 读 permissionMode/tokenCount/toolCount/memoryList/model/workDir 拼 6 行；缺哪个回调就跳过哪行
   - `session`（aliases: `[]`，type: `local`）：handler 返回固定字符串 `"Session is active. Use /resume to list past sessions."`
   - `plan`（aliases: `["p"]`，type: `local_ui`）：handler `() => "plan"`
   - `resume`（aliases: `["r"]`，type: `local_ui`）：handler `() => "resume"`
   - `quit`（aliases: `["exit", "q"]`，type: `local_ui`）：handler `() => "quit"`
   - `memory`（aliases: `[]`，type: `local`）：handler `() => "memory"`（实际渲染由 dispatcher 特殊路径处理）
   - `permission`（aliases: `["perm"]`，type: `local`）：handler `() => "permission"`（实际渲染由 dispatcher 特殊路径处理）
   - `skills`（aliases: `[]`，type: `local_ui`）：handler `() => "skills"`
   - `worktree`（aliases: `["wt"]`，type: `local_ui`）：handler `() => "worktree"`
   - `code-review`（aliases: `["cr"]`，type: `local`）：handler 检查 `ctx.args.trim()`，空时返回 usage 文本，否则返回 `code-review:<args>` 让 dispatcher 后续 split
   - `review`（aliases: `[]`，type: `prompt`）：handler 返回 `"Review the current uncommitted changes. Run \`git status\` and \`git diff\` to see them, ..."`，若 `ctx.args` 非空附加 `\n\nFocus on: <args>`
   - `rewind`（aliases: `[]`，type: `local_ui`）：handler `() => "rewind"`
   - `mcp`（aliases: `[]`，type: `local`）：handler `() => "mcp"`（dispatcher 顶部短路）
4. `return registry`

**验证**：写一段临时 `bun -e 'import("./src/commands/commands.js").then(m => console.log(m.createDefaultRegistry().listCommands().map(c => c.name)))'`，应输出 16 个名字按字母序

### T4: 实现 loader.ts**文件**：`src/commands/loader.ts`

**依赖**：T1（用 `Command` 类型）

**步骤**：

1. 顶部 import `readdirSync, readFileSync, statSync, existsSync` from `node:fs`；`join` from `node:path`；`homedir` from `node:os`；`yaml from "js-yaml"`；`type { Command } from "./commands.js"`
2. 实现 `export function loadUserCommands(workDir: string): Command[]`：维护 `Map<string, Command>`，先后扫 `~/.mewcode/commands`、`<workDir>/.mewcode/commands`，每个目录调 `walkDir` 后 `byName.set(cmd.name, cmd)` 让后者覆盖前者，返回 `[...byName.values()]`
3. 实现 `function walkDir(base: string, dir: string): Command[]`：`readdirSync` try/catch 返回空；每个 entry `statSync` try/catch 跳过；目录递归、`.md` 文件调 `parseCommandFile`
4. 实现 `function commandName(base, full): string`：减去 base + `/`、去 `.md` 后缀、按 `/\\` 切段、每段 `lower` + 空格替换 `-`、`:` 连接
5. 实现 `function parseCommandFile(base, full): Command | null`：`readFileSync` try/catch 返回 null；若以 `---` 起头查找下一个 `---`，中间段调 `yaml.load` 读 `description` / `argument-hint` / `aliases` 字段；frontmatter 解析失败时整文件作 body；返回 `{ name, aliases, type: "prompt", description, handler: ctx => renderBody(body, ctx.args) }`
6. 实现 `export function renderBody(body: string, args: string): string`：含 `$ARGUMENTS` 全量替换；不含但 args 非空时 `body + "\n\n" + args`；都不满足返回 body

**验证**：`bunx tsc --noEmit` 通过

### T5: 实现 usage-tracker.ts**文件**：`src/commands/usage-tracker.ts`

**依赖**：无

**步骤**：

1. import `readFileSync, writeFileSync, mkdirSync, existsSync` from `fs`；`join, dirname` from `path`
2. 定义 `interface UsageEntry { usageCount: number; lastUsedAt: number; }`
3. 实现 `class CommandUsageTracker`：私有 `usage = new Map<string, UsageEntry>()` 与 `filePath: string`
4. 构造函数 `constructor(workDir: string)`：拼 `<workDir>/.mewcode/command_usage.json`；目录不存在则 `mkdirSync({ recursive: true })`；调 `this.load()`
5. `record(name)`：读 existing，更新 `usageCount: (existing?.usageCount ?? 0) + 1`、`lastUsedAt: Date.now()`；调 `save()`
6. `getScore(name)`：无 entry 返回 0；`daysSince = (now - lastUsedAt) / 86400000`；`recency = Math.pow(0.5, daysSince/7)`；`return usageCount * Math.max(recency, 0.1)`
7. `getRecentlyUsed(limit = 5)`：`[...usage.entries()].map(...).filter(score>0).sort(desc).slice(0, limit).map(name)`
8. 私有 `load()`：try `JSON.parse(readFileSync(...))` 然后逐条 set；任意错误吞掉
9. 私有 `save()`：try `mkdirSync(dirname)` + `writeFileSync(JSON.stringify(Object.fromEntries(usage), null, 2))`；错误吞掉

**验证**：`bunx tsc --noEmit` 通过；手工跑 `bun -e 'const { CommandUsageTracker } = await import("./src/commands/usage-tracker.js"); const t = new CommandUsageTracker(".mewcode-test"); t.record("help"); console.log(t.getScore("help"));'` 应输出 1

### T6: 写 command-loader 单测**文件**：`tests/command-loader.test.ts`

**依赖**：T4

**步骤**：

1. import `describe, it, expect` from `bun:test`；`mkdtempSync, mkdirSync, writeFileSync` from `node:fs`；`tmpdir` from `node:os`；`join` from `node:path`
2. import `loadUserCommands, renderBody` from `"../src/commands/loader.js"`
3. 写 `cmdDir(): string` helper 用 `mkdtempSync` 创建临时目录并预建 `.mewcode/commands/` 子目录
4. 测试 1：写入 `deploy.md` 含 frontmatter 与 `$ARGUMENTS`，断言加载后命令的 name/description/aliases/type，且 handler({workDir, args: "staging"}) 替换后等于 `"Deploy staging to production."`
5. 测试 2：在 `git/sync.md` 子目录写 md，断言加载后 name === `"git:sync"`
6. 测试 3：直接调 `renderBody`，覆盖 `$ARGUMENTS` 替换、末尾拼接、无参数三种情况

**验证**：`bun test tests/command-loader.test.ts` 三个 case 全绿

### T7: 在 styles.ts 增加 commandIcons 映射**文件**：`src/tui/styles.ts`

**依赖**：无

**步骤**：

1. 在 `symbols` 常量之后导出 `export const commandIcons: Record<string, string> = { local: "⚙", local_ui: "⚙", skill_fork: "★", prompt: "◇" }`

**验证**：`bunx tsc --noEmit` 通过

### T8: 改造 InputBox 加入命令补全**文件**：`src/tui/input.tsx`

**依赖**：T1、T5、T7

**步骤**：

1. 新增 import `Fuse from "fuse.js"`；`brand, symbols, commandIcons, borderColors from "./styles.js"`；`type { Command } from "../commands/commands.js"`；`type { CommandUsageTracker } from "../commands/usage-tracker.js"`
2. `Props` 接口新增可选字段：`commands?: Command[]`、`usageTracker?: CommandUsageTracker`
3. 解构 props 时给默认值：`commands = []`
4. 增 state：`const [dropdownIndex, setDropdownIndex] = useState(0)`、`const [dropdownDismissed, setDropdownDismissed] = useState(false)`
5. 写 `useMemo` 计算 `{ filteredCmds, recentCount }`，依赖 `[lines, commands, isMultiline, usageTracker]`：
   - first = lines[0]，非 `/` 起头或 isMultiline → 返回空与 recentCount=0
   - query = first.slice(1).toLowerCase()
   - query 含空格 → 返回空
   - query 为空：有 usageTracker 时按 `getRecentlyUsed(5)` 把 recent 命令排前面，rest 排后面；无 tracker 时返回 commands 全集
   - query 非空：5 层 Tier 顺序合并去重（用 `Set<string>` 防重）；Tier 5 用 Fuse.js 实例 `keys: [{name:"name",weight:3},{name:"aliases",weight:2},{name:"description",weight:0.5}]`, `threshold: 0.4`
6. 写 `showDropdown = filteredCmds.length > 0 && lines[0].startsWith("/") && !isMultiline && !dropdownDismissed`
7. 在 `useInput` 钩子里：
   - Escape 分支顶部加 `if (showDropdown) { setDropdownDismissed(true); setDropdownIndex(0); return; }`
   - hasReturn 分支：若 showDropdown 且 filteredCmds 非空，把选中命令写回 `setLines(["/" + selected.name + " "])`、`setDropdownIndex(0)`、return（不调 onSubmit）
   - Tab 分支同理处理 showDropdown 情况
   - upArrow / downArrow 分支顶部加 showDropdown 检查，命中则切 dropdownIndex 不切 cursor
   - cleanInput 字符插入分支结尾加 `setDropdownIndex(0); setDropdownDismissed(false)`
8. 写 `ghostText` useMemo：仅当首字符 `/` 且第一候选 name lower 以输入 lower 开头时返回剩余后缀
9. JSX 改造：在原 `<Box borderStyle>` 之后插入 `{showDropdown && <Box flexDirection="column">...}` 块，含 `RECENTLY USED` / `ALL COMMANDS` 段头与 `slice(0, 8)` 候选行；每行 icon 从 `commandIcons[cmd.type]` 取
10. 输入框内追加 `{ghostText && <Text dimColor>{ghostText}</Text>}`

**验证**：`bunx tsc --noEmit` 通过；`bun run src/main.tsx` 启动 TUI 后按 `/` 看到菜单出现

### T9: app.tsx 实例化 cmdRegistry / usageTracker 并接入 wireSkillsToRegistry**文件**：`src/tui/app.tsx`

**依赖**：T3、T5

**步骤**：

1. 顶部新增 import：
   ```ts
   import { parse as parseCommand, createDefaultRegistry as createCommandRegistry, type CommandRegistry, type Command } from "../commands/commands.js";
   import { loadUserCommands } from "../commands/loader.js";
   import { CommandUsageTracker } from "../commands/usage-tracker.js";
   ```
2. 在组件顶部 useRef 区新增：`const cmdRegistryRef = useRef(createCommandRegistry())`、`const usageTrackerRef = useRef(new CommandUsageTracker(workDir))`
3. 在 `App` 上方实现 `function wireSkillsToRegistry(catalog, cmdRegistry, skillHost)`：
   - 遍历 `catalog.list()`
   - `if (cmdRegistry.find(meta.name)) continue` 短路
   - skill 为 fork mode 时 `type: "skill_fork"`、handler `() => ""`
   - 否则 `type: "prompt"`、handler 调 `runSkillInline(skill, ctx.args, skillHost)`
   - description 末尾追加 `[skill]`
   - try `cmdRegistry.register(cmd)` catch 静默
4. 在 `initClient` 中 SkillCatalog.load 之后加入：
   - `for (const cmd of loadUserCommands(workDir)) { try { cmdRegistryRef.current.register(cmd); } catch {} }`
   - `wireSkillsToRegistry(catalog, cmdRegistryRef.current, skillHostRef.current)`
5. 在 `InstallSkillTool` 的 `onInstalled` 回调内再调一次 `wireSkillsToRegistry`，让新装的 skill 立刻可用
6. 在 `<InputBox ... />` 元素上加 props：`commands={cmdRegistryRef.current.listCommands()}`、`usageTracker={usageTrackerRef.current}`

**验证**：`bunx tsc --noEmit` 通过

### T10: 实现 handleSlashCommand 分发器**文件**：`src/tui/app.tsx`（同 T9）

**依赖**：T9

**步骤**：

1. 在 `App` 内（`handleSubmit` 之前）新增 `const handleSlashCommand = async (text: string): Promise<boolean> => { ... }`
2. 顶部 `let parsed = parseCommand(text); if (!parsed) return false`
3. `/mcp` 顶部短路分支：若 `parsed.name === "mcp"`，按 `mcpInfo.servers` 拼若干行 push 到 messages，`usageTrackerRef.current.record("mcp")`，`return true`
4. `/skill <name>` 重写分支：若 `parsed.name === "skill" && parsed.args.trim()`，拆 `parts`，把 parsed 改为 `{ name: parts[0], args: parts.slice(1).join(" ") }`
5. `const cmd = cmdRegistryRef.current.find(parsed.name); if (cmd) usageTrackerRef.current.record(cmd.name)`
6. 未命中：`setMessages(prev => [...prev, { role: "system", content: \`Unknown command: /\${parsed.name}\` }])`；`return true`
7. `/status` 特殊分支：拼 10 行 key:value（Mode/Model/Provider/Tokens/Tools/Memories/Skills/MCP/Session/Directory），push 后 return
8. `/permission` 特殊分支：解析 `parts`，`parts[0]==="mode" && parts[1] in modes` 时 `setPermMode(parts[1])` + system 消息；否则 push 当前模式与切换说明
9. `/memory` 特殊分支：sub === "clear" 时 `new MemoryManager(workDir).clear()` 然后 system 提示；否则列出 `getMemories()` 条目
10. 按 `cmd.type` 走四分支：
    - `local`：`output = cmd.handler({...}); setMessages(prev => [...prev, { role: "system", content: output }])`
    - `local_ui`：`action = cmd.handler({...})`，进 `switch(action)` 处理 `clear`/`quit`/`plan`/`do`/`compact`/`resume`/`skills`/`worktree`/`rewind` 共 9 个 case
    - `prompt`：守卫 `clientRef.current`，`promptText = cmd.handler({...})`；`setMessages(... user)`；`convRef.current.addUserMessage(promptText)`；`sessionMod.saveMessage(...)`；`setIsStreaming(true)`；调 `runAgentLoop().then(...).catch(...)`
    - `skill_fork`：从 `skillCatalogRef.current.get(parsed.name)` 取 skill，构造 `SkillForkHost`（含 `runSubAgent`、`snapshotParentMessages`）；调 `runSkillFork(skill, parsed.args, forkHost).then(result => push assistant 消息)`
11. 在 `handleSubmit` 内的 slash 分支调用 `await handleSlashCommand(text)`，命中即 return

**验证**：`bunx tsc --noEmit` 通过；`bun run src/main.tsx` 实跑 `/help` / `/status` / `/clear` / `/foobar` 看输出符合预期

### T11: 端到端验证**文件**：无（运行可执行文件）

**依赖**：T10

**步骤**：

1. `bun test` 全套测试，包含新加的 `tests/command-loader.test.ts`
2. `bunx tsc --noEmit` 整仓零错误
3. 启动 `bun run src/main.tsx`：
   - 按 `/` 看到补全菜单含至少 16 条
   - 输入 `/s` 看到候选过滤为 status/session/skills 等
   - 按 ↓ Enter 选 `/status` 看输出 10 行 key:value
   - 跑 `/help compact`、`/permission mode plan`、`/clear`、`/review`、`/foobar`、`/help`
   - 在 `.mewcode/commands/test.md` 放 `---\ndescription: Test\n---\nHello $ARGUMENTS!` 重启后跑 `/test world` 看输出 `Hello world!`
4. 全部通过

**验证**：按 `checklist.md` 全部勾选

## 执行顺序

```text
T1 (commands.ts 基础) ──► T2 (parse) ──► T3 (createDefaultRegistry)
                                              │
T4 (loader.ts) ─────────────────────────────► │
T5 (usage-tracker.ts) ──────────────────────► │
T7 (styles.ts commandIcons) ────────────────► │
                                              ▼
T6 (loader 单测) ──────────► T8 (input.tsx 补全)
                                              │
                                              ▼
                                         T9 (app.tsx wire) ──► T10 (handleSlashCommand) ──► T11 (端到端)
```

- T1 是基础，必须先做；T2 / T3 在同文件内顺序追加
- T4 / T5 / T7 互不依赖，可与 T2 / T3 并行（但都属于同一开发会话，建议按列表顺序写）
- T6 在 T4 后写，命令加载器是该期最简单的纯函数单测目标
- T8 改 `input.tsx`，依赖 T1（`Command` 类型）、T5（`CommandUsageTracker` 类型）、T7（icon 映射）
- T9 → T10 是 app 改造的严格串行：先实例化再写分发器
- T11 端到端依赖整条链路完工
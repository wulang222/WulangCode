# slash命令体系 Plan## 技术栈

- 运行时：bun（直接执行 `.tsx`，无独立编译步骤）
- 语言：TypeScript 5.x，严格模式（`strict: true`）
- TUI：Ink 5.x + React 18，输入框通过 `useInput` 钩子拿到原始按键
- 状态管理：React hooks，`useState` / `useRef` / `useMemo` / `useEffect`
- 模糊匹配：fuse.js（命令补全的 Tier 5 兜底）
- YAML 解析：js-yaml（用户命令 frontmatter）
- 终端样式：chalk + Ink 的内置颜色 prop
- 测试：bun test（`tests/command-loader.test.ts` 走 `bun:test`）
- 类型检查：`tsc --noEmit`

## 架构概览

```
┌────────────────────────────────────────────────────────────────────┐
│                          src/tui/app.tsx                           │
│                                                                    │
│  handleSubmit(text)                                                │
│    │                                                               │
│    ├─► text.startsWith("/") ─► handleSlashCommand(text)            │
│    │      │                                                        │
│    │      ├─► parseCommand(text) → { name, args } | null           │
│    │      │                                                        │
│    │      ├─► /mcp 短路：读 mcpInfo 直接 push system 消息          │
│    │      │                                                        │
│    │      ├─► /skill <name> 别名展开：parsed 重写                  │
│    │      │                                                        │
│    │      ├─► cmdRegistry.find(name)                               │
│    │      │      │                                                 │
│    │      │      ├─► 未命中 → push "Unknown command" system 消息   │
│    │      │      │                                                 │
│    │      │      └─► 命中 → usageTracker.record(name)              │
│    │      │             │                                          │
│    │      │             ├─► /status /permission /memory 走 app     │
│    │      │             │   内特殊分支（读实时状态后输出）         │
│    │      │             │                                          │
│    │      │             └─► 按 cmd.type 走 4 分支：                │
│    │      │                  local      → push handler 字符串      │
│    │      │                  local_ui   → switch 动作字符串触发    │
│    │      │                              副作用                    │
│    │      │                  prompt     → 注入 user 消息 + 跑 turn │
│    │      │                  skill_fork → runSkillFork(...)        │
│    │      │                                                        │
│    │      └─► return true (消费)                                   │
│    │                                                               │
│    └─► return false → 走 LLM 用户消息路径                          │
│                                                                    │
│  <InputBox commands={...} usageTracker={...} />                    │
│       │                                                            │
│       └─► 实时 ghost text + 5-tier 排序 + Fuse 补全 + 上下/Tab/ESC │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ 导入
                              │
┌────────────────────────────────────────────────────────────────────┐
│                       src/commands/ (新模块)                       │
│                                                                    │
│  commands.ts                                                       │
│    ├─► CommandType / CommandContext / Command 类型                 │
│    ├─► CommandRegistry 类（register/hasConflict/find/complete/list）│
│    ├─► parse(input) 纯函数                                          │
│    └─► createDefaultRegistry()：注册 16 条内置命令                  │
│                                                                    │
│  loader.ts                                                          │
│    ├─► loadUserCommands(workDir)：扫两层目录、解析 frontmatter      │
│    └─► renderBody(body, args)：$ARGUMENTS 替换 / 末尾拼接           │
│                                                                    │
│  usage-tracker.ts                                                   │
│    └─► CommandUsageTracker：record/getScore/getRecentlyUsed         │
│         + JSON 文件持久化到 .mewcode/command_usage.json             │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ 拉取数据
                              │
┌────────────────────────────────────────────────────────────────────┐
│  SkillCatalog / wireSkillsToRegistry (app.tsx 顶层函数)            │
│    每次 initClient 或 InstallSkill 回调把 catalog.list() 注册成     │
│    prompt / skill_fork 命令，遇 name 已存在则静默跳过               │
└────────────────────────────────────────────────────────────────────┘
```

- 新建 `src/commands/`：纯领域模块，不依赖 Ink、不依赖 React
- 既有 `src/tui/app.tsx`：作为分发器实现 `handleSlashCommand`、做 `/mcp` 与 `/status` 等需要实时状态的特殊分支、把 `local_ui` 动作字符串映射为副作用
- 既有 `src/tui/input.tsx`：补全菜单完全在 `InputBox` 里实现，只读 registry 提供的 `listCommands()` 数组与 `usageTracker` 提供的最近使用列表

## 数据流### 一次 `/help` 命令的完整路径

```
用户按 Enter
  ↓
useInput 钩子里 hasReturn 分支命中 onSubmit(value)
  ↓
handleSubmit("/help")
  ├─► historyMod.append + setPromptHistory
  ├─► text.startsWith("/") → handleSlashCommand("/help")
  │      ├─► parseCommand("/help") = { name: "help", args: "" }
  │      ├─► /mcp 检查 → 跳过
  │      ├─► /skill 检查 → 跳过
  │      ├─► cmdRegistry.find("help") = Command(name=help, type=local)
  │      ├─► usageTracker.record("help")
  │      ├─► /status 等特殊分支 → 跳过
  │      ├─► cmd.type === "local" 分支
  │      │      ├─► output = cmd.handler({ workDir, args: "" })
  │      │      │      （此 handler 闭包捕获 registry，调 registry.listCommands()
  │      │      │       拼出 `Available commands:\n\n  /help, /h, /?\n    Show available commands\n...`）
  │      │      └─► setMessages([..., { role: "system", content: output }])
  │      └─► return true
  └─► handleSubmit 早返回，不走 LLM 路径
```

### 一次 `/review` 命令的完整路径

```
handleSubmit("/review")
  └─► handleSlashCommand("/review")
        ├─► parseCommand → { name: "review", args: "" }
        ├─► cmdRegistry.find("review") = Command(type=prompt)
        ├─► cmd.type === "prompt" 分支
        │      ├─► promptText = cmd.handler({ workDir, args: "" })
        │      │       （返回 "Review the current uncommitted changes. Run `git status`..."）
        │      ├─► setMessages([..., { role: "user", content: promptText }])
        │      ├─► convRef.current.addUserMessage(promptText)
        │      ├─► sessionMod.saveMessage(...)
        │      ├─► setIsStreaming(true) / setStreamingText("")
        │      └─► runAgentLoop().then(...) / catch(...)
        └─► return true
```

### 一次补全菜单交互（输入 `/s`）

```
按下 "/"
  ↓
useInput cleanInput 分支 → setLines(["/"])
  ↓
useMemo 重算 filteredCmds：
  - first = "/", isMultiline = false
  - query = "" → 走 usageTracker 路径，返回 recent + rest 全集
  ↓
showDropdown = true，菜单渲染 8 行候选
  ↓
按下 "s"
  ↓
setLines(["/s"])
  ↓
useMemo 重算 filteredCmds：
  query = "s"
  Tier 1 (exact name): 无
  Tier 2 (exact alias): /status (alias=s), /compact (alias=c) ← s≠c 不进
  Tier 3 (prefix name): /status, /session, /skills
  Tier 4 (prefix alias): /quit (alias 含 q 不进), ...
  Tier 5 (Fuse fuzzy): 把所有 description 含 "s" 的兜底进来
  去重后渲染 slice(0,8)
  ↓
按 ↓
  ↓
setDropdownIndex((i) => (i < filteredCmds.length - 1 ? i + 1 : 0))
  ↓
按 Enter
  ↓
setLines(["/" + selected.name + " "])
（用户可继续打参数或再按 Enter 提交）
```

## 核心数据结构与接口### `CommandType`

```ts
export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";
```

### `CommandContext`

dispatcher 调 handler 时传入的上下文；handler 通过它读 workDir、参数、以及若干可选回调。

```ts
export interface CommandContext {
  workDir: string;
  args: string;
  conversation?: unknown;
  registry?: unknown;
  permissionMode?: () => string;
  tokenCount?: () => [number, number];
  toolCount?: () => number;
  memoryList?: () => string[];
  memoryClear?: () => void;
  model?: string;
}
```

### `Command`

```ts
export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  handler: (ctx: CommandContext) => string;
}
```

### `CommandRegistry`

```ts
export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, string>();

  register(cmd: Command): void;          // 冲突时抛 Error
  hasConflict(cmd: Command): boolean;    // 动态加载器在 register 前预检
  find(name: string): Command | undefined;
  complete(prefix: string): Command[];   // 大小写不敏感，name 或 alias 前缀
  listCommands(): Command[];             // 按 name.localeCompare 排序
}
```

### `parse`

```ts
export function parse(input: string): { name: string; args: string } | null;
// "/foo bar baz" → { name: "foo", args: "bar baz" }
// "/foo"          → { name: "foo", args: "" }
// "/"             → { name: "", args: "" }
// "hello"         → null
```

### `CommandUsageTracker`

```ts
interface UsageEntry { usageCount: number; lastUsedAt: number; }

export class CommandUsageTracker {
  constructor(workDir: string);            // 自动 mkdir + 加载已有 JSON
  record(name: string): void;              // 累加 count + 刷新 lastUsedAt + 写盘
  getScore(name: string): number;          // count × max(0.5^(daysSince/7), 0.1)
  getRecentlyUsed(limit?: number): string[]; // 按 score 降序 截断
}
```

### `loadUserCommands` / `renderBody`

```ts
export function loadUserCommands(workDir: string): Command[];
// 遍历 ~/.mewcode/commands 与 <workDir>/.mewcode/commands
// 子目录路径以 ":" 命名空间化
// 后扫到的同名条目覆盖前者（项目级覆盖用户级）

export function renderBody(body: string, args: string): string;
// 含 $ARGUMENTS：全量替换
// 不含但 args 非空：body + "\n\n" + args
// 无 args：返回 body
```

## 模块设计### `src/commands/commands.ts`**职责**：定义命令类型、`CommandRegistry` 类、`parse` 函数、`createDefaultRegistry` 工厂；不依赖 Ink、不依赖任何 TUI 类型。

**对外接口**：上面列出的类型与函数。

**关键实现细节**：
- `register` 做四道冲突检查：commands.has(name) → "already registered"、aliasMap.has(name) → "collides with alias of ..."、commands.has(alias) → "collides with existing command name"、aliasMap.has(alias) → "already registered by ..."
- `find(name)` 同时查 commands 与 aliasMap，避免大小写敏感问题（按设计 store 时不做 lower，原样存）
- `complete(prefix)` 把 prefix 转 lower 再做 `startsWith`，覆盖 name 与每个 alias
- `createDefaultRegistry()` 内部按字母序调 16 次 `registry.register({...})`，每次 inline 字面量传完整的 4 个字段；`/help` 的 handler 通过闭包捕获 `registry` 自身实现"列出全部"

**依赖**：无外部依赖（仅标准 `Map`）

### `src/commands/loader.ts`**职责**：解析 `.mewcode/commands/*.md` 为 `Command[]`；为 dispatcher 渲染最终 prompt 提供 `renderBody` 工具函数。

**对外接口**：`loadUserCommands(workDir)`、`renderBody(body, args)`

**关键实现细节**：
- `walkDir(base, dir)` 递归 `readdirSync` + `statSync`；只收 `.md` 后缀；每层 try/catch 吞掉单文件错误
- `commandName(base, full)` 把绝对路径减去 base 再去 `.md` 后缀，分隔符按 `[/\\]` 切分，每段 lower + 空格替换 `-`，再用 `:` 拼接
- `parseCommandFile` 看到 `---\n` 起头时尝试解析 frontmatter；`yaml.load` 抛出时整文件作 body 不再拆，命令仍能注册
- handler 闭包捕获 `body`，调用时调 `renderBody(body, ctx.args)`，所有用户命令一律标 `type: "prompt"`

**依赖**：`node:fs`、`node:path`、`node:os`、`js-yaml`、同目录 `commands.ts` 的 `Command` 类型

### `src/commands/usage-tracker.ts`**职责**：把命令使用频次持久化到 `.mewcode/command_usage.json`，提供 `getRecentlyUsed` 给补全菜单的空 query 排序。

**对外接口**：`CommandUsageTracker` 类。

**关键实现细节**：
- 构造函数 `mkdirSync(dir, { recursive: true })` + `load()` 读 JSON；读取失败视为空 Map
- `record` 同步调 `save()` 写 JSON，写失败吞错（避免阻塞 UI）
- `getScore` 用每 7 天衰减 50%、地板 0.1 的指数衰减；首次使用得 1 分，一周前用过的得 0.5 分
- `getRecentlyUsed` 过滤 score>0 再排序，保护尚未启用 tracker 的早期使用场景

**依赖**：`node:fs`、`node:path`

### `src/tui/input.tsx` 改造点**职责**：在原本承载 `@<file>` 补全的同一份输入框组件里追加 `/<command>` 补全菜单。

**关键实现细节**：
- 新增 props：`commands: Command[]`、`usageTracker?: CommandUsageTracker`
- `filteredCmds` 用 `useMemo` 缓存，依赖 `[lines, commands, isMultiline, usageTracker]`
- `showDropdown = filteredCmds.length > 0 && lines[0].startsWith("/") && !isMultiline && !dropdownDismissed`
- `useInput` 钩子内：Escape 优先关菜单（设 `dropdownDismissed=true`）、Up/Down 在菜单激活时改 `dropdownIndex` 不切 cursor、Enter/Tab 在菜单激活时把 `"/" + selected.name + " "` 写回 lines[0]
- `ghostText` 仅在第一候选 name 以 query lower 开头时才显示，避免误导
- 渲染层加 `<Box flexDirection="column">` 包住 8 行候选，且分组段头 `RECENTLY USED` / `ALL COMMANDS` 用 `<Text dimColor>`

**依赖**：`ink`、`react`、`fuse.js`、`../commands/commands.js` 的 `Command` 类型、`../commands/usage-tracker.js`

### `src/tui/app.tsx` 改造点**职责**：把 `CommandRegistry` 与 `CommandUsageTracker` 实例化为 ref，实现 `handleSlashCommand` 异步分发器，把 `local_ui` 动作字符串映射到 React 状态变更。

**关键实现细节**：
- 顶层 useRef 三处：`cmdRegistryRef = useRef(createCommandRegistry())`、`usageTrackerRef = useRef(new CommandUsageTracker(workDir))`、`registryRef`（这是 tool registry，与 cmd registry 同名易混，注意区分）
- `initClient` 流程里在加载 user commands 后调一次 `wireSkillsToRegistry`
- `handleSlashCommand` 在以下三种情况短路：`parsed === null` 返回 false；`parsed.name === "mcp"` 自己 push；`/status` / `/permission` / `/memory` 在 dispatcher 内特殊处理而不调 handler 返回值（因为这些命令的输出依赖 React state，handler 拿不到）
- `local_ui` 的 `switch(action)` 12 个 case 对应 `clear` / `quit` / `plan` / `do` / `compact` / `resume` / `skills` / `worktree` / `rewind` 等动作；每个 case 内调 `setMessages` / `setPermMode` / `exit()` 等
- `prompt` 分支：必有 client 守卫；同步 `setMessages` + `convRef.addUserMessage` + `sessionMod.saveMessage`，然后 `runAgentLoop().then(...).catch(...)`
- `skill_fork` 分支：从 `skillCatalogRef` 取 skill，构造 `SkillForkHost` 含 `runSubAgent`、`snapshotParentMessages`，调 `runSkillFork`，结果作为 assistant 消息 push 回 messages

**依赖**：`../commands/commands.js`、`../commands/loader.js`、`../commands/usage-tracker.js`、各种现有 TUI / Agent / Skill 模块

### `tests/command-loader.test.ts` 改造点**职责**：bun:test 形式覆盖 `loadUserCommands` 的三条核心路径——frontmatter 解析、`$ARGUMENTS` 替换、子目录命名空间。

**依赖**：`bun:test`、`node:fs`、`node:os`、`node:path`、`../src/commands/loader.js`

## 模块交互### 启动期注册顺序

```
main.tsx 启动
  ↓
<App /> 挂载
  ↓
useRef 立即执行 createCommandRegistry()
  → 注册 16 条内置命令（同步）
  ↓
useEffect → initClient(provider)
  ↓ 异步流程：
  1. detectEnvironment / buildSystemPrompt / createClient
  2. memMgr 注入 long-term memory
  3. 加载 hooks
  4. SkillCatalog.load(workDir)
  5. registryRef（tool registry）注册若干 tool（LoadSkill / InstallSkill / AskUser / Team* / Agent）
  6. for cmd of loadUserCommands(workDir):
        cmdRegistry.register(cmd)
        try/catch → 内置已占名则静默跳过
  7. wireSkillsToRegistry(catalog, cmdRegistry, skillHost)
        for skill of catalog.list():
            if cmdRegistry.find(name) → 跳过
            else 按 mode 注册为 prompt 或 skill_fork
```

### 运行期补全菜单 → 命令分发

```
用户敲 "/"
  ↓
useInput 拿到 "/" → setLines(["/"])
  ↓
useMemo filteredCmds 重算：
  - usageTracker.getRecentlyUsed(5) → recentNames
  - recent = commands.filter(c => recentNames.has(c.name))
  - rest = commands.filter(c => !recentNames.has(c.name))
  - return [...recent, ...rest], recentCount = recent.length
  ↓
渲染：RECENTLY USED 段 + ALL COMMANDS 段
  ↓
用户继续敲字符或按 ↑↓ 选项
  ↓
用户按 Enter
  ↓
useInput 的 hasReturn 分支：
  - showDropdown && filteredCmds 非空
  - selected = filteredCmds[dropdownIndex]
  - setLines(["/" + selected.name + " "])
  ↓
（用户再次按 Enter 提交完整命令；或先打参数）
  ↓
useInput hasReturn：showDropdown 这次为 false（query 包含空格）
  → onSubmit(value) → app.handleSubmit
  → handleSlashCommand 走前述流程
```

### `InstallSkill` 工具触发的动态扩展

```
LLM 调 InstallSkillTool 安装 skill
  ↓
工具回调 onInstalled() 被触发
  ↓
wireSkillsToRegistry(catalog, cmdRegistry, skillHost)
  ↓
新 skill 注册为 /<name>，下一次 InputBox 重新读 listCommands() 时自动包含
```

## 文件组织

```text
src/
  commands/
    commands.ts          CommandType / Command / CommandContext / CommandRegistry / parse / createDefaultRegistry
    loader.ts            loadUserCommands(workDir) / renderBody(body, args)
    usage-tracker.ts     CommandUsageTracker（持久化 .mewcode/command_usage.json）

  tui/
    app.tsx              handleSlashCommand 分发器 + 4 类命令副作用 switch + wireSkillsToRegistry
    input.tsx            5-tier 补全 + ghost text + ↑↓/Tab/Enter/ESC 键位 + RECENTLY USED 分组
    styles.ts            commandIcons 映射（local/local_ui/skill_fork/prompt 对应 ⚙/⚙/★/◇）

tests/
  command-loader.test.ts  bun:test 覆盖 frontmatter / 子目录命名空间 / $ARGUMENTS 替换
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 命令模块归属 | 新建 `src/commands/`，独立于 `src/tui/` | dispatcher 要在 `app.tsx` 里调用 React state setter，但命令注册中心与 parse 是纯函数，分包让 `tests/command-loader.test.ts` 这种纯单测不需要 mock Ink |
| 注册方式 | `createDefaultRegistry()` 工厂内显式 16 次 `register` 调用 | 顺序可控、测试时能用空 registry 起步、不依赖模块顶层副作用 |
| 冲突检测 | `register` 抛 `Error`、`hasConflict` 提供非抛版本 | 动态加载（用户命令、技能）必须能预检后跳过；内置命令一旦冲突应该爆给开发者看 |
| Handler 签名 | `(ctx: CommandContext) => string` 统一返回字符串 | local 直接 push 字符串、prompt 把字符串当注入消息、local_ui 把字符串当动作枚举；skill_fork handler 无副作用占位符 |
| `local_ui` 副作用归属 | dispatcher 内 `switch(action)` 集中处理 | handler 不依赖 React state；状态变更必须在主组件内 |
| `/status` / `/permission` / `/memory` 实时数据 | dispatcher 内特殊路径，越过 handler 返回值 | 这些命令的内容依赖 `permMode` / `mcpInfo` / `selectedProvider` 等 React state，handler 拿不到也不该拿到 |
| `/mcp` 提前短路 | 在 `find` 之前判断 | mcpInfo 的来源不在 `CommandContext` 上；写在前面避免污染主分支 |
| `/skill <name>` 别名展开 | parse 后重写 parsed | 用户敲 `/skill foo` 与 `/foo` 同效，无需在每条 skill 命令上再注册 alias=`skill foo` |
| 补全匹配策略 | 5 层去重合并：精确 name → 精确 alias → 前缀 name → 前缀 alias → Fuse 模糊 | 输入越精确越靠前，Fuse 兜底覆盖 typo 但权重最低 |
| 补全菜单实现 | Ink 原生 `<Box flexDirection="column">` 多行字符串，不引第三方 list 组件 | 与 ghost text、`@`-mention 补全共用一套 useInput 状态机；引入第三方 list 会与 `useApp().exit()` 等 Ink 子集相冲突 |
| ghost text 显示条件 | 第一候选 name lower 以 query lower 开头才显示 | Fuse 命中的候选 name 不一定以输入开头，渲染 ghost 会误导用户 |
| 持久化使用频次 | JSON 文件落在 `.mewcode/command_usage.json`，无版本号 | 单机轻量数据；丢失或损坏时空起步影响零 |
| 推荐分数衰减 | `count × max(0.5^(daysSince/7), 0.1)` | 半衰期 7 天，最低保留 10% 让一年前用过一次的命令仍能在没新事件时出现 |
| 用户命令 type 固定 | 全部标 `"prompt"`，不暴露 type frontmatter 字段 | 用户 `.md` 文件天然就是给 LLM 看的提示词；其他类型留给内置 |
| 用户命令命名空间 | 子目录路径用 `:` 拼接，单段全 lower、空格转 `-` | 文件系统级隔离不同主题；`:` 在 shell 不需要转义、与 npm scope 类似易理解 |
| 技能命令注册时机 | `initClient` 流程中 + `InstallSkillTool` 回调 | 启动期一次覆盖、运行期安装即生效；不需要重启 TUI |
| 冲突处理（用户 vs 内置） | 用户命令 register 抛错 → try/catch 静默跳过 | 内置命令永远赢；用户无意撞名时 UI 仍能启动 |
| 冲突处理（技能 vs 现有） | `cmdRegistry.find(name)` 短路而不是 try/catch | 技能批量注册，find 提前判断省去 throw/catch 的栈展开 |
| 错误消息文案 | 英文（`Available commands:` / `Unknown command:` / `MewCode Status`）| 既有代码与终端国际化策略保持一致；后续可整体本地化时再统一替换 |
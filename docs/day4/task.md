# 系统提示工程化 Tasks

> 模块路径在 `src/prompt/`、`src/llm/`、`src/agent/`、`src/tools/`、`src/conversation/`、`src/tui/` 下;运行时 bun + TypeScript 5.x,`bun test` 执行单测、`tsc --noEmit` 类型检查。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/prompt/sections.ts` | `Section` 接口、`EnvironmentContext` 接口;八个固定 Section 工厂(identitySection ... environmentSection) |
| 新建 | `src/prompt/builder.ts` | `PromptBuilder` 类、`detectEnvironment(workDir)`、`BuildOptions` 接口、`buildSystemPrompt(env, opts?)` |
| 新建 | `src/prompt/plan-mode.ts` | `buildPlanModeReminder / buildPlanModeExitReminder / buildPlanModeReentryReminder` + `reminderInterval` 常量 + 完整/精简提醒模板 |
| 改   | `src/llm/events.ts` | `UsageInfo` 增加 `cacheReadInputTokens / cacheCreationInputTokens` 两字段 |
| 改   | `src/llm/anthropic.ts` | 构造器接收 `systemPrompt`;`stream()` 中 system 单 TextBlockParam + ephemeral 断点;末 tool / `markLastUserTailForCache` 加 ephemeral;解析 `cache_read_input_tokens / cache_creation_input_tokens` |
| 改   | `src/llm/openai.ts` | `OpenAIClient / OpenAICompatClient` 构造器接收 `systemPrompt`;Responses input / Chat messages 前缀 system;解析 `input_tokens_details / prompt_tokens_details.cached_tokens`;`inputTokens` 减除避免双计 |
| 改   | `src/llm/client.ts` | `createClient(cfg, systemPrompt)` 工厂分发三协议 |
| 沿用 | `src/conversation/conversation.ts` | `addSystemReminder(content)` 包 `<system-reminder>` 标签写入 history;`injectLongTermMemory` 头插一条 system-reminder user 消息 |
| 改   | `src/agent/agent.ts` | `run()` 每轮 `manageContext` 后注入 plan-mode / active-skills / hook reminder;`buildActiveSkillsReminder(activeSkills)` 内部辅助函数 |
| 改/沿用 | `src/tools/descriptions.ts` | `BashDescription` 含「Avoid using this tool to run cat, head, tail...」;`EditFileDescription` 含「You MUST read the file with ReadFile before editing」 |
| 改   | `src/tui/app.tsx` | `initClient` 调 `detectEnvironment + buildSystemPrompt`;`/plan` `/do` 切换时通过 `addSystemReminder(buildPlanModeReentryReminder / buildPlanModeExitReminder)` 注入 |
| 改   | `src/agents/spawn.ts` | 子 agent 启动时 `detectEnvironment(workDir); env.model = resolvedModel; systemPrompt = definition.systemPromptOverride ?? buildSystemPrompt(env)` |
| 改   | `src/teammate.ts` | teammate 启动时同上 |
| 新建 | `tests/prompt-builder.test.ts` | PromptBuilder 排序、跳空、N1 稳定性、F5 双重强化文本断言 |
| 新建 | `tests/plan-mode-reminder.test.ts` | iteration=1 完整版、iteration=2 精简版、iteration=6 完整版重复 |

---

## T1: Section 工厂与 Environment 渲染**文件:** `src/prompt/sections.ts`
**依赖:** 无
**步骤:**
1. 定义 `export interface Section { name: string; priority: number; content: string }`。
2. 实现八个工厂函数,各自返回 `Section`:
   - `identitySection()` priority=0:「你是 MewCode...优先编写安全、正确的代码...」。
   - `systemSection()` priority=10:`# 系统`,包含「工具结果和用户消息中可能包含 `<system-reminder>` 标签」(让模型理解 F6 的语义)。
   - `doingTasksSection()` priority=20:`# 任务执行`,详尽列出 ReAct 行为约定。
   - `executingActionsSection()` priority=30:`# 谨慎执行操作`,列出破坏性操作 / 难撤销操作 / 影响他人操作三类高风险。
   - `usingToolsSection()` priority=40:`# 使用你的工具`——**F5 双重强化**列表,「ReadFile 而非 cat/head/tail」「EditFile 而非 sed/awk」等。
   - `toneStyleSection()` priority=50:`# 语气与风格`,简洁、file_path:line_number、不要冒号。
   - `outputEfficiencySection()` priority=60:`# 文本输出`,假设用户看不到工具调用与思考、简短更新等。
3. 定义 `export interface EnvironmentContext { workDir; os; arch; shell; isGitRepo; gitBranch; model; date }`。
4. 实现 `environmentSection(env)` priority=70:输出 `# 环境` 段,固定行 workDir / `${os}/${arch}` / shell / isGitRepo / date;条件行 gitBranch(`env.isGitRepo && env.gitBranch`)、model(非空)。

**验证:** `bun test tests/prompt-builder.test.ts` 中断言各 Section name/priority 正确。

## T2: PromptBuilder 与 buildSystemPrompt**文件:** `src/prompt/builder.ts`
**依赖:** T1
**步骤:**
1. `import { execSync } from "node:child_process"; import { platform, arch } from "node:os"; import type { Section, EnvironmentContext } from "./sections.js"; import { identitySection, ..., environmentSection } from "./sections.js";`
2. 实现 `export class PromptBuilder`:私有 `sections: Section[]`;`add(s): this` 返回 this 支持链式;`build(): string` 排序 → trim → filter(Boolean) → join("\n\n")。
3. 实现 `export function detectEnvironment(workDir: string): EnvironmentContext`:
   - 初始化 `env = { workDir, os: platform(), arch: arch(), shell: process.env.SHELL ?? "bash", isGitRepo: false, gitBranch: "", model: "", date: new Date().toISOString().split("T")[0] }`。
   - try 块:`execSync("git rev-parse --is-inside-work-tree", { cwd: workDir, stdio: ["pipe","pipe","pipe"], encoding: "utf-8" }).trim() === "true"` 则 `env.isGitRepo = true; env.gitBranch = execSync("git rev-parse --abbrev-ref HEAD", ...).trim()`。
   - catch 块:留空,函数继续返回 env。
4. 定义 `export interface BuildOptions { skillSection?: string; customInstructions?: string; memorySection?: string }`。
5. 实现 `export function buildSystemPrompt(env, opts = {}): string`:
   - new PromptBuilder;依次 add Identity ... Environment 八个 Section。
   - `opts.skillSection` → `b.add({ name:"Skills", priority:90, content: opts.skillSection })`。
   - `opts.customInstructions` → `b.add({ name:"CustomInstructions", priority:95, content: opts.customInstructions })`。
   - `opts.memorySection` → `b.add({ name:"Memory", priority:100, content: opts.memorySection })`。
   - return b.build()。

**验证:** `tsc --noEmit` 无报错;`bun test tests/prompt-builder.test.ts` 通过。

## T3: 规划模式 reminder 构造器**文件:** `src/prompt/plan-mode.ts`
**依赖:** 无
**步骤:**
1. 定义模板字符串常量:`planModeFullReminder`(含 `%PLAN_FILE_INFO%` 占位符 + 5 阶段工作流)、`planModeSparseReminder`(含 `%PLAN_PATH%` 占位符,一句话精简)、`planModeExitTemplate`(含 `%EXTRA%` 占位符)、`planModeReentryTemplate`(含 `%PLAN_PATH%` 占位符)。
2. 定义 `const reminderInterval = 5`。
3. 实现 `export function buildPlanModeReminder(planPath, planExist, iteration): string`:
   - 构造 `planFileInfo`:`Plan file: ${planPath}` + (planExist 时「A plan file already exists...」/ 否则「No plan file exists yet...」)。
   - `iteration === 1` → return `planModeFullReminder.replace("%PLAN_FILE_INFO%", planFileInfo)`。
   - 否则 `const attachmentIndex = Math.floor((iteration - 1) / reminderInterval); if (attachmentIndex % reminderInterval === 0)` → 返回完整版。
   - 其余 → return `planModeSparseReminder.replace("%PLAN_PATH%", planPath)`。
4. 实现 `export function buildPlanModeExitReminder(planPath, planExists): string`:`extra` 在 `planExists` 时为 `The plan file is located at ${planPath}...`,否则 `""`;return `planModeExitTemplate.replace("%EXTRA%", extra)`。
5. 实现 `export function buildPlanModeReentryReminder(planPath, planFileExists): string`:`planFileExists` false 则 return `""`;否则 return `planModeReentryTemplate.replace("%PLAN_PATH%", planPath)`。

**验证:** `bun test tests/plan-mode-reminder.test.ts` 断言 iteration=1 含「Plan mode is active」、iteration=2 含「Plan mode still active」、iteration=6 含「Plan mode is active」(完整)。

## T4: UsageInfo 与 LLMClient 接口**文件:** `src/llm/events.ts`、`src/llm/client.ts`
**依赖:** 无
**步骤:**
1. `src/llm/events.ts`:`UsageInfo` 增加 `cacheReadInputTokens: number; cacheCreationInputTokens: number`;`stream_end` 事件的 `usage` 类型自动跟随更新。
2. `src/llm/client.ts`:确认 `createClient(cfg: ProviderConfig, systemPrompt: string)` 签名;三协议分支 dynamic import 并 `new XxxClient(cfg, systemPrompt)`。

**验证:** `tsc --noEmit` 通过;旧 client 实现暂时编译失败(T5/T6 修复)。

## T5: Anthropic adapter 改造**文件:** `src/llm/anthropic.ts`
**依赖:** T4
**步骤:**
1. `constructor(cfg, systemPrompt)`:把 systemPrompt 存为 `this.systemPrompt`;沿用 `this.model / this.thinking / this.maxOutputTokens / this.contextWindow` 字段。
2. `stream(conv, toolSchemas, abortSignal)`:
   - `const messages = buildAnthropicMessages(conv.getMessages())`。
   - tools 数组从 toolSchemas 映射 `{ name, description, input_schema: { type:"object", properties, required } }`。
   - `if (tools.length > 0)` 把最后一个 tool 的 `cache_control = { type:"ephemeral" }`。
   - `markLastUserTailForCache(messages)`:从后向前找首条 role=user,把其 content 数组末块的 `cache_control` 设为 ephemeral。
   - 构造 `params`:`system: [{ type:"text", text: this.systemPrompt, cache_control: {type:"ephemeral"} }]`、`messages`、`tools`(可选)。
3. 流式收集:`message_start` 事件读 `event.message.usage.input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`(`?? 0` 兜底);最后 yield `stream_end { stopReason, usage: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } }`。
4. `buildAnthropicMessages` 已有连续 user 合并逻辑沿用,不改。

**验证:** `bun build src/llm/anthropic.ts` 无错;手工跑 smoke 看 Anthropic 路径 message_start 字段。

## T6: OpenAI / OpenAI-Compat adapter 改造**文件:** `src/llm/openai.ts`
**依赖:** T4
**步骤:**
1. `OpenAIClient.constructor(cfg, systemPrompt)`:存 `this.systemPrompt`;`this.client = new OpenAI({ apiKey, baseURL })`。
2. `OpenAIClient.stream()`:`input = []; input.push({ role:"system", content: this.systemPrompt });` 再 `for (const msg of buildOpenAIInput(history)) input.push(msg)`。`response.completed` 事件 `usage`:`cacheReadInputTokens = usage.input_tokens_details?.cached_tokens ?? 0; inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadInputTokens); outputTokens = usage.output_tokens ?? 0;`,`cacheCreationInputTokens: 0`。
3. `OpenAICompatClient.stream()`:`messages: [{ role:"system", content: this.systemPrompt }, ...buildChatCompletionMessages(history)]`。chunk.usage 阶段 `cacheReadInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0; inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cacheReadInputTokens); outputTokens = chunk.usage.completion_tokens ?? 0`,`cacheCreationInputTokens: 0`。
4. `buildOpenAIInput` 和 `buildChatCompletionMessages` 沿用,不改。

**验证:** `tsc --noEmit` 全部通过;smoke openai 看 cached_tokens 字段(端点支持则 >0)。

## T7: 工具描述双重强化**文件:** `src/tools/descriptions.ts`、`src/tools/bash.ts`、`src/tools/edit-file.ts`
**依赖:** 无
**步骤:**
1. `descriptions.ts`:
   - `BashDescription` 首段确保含「IMPORTANT: Avoid using this tool to run cat, head, tail, sed, awk, or echo commands. Instead use the dedicated ReadFile, EditFile, or WriteFile tools」。
   - `EditFileDescription` 首条 Usage 含「You MUST read the file with ReadFile before editing. This tool will fail otherwise.」
2. `bash.ts` / `edit-file.ts` 各自 `description = BashDescription / EditFileDescription`,不另行修改 schema。

**验证:** `bun test` 涉及工具 schema 的用例通过。

## T8: agent reminder 注入循环**文件:** `src/agent/agent.ts`
**依赖:** T2、T3
**步骤:**
1. 顶部 `import { getOrCreatePlanPath, planExists } from "../planfile/planfile.js"; import { buildPlanModeReminder } from "../prompt/plan-mode.js";`。
2. `run()` 主循环每轮 `iteration++`、`manageContext` 之后,`fireLifecycle("turn_start")` 之前:
   - `if (this.checker.mode === "plan") { const planPath = getOrCreatePlanPath(this.workDir); this.checker.planFilePath = planPath; this.conversation.addSystemReminder(buildPlanModeReminder(planPath, planExists(this.workDir), iteration)); }`
   - `const skillReminder = buildActiveSkillsReminder(this.activeSkills); if (skillReminder) this.conversation.addSystemReminder(skillReminder);`
   - `if (this.hookEngine) for (const note of this.hookEngine.drainNotifications()) this.conversation.addSystemReminder(note);`
   - `if (this.notificationFn) for (const note of this.notificationFn()) this.conversation.addSystemReminder(note);`
3. 文件末追加 `function buildActiveSkillsReminder(active: Map<string, string>): string`:active 空时返回 `""`;否则拼接 `# Active Skills\n\nThe following Skill SOPs are pinned to the environment context. ...\n\n## Active Skill: ${name}\n\n${body}\n\n` × N。

**验证:** `tsc --noEmit` 通过;agent 单测覆盖三类 reminder 各自注入逻辑。

## T9: TUI 与 spawn / teammate 接线**文件:** `src/tui/app.tsx`、`src/agents/spawn.ts`、`src/teammate.ts`
**依赖:** T2、T3、T4
**步骤:**
1. `src/tui/app.tsx`:`initClient` 中 `const env = detectEnvironment(workDir); env.model = provider.model; const systemPrompt = buildSystemPrompt(env); const client = await createClient(provider, systemPrompt); clientRef.current = client;`。
2. `/plan` 进入路径:在已有 plan 文件存在时 `convRef.current.addSystemReminder(buildPlanModeReentryReminder(planPath, true))`。
3. `/do` 退出路径:`convRef.current.addSystemReminder(buildPlanModeExitReminder(planPath, !!planContent))`,两处(主输入分支与 plan-approval 分支均处理)。
4. `src/agents/spawn.ts`:`const env = detectEnvironment(workDir); env.model = resolvedModel; const systemPrompt = definition.systemPromptOverride ?? buildSystemPrompt(env); const client = effectiveModel ? await createClient({ ...parentProvider, model: resolvedModel }, systemPrompt) : parentClient;`。
5. `src/teammate.ts`:`const env = detectEnvironment(process.cwd()); const systemPrompt = buildSystemPrompt(env);`。

**验证:** `bun run src/main.tsx`(或在 tmux 内启动)进入 `/plan` 模式,首轮看到完整提醒、第二轮看到精简提醒。

## T10: PromptBuilder 单测**文件:** `tests/prompt-builder.test.ts`
**依赖:** T1、T2
**步骤:**
1. `import { test, expect } from "bun:test"; import { buildSystemPrompt, detectEnvironment, PromptBuilder } from "../src/prompt/builder.js"; import { identitySection, usingToolsSection } from "../src/prompt/sections.js";`
2. 测试 1:Section 排序——`new PromptBuilder().add(usingToolsSection()).add(identitySection()).build()` 中 identity 出现在 usingTools 之前。
3. 测试 2:跳空 content——传入 `{name:"X", priority:50, content:""}` 不出现、无连续 `\n\n\n`。
4. 测试 3:N1 稳定性——两次 `buildSystemPrompt(fakeEnv)` 结果 `===`(同一 env 字面量)。
5. 测试 4:F5 双重强化——`buildSystemPrompt(fakeEnv)` 含子串「ReadFile」「Bash」「EditFile」。
6. 测试 5:可选 Section——`buildSystemPrompt(env, { skillSection:"S", customInstructions:"C", memorySection:"M" })` 末尾按 Skills / CustomInstructions / Memory 顺序出现。

**验证:** `bun test tests/prompt-builder.test.ts` 全绿。

## T11: plan-mode 单测**文件:** `tests/plan-mode-reminder.test.ts`
**依赖:** T3
**步骤:**
1. iteration=1 → 完整版,含「Plan mode is active」「Phase 1: Initial Understanding」。
2. iteration=2 → 精简版,含「Plan mode still active」、不含「Phase 1」。
3. iteration=6(刚好下一个 attachmentIndex 边界)→ 完整版。
4. `buildPlanModeExitReminder(p, true)` 含「You have exited plan mode」「The plan file is located at」;`buildPlanModeExitReminder(p, false)` 不含后者。
5. `buildPlanModeReentryReminder(p, false)` 返回 `""`;`buildPlanModeReentryReminder(p, true)` 含「You have re-entered plan mode」。

**验证:** `bun test tests/plan-mode-reminder.test.ts` 全绿。

## T12: 全量类型检查与测试**文件:** —
**依赖:** T1–T11
**步骤:**
1. `tsc --noEmit`——无任何报错。
2. `bun test`——`tests/` 全部用例通过(含 ch04 用例不退化)。
3. 在 tmux 内手工启动 `bun run src/main.tsx`,验证三个端到端场景:
   - 同一会话连发两条消息(Anthropic 路径),观察日志 / debug 打印的 `cacheCreationInputTokens / cacheReadInputTokens`。
   - 进入 `/plan`,在多轮调研后退出 `/do`,确认提醒详略按 iteration 切换。
   - 在非 git 目录启动,确认 `# 环境` 段无 Git 分支行、不报错。

**验证:** 全部通过;输出无 api_key 明文。

## 执行顺序

```text
T1(sections)─┐
             ├─→ T2(builder) ─┬─→ T10(prompt 单测)
             │                └─→ T9(TUI/spawn/teammate 接线)
T3(plan-mode)──→ T11(plan-mode 单测)
                  ↘
T4(UsageInfo/client) ─┬─→ T5(anthropic) ─┐
                      └─→ T6(openai)    ─┤
T7(工具描述,独立)                         │
T1,T2,T3,T4 ─→ T8(agent) ────────────────┴─→ T12(全量类型 / 测试 / tmux 端到端)
```
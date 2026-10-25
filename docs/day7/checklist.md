# 上下文管理 Checklist

> 每一项通过运行 bun 测试、类型检查或手测真实运行来验证，聚焦系统行为而非实现细节。

## 实现完整性### 包与目录结构- [ ] **C1**：`src/toolresult/` 与 `src/compact/` 目录存在，文件齐全。
  - 验证：`ls src/toolresult/` 列出 `state.ts` / `budget.ts` / `reconstruct.ts` / `record.ts`。
  - 验证：`ls src/compact/` 列出 `compact.ts` / `recovery.ts`。
  - 验证：`tsc --noEmit` 退出码 0，无未解析符号。

- [ ] **C2**：常量集中：第 1 层常量在 `src/toolresult/budget.ts` 顶部、第 2 层常量在 `src/compact/compact.ts` 顶部、恢复段常量在 `src/compact/recovery.ts` 顶部。
  - 验证：`grep -n "= 50000\|= 200000\|= 20000\|= 13000\|= 3000\|= 10000\|= 40000" src/toolresult/budget.ts src/compact/compact.ts src/compact/recovery.ts` 命中点全部落在这三个文件，**不**散落到 agent.ts / tui/。

### 状态对象- [ ] **C3**：`ContentReplacementState` 暴露 `record / has / getReplacement / clone / size`，构造后两本 set/map 都初始化。
  - 验证：单测 `state.record("a", "x", "y"); expect(state.has("a")).toBe(true); expect(state.getReplacement("a")).toBe("y")`。
  - 验证：`state.record("b", "x", "x")` 不写 replacements（original === replaced）→ `state.has("b") === true && state.getReplacement("b") === undefined`。

- [ ] **C4**：`AutoCompactTrackingState` 暴露 `consecutiveFailures` 字段并允许直接读写。
  - 验证：单测三次让 `manageContext` 抛错后 `tracking.consecutiveFailures === 3`；一次成功后立即清零。

- [ ] **C5**：`RecoveryState` 暴露 `recordFileRead / recordSkillInvocation / snapshotFiles / snapshotSkills / buildRecoveryAttachment`。
  - 验证：单测连续 record 7 个文件 → `snapshotFiles()` 返回 5 条按 timestamp 倒序。
  - 验证：单测 `buildRecoveryAttachment(["Bash", "Read"])` 输出含 `## Available tools` 段、含两个工具名。

- [ ] **C6**：`ConversationManager.replaceWithCompacted(summaryContent, keep)` 把内部 history 替换为 `[摘要 user 消息, ...keep]`。
  - 验证：单测构造 5 条 history、调 `replaceWithCompacted("S", [...keep])` → `getMessages().length === 1 + keep.length`、首条 role=user content="S"。

### 两层压缩- [ ] **C7**：`applyBudget` 支持单条 / 聚合 / 幂等 / 决策冻结 / `snipStale` 五种行为。
  - 验证：60000 字符单条 → 替换为 `<persisted-output>` 预览串；`.mewcode/tool_results/<id>` 文件 size = 60000。
  - 验证：3 条 80000 字符聚合 → 至少 2 条替换、聚合 ≤ 200000。
  - 验证：同一 messages 两次调用 → 输出消息逐字节相等；spill 文件 mtime 不变。
  - 验证：12 真实轮次 + 大旧 toolResults → 旧轮次出现 `[Stale output snipped: N chars]`。

- [ ] **C8**：`writeSpill` 用 `flag: "wx"` 实现幂等；非 EEXIST 错误以 throw 冒泡到调用方。
  - 验证：人为锁定 `.mewcode/tool_results/` 为只读 → applyBudget throw；解锁后再调正常落盘。

- [ ] **C9**：预览替换体（`buildSpillPreview`）字段固定，逐字节稳定。
  - 验证：用 `strings.Contains` 等价的 `.includes(...)` 检查 4 个标志：① `<persisted-output>` 起止包裹；② `输出太大（` + KB 数 + `KB）`；③ 落盘绝对路径子串；④ `预览（前 2KB）：` 之后跟前 2000 字符 + 末尾 `...`。
  - 验证：同 (content, spillPath) 两次构造结果 `===` 比较为 true。

- [ ] **C10**：`doCompact` 摘要 prompt 显式两阶段、解析 `<summary>...</summary>`。
  - 验证：stub client 收到的 `summaryConv.getMessages()[0].content` 包含 `Wrap your analysis in <analysis> tags` 与 `<summary> tags`。
  - 验证：返回 `<analysis>x</analysis><summary>BODY</summary>tail` → 解析后的 `boundary.summary === "BODY"`。
  - 验证：返回不含 `<summary>` 标签时降级为整段返回，不抛错。

### 恢复三段- [ ] **C11**：`buildRecoveryAttachment` 三块按可用性条件出现：`## Recently read files` / `## Active skills` / `## Available tools`；末尾固定 `## Note`。
  - 验证：构造 7 条文件 record + 0 技能 + 3 工具名 → 输出含 `## Recently read files`、不含 `## Active skills`、含 `## Available tools`、含 `## Note`；不含第 6/7 条文件路径子串（反向断言）。
  - 验证：单文件 > 5000 token → 保留头部、尾部出现 `\n… (content truncated)`。
  - 验证：三块全空 → 返回空字符串。

- [ ] **C12**：`## Note` 边界提示文案稳定。
  - 验证：连续两次 `buildRecoveryAttachment(toolSchemaNames)` 在相同 fixture 下返回逐字节相等结果；用 `=== ` 比较。
  - 验证：固定文案匹配：`.includes("Everything above the divider is reconstructed context")` 与 `.includes("re-read the source rather than guess from the summary")`。

### Token 估算- [ ] **C13**：`estimateMessages` / `estimateTokens` / `currentContextTokens` 行为符合 chars / 3.5 规则。
  - 验证：`estimateMessages([])` === 0。
  - 验证：`estimateMessages([{role:"user", content:"x".repeat(7)}])` === `Math.ceil(7 / 3.5)` === 2。
  - 验证：`currentContextTokens(conv, null)` === `estimateTokens(conv)`（冷启动）。
  - 验证：anchor `{baselineTokens: 5000, anchorCount: 2}`、conv 含 2 条 + 1 条新增 70 字符 → 返回 5000 + 20 = 5020。

- [ ] **C13a**：`currentContextTokens` 在 anchorCount > messages.length 时正确 clamp，不出现负索引。
  - 验证：anchor `{baselineTokens: 3000, anchorCount: 5}`、conv 只 1 条 → 返回 3000（不抛错、不切负数）。

- [ ] **C14**：`manageContext` 与 `computeCompactThreshold` 按 effective + margin 公式触发。
  - 验证：contextWindow=200000、maxOutput=8192 → autoThreshold = `200000 − min(8192, 20000) − 13000` = 178808；hardBlock = 200000 − 8192 − 3000 = 188808。
  - 验证：tokens < autoThreshold → manageContext 返回 `{compacted: false, message: ""}`；tokens ≥ autoThreshold & 未熔断 → 触发 doCompact。
  - 验证：tokens ≥ hardBlock 即便熔断也强制 doCompact。

### 手动入口与命令分发- [ ] **C15**：`/compact`（含别名 `c`）已注册在 `registerBuiltins`。
  - 验证：`grep -n "name: \"compact\"" src/commands/commands.ts` 命中；`aliases: ["c"]` 命中；`type: "local_ui"` 命中。
  - 验证：单测 `registry.find("compact")?.name === "compact" && registry.find("c")?.name === "compact"`。

- [ ] **C16**：TUI `case "compact":` 分支调 `forceCompact`、push 进度与结果系统消息、成功时持久化 boundary。
  - 验证：`grep -n "forceCompact" src/tui/app.tsx` 命中。
  - 验证：`grep -n "saveCompactBoundary" src/tui/app.tsx` 命中。
  - 验证：手测输入 `/compact` 看到先 `Compacting conversation...` 再 `Compact: Compacted N messages into summary (M chars), kept K recent messages verbatim`。

### ContextTooLongError 自愈- [ ] **C17**：`src/llm/errors.ts` 导出 `ContextTooLongError extends LLMError`。
  - 验证：`grep -n "class ContextTooLongError" src/llm/errors.ts` 命中。
  - 验证：单测 `new ContextTooLongError("x") instanceof LLMError === true`。

- [ ] **C18**：Anthropic provider 在 400 + `prompt is too long` 时构造 `ContextTooLongError`；OpenAI provider 在 `context_length_exceeded` 时同样。
  - 验证：mock anthropic SDK 抛 `{ status: 400, message: "prompt is too long: ..." }` → `client.stream` 抛出的 err `instanceof ContextTooLongError === true`。
  - 验证：mock openai SDK 抛 `{ code: "context_length_exceeded", ... }` → 同样。
  - 验证：其他错误不被错误地包装为 PTL（`instanceof ContextTooLongError === false`）。

### 配置- [ ] **C19**：`AgentConfig.contextWindow` 默认 200000、`AgentConfig.maxOutput` 默认 8192；可由调用方覆盖。
  - 验证：`new Agent({ ... })` 不传 contextWindow → 内部字段 200000。
  - 验证：`new Agent({ ..., contextWindow: 100000 })` → 内部字段 100000，下一轮 manageContext 用 100000 计算阈值。

- [ ] **C20**：`UsageInfo` 类型含 `cacheReadInputTokens` 与 `cacheCreationInputTokens` 字段。
  - 验证：`grep -n "cacheReadInputTokens\|cacheCreationInputTokens" src/llm/events.ts` 命中。
  - 验证：anthropic provider 在 stream_end 时把 `usage.cache_read_input_tokens` 映射到 `cacheReadInputTokens`。

---

## 集成### compact 与 conversation- [ ] **I1**：`ConversationManager.replaceWithCompacted` 在 doCompact 内被调用，替换后 `getMessages()` 长度 = 1 + toKeep.length。
  - 验证：单测 `forceCompact` 完成后断言 `conv.getMessages().length === 1 + boundary.keep.length`（注意 keep 已过滤掉无 content 的项，可能与原 toKeep 长度不同——以 replaceWithCompacted 实际传入的 toKeep 为准）。

- [ ] **I2**：摘要 + 中文框架 + verbatim 尾部一次性放进新对话首条 user 消息 content。
  - 验证：单测 conv 含 RECENT-* 标记尾部 → 压缩后 `conv.getMessages()[0].content` 包含 `本次会话延续自之前的对话` 与摘要 BODY。

### compact 与 agent- [ ] **I3**：Agent 主循环每轮调一次 `manageContext`，把 `toolSchemaNames` 与 `usageAnchor` 透传。
  - 验证：单测 stub LLMClient 记录 `manageContext` 调用次数 vs `client.stream` 调用次数 → 同一 iteration 内 manageContext 必先于 stream 发生。
  - 验证：单测 `Agent.run()` 第 N 轮、stream_end 带 usage 之后第 N+1 轮 → `usageAnchor.baselineTokens` 等于上一轮 `inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens`。

- [ ] **I4**：`usageAnchor` 在压缩后被清零（自动 + 紧急两路径都要）。
  - 验证：自动路径：让 manageContext 返回 `compacted: true` → Agent 内 `usageAnchor === null`。
  - 验证：紧急路径：第 1 次 stream 抛 ContextTooLongError 触发 forceCompact 后，Agent 内 `usageAnchor === null`，下一轮 currentContextTokens 走冷启动 estimateTokens 分支。

- [ ] **I4-bis**：usageAnchor 是替换（不是累加）。
  - 验证：stub client 在 3 次连续 stream_end 带 usage `{input:1000,...}` / `{input:1500,...}` / `{input:2200,...}` → 第 3 次后 `usageAnchor.baselineTokens` 等于 2200 + caches + output（最新 usage 之和），不是历史累加。

- [ ] **I5**：ReadFile 工具成功后 Agent 调 `recoveryState.recordFileRead(path, content)`，content 是磁盘真实字节。
  - 验证：单测 stub Read 工具返回成功 + Agent 后续 `recovery.snapshotFiles()` 含该路径；与 `await readFile(path, "utf-8")` 逐字节相等。

- [ ] **I6**：Agent 捕获 ContextTooLongError → 紧急 `forceCompact` → 清 anchor → yield compact 事件 → continue 重试。
  - 验证：stub client 第 1 次 throw PTL、第 2 次正常 stream_end → Agent.run() 收集到的事件序列含 `{type:"compact", message: "Auto-compacted due to context length: ..."}`，紧随其后是后续正常事件（text_delta、tool_use 等）。
  - 验证：紧急 `forceCompact` 自身 throw → Agent yield `{type: "error", ...}` 后 generator return，不进入第二次 forceCompact。

### compact 与 tui- [ ] **I7**：TUI 命令注册表含 compact，且别名 c 路由到同一 handler。
  - 验证：`grep -n "compact\|aliases.*c" src/commands/commands.ts` 命中 compact 注册。
  - 验证：单测 `commandRegistry.find("c")?.name === "compact"`。

- [ ] **I8**：`/compact` 完成后 TUI 输出系统消息（成功 / 失败两种形式）。
  - 验证：手测：成功后看到 `Compact: Compacted N messages into summary (M chars), kept K recent messages verbatim`；模拟错误（断网）看到 `Compact failed: <message>`。

- [ ] **I9**：`/compact` 成功后 boundary 被写到 `.mewcode/sessions/<sessionId>.jsonl`。
  - 验证：手测 `tail -n 1 .mewcode/sessions/<sessionId>.jsonl | jq .type` 输出 `"compact_boundary"`；`jq .role` 输出 `"system"`；`jq -r .content | jq .summary` 能正确解析出摘要。

### compact 与 session- [ ] **I10**：`/resume <sessionId>` 调 `rebuildFromSession` 后能正确展开压缩态。
  - 验证：单测构造含 boundary 的 saved → restored = `[摘要 user, ...keep, ...boundary 之后追加]`；boundary 之前的原始消息**不**出现在 restored 中。
  - 验证：单测无 boundary 的 saved → 全量 replay，行为与旧版本兼容。

### compact 与 main- [ ] **I11**：`src/main.tsx` 创建 Agent 时按 provider protocol 注入 `contextWindow`。
  - 验证：anthropic provider → 注入 200000；openai provider → 注入 128000；可读 main.tsx 验证 `protocol === "openai" ? 128000 : 200000` 类型的判断存在。

- [ ] **I12**：`.mewcode/tool_results/` 与 `.mewcode/sessions/` 目录由 `writeSpill` / `saveMessage` 用 `mkdirSync(recursive: true)` 按需创建。
  - 验证：删掉 `.mewcode/` 后启动 bun + 触发一次 Read 大文件 → 目录与文件自动创建。
  - 验证：进程退出后 `.mewcode/sessions/<sessionId>.jsonl` 与 `.mewcode/tool_results/<id>` 文件仍存在，下次启动新 sessionId 但不影响读取旧文件。

---

## 编译与测试- [ ] **B1**：`tsc --noEmit` 在仓库根目录退出码 0，无类型错误。

- [ ] **B2**：`bun test` 全部测试通过。

- [ ] **B3**：`bun test tests/toolresult.test.ts` 通过。覆盖：
  - applyBudget 单条 / 聚合 / 幂等 / 决策冻结 / snipStale 五种行为。

- [ ] **B4**：`bun test tests/compact.test.ts` 通过。覆盖：
  - currentContextTokens 冷启动 / anchor / clamp 三种场景。
  - computeKeepStartIndex count 下界 / tool 配对修正 / 上界。
  - forceCompact / doCompact 摘要解析 / boundary 字段构造 / Chinese framing 注入。
  - 摘要请求 `tools` 参数严格为空。
  - MIN_COMPACT_PREFIX 退化保护。

- [ ] **B5**：`bun test tests/conversation.test.ts` 通过。覆盖 `replaceWithCompacted` 正常 / 空 keep 两个用例。

- [ ] **B6**：`bun test tests/session.test.ts` 通过。覆盖：
  - rebuildFromSession 含 boundary / 无 boundary 两个分支。
  - saveCompactBoundary + loadSession round-trip。

- [ ] **B7**：`bun test tests/agent.test.ts` 通过。覆盖：
  - ContextTooLongError 自愈成功。
  - 紧急 forceCompact 自身失败时 yield error 后 return。
  - usageAnchor 替换不累加。

- [ ] **B8**：注释不出现外部引用语。
  - 验证：跑一条针对 `src/toolresult/`、`src/compact/`、`src/conversation/`、`src/llm/errors.ts`、`src/session/`、`src/agent/agent.ts` 的禁用词扫描脚本，结果为空（脚本检测词表见仓库根目录约定）。

- [ ] **B9**：文档自检：spec / plan / task / checklist 本身不出现外部引用语。
  - 验证：跑同一条扫描脚本扫 `docs/typescript/ch08/`（排除本 checklist 自身），结果为空。

- [ ] **B10**：手测启动 `bun run src/main.tsx` 不报错，TUI 正常进入对话状态。

---

## 端到端场景### 场景 E1：长会话不撞墙- [ ] **触发**：stub LLMClient 脚本，30 轮迭代每轮返回一个工具调用 + 30KB 工具结果，注入 `contextWindow = 50000`。
- [ ] **预期**：30 轮完整跑完，无未捕获异常；中途至少触发一次自动 layer2 摘要（observers 见 `{type: "compact"}` 事件）；最终 `conv.getMessages().length` 远小于 30。
- [ ] **观察方式**：测试用例收集所有 AgentEvent，断言 `events.filter(e => e.type === "compact").length >= 1`，并断言 `Agent.run()` generator 正常完成（不 yield error）。

### 场景 E2：单条大工具结果- [ ] **触发**：stub LLMClient 一轮返回一个工具调用，工具回填 80000 字符。
- [ ] **预期**：下一轮 `apiConv` 对应 toolResult content 被替换为 `<persisted-output>` 包裹的预览串，含原始 KB、绝对路径、前 2000 字符 + `...`；`.mewcode/tool_results/<toolUseId>` 文件存在 size = 80000。
- [ ] **观察方式**：捕获 stub client 收到的第 N+1 次 stream messages，断言 content 字段；`fs.statSync(spillPath).size === 80000`。

### 场景 E3：单轮聚合超标- [ ] **触发**：单条 `role: "user"` 消息含 3 条 toolResult，每条 80000 字符（聚合 240000）。
- [ ] **预期**：至少 2 条被替换、剩余聚合 ≤ 200000；未被替换的项保持原文。
- [ ] **观察方式**：apply 后遍历 toolResults sum content.length；spill 目录至少多 2 个新文件。

### 场景 E4：决策冻结- [ ] **触发**：同一 toolUseId 在第 N 轮被 record 替换；继续跑到第 N+5 轮，期间内容未变。
- [ ] **预期**：第 N+1 ~ N+5 轮 `apiConv` 中该工具结果与第 N 轮替换字符串逐字节相等；`writeSpill` 在 wx flag 下 EEXIST 静默吞。
- [ ] **观察方式**：捕获多轮 apiConv，对同一 toolUseId 的 content 做 `===` 比较。

### 场景 E5：手动 /compact- [ ] **触发**：TUI 输入 `/compact`，压缩前 currentContextTokens 远低于 autoThreshold。
- [ ] **预期**：① stub LLMClient 收到一次摘要请求（`stream(summaryConv, [])`，tools 参数严格为 `[]`）；② conv 被替换为摘要 + verbatim 尾部；③ TUI 系统消息匹配正则 `^Compact: Compacted \d+ messages into summary \(\d+ chars\), kept \d+ recent messages verbatim$`；④ `.mewcode/sessions/<sessionId>.jsonl` 末尾出现 `type: "compact_boundary"` 行。
- [ ] **观察方式**：mock LLMClient 计数 stream 调用，断言 tools 参数 length === 0；`tail -n 1` 查 jsonl。

### 场景 E6：紧急自愈- [ ] **触发**：stub LLMClient 第 K 次 stream throw `new ContextTooLongError("...")`；之后准备一次摘要响应 + 一次重试主对话响应。
- [ ] **预期**：① Agent yield `{type: "compact", message: "Auto-compacted due to context length: ..."}`；② usageAnchor 被清零；③ 重试本轮主对话 stream 成功；④ Agent.run() 不中断。
- [ ] **触发（失败分支）**：紧急 forceCompact 自身抛错。
- [ ] **预期（失败分支）**：yield `{type: "error", ...}` 后 generator return；不进入第二次 forceCompact。
- [ ] **观察方式**：收集 Agent.run() events，断言事件序列。

### 场景 E7：熔断- [ ] **触发 A（连续失败跳闸）**：让 stub LLMClient 对摘要请求连续 3 次 throw 非 PTL 错误（如 500）。
- [ ] **预期 A**：① `tracking.consecutiveFailures === 3`；② 第 4 次 tokens 跨越 autoThreshold 但 < hardBlock → manageContext 返回 `{compacted: false, message: "Auto-compact circuit breaker: 3 consecutive failures"}`；③ tokens ≥ hardBlock 时即便熔断也强制走 doCompact（forced 分支）；④ 手动 `/compact` → forceCompact 路径不读熔断照常执行。
- [ ] **触发 B（成功清零）**：摘要响应序列 `[err, err, ok, err, err, err]`。
- [ ] **预期 B**：第 3 个 ok 后 `consecutiveFailures` 立即清零；6 次后才再次跳闸。

### 场景 E8：压缩后恢复- [ ] **触发**：① 在压缩前依次读 7 个不同文件；② 触发一次手动 /compact。
- [ ] **预期**：压缩后下一轮 stream 的 messages 首条 user 消息 content 同时包含：
  - 中文框架 `本次会话延续自之前的对话...` 与摘要 BODY。
  - 恢复段 `## Recently read files` 仅展示最近 5 个，按 timestamp 倒序；第 6/7 个文件路径**不**出现（反向断言）。
  - 恢复段 `## Available tools` 每行 `- <name>`，与入参 toolSchemaNames 逐项对应。
  - 恢复段 `## Note` 固定文案 `Everything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.`
- [ ] **观察方式**：捕获摘要后第 1 次 stream messages，按文本片段断言。

### 场景 E9：多 provider contextWindow- [ ] **触发 1**：anthropic provider + 默认（不显式传 contextWindow）。
- [ ] **预期 1**：Agent 内部 `contextWindow === 200000`；autoThreshold = `200000 − min(8192, 20000) − 13000` = 178808。
- [ ] **触发 2**：openai provider + 显式 `contextWindow: 128000`。
- [ ] **预期 2**：Agent 内部 `contextWindow === 128000`；autoThreshold = `128000 − min(8192, 20000) − 13000` = 106808。
- [ ] **触发 3**：anthropic provider + 显式 `contextWindow: 100000`。
- [ ] **预期 3**：autoThreshold = `100000 − 8192 − 13000` = 78808；hardBlock = `100000 − 8192 − 3000` = 88808。

### 场景 E10：不切断 tool_use / tool_result- [ ] **触发**：构造 messages 含 `[..., user, assistant{toolUses=[A]}, user{toolResults=[A]}, assistant{toolUses=[B]}, user{toolResults=[B]}]`，让 computeKeepStartIndex 按 count 下界算出的起点落在 user{toolResults=[A]} 上。
- [ ] **预期**（并列断言）：
  ① 返回的 keepStart 对应消息不是 `user{toolResults: ...}`（即 hasToolResult 为 false）；
  ② keepStart 指向带 toolUseId="A" 的 assistant{toolUses=[A]} 消息（backUpPastToolUse 修正成功）；
  ③ `messages.slice(keepStart)` 同时含 toolUseId="A" 的 tool_use 与 tool_result（配对完整）。

### 场景 E11：MIN_COMPACT_PREFIX 退化保护- [ ] **触发**：构造极短 messages（如 2 条 user/assistant 短消息），computeKeepStartIndex 返回 0 或 1。
- [ ] **预期**：doCompact 直接返回 `{compacted: false, message: "Compaction skipped: only N message(s) to summarize, kept verbatim"}`；conversation 不被替换；stub client 未被调用（没有 stream(summaryConv, []) 发生）。

### 场景 E12：bun + tmux 真实运行- [ ] **触发**：`bun install`、`bun run src/main.tsx`，在 tmux 中启动 mewcode，配置 anthropic provider。
- [ ] **预期**：
  - 让 Agent 读一个 80KB 本地文件 → `.mewcode/tool_results/<toolUseId>` 出现该文件，size = 80000；下一轮请求该 toolResult 已被替换为 `<persisted-output>` 预览串。
  - 临时把 `src/main.tsx` 注入的 contextWindow 改成 80000 → 连续几轮对话后看到自动压缩 `{type: "compact"}` 事件被渲染到 TUI scrollback。
  - 任意时刻输入 `/compact` 看到系统消息 `Compact: Compacted N messages into summary (M chars), kept K recent messages verbatim`；`.mewcode/sessions/<sessionId>.jsonl` 末尾新增 `type: "compact_boundary"` 行。
  - 退出进程后再启动 → `/resume <sessionId>` → 看到中文框架包裹的摘要消息出现在对话头部，verbatim 尾部跟在后面，boundary 之后追加的消息也都在。
  - 输入未知命令 `/unknown` → TUI 提示未知命令，不调用 LLM。
- [ ] **观察方式**：tmux 中目测；`tail -f .mewcode/sessions/<sessionId>.jsonl` 实时看 boundary 写入；`ls -la .mewcode/tool_results/` 看落盘文件。

### 场景 E13：UsageInfo cache 字段累加- [ ] **触发**：stub anthropic client 在 stream_end 事件带 `usage = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 8000, cacheCreationInputTokens: 200 }`。
- [ ] **预期**：Agent 内 `usageAnchor.baselineTokens === 9700`（四项相加），不是只取 inputTokens。
- [ ] **观察方式**：单测在 Agent 类上暴露 `_testGetUsageAnchor` 方法（仅测试用），或通过下一轮 manageContext 行为侧推。

### 场景 E14：压缩后 anchor 必须清零- [ ] **触发**：让 manageContext 在某轮返回 `{compacted: true}`。
- [ ] **预期**：紧随其后的 `currentContextTokens(conv, this.usageAnchor)` 调用走 `anchor === null` 冷启动分支（即 `estimateMessages(conv.getMessages())`），不再用旧的 baselineTokens + anchorCount。
- [ ] **观察方式**：单测在 Agent 上观察 `usageAnchor === null` 在压缩后立即为真；下一轮 manageContext 入口处 `tokens` 等于 `estimateTokens(conv)`（即冷启动估算结果）。
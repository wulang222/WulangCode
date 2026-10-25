import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Agent } from "../../src/agent/agent.ts";
import type { AgentEvent } from "../../src/agent/events.ts";
import type { Message, ToolResultBlock, ToolUseBlock, ThinkingBlock } from "../../src/conversation/conversation.ts";
import { ConversationManager as Conv } from "../../src/conversation/conversation.ts";
import type { LLMClient } from "../../src/llm/client.js";
import type { StreamEvent } from "../../src/llm/events.ts";
import { emptyUsage } from "../../src/llm/events.ts";
import { ContextTooLongError } from "../../src/llm/errors.ts";
import { RecoveryState } from "../../src/compact/recovery.ts";
import { estimateMessages } from "../../src/compact/compact.ts";
import { PermissionChecker } from "../../src/permissions/checker.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ReadFileTool } from "../../src/tools/read-file.ts";
import { WriteFileTool } from "../../src/tools/write-file.ts";
import type { Tool, ToolCategory } from "../../src/tools/types.ts";

type Script = StreamEvent[];

/** 可配置每次 stream 吐什么事件的假 client；记录调用次数、收到的 tools 与每轮历史快照。 */
class FakeLLMClient implements LLMClient {
  streamCalls = 0;
  lastToolSchemas: Record<string, unknown>[] = [];
  receivedMessages: Message[][] = [];

  constructor(private readonly pick: (call: number) => Script | undefined) {}

  async *stream(
    conv: Conv,
    tools: Record<string, unknown>[],
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // 与真实 client 一致：走请求视图（持久历史 + 待发 system-reminder）。
    this.receivedMessages.push(conv.getRequestMessages());
    const script = this.pick(this.streamCalls);
    this.streamCalls += 1;
    this.lastToolSchemas = tools;
    if (!script) throw new Error(`unexpected stream call #${this.streamCalls}`);
    for (const event of script) yield event;
  }
}

const scripted = (...scripts: Script[]) => new FakeLLMClient((call) => scripts[call]);

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  return registry;
}

function readFileCall(filePath: string, id: string): Script {
  return [
    { type: "tool_call_start", toolName: "ReadFile", toolId: id },
    { type: "tool_call_delta", text: "{\"file_path\":" },
    { type: "tool_call_delta", text: `"${filePath}"}` },
    { type: "tool_call_complete", toolId: id, toolName: "ReadFile", arguments: { file_path: filePath } },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
}

function finalText(text: string): Script {
  return [
    { type: "text_delta", text },
    { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
  ];
}

/** 历史配对合法性：每个 tool_use 都有对应 tool_result，无悬空。 */
function expectHistoryValid(messages: Message[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const use of message.toolUses ?? []) pending.add(use.toolUseId);
    for (const result of message.toolResults ?? []) {
      expect(pending.has(result.toolUseId)).toBe(true);
      pending.delete(result.toolUseId);
    }
  }
  expect(pending.size).toBe(0);
}

async function collect(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.run()) events.push(ev);
  return events;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- 场景 A（AC1）：多轮自动连环 ----------

test("场景 A：读文件 → 回灌 → 续答给最终答复，全程无需干预", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "note.txt");
  writeFileSync(filePath, "hello agent\n", "utf-8");

  const client = scripted(readFileCall(filePath, "t1"), finalText("这个文件内容是 hello agent"));
  const conv = new Conv();
  conv.addUserMessage("读这个文件并总结");

  const events = await collect(
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(dir, "bypassPermissions"), conversation: conv, workDir: dir }),
  );

  // 不再单轮收口：两轮自动连环
  expect(client.streamCalls).toBe(2);
  const types = new Set(events.map((e) => e.type));
  for (const type of ["tool_use", "tool_result", "turn_complete", "stream_text", "usage", "loop_complete"] as const) {
    expect(types.has(type)).toBe(true);
  }
  const toolResult = events.find((e) => e.type === "tool_result");
  expect(toolResult && toolResult.type === "tool_result" ? toolResult.output : "").toContain("hello agent");
  const loop = events[events.length - 1];
  expect(loop?.type).toBe("loop_complete");
  expect(loop?.type === "loop_complete" ? loop.stopReason : "").toBe("end_turn");

  // 历史：user → assistant(toolUses) → user(toolResults) → assistant(最终答复)
  const messages = conv.getMessages();
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  const toolUse = messages[1]?.toolUses?.[0] as ToolUseBlock | undefined;
  expect(toolUse?.toolName).toBe("ReadFile");
  expect(toolUse?.toolUseId).toBe("t1");
  const result = messages[2]?.toolResults?.[0] as ToolResultBlock | undefined;
  expect(result?.toolUseId).toBe("t1");
  expect(result?.isError).toBe(false);
  expect(messages[3]?.content).toBe("这个文件内容是 hello agent");
  expectHistoryValid(messages);
});

// ---------- 场景 B（AC3）：迭代上限兜底 ----------

test("场景 B：maxIterations=5 时第 5 轮后 yield error，不无限循环", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "note.txt");
  writeFileSync(filePath, "x", "utf-8");

  const client = new FakeLLMClient((call) => readFileCall(filePath, `t${call}`));
  const conv = new Conv();
  conv.addUserMessage("一直读");
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      maxIterations: 5,
    }),
  );

  expect(client.streamCalls).toBe(5);
  const error = events.find((e) => e.type === "error");
  expect(error).toBeDefined();
  expect(error?.type === "error" ? error.error.message : "").toContain("最大迭代");
  expectHistoryValid(conv.getMessages());
});

// ---------- 场景 C（AC4）：连续未知工具停止 ----------

function unknownCall(id: string): Script {
  return [
    { type: "tool_call_complete", toolId: id, toolName: "NotATool", arguments: {} },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
}

test("场景 C1：连续 3 轮只请求未注册工具即停", async () => {
  const client = scripted(unknownCall("u1"), unknownCall("u2"), unknownCall("u3"));
  const conv = new Conv();
  conv.addUserMessage("幻觉工具");
  const events = await collect(
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker("/tmp", "bypassPermissions"), conversation: conv, workDir: "/tmp" }),
  );

  expect(client.streamCalls).toBe(3);
  const error = events.find((e) => e.type === "error");
  expect(error?.type === "error" ? error.error.message : "").toContain("未注册");
  // 未知工具以结构化错误结果回灌，历史配对合法
  const outputs = conv
    .getMessages()
    .flatMap((m) => m.toolResults ?? [])
    .map((r) => r.content);
  expect(outputs.length).toBe(3);
  expect(outputs[0]).toContain("unknown tool 'NotATool'");
  expectHistoryValid(conv.getMessages());
});

test("场景 C2：第 2 轮混入已注册工具，计数重置不提前停", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "note.txt");
  writeFileSync(filePath, "ok", "utf-8");

  const client = scripted(
    unknownCall("u1"),
    [
      { type: "tool_call_complete", toolId: "u2", toolName: "NotATool", arguments: {} },
      { type: "tool_call_complete", toolId: "r1", toolName: "ReadFile", arguments: { file_path: filePath } },
      { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
    ],
    finalText("done"),
  );
  const conv = new Conv();
  conv.addUserMessage("先幻觉后正常");
  const events = await collect(
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(dir, "bypassPermissions"), conversation: conv, workDir: dir }),
  );

  expect(client.streamCalls).toBe(3);
  expect(events.some((e) => e.type === "error")).toBe(false);
  const loop = events[events.length - 1];
  expect(loop?.type).toBe("loop_complete");
});

// ---------- 场景 D（AC8）：保序分批并发 ----------

interface Slot {
  n: number;
  start: number;
  end: number;
}

/** 插桩工具：记录每次执行的起止时刻，可配延迟与类别。 */
class SlowTool implements Tool {
  constructor(
    readonly name: string,
    readonly category: ToolCategory,
    private readonly slots: Slot[],
    private readonly ms: number,
  ) {}

  description = "instrumented";

  schema(): Record<string, unknown> {
    return { name: this.name, description: this.description, input_schema: { type: "object", properties: {} } };
  }

  async execute(args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
    const n = Number(args.n ?? 0);
    const start = Date.now();
    await sleep(this.ms);
    this.slots.push({ n, start, end: Date.now() });
    return { output: `${this.name}#${n}`, isError: false };
  }
}

test("场景 D：连续只读并发、写入串行且保序", async () => {
  const readSlots: Slot[] = [];
  const writeSlots: Slot[] = [];
  const registry = new ToolRegistry();
  registry.register(new SlowTool("SlowRead", "read", readSlots, 80));
  registry.register(new SlowTool("SlowWrite", "write", writeSlots, 20));

  const round: Script = [
    { type: "tool_call_complete", toolId: "d1", toolName: "SlowRead", arguments: { n: 1 } },
    { type: "tool_call_complete", toolId: "d2", toolName: "SlowRead", arguments: { n: 2 } },
    { type: "tool_call_complete", toolId: "d3", toolName: "SlowWrite", arguments: { n: 3 } },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
  const client = scripted(round, finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("跑一批");
  const events = await collect(
    new Agent({ client, registry, checker: new PermissionChecker("/tmp", "bypassPermissions"), conversation: conv, workDir: "/tmp" }),
  );

  // 两只读执行时间窗重叠（并发）
  expect(readSlots.length).toBe(2);
  const [a, b] = readSlots as [Slot, Slot];
  expect(a.end > b.start).toBe(true);
  expect(b.end > a.start).toBe(true);
  // 写入开始不早于两只读全部结束（串行且不提前；Date.now 为毫秒粒度，取 >=）
  expect(writeSlots.length).toBe(1);
  expect(writeSlots[0]!.start).toBeGreaterThanOrEqual(Math.max(a.end, b.end));
  // tool_result 顺序匹配调用序
  const order = events.filter((e) => e.type === "tool_result").map((e) => (e.type === "tool_result" ? e.toolName : ""));
  expect(order).toEqual(["SlowRead", "SlowRead", "SlowWrite"]);
});

// ---------- 场景 E（AC9/AC10）：用户取消 ----------

test("场景 E：工具执行期间 abort，历史以 assistant 文本收尾、无悬空 tool_use", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const slots: Slot[] = [];
  const registry = new ToolRegistry();
  registry.register(new SlowTool("Block", "read", slots, 1000));

  const script: Script = [
    { type: "text_delta", text: "我先看看" },
    { type: "tool_call_complete", toolId: "e1", toolName: "Block", arguments: {} },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
  const client = scripted(script);
  const conv = new Conv();
  conv.addUserMessage("慢慢来");
  const controller = new AbortController();
  const events: AgentEvent[] = [];

  const runPromise = (async () => {
    for await (const ev of new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      abortSignal: controller.signal,
    }).run()) {
      events.push(ev);
    }
  })();
  await sleep(100);
  controller.abort();
  await runPromise;

  expect(slots.length).toBe(1); // 工具确实执行过
  const loop = events[events.length - 1];
  expect(loop?.type).toBe("loop_complete");
  expect(loop?.type === "loop_complete" ? loop.stopReason : "").toBe("interrupted");
  const messages = conv.getMessages();
  const last = messages[messages.length - 1];
  expect(last?.role).toBe("assistant");
  expect(last?.content).toBe("我先看看");
  expect(last?.toolUses).toBeUndefined();
  expectHistoryValid(messages);
});

// ---------- 场景 F（AC13）：Plan Mode ----------

test("场景 F1：plan 模式注入计划态提醒，ExitPlanMode 后循环停止", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "note.txt");
  writeFileSync(filePath, "plan me", "utf-8");

  const client = scripted(
    readFileCall(filePath, "f1"),
    [
      { type: "tool_call_complete", toolId: "f2", toolName: "ExitPlanMode", arguments: {} },
      { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
    ],
  );
  const conv = new Conv();
  conv.addUserMessage("给个方案");
  const checker = new PermissionChecker(dir, "plan");
  const events = await collect(
    new Agent({ client, registry: makeRegistry(), checker, conversation: conv, workDir: dir }),
  );

  // 每轮注入计划态提醒：两轮 stream 各自看到的最后一条消息都是 <system-reminder> 包裹的 plan 提醒
  expect(client.streamCalls).toBe(2);
  for (const snapshot of client.receivedMessages) {
    const last = snapshot[snapshot.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("<system-reminder>");
    expect(last?.content).toContain("Plan mode");
  }
  // 按轮次切换详略（F7）：首轮完整、第二轮精简
  expect(client.receivedMessages[0]?.[client.receivedMessages[0]!.length - 1]?.content).toContain("Phase 1: Initial Understanding");
  expect(client.receivedMessages[1]?.[client.receivedMessages[1]!.length - 1]?.content).toContain("Plan mode still active");
  // 提醒不写入持久历史（AC8）：历史里没有任何 <system-reminder>
  expect(conv.getMessages().some((m) => m.content.includes("<system-reminder>"))).toBe(false);
  // 只读工具在 plan 模式照常执行
  const toolResult = events.find((e) => e.type === "tool_result");
  expect(toolResult?.type === "tool_result" ? toolResult.isError : true).toBe(false);
  // ExitPlanMode 声明后不再有第 3 轮（超出脚本会 throw），以 loop_complete 收尾
  const loop = events[events.length - 1];
  expect(loop?.type).toBe("loop_complete");
  expect(loop?.type === "loop_complete" ? loop.stopReason : "").toBe("end_turn");
  expectHistoryValid(conv.getMessages());
});

test("场景 F2：plan 模式物理拦截写入工具", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const target = join(dir, "out.txt");
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool());

  const client = scripted(
    [
      {
        type: "tool_call_complete",
        toolId: "w1",
        toolName: "WriteFile",
        arguments: { file_path: target, content: "should not land" },
      },
      { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
    ],
    finalText("planned"),
  );
  const conv = new Conv();
  conv.addUserMessage("直接改吧");
  const events = await collect(
    new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "plan"),
      conversation: conv,
      workDir: dir,
    }),
  );

  const toolResult = events.find((e) => e.type === "tool_result");
  expect(toolResult?.type === "tool_result" ? toolResult.isError : false).toBe(true);
  expect(toolResult?.type === "tool_result" ? toolResult.output : "").toContain("Permission denied");
  expect(existsSync(target)).toBe(false);
  expectHistoryValid(conv.getMessages());
});

test("场景 F3：已激活 Skill 与计划态提醒走同一 <system-reminder> 通道（F6）", async () => {
  const client = scripted(finalText("ok"));
  const conv = new Conv();
  conv.addUserMessage("帮我提交");
  await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker("/tmp", "bypassPermissions"),
      conversation: conv,
      workDir: "/tmp",
      activeSkills: new Map([["commit-helper", "1. run tests\n2. commit"]]),
    }),
  );
  const snapshot = client.receivedMessages[0] ?? [];
  const last = snapshot[snapshot.length - 1];
  expect(last?.role).toBe("user");
  expect(last?.content).toContain("<system-reminder>");
  expect(last?.content).toContain("# Active Skills");
  expect(last?.content).toContain("commit-helper");
  // 不写持久历史；无激活时不注入
  expect(conv.getMessages().some((m) => m.content.includes("<system-reminder>"))).toBe(false);
  const bare = scripted(finalText("ok"));
  const bareConv = new Conv();
  bareConv.addUserMessage("hi");
  await collect(
    new Agent({ client: bare, registry: makeRegistry(), checker: new PermissionChecker("/tmp", "bypassPermissions"), conversation: bareConv, workDir: "/tmp" }),
  );
  const bareSnapshot = bare.receivedMessages[0] ?? [];
  expect(bareSnapshot.some((m) => m.content.includes("<system-reminder>"))).toBe(false);
});

// ---------- 既有回归：thinking 落库 / schema 注入 ----------

test("thinking 块随 addAssistantFull 落库", async () => {
  const client = scripted([
    { type: "thinking_delta", text: "让我想想" },
    { type: "thinking_complete", thinking: "让我想想", signature: "sig-1" },
    { type: "text_delta", text: "答案" },
    { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
  ]);
  const conv = new Conv();
  conv.addUserMessage("?");
  const events = await collect(
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker("/tmp", "bypassPermissions"), conversation: conv, workDir: "/tmp" }),
  );

  expect(events.some((e) => e.type === "thinking_complete")).toBe(true);
  const assistant = conv.getMessages()[1];
  const thinking = assistant?.thinkingBlocks?.[0] as ThinkingBlock | undefined;
  expect(thinking?.thinking).toBe("让我想想");
  expect(thinking?.signature).toBe("sig-1");
  expect(assistant?.content).toBe("答案");
});

test("工具 schema 随请求注入", async () => {
  const client = scripted(finalText("ok"));
  const conv = new Conv();
  conv.addUserMessage("hi");
  await collect(
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker("/tmp", "bypassPermissions"), conversation: conv, workDir: "/tmp" }),
  );
  expect(client.lastToolSchemas.length).toBe(1);
  expect((client.lastToolSchemas[0] as { name?: string }).name).toBe("ReadFile");
});

// ---------- 场景 G（ch06）：权限拦截 / HITL / 批次独立性 ----------

test("场景 G1：deny 回灌结构化错误并附安全话术，同批其他调用照常执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "ok.txt");
  writeFileSync(filePath, "fine", "utf-8");
  const registry = makeRegistry();

  const round: Script = [
    { type: "tool_call_complete", toolId: "b1", toolName: "Bash", arguments: { command: "rm -rf /" } },
    { type: "tool_call_complete", toolId: "r1", toolName: "ReadFile", arguments: { file_path: filePath } },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
  const client = scripted(round, finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("干两件事");
  const events = await collect(
    new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "bypassPermissions"), // 全放行模式下黑名单仍拦（N1）
      conversation: conv,
      workDir: dir,
    }),
  );

  const results = events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[];
  expect(results.length).toBe(2);
  const denied = results.find((r) => r.toolId === "b1")!;
  expect(denied.isError).toBe(true);
  expect(denied.output).toContain("Permission denied");
  expect(denied.output).toContain("Dangerous command blocked");
  expect(denied.output).toContain("此操作已被安全策略拦截和阻止");
  const allowed = results.find((r) => r.toolId === "r1")!;
  expect(allowed.isError).toBe(false);
  expect(allowed.output).toContain("fine");
  // 结果按原调用序回灌，Agent Loop 继续到下一轮
  expect(results.map((r) => r.toolId)).toEqual(["b1", "r1"]);
  expect(client.streamCalls).toBe(2);
  expectHistoryValid(conv.getMessages());
});

test("场景 G2：ask 经 onPermissionRequest 三分支（allow 执行 / deny 回灌 / allowAlways 落盘）", async () => {
  // 用短路径固定目录（/tmp 属沙箱允许根）：macOS mkdtemp 长路径会触发 60 字符
  // 截断，而 glob 的 * 不跨 /，截断点后含斜杠的路径匹配不回自身（文档配方的已知边界）。
  const dir = mkdtempSync("/tmp/mewcode-g2-");
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool());

  const writeRound = (target: string, id: string): Script => [
    { type: "tool_call_complete", toolId: id, toolName: "WriteFile", arguments: { file_path: target, content: "x" } },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];

  const runOnce = async (answer: "allow" | "deny" | "allowAlways", target: string) => {
    const client = scripted(writeRound(target, "w1"), finalText("done"));
    const conv = new Conv();
    conv.addUserMessage("写文件");
    let asked = 0;
    const events = await collect(
      new Agent({
        client,
        registry,
        checker: new PermissionChecker(dir, "default"), // 写 → ask
        conversation: conv,
        workDir: dir,
        onPermissionRequest: async () => {
          asked += 1;
          return answer;
        },
      }),
    );
    return { events, asked };
  };

  // allow：触发一次 ask，执行
  const target1 = join(dir, "hitl-allow.txt");
  const r1 = await runOnce("allow", target1);
  expect(r1.asked).toBe(1);
  expect(existsSync(target1)).toBe(true);

  // deny：不执行，回灌用户拒绝
  const target2 = join(dir, "hitl-deny.txt");
  const r2 = await runOnce("deny", target2);
  expect(existsSync(target2)).toBe(false);
  const denied = r2.events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }> | undefined;
  expect(denied?.isError).toBe(true);
  expect(denied?.output).toContain("Permission denied by user");

  // allowAlways：执行 + 规则落盘，之后同调用直接 allow（无需重启，ask 不再触发）
  const target3 = join(dir, "hitl-always.txt");
  const r3 = await runOnce("allowAlways", target3);
  expect(r3.asked).toBe(1);
  expect(existsSync(target3)).toBe(true);
  const localPath = join(dir, ".mewcode", "permissions.local.yaml");
  expect(existsSync(localPath)).toBe(true);
  // pattern 采用 60 字符截断 + "*"（F10），按同一规则计算期望串。
  const expectedPattern = target3.length > 60 ? `${target3.slice(0, 60)}*` : `${target3}*`;
  expect(readFileSync(localPath, "utf-8")).toContain(`WriteFile(${expectedPattern})`);
  const r4 = await runOnce("allow", target3); // 用 allow 桩但预期根本不触发 ask
  expect(r4.asked).toBe(0);
  const r4Results = r4.events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[];
  expect(r4Results[0]?.isError).toBe(false);
});

test("场景 G3：只读批次仍并发执行，批内被沙箱拦的独立回灌不拖累其他", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const registry = new ToolRegistry();
  for (let i = 1; i <= 4; i += 1) writeFileSync(join(dir, `f${i}.txt`), `content-${i}`, "utf-8");
  registry.register(new ReadFileTool());

  const round: Script = [
    { type: "tool_call_complete", toolId: "g1", toolName: "ReadFile", arguments: { file_path: join(dir, "f1.txt") } },
    { type: "tool_call_complete", toolId: "g2", toolName: "ReadFile", arguments: { file_path: join(dir, "f2.txt") } },
    { type: "tool_call_complete", toolId: "g3", toolName: "ReadFile", arguments: { file_path: "/etc/passwd" } },
    { type: "tool_call_complete", toolId: "g4", toolName: "ReadFile", arguments: { file_path: join(dir, "f3.txt") } },
    { type: "tool_call_complete", toolId: "g5", toolName: "ReadFile", arguments: { file_path: join(dir, "f4.txt") } },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
  const client = scripted(round, finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("读一批");
  const events = await collect(
    new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "default"),
      conversation: conv,
      workDir: dir,
    }),
  );

  const results = events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[];
  expect(results.length).toBe(5);
  // 按原调用序配对
  expect(results.map((r) => r.toolId)).toEqual(["g1", "g2", "g3", "g4", "g5"]);
  // 沙箱外的 g3 被拦，其余 4 个正常执行
  const blocked = results.find((r) => r.toolId === "g3")!;
  expect(blocked.isError).toBe(true);
  expect(blocked.output).toContain("outside allowed directories");
  for (const r of results.filter((x) => x.toolId !== "g3")) {
    expect(r.isError).toBe(false);
  }
  // default 模式只读不触发任何 ask（N3）
  expect(events.some((e) => e.type === "permission_request")).toBe(false);
  expectHistoryValid(conv.getMessages());
});

// ---------- 场景 H（ch08）：上下文管理 ----------

/** 按 tools 区分主对话 / 摘要请求的可编程 stub：记录每轮收到的消息视图。 */
class ContextStubClient implements LLMClient {
  calls = 0;
  mainCalls = 0;
  summaryCalls = 0;
  received: Message[][] = [];

  constructor(
    private readonly main: (client: ContextStubClient) => Script,
    private readonly summary: (client: ContextStubClient) => Script = () => [
      { type: "text_delta", text: "<analysis>a</analysis><summary>STUB SUMMARY</summary>" },
    ],
  ) {}

  async *stream(conv: Conv, tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    this.received.push(conv.getRequestMessages());
    let script: Script;
    if (tools.length === 0) {
      this.summaryCalls += 1;
      script = this.summary(this);
    } else {
      this.mainCalls += 1;
      script = this.main(this);
    }
    for (const event of script) {
      // 全零 usage 的桩输出回填当前请求的估算 token：锚点语义与真实 provider 一致。
      if (event.type === "stream_end" && isZeroUsage(event.usage)) {
        yield { ...event, usage: { ...emptyUsage(), inputTokens: estimateMessages(conv.getMessages()) } };
        continue;
      }
      yield event;
    }
  }
}

function isZeroUsage(u: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }): boolean {
  return u.inputTokens === 0 && u.outputTokens === 0 && u.cacheReadInputTokens === 0 && u.cacheCreationInputTokens === 0;
}

/** 7 条短消息：保证 computeKeepStartIndex 有 >= 2 条可摘要前缀。 */
function seededConversation(): Conv {
  const conv = new Conv();
  conv.addUserMessage("q1");
  conv.addAssistantMessage("a1");
  conv.addUserMessage("q2");
  conv.addAssistantMessage("a2");
  conv.addUserMessage("q3");
  conv.addAssistantMessage("a3");
  conv.addUserMessage("q4");
  return conv;
}

test("场景 H1：ContextTooLongError 自愈——紧急压缩后重试成功（I6/AC16）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  let attempt = 0;
  const client = new ContextStubClient(() => {
    attempt += 1;
    if (attempt === 1) throw new ContextTooLongError("prompt is too long: 999999 tokens");
    return finalText("恢复后的回答");
  });
  const conv = seededConversation();
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
    }),
  );

  // 主对话 PTL → 摘要一次 → 主对话重试一次
  expect(client.mainCalls + client.summaryCalls).toBeGreaterThanOrEqual(3);
  const compactEvent = events.find((e) => e.type === "compact");
  expect(compactEvent?.type === "compact" ? compactEvent.message : "").toContain(
    "Auto-compacted due to context length: Compacted 2 messages into summary",
  );
  // 对话被替换：中文框架 + 摘要 + verbatim 尾部
  const messages = conv.getMessages();
  expect(messages[0]!.content).toContain("本次会话延续自之前的对话");
  expect(messages[0]!.content).toContain("STUB SUMMARY");
  // 重试成功：流程正常收尾
  const loop = events[events.length - 1];
  expect(loop?.type).toBe("loop_complete");
  expect(events.some((e) => e.type === "error")).toBe(false);
  expectHistoryValid(messages);
});

test("场景 H2：紧急 forceCompact 自身失败 → yield error 后 return（I6 失败分支）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  let attempt = 0;
  const client = new ContextStubClient(
    () => {
      attempt += 1;
      throw new ContextTooLongError("prompt is too long");
    },
    () => {
      throw new Error("summary endpoint dead");
    },
  );
  const conv = seededConversation();
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
    }),
  );

  expect(attempt).toBe(1);
  const error = events.find((e) => e.type === "error");
  expect(error?.type === "error" ? error.error.name : "").toBe("ContextTooLongError");
  // generator 已 return：最后一个事件就是 error，没有 loop_complete / 二次压缩
  expect(events[events.length - 1]?.type).toBe("error");
});

test("场景 H3：usageAnchor 用最近一次 usage 替换，不累加（I4-bis/E13/AC22）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const client = new ContextStubClient((c) =>
    c.mainCalls <= 2
      ? [
          { type: "tool_call_complete", toolId: `u${c.mainCalls}`, toolName: "ReadFile", arguments: { file_path: join(dir, "n.txt") } },
          { type: "stream_end", stopReason: "tool_use", usage: { inputTokens: c.mainCalls === 1 ? 1000 : 1500, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        ]
      : [
          { type: "text_delta", text: "done" },
          { type: "stream_end", stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 8000, cacheCreationInputTokens: 200 } },
        ],
  );
  writeFileSync(join(dir, "n.txt"), "x", "utf-8");
  const conv = new Conv();
  conv.addUserMessage("三轮对话");
  const agent = new Agent({
    client,
    registry: makeRegistry(),
    checker: new PermissionChecker(dir, "bypassPermissions"),
    conversation: conv,
    workDir: dir,
  });
  await collect(agent);

  const anchor = agent._testGetUsageAnchor();
  // 四项相加 9700，且是最后一次 usage 的替换值（非 1000+1500+9700 累加）
  expect(anchor?.baselineTokens).toBe(9700);
});

test("场景 H4：ReadFile 成功后 recovery 记录磁盘纯净字节（I5/F19）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const filePath = join(dir, "raw.txt");
  writeFileSync(filePath, "第一行\n第二行\n", "utf-8");
  const client = scripted(readFileCall(filePath, "rr1"), finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("读文件");
  const recovery = new RecoveryState();
  await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      recoveryState: recovery,
    }),
  );
  const snapshot = recovery.snapshotFiles();
  expect(snapshot.length).toBe(1);
  expect(snapshot[0]!.path).toBe(filePath);
  // 与磁盘真实字节一致（工具输出带行号前缀，恢复段必须是无前缀原文）
  expect(snapshot[0]!.content).toBe("第一行\n第二行\n");
});

test("场景 H5：长会话不撞墙——30 轮 + 窗口 50000，自动压缩兜底（E1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const big = "K".repeat(30_000);
  class BigEchoTool implements Tool {
    readonly name = "BigEcho";
    readonly description = "echo big";
    readonly category = "read" as const;
    schema() {
      return { name: this.name, description: this.description, input_schema: { type: "object", properties: {} } };
    }
    async execute(): Promise<{ output: string; isError: boolean }> {
      return { output: big, isError: false };
    }
  }
  const registry = new ToolRegistry();
  registry.register(new BigEchoTool());

  const client = new ContextStubClient((c) =>
    c.mainCalls <= 30
      ? [
          { type: "tool_call_complete", toolId: `e${c.mainCalls}`, toolName: "BigEcho", arguments: {} },
          { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
        ]
      : finalText("全部完成"),
  );
  const conv = new Conv();
  conv.addUserMessage("跑 30 轮");
  const events = await collect(
    new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      contextWindow: 50_000,
    }),
  );

  expect(client.mainCalls).toBe(31);
  expect(client.summaryCalls).toBeGreaterThanOrEqual(1);
  const compacts = events.filter((e) => e.type === "compact");
  expect(compacts.length).toBeGreaterThanOrEqual(1);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events[events.length - 1]?.type).toBe("loop_complete");
  // 压缩吃掉了早期历史：最终消息数远小于 30 轮的原始累积（60+ 条）
  expect(conv.len()).toBeLessThan(30);
  expectHistoryValid(conv.getMessages());
});

test("场景 H6：80000 字符工具结果——下一轮请求已被预览替换、原文落盘（E2/AC1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const huge = "H".repeat(80_000);
  class HugeEchoTool implements Tool {
    readonly name = "HugeEcho";
    readonly description = "echo huge";
    readonly category = "read" as const;
    schema() {
      return { name: this.name, description: this.description, input_schema: { type: "object", properties: {} } };
    }
    async execute(): Promise<{ output: string; isError: boolean }> {
      return { output: huge, isError: false };
    }
  }
  const registry = new ToolRegistry();
  registry.register(new HugeEchoTool());

  let mainCalls = 0;
  const client = new ContextStubClient((c) => {
    mainCalls += 1;
    if (mainCalls === 1) {
      return [
        { type: "tool_call_complete", toolId: "huge-1", toolName: "HugeEcho", arguments: {} },
        { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
      ];
    }
    return finalText("done");
  });
  const conv = new Conv();
  conv.addUserMessage("来一次大输出");
  await collect(
    new Agent({
      client,
      registry,
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
    }),
  );

  // 第二轮主对话请求视图里，工具结果已是 <persisted-output> 预览体
  const second = client.received.find((snapshot, index) => index >= 1 && snapshot.some((m) => m.toolResults?.length));
  const replaced = second?.flatMap((m) => m.toolResults ?? []).find((tr) => tr.toolUseId === "huge-1");
  expect(replaced?.content.startsWith("<persisted-output>")).toBe(true);
  expect(replaced?.content).toContain(join(dir, ".mewcode", "tool_results", "huge-1"));
  // 原文完整落盘
  const spill = join(dir, ".mewcode", "tool_results", "huge-1");
  expect(statSync(spill).size).toBe(80_000);
  expect(readFileSync(spill, "utf-8")).toBe(huge);
});

test("场景 H7：紧急压缩后仍撞 PTL → 不做第二次紧急压缩，按错误上抛（F26）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const client = new ContextStubClient(() => {
    throw new ContextTooLongError("prompt is too long");
  });
  const conv = seededConversation();
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
    }),
  );

  // 1 次主对话 PTL + 1 次摘要（紧急压缩成功）+ 1 次重试 PTL → 收敛为 error
  const compacts = events.filter((e) => e.type === "compact");
  expect(compacts.length).toBe(1);
  const error = events.find((e) => e.type === "error");
  expect(error).toBeDefined();
  expect(events[events.length - 1]?.type).toBe("error");
});

// ---------- day8 T9：onLoopComplete 冒烟 ----------

test("onLoopComplete：loop 自然结束时回调一次，最终 assistant 已落库", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const client = scripted(finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("hi");
  let calls = 0;
  let lenAtCall = 0;
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      onLoopComplete: (c) => {
        calls += 1;
        lenAtCall = c.len();
      },
    }),
  );
  expect(calls).toBe(1);
  expect(events[events.length - 1]?.type).toBe("loop_complete");
  // 回调触发时最终答复已写入历史（user + assistant）
  expect(lenAtCall).toBe(2);
});

test("onLoopComplete 回调抛错不影响 loop 完结", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-agent-"));
  const client = scripted(finalText("done"));
  const conv = new Conv();
  conv.addUserMessage("hi");
  const events = await collect(
    new Agent({
      client,
      registry: makeRegistry(),
      checker: new PermissionChecker(dir, "bypassPermissions"),
      conversation: conv,
      workDir: dir,
      onLoopComplete: () => {
        throw new Error("boom");
      },
    }),
  );
  expect(events[events.length - 1]?.type).toBe("loop_complete");
  expect(conv.getMessages().length).toBe(2);
});

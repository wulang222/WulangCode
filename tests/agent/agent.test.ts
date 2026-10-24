import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(), conversation: conv, workDir: dir }),
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
      checker: new PermissionChecker(),
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
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(), conversation: conv, workDir: "/tmp" }),
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
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(), conversation: conv, workDir: dir }),
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
    new Agent({ client, registry, checker: new PermissionChecker(), conversation: conv, workDir: "/tmp" }),
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
      checker: new PermissionChecker(),
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
  const checker = new PermissionChecker("plan");
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
      checker: new PermissionChecker("plan"),
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
      checker: new PermissionChecker(),
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
    new Agent({ client: bare, registry: makeRegistry(), checker: new PermissionChecker(), conversation: bareConv, workDir: "/tmp" }),
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
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(), conversation: conv, workDir: "/tmp" }),
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
    new Agent({ client, registry: makeRegistry(), checker: new PermissionChecker(), conversation: conv, workDir: "/tmp" }),
  );
  expect(client.lastToolSchemas.length).toBe(1);
  expect((client.lastToolSchemas[0] as { name?: string }).name).toBe("ReadFile");
});

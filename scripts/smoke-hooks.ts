#!/usr/bin/env bun
/**
 * Hook 系统端到端冒烟（day10，Agent 层脚本，expect 驱动不了 Bun+Ink）：
 * 覆盖 checklist 端到端场景 1-8 的自动化等价（真实工具执行 + MockClient 脚本流）：
 * 1. turn_start prompt 注入 → 下一轮请求视图出现 <system-reminder>（场景 1/AC1）
 * 2. pre_tool_use 条件拦截：WriteFile 被拒、文件未写、Bash 放行（场景 2/AC2）
 * 3. post_tool_use async 后台命令：主循环不停顿、日志异步落盘（场景 3/AC3）
 * 4. session_start + once：首次注入、同引擎第二次 run 不再注入（场景 4/AC4）
 * 5. 非法 hook 不阻塞：validate 聚合告警、合法 hook 继续生效（场景 5/AC5）
 * 6. post_receive http：echo server 收到 POST、body JSON 含 event/message（场景 6/AC8）
 * 7. reject + async 互斥校验告警（场景 7/AC6）
 * 8. 场景 1+2+3 组合：一轮 run 内互不干扰（场景 8/AC10）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import { emptyUsage } from "../src/llm/events.js";
import { HookEngine, validate, type HookConfig } from "../src/hooks/hooks.ts";
import { PermissionChecker } from "../src/permissions/checker.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ReadFileTool } from "../src/tools/read-file.ts";
import { WriteFileTool } from "../src/tools/write-file.ts";
import { BashTool } from "../src/tools/bash.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Script = StreamEvent[];

/** 脚本驱动的假 client：记录每次请求视图，验证 system-reminder 注入。 */
class MockClient implements LLMClient {
  streamCalls = 0;
  received: { content: string; toolResults: string[] }[] = [];

  constructor(private readonly pick: (call: number) => Script | undefined) {}

  async *stream(conv: Conv, _tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    void _tools;
    this.received.push(
      conv.getRequestMessages().map((m) => ({
        content: typeof m.content === "string" ? m.content : "",
        toolResults: (m.toolResults ?? []).map((r) => r.content),
      })).reduce(
        (acc, m) => {
          acc.content += m.content + "\n";
          acc.toolResults.push(...m.toolResults);
          return acc;
        },
        { content: "", toolResults: [] as string[] },
      ),
    );
    const script = this.pick(this.streamCalls);
    this.streamCalls += 1;
    if (!script) throw new Error(`unexpected stream call #${this.streamCalls}`);
    for (const event of script) yield event;
  }

  /** 第 N 次请求（视图）里是否包含文本（含 tool_result 内容）。 */
  includes(call: number, text: string): boolean {
    const r = this.received[call];
    if (!r) return false;
    return r.content.includes(text) || r.toolResults.some((t) => t.includes(text));
  }
}

function finalText(text: string): Script {
  return [
    { type: "text_delta", text },
    { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
  ];
}

function toolCall(toolName: string, args: Record<string, unknown>, id: string): Script {
  return [
    { type: "tool_call_complete", toolId: id, toolName, arguments: args },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new BashTool());
  return registry;
}

async function runAgent(opts: {
  client: LLMClient;
  engine?: HookEngine;
  dir: string;
  userText: string;
  conv?: Conv;
}): Promise<AgentEvent[]> {
  const conv = opts.conv ?? new Conv();
  conv.addUserMessage(opts.userText);
  const agent = new Agent({
    client: opts.client,
    registry: makeRegistry(),
    checker: new PermissionChecker(opts.dir, "bypassPermissions"),
    conversation: conv,
    workDir: opts.dir,
    hookEngine: opts.engine,
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.run()) events.push(ev);
  return events;
}

const root = mkdtempSync(join(tmpdir(), "mewcode-smoke-hooks-"));
console.log(`workdir: ${root}`);

// ---- 场景 1（AC1）：turn_start prompt 注入 ----
{
  const dir = join(root, "s1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "note.txt");
  writeFileSync(file, "x", "utf-8");
  const engine = new HookEngine([
    { id: "zh-default", event: "turn_start", action: { type: "prompt", prompt: "请用中文回答" } },
  ]);
  const client = new MockClient((call) =>
    call === 0 ? toolCall("ReadFile", { file_path: file }, "t1") : finalText("好的"),
  );
  await runAgent({ client, engine, dir, userText: "读文件" });
  check("S1 首轮请求无提醒", !client.includes(0, "请用中文回答"));
  check("S1 下一轮请求注入「请用中文回答」", client.includes(1, "请用中文回答"));
  check("S1 注入为 <system-reminder> 形态", client.includes(1, "<system-reminder>"));
}

// ---- 场景 2 + AC7（glob 区分）：pre_tool_use 条件拦截 ----
{
  const dir = join(root, "s2");
  mkdirSync(dir, { recursive: true });
  const txt = join(dir, "hello.txt");
  const md = join(dir, "README.md");
  const engine = new HookEngine([
    {
      id: "block-txt",
      event: "pre_tool_use",
      condition: 'tool == "WriteFile" && file_path =* "**/*.txt"',
      reject: true,
      on_error: "reject",
      action: { type: "command", command: "echo 'blocked by hook policy' >&2; false" },
    },
  ]);
  const client = new MockClient((call) =>
    call === 0
      ? toolCall("WriteFile", { file_path: txt, content: "hi" }, "w1")
      : call === 1
        ? toolCall("WriteFile", { file_path: md, content: "# md" }, "w2")
        : finalText("done"),
  );
  const events = await runAgent({ client, engine, dir, userText: "写两个文件" });
  const rejected = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
      e.type === "tool_result" && e.output.startsWith("Rejected by hook:"),
  );
  check("S2 .txt 写入被拦截并回灌拒绝原因", rejected.length === 1 && rejected[0]!.isError);
  check("S2 拒绝原因含 Hook error (rejecting)", rejected[0]?.output.includes("Hook error (rejecting):") ?? false);
  check("S2 hello.txt 未被创建", !existsSync(txt));
  check("AC7 .md 不受 glob 匹配、正常写入", existsSync(md));
  check("S2 第 2 轮请求可见被拒 tool_result", client.includes(1, "Rejected by hook:"));
}

// ---- 场景 3（AC3）：post_tool_use async 后台命令 ----
{
  const dir = join(root, "s3");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "note.txt");
  const log = join(dir, "hook.log");
  writeFileSync(file, "x", "utf-8");
  const engine = new HookEngine([
    {
      id: "bg-log",
      event: "post_tool_use",
      async: true,
      action: { type: "command", command: `sleep 0.3; echo tool_done >> "${log}"` },
    },
  ]);
  const client = new MockClient((call) =>
    call === 0 ? toolCall("ReadFile", { file_path: file }, "t1") : finalText("done"),
  );
  const started = Date.now();
  await runAgent({ client, engine, dir, userText: "读文件" });
  const elapsed = Date.now() - started;
  // 主流程不等 sleep 0.3 的后台命令：整轮 run 应显著短于命令自身耗时 + 下一轮即续
  check("S3 主循环未阻塞（run 耗时 < 300ms）", elapsed < 300, `${elapsed}ms`);
  await sleep(600);
  check("S3 后台日志异步写入", existsSync(log) && readFileSync(log, "utf-8").includes("tool_done"));
}

// ---- 场景 4（AC4）：session_start + once ----
{
  const dir = join(root, "s4");
  mkdirSync(dir, { recursive: true });
  const engine = new HookEngine([
    { id: "first-session-note", event: "session_start", once: true, action: { type: "prompt", prompt: "first-session-only-note" } },
  ]);
  const first = new MockClient(() => finalText("ok"));
  await runAgent({ client: first, engine, dir, userText: "hi" });
  check("S4 首次 run 首轮请求注入 first-session-only-note", first.includes(0, "first-session-only-note"));
  const second = new MockClient(() => finalText("ok"));
  await runAgent({ client: second, engine, dir, userText: "again" });
  check("S4 第二次 run 不再注入（once 命中）", !second.includes(0, "first-session-only-note"));
}

// ---- 场景 5（AC5）：非法 hook 不阻塞启动、合法 hook 照常生效 ----
{
  const hooks: HookConfig[] = [
    { id: "bad-event", event: "not_a_real_event", action: { type: "command", command: "echo x" } },
    { id: "good", event: "turn_start", action: { type: "prompt", prompt: "ok-note" } },
  ];
  const err = validate(hooks);
  check("S5 校验聚合并返回 Error", err !== null);
  check(
    "S5 告警含 hook[0] 非法事件名",
    err?.message.includes('hook[0] (id="bad-event"): invalid event \'not_a_real_event\'') ?? false,
  );
  // 合法 hook 继续生效：用引擎实跑一轮
  const dir = join(root, "s5");
  mkdirSync(dir, { recursive: true });
  const engine = new HookEngine(hooks);
  const client = new MockClient((call) => (call === 0 ? toolCall("ReadFile", { file_path: "/etc/hostname" }, "t1") : finalText("done")));
  // 非法事件的 hook 在 fire 时因 event 不匹配任何触发点而静默跳过（F29）
  await runAgent({ client, engine, dir, userText: "读文件" });
  check("S5 合法 hook（good）下一轮生效", client.includes(1, "ok-note"));
}

// ---- 场景 6（AC8）：post_receive http 通知 ----
{
  const received: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        body: JSON.parse(await req.text()),
      });
      return new Response("ok");
    },
  });
  try {
    const dir = join(root, "s6");
    const engine = new HookEngine([
      { id: "notify-receive", event: "post_receive", action: { type: "http", url: `http://127.0.0.1:${server.port}/recv` } },
    ]);
    const client = new MockClient(() => finalText("done"));
    await runAgent({ client, engine, dir, userText: "hi" });
    check("S6 每轮回复完成收到一次 POST /recv", received.length === 1 && received[0]!.method === "POST" && received[0]!.path === "/recv");
    check(
      "S6 请求体 JSON 含 event 与 message 字段",
      received[0]?.body.event === "post_receive" && String(received[0]?.body.message ?? "").length > 0,
    );
  } finally {
    server.stop(true);
  }
}

// ---- 场景 7（AC6）：reject + async 互斥校验 ----
{
  const err = validate([
    { id: "bad-combo", event: "pre_tool_use", reject: true, async: true, action: { type: "command", command: "echo x" } },
  ]);
  check("S7 互斥组合产生告警", err !== null && err.message.includes("reject and async are mutually exclusive"));
}

// ---- 场景 8（AC10）：1+2+3 组合互不干扰 ----
{
  const dir = join(root, "s8");
  mkdirSync(dir, { recursive: true });
  const txt = join(dir, "hello.txt");
  const file = join(dir, "note.txt");
  const log = join(dir, "combo.log");
  writeFileSync(file, "x", "utf-8");
  const engine = new HookEngine([
    { id: "zh", event: "turn_start", action: { type: "prompt", prompt: "请用中文回答" } },
    {
      id: "block-write",
      event: "pre_tool_use",
      condition: 'tool == "WriteFile"',
      reject: true,
      on_error: "reject",
      action: { type: "command", command: "echo 'blocked by hook policy' >&2; false" },
    },
    { id: "bg-log", event: "post_tool_use", async: true, action: { type: "command", command: `echo tool_done >> "${log}"` } },
  ]);
  const client = new MockClient((call) =>
    call === 0
      ? toolCall("WriteFile", { file_path: txt, content: "hi" }, "w1")
      : call === 1
        ? toolCall("ReadFile", { file_path: file }, "t1")
        : finalText("done"),
  );
  const events = await runAgent({ client, engine, dir, userText: "写 txt 再读 note" });
  await sleep(400);
  check("S8 组合：WriteFile 被拦截", events.some((e) => e.type === "tool_result" && e.output.startsWith("Rejected by hook:")));
  check("S8 组合：ReadFile 正常执行（未被误拦）", events.some((e) => e.type === "tool_result" && !e.isError && e.toolName === "ReadFile"));
  check("S8 组合：async 日志已落盘", existsSync(log));
  check("S8 组合：prompt 提醒照常注入第 2 轮", client.includes(1, "请用中文回答"));
}

rmSync(root, { recursive: true, force: true });
console.log("");
if (failures === 0) {
  console.log("SMOKE PASS（day10 hooks）");
} else {
  console.log(`SMOKE FAIL: ${failures} 项未过`);
  process.exit(1);
}

#!/usr/bin/env bun
/**
 * 上下文管理端到端冒烟（day7 T33，Agent 层脚本，expect 驱动不了 Bun+Ink）：
 * 1. E2/E4：80KB 工具结果落盘 + 下一轮请求预览替换 + 多轮替换串逐字节一致（决策冻结）
 * 2. E5：手动压缩路径（forceCompact + saveCompactBoundary）→ 会话 jsonl 出现 compact_boundary 行
 * 3. T33-5：/resume 等价路径 loadSession + rebuildFromSession 展开压缩态
 * 4. E6：主对话 PTL → 紧急压缩 → 重试成功，事件序列正确
 * 5. E1：窗口 50000 + 24 轮 30KB 结果 → 自动压缩至少一次且全程无 error
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { Message } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import { emptyUsage } from "../src/llm/events.js";
import { ContextTooLongError } from "../src/llm/errors.js";
import { estimateMessages, forceCompact } from "../src/compact/compact.ts";
import { RecoveryState } from "../src/compact/recovery.ts";
import { ContentReplacementState } from "../src/toolresult/state.ts";
import {
  COMPACT_BOUNDARY,
  getSessionFilePath,
  loadSession,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "../src/session/session.ts";
import { PermissionChecker } from "../src/permissions/checker.ts";
import { ReadFileTool } from "../src/tools/read-file.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

type Script = StreamEvent[];

class EchoTool implements Tool {
  readonly name: string;
  readonly description = "echo payload";
  readonly category = "read" as const;
  constructor(name: string, private readonly payload: string) {
    this.name = name;
  }
  schema() {
    return { name: this.name, description: this.description, input_schema: { type: "object", properties: {} } };
  }
  async execute(): Promise<{ output: string; isError: boolean }> {
    return { output: this.payload, isError: false };
  }
}

/** 按 tools 区分主对话/摘要；零 usage 回填请求估算，锚点语义与线上一致。 */
class SmokeClient implements LLMClient {
  mainCalls = 0;
  summaryCalls = 0;
  received: Message[][] = [];
  private readonly summaryScript: Script = [
    { type: "text_delta", text: "<analysis>a</analysis><summary>SMOKE SUMMARY</summary>" },
  ];

  constructor(private readonly mainScript: (c: SmokeClient) => Script) {}

  async *stream(conv: Conv, tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    this.received.push(conv.getRequestMessages());
    let script: Script;
    if (tools.length === 0) {
      this.summaryCalls += 1;
      script = this.summaryScript;
    } else {
      this.mainCalls += 1;
      script = this.mainScript(this);
    }
    for (const event of script) {
      if (event.type === "stream_end") {
        const zero =
          event.usage.inputTokens === 0 &&
          event.usage.outputTokens === 0 &&
          event.usage.cacheReadInputTokens === 0 &&
          event.usage.cacheCreationInputTokens === 0;
        yield zero
          ? { ...event, usage: { ...emptyUsage(), inputTokens: estimateMessages(conv.getMessages()) } }
          : event;
        continue;
      }
      yield event;
    }
  }
}

async function collect(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.run()) events.push(ev);
  return events;
}

// ---------- E2/E4：大结果落盘 + 冻结 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "mewcode-smoke-e2-"));
  const huge = "S".repeat(80_000);
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new EchoTool("HugeEcho", huge));
  const state = new ContentReplacementState();

  const client = new SmokeClient((c) =>
    c.mainCalls <= 2
      ? [
          { type: "tool_call_complete", toolId: `smoke-huge${c.mainCalls === 2 ? "-2" : ""}`, toolName: "HugeEcho", arguments: {} },
          { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
        ]
      : [
          { type: "text_delta", text: "结束" },
          { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
        ],
  );
  const conv = new Conv();
  conv.addUserMessage("来一次大输出");
  // 第 2/3 轮是纯文本收尾：为观察多轮冻结，直接再手动跑两轮 Agent
  await collect(new Agent({ client, registry, checker: new PermissionChecker(dir, "bypassPermissions"), conversation: conv, workDir: dir, replacementState: state }));

  const spill = join(dir, ".mewcode", "tool_results", "smoke-huge");
  check("E2: spill 文件存在且 size = 80000", existsSync(spill) && statSync(spill).size === 80_000);
  const round2 = client.received[1]!.flatMap((m) => m.toolResults ?? []).find((tr) => tr.toolUseId === "smoke-huge");
  check("E2: 第二轮请求已替换为 <persisted-output> 预览", (round2?.content ?? "").startsWith("<persisted-output>"));
  // 冻结：第 2、3 轮请求视图里同一 toolUseId 的替换串逐字节一致
  const previewAtRound2 = round2?.content ?? "";
  const round3 = client.received[2]!.flatMap((m) => m.toolResults ?? []).find((tr) => tr.toolUseId === "smoke-huge");
  check("E4: 同一 toolUseId 多轮替换串逐字节一致", previewAtRound2 !== "" && round3?.content === previewAtRound2);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- E5 + T33-5：手动压缩 + boundary 持久化 + resume 重建 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "mewcode-smoke-e5-"));
  const workDir = dir;
  const sessionId = "smoke-s1";
  const sessionFilePath = getSessionFilePath(workDir, sessionId);
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  const recovery = new RecoveryState();

  // 模拟 TUI：先落几条普通消息，再走 /compact 分支的同一套调用
  const conv = new Conv();
  for (let i = 0; i < 6; i += 1) {
    const q = `历史问题 ${i} ` + "x".repeat(400);
    const a = `历史回答 ${i} ` + "y".repeat(400);
    conv.addUserMessage(q);
    conv.addAssistantMessage(a);
    saveMessage(workDir, sessionId, { role: "user", content: q, timestamp: new Date().toISOString() });
    saveMessage(workDir, sessionId, { role: "assistant", content: a, timestamp: new Date().toISOString() });
  }
  conv.addUserMessage("recent-q1");
  conv.addAssistantMessage("recent-a1");
  saveMessage(workDir, sessionId, { role: "user", content: "recent-q1", timestamp: new Date().toISOString() });
  saveMessage(workDir, sessionId, { role: "assistant", content: "recent-a1", timestamp: new Date().toISOString() });

  const tokensBefore = estimateMessages(conv.getMessages());
  const client = new SmokeClient(() => [{ type: "stream_end", stopReason: "end_turn", usage: emptyUsage() }]);
  const result = await forceCompact(
    conv,
    client,
    recovery,
    registry.listTools().map((t) => t.name),
    sessionFilePath,
  );
  check("E5: forceCompact 成功", result.compacted);
  check("E5: 消息模板匹配", /^Compacted \d+ messages into summary \(\d+ chars\), kept \d+ recent messages verbatim$/.test(result.message));
  check("E5: 摘要请求 tools 严格为空", client.summaryCalls === 1 && client.received[0]!.length >= 0);
  if (result.boundary) saveCompactBoundary(workDir, sessionId, result.boundary);
  const tokensAfter = estimateMessages(conv.getMessages());
  check("E5/F24: 压缩后估算 token 下降", tokensAfter < tokensBefore, `${tokensBefore} -> ${tokensAfter}`);

  const saved = loadSession(workDir, sessionId);
  const boundary = saved.find((m) => m.type === COMPACT_BOUNDARY);
  check("I9: jsonl 末尾存在 compact_boundary 行", boundary !== undefined && boundary.role === "system");
  check(
    "I9: boundary 内容可解析回 payload",
    boundary !== undefined && (JSON.parse(boundary.content) as { summary: string }).summary === "SMOKE SUMMARY",
  );

  const restored = rebuildFromSession(saved);
  check(
    "T33-5: resume 重建 = 摘要 + keep + 后续",
    restored[0]!.content.includes("本次会话延续自之前的对话") &&
      restored[0]!.content.includes("SMOKE SUMMARY") &&
      restored.some((m) => m.content === "recent-q1") &&
      !restored.some((m) => m.content === "历史问题 0"),
  );
  rmSync(dir, { recursive: true, force: true });
}

// ---------- E6：紧急自愈 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "mewcode-smoke-e6-"));
  const conv = new Conv();
  for (let i = 1; i <= 3; i += 1) {
    conv.addUserMessage(`q${i}`);
    conv.addAssistantMessage(`a${i}`);
  }
  conv.addUserMessage("q4");
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  const client = new SmokeClient((c) => {
    if (c.mainCalls === 1) throw new ContextTooLongError("prompt is too long");
    return [
      { type: "text_delta", text: "重试成功" },
      { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
    ];
  });
  const events = await collect(
    new Agent({ client, registry, checker: new PermissionChecker(dir, "bypassPermissions"), conversation: conv, workDir: dir }),
  );
  const compactEvent = events.find((e) => e.type === "compact");
  check(
    "E6: 紧急压缩事件前缀正确",
    compactEvent?.type === "compact" && compactEvent.message.startsWith("Auto-compacted due to context length: "),
  );
  check(
    "E6: 压缩后重试成功、流程正常收尾",
    events[events.length - 1]?.type === "loop_complete" && !events.some((e) => e.type === "error"),
  );
  check("E6: 对话头部为中文框架 + 摘要", conv.getMessages()[0]!.content.includes("本次会话延续自之前的对话"));
  rmSync(dir, { recursive: true, force: true });
}

// ---------- E1：长会话自动压缩 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "mewcode-smoke-e1-"));
  const big = "K".repeat(30_000);
  const registry = new ToolRegistry();
  registry.register(new EchoTool("BigEcho", big));
  const client = new SmokeClient((c) =>
    c.mainCalls <= 24
      ? [
          { type: "tool_call_complete", toolId: `e${c.mainCalls}`, toolName: "BigEcho", arguments: {} },
          { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
        ]
      : [
          { type: "text_delta", text: "全部完成" },
          { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
        ],
  );
  const conv = new Conv();
  conv.addUserMessage("跑 24 轮");
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
  const compacts = events.filter((e) => e.type === "compact" && e.message.startsWith("Compacted"));
  check("E1: 自动压缩至少触发一次", compacts.length >= 1, `compacts=${compacts.length}`);
  check("E1: 25 轮主对话全部完成", client.mainCalls === 25);
  check("E1: 无 error、正常收尾", !events.some((e) => e.type === "error") && events[events.length - 1]?.type === "loop_complete");
  check("E1: 最终对话长度被压缩压制", conv.len() < 25, `len=${conv.len()}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE OK (context)" : `\nSMOKE FAILED: ${failures} 项未过`);
process.exit(failures === 0 ? 0 : 1);

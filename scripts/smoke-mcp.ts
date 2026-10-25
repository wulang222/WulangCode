#!/usr/bin/env bun
/**
 * MCP 端到端冒烟（day6 T10，Agent 层脚本，expect 驱动不了 Bun+Ink）：
 * 1. 三步会话：stdio fixture server 真连 + 失败隔离（坏 server 进 errors）
 * 2. wrapper 注册后 deferred 默认不进 prompt；ToolSearch 关键词检索 + select: 激活
 * 3. Agent 真循环：模型(脚本化) 发起 ToolSearch → 激活 echo → tool_use 调用 → 结果回灌
 * 4. 权限：default 模式下 MCP 工具触发 ask（HITL 自动应答 allow），bypass 直接放行
 * 5. F10：server instructions 以 system-reminder 进入请求视图
 * 6. AC12：openai 协议下 MCP 工具被包成 function 形态
 */
import { Agent } from "../src/agent/agent.ts";
import { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { Message } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.ts";
import { emptyUsage } from "../src/llm/events.ts";
import { MCPManager } from "../src/mcp/manager.ts";
import { MCPToolWrapper } from "../src/mcp/tool-wrapper.ts";
import { PermissionChecker } from "../src/permissions/checker.ts";
import { BashTool } from "../src/tools/bash.ts";
import { EditFileTool } from "../src/tools/edit-file.ts";
import { GlobTool } from "../src/tools/glob.ts";
import { GrepTool } from "../src/tools/grep.ts";
import { ReadFileTool } from "../src/tools/read-file.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ToolSearchTool } from "../src/tools/tool-search.ts";
import { WriteFileTool } from "../src/tools/write-file.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

type Script = StreamEvent[];

class FakeLLMClient implements LLMClient {
  streamCalls = 0;
  receivedMessages: Message[][] = [];
  lastToolSchemas: Record<string, unknown>[] = [];
  constructor(private readonly pick: (call: number) => Script | undefined) {}
  async *stream(
    conv: Conv,
    tools: Record<string, unknown>[],
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.receivedMessages.push(conv.getRequestMessages());
    this.lastToolSchemas = tools;
    const script = this.pick(this.streamCalls);
    this.streamCalls += 1;
    if (!script) throw new Error(`unexpected stream call #${this.streamCalls}`);
    for (const event of script) yield event;
  }
}

function toolCall(toolName: string, toolId: string, args: Record<string, unknown>): Script {
  return [
    { type: "tool_call_start", toolName, toolId },
    { type: "tool_call_complete", toolId, toolName, arguments: args },
    { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
  ];
}

const finalText = (text: string): Script => [
  { type: "text_delta", text },
  { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
];

const fixture = `${import.meta.dir}/../tests/fixtures/echo-server.ts`;

// ── 1. 连接：失败隔离 + 三步会话 ───────────────────────────────
const manager = new MCPManager();
const result = await manager.connectAll([
  { name: "broken", command: "no-such-binary-smoke" },
  { name: "echo-fixture", command: "bun", args: [fixture] },
]);
check("失败隔离：broken 进 errors", result.errors.length === 1 && result.errors[0]!.serverName === "broken");
check("可用 server 完成 connect + listTools", result.servers.includes("echo-fixture") && result.tools.length >= 3);
check("握手 instructions 收集", result.instructions.some((i) => i.serverName === "echo-fixture" && i.text.length > 0));

// ── 2. 注册 wrapper（与 app.tsx 接线一致）──────────────────────
const registry = new ToolRegistry();
registry.register(new ReadFileTool());
registry.register(new BashTool());
registry.register(new GlobTool());
registry.register(new GrepTool());
registry.register(new WriteFileTool());
registry.register(new EditFileTool());
registry.register(new ToolSearchTool(registry));
for (const { serverName, tool } of result.tools) {
  const client = manager.getClient(serverName);
  if (client) registry.register(new MCPToolWrapper(client, serverName, tool));
}
const echoName = "mcp__echo-fixture__echo";
const flatNames = () =>
  registry.getAllSchemas("anthropic").map((s) => (s as { name?: string }).name) as string[];
check("AC6：注册后 deferred 工具默认不进工具清单", !flatNames().includes(echoName));
check("F9：未激活清单包含该工具", registry.getDeferredToolNames().includes(echoName));

// ── 3. ToolSearch 关键词 + select 激活 ─────────────────────────
const conv = new Conv();
const searchTool = registry.get("ToolSearch")!;
const ctx = { workDir: process.cwd() };
const keyword = await searchTool.execute({ query: "echo" }, ctx);
check(
  "AC7：关键词检索返回名称与描述且不激活",
  keyword.output.includes(`- ${echoName}:`) && !registry.isDiscovered(echoName),
  keyword.output,
);
// F10：instructions 注入请求视图（与 app.tsx 相同通道）
for (const { serverName, text } of result.instructions) {
  conv.addSystemReminder(`# MCP Server: ${serverName}\n${text}`);
}
const selected = await searchTool.execute({ query: `select:${echoName}` }, ctx);
check("AC7：select 返回 schema JSON 并激活", selected.output.includes('"input_schema"') && registry.isDiscovered(echoName));
check("AC6：激活后工具进入清单", flatNames().includes(echoName));
check("AC12：openai 协议包成 function 形态", (() => {
  const entry = registry.getAllSchemas("openai").find(
    (s) => (s as { function?: { name?: string } }).function?.name === echoName,
  ) as { function: { parameters: unknown } } | undefined;
  return entry?.function.parameters !== undefined;
})());

// ── 4. Agent 真循环：ToolSearch → echo 调用 → 结果回灌 ─────────
conv.addUserMessage("请用 ToolSearch 查 echo 工具并调用它");
const client = new FakeLLMClient((call) => {
  if (call === 0) return toolCall("ToolSearch", "t1", { query: "echo" });
  if (call === 1) return toolCall(echoName, "t2", { message: "hi from agent loop" });
  return finalText("echo 工具已调用成功");
});
const hitlAsks: string[] = [];
const agent = new Agent({
  client,
  registry,
  checker: new PermissionChecker(process.cwd(), "default"),
  conversation: conv,
  workDir: process.cwd(),
  onPermissionRequest: (toolName, _args, _decision) => {
    hitlAsks.push(toolName);
    return Promise.resolve("allow");
  },
});
let echoResult = "";
for await (const ev of agent.run()) {
  if (ev.type === "tool_result" && ev.toolId === "t2") echoResult = ev.output;
}
check("Agent 闭环：echo 调用结果回灌", echoResult === "echo: hi from agent loop", echoResult);
check("AC13：default 模式下 MCP 工具触发 HITL ask", hitlAsks.includes(echoName), hitlAsks.join(","));
check("ToolSearch 属 read 类不触发 HITL", !hitlAsks.includes("ToolSearch"));
check("F10：请求视图含 server instructions 提醒", (() => {
  const first = client.receivedMessages[0] ?? [];
  return first.some((m) => m.content.includes("# MCP Server: echo-fixture"));
})());
check("第一轮工具清单：已激活的在、未激活的不在", (() => {
  const names = (client.lastToolSchemas as { name?: string }[]).map((s) => s.name);
  return names.includes("ToolSearch") && names.includes(echoName) && !names.includes("mcp__echo-fixture__mixed");
})());

// ── 5. bypass 模式直接放行 ─────────────────────────────────────
const bypassChecker = new PermissionChecker(process.cwd(), "bypassPermissions");
check(
  "AC13：bypassPermissions 下 MCP 工具放行",
  bypassChecker.check(echoName, "command", { message: "x" }).effect === "allow",
);

await manager.disconnectAll();
check("disconnectAll 后 client 清空", manager.getClient("echo-fixture") === undefined);

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL: ${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);

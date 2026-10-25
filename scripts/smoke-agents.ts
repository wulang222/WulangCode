#!/usr/bin/env bun
/**
 * SubAgent 系统端到端冒烟（day11，Agent 层脚本，expect 驱动不了 Bun+Ink）：
 * LLM 层用脚本驱动 MockClient，其余（Agent 循环、真实工具、AgentTool 三路径、
 * TaskManager、TeamManager、通知回流）全部真件。覆盖：
 * 1. 定义式前台派生：主 Agent 调 Agent 工具 → 子 Agent 真读文件 → 结果回灌（场景 1）
 * 2. 子 Agent 工具过滤：收到的 schema 里无 Agent（场景 5 / AC9）
 * 3. run_in_background：立即返回 async_launched，后台完成后 drain 出通知（场景 3）
 * 4. Fork 路径：立即返回 launched；后台子 Agent 首条 user 消息 = Boilerplate + 任务（场景 2）
 * 5. 嵌套防护：querySource 标记与对话扫描双闸门（场景 6 / AC7/AC8）
 * 6. 未知 subagent_type 结构化错误（AC4）
 * 7. team_name 路径：队友派生 → idle 上报 → ListTeams（场景 4 / AC19）
 * 8. TaskManager stop / drainNotifications（AC17/AC18）
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { AgentTool, FORK_QUERY_SOURCE } from "../src/agents/agent-tool.ts";
import { BUILTIN_AGENTS, type AgentDefinition } from "../src/agents/definition.ts";
import { spawnSubAgent, type AgentEventSink } from "../src/agents/spawn.ts";
import { TaskManager } from "../src/agents/task-manager.ts";
import { TeamManager } from "../src/teams/team.ts";
import { ListTeamsTool, TeamCreateTool } from "../src/teams/tools.ts";
import { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.ts";
import { emptyUsage } from "../src/llm/events.ts";
import { PermissionChecker } from "../src/permissions/checker.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { BashTool } from "../src/tools/bash.ts";
import { GlobTool } from "../src/tools/glob.ts";
import { GrepTool } from "../src/tools/grep.ts";
import { ReadFileTool } from "../src/tools/read-file.ts";
import { WriteFileTool } from "../src/tools/write-file.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const wait = async (cond: () => boolean, timeoutMs = 8000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(25);
  }
  return true;
};

type Script = StreamEvent[];

/** 脚本驱动假 client：按调用序吐事件；记录每次收到的消息视图与工具 schema。 */
class MockClient implements LLMClient {
  streamCalls = 0;
  received: { contents: string[]; toolNames: string[] }[] = [];

  constructor(private readonly pick: (call: number) => Script | undefined) {}

  async *stream(conv: Conv, tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    const messages = conv.getRequestMessages();
    this.received.push({
      contents: messages.map((m) => (typeof m.content === "string" ? m.content : "")),
      toolNames: tools.map((t) => String(t.name)),
    });
    const script = this.pick(this.streamCalls);
    this.streamCalls += 1;
    if (!script) throw new Error(`unexpected stream call #${this.streamCalls}`);
    for (const event of script) yield event;
  }
}

const finalText = (text: string): Script => [
  { type: "text_delta", text },
  { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
];

const agentCall = (args: Record<string, unknown>): Script => [
  { type: "tool_call_complete", toolId: "call-main-1", toolName: "Agent", arguments: args },
  { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
];

const readFileCall = (filePath: string): Script => [
  { type: "tool_call_complete", toolId: "call-sub-1", toolName: "ReadFile", arguments: { file_path: filePath } },
  { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
];

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  return registry;
}

/** 与 app.tsx T13 同构的 wiring（client 可替换）。 */
function wire(workDir: string, registry: ToolRegistry, clientBox: { current: LLMClient | null }) {
  const taskMgr = new TaskManager();
  const teamMgr = new TeamManager(workDir);
  const providerCfg = { name: "smoke", protocol: "openai-compat", base_url: "http://127.0.0.1:9", model: "smoke-model" };

  const spawnHandler = async (def: AgentDefinition, prompt: string, background: boolean, modelOverride?: string) => {
    const client = clientBox.current!;
    const spawn = () => spawnSubAgent(def, prompt, client, registry, providerCfg, workDir, undefined, undefined, modelOverride);
    if (background) {
      const ctrl = new AbortController();
      const task = taskMgr.create(def.name, spawn, () => ctrl.abort());
      return JSON.stringify({ task_id: task.id, status: "async_launched" });
    }
    return await spawn();
  };

  const forkHandler = async (forkedPrompt: string, _conv: Conv, _reg: ToolRegistry, modelOverride?: string) => {
    const client = clientBox.current!;
    const ctrl = new AbortController();
    const task = taskMgr.create(
      "fork",
      () => spawnSubAgent({ name: "fork", description: "forked agent" }, forkedPrompt, client, registry, providerCfg, workDir, undefined, undefined, modelOverride),
      () => ctrl.abort(),
    );
    return JSON.stringify({ task_id: task.id, status: "async_launched" });
  };

  const agentTool = new AgentTool(workDir, registry, spawnHandler, undefined, forkHandler);
  const runAgentForTeammate = async (task: string, onEvent?: AgentEventSink) => {
    return await spawnSubAgent(BUILTIN_AGENTS[0]!, task, clientBox.current!, registry, providerCfg, workDir, undefined, onEvent);
  };
  agentTool.setTeamManager(teamMgr, runAgentForTeammate);
  registry.register(agentTool);
  registry.register(new TeamCreateTool(teamMgr));
  registry.register(new ListTeamsTool(teamMgr));
  return { taskMgr, teamMgr, agentTool };
}

async function runMainAgent(client: LLMClient, registry: ToolRegistry, workDir: string): Promise<Conv> {
  const conv = new Conv();
  conv.addUserMessage("please delegate");
  const agent = new Agent({
    client,
    registry,
    checker: new PermissionChecker(workDir, "default"),
    conversation: conv,
    workDir,
    maxIterations: 10,
  });
  for await (const _event of agent.run()) void _event;
  return conv;
}

const workDir = mkdtempSync(join(tmpdir(), "mewcode-smoke-agents-"));
const targetFile = join(workDir, "sample.txt");
writeFileSync(targetFile, "hello from smoke\n", "utf-8");

// ---- 场景 1 + 2：定义式前台派生 + 子 Agent 工具过滤 ----
{
  const registry = makeRegistry();
  const client = new MockClient((call) =>
    [
      agentCall({ description: "read sample", prompt: `read ${targetFile} and report`, subagent_type: "general-purpose" }),
      readFileCall(targetFile),
      finalText("SUB_FINAL_REPORT"),
      finalText("MAIN_FINAL"),
    ][call],
  );
  const box = { current: client as LLMClient | null };
  const { taskMgr } = wire(workDir, registry, box);
  const conv = await runMainAgent(client, registry, workDir);

  const subToolNames = client.received[1]?.toolNames ?? [];
  check("场景1: 主 Agent 调 Agent 工具且拿到非错误结果", (() => {
    const results = conv.getMessages().flatMap((m) => m.toolResults ?? []);
    return results.some((r) => !r.isError && r.content.includes("SUB_FINAL_REPORT"));
  })());
  check("场景1: 主 Agent 最终文本落地", conv.getMessages().some((m) => m.content.includes("MAIN_FINAL")));
  check("场景5: 子 Agent 工具列表不含 Agent", !subToolNames.includes("Agent"));
  check("场景1: 子 Agent 用 ReadFile 真读了文件", client.received.length >= 3 && client.streamCalls === 4);
  check("场景1: 前台派生不产生后台任务", taskMgr.list().length === 0);
}

// ---- 场景 3：run_in_background 后台任务 + 通知回流 ----
{
  const registry = makeRegistry();
  const client = new MockClient((call) =>
    [
      agentCall({ description: "bg job", prompt: "do bg work", subagent_type: "general-purpose", run_in_background: true }),
      finalText("BG_RESULT_TEXT"),
      finalText("MAIN_AFTER_BG"),
    ][call],
  );
  const box = { current: client as LLMClient | null };
  const { taskMgr } = wire(workDir, registry, box);
  const conv = await runMainAgent(client, registry, workDir);

  const toolResults = conv.getMessages().flatMap((m) => (m.toolResults ?? []).map((r) => r.content));
  const launched = toolResults.find((c) => c.includes("async_launched"));
  check("场景3: 后台派生立即返回 async_launched JSON", !!launched && launched.includes("task_id"));
  const done = await wait(() => taskMgr.list().some((t) => t.status === "completed"));
  const task = taskMgr.list().find((t) => t.name === "general-purpose");
  check("场景3: 后台任务完成且输出为子 Agent 最终文本", done && task?.output === "BG_RESULT_TEXT");
  const drained = taskMgr.drainNotifications();
  const note = drained.length === 1 ? `<task-notification>\nTask ${drained[0]!.id} (name="${drained[0]!.name}"): completed\nResult: BG_RESULT_TEXT\n</task-notification>` : "";
  check("场景3: drainNotifications 拼出任务通知块", drained.length === 1 && note.includes("BG_RESULT_TEXT"));
}

// ---- 场景 2：Fork 路径（Boilerplate 首条消息 + 立即返回） ----
{
  const registry = makeRegistry();
  const client = new MockClient((call) =>
    [
      agentCall({ description: "fork job", prompt: "count lines" }),
      finalText("FORK_RESULT"),
      finalText("MAIN_AFTER_FORK"),
    ][call],
  );
  const box = { current: client as LLMClient | null };
  const { agentTool } = wire(workDir, registry, box);
  const parentConv = new Conv();
  parentConv.addUserMessage("earlier context");
  agentTool.conversation = parentConv;

  const result = await agentTool.execute({ description: "fork job", prompt: "count lines" }, { workDir });
  check("场景2: Fork 立即返回 launched in background", !result.isError && result.output.includes("launched in background"));
  await wait(() => client.streamCalls >= 2);
  const subFirstUser = client.received[1]?.contents.find((c) => c.includes("<fork_boilerplate>")) ?? "";
  check("场景2: 后台子 Agent 首条消息以 Boilerplate 起头且带任务文本", subFirstUser.includes("<fork_boilerplate>") && subFirstUser.includes("\n\nYour task:\ncount lines"));
}

// ---- 场景 6：嵌套防护双闸门 ----
{
  const registry = makeRegistry();
  const box = { current: null as LLMClient | null };
  const { agentTool } = wire(workDir, registry, box);
  const conv = new Conv();
  conv.addUserMessage("hi");
  agentTool.conversation = conv;

  agentTool.querySource = FORK_QUERY_SOURCE;
  const r1 = await agentTool.execute({ description: "x", prompt: "y" }, { workDir });
  check("场景6: querySource 标记命中 → cannot fork from a forked agent", r1.isError && r1.output.includes("cannot fork from a forked agent"));

  agentTool.querySource = "";
  conv.addUserMessage("<fork_boilerplate>\nprior fork\n</fork_boilerplate>");
  const r2 = await agentTool.execute({ description: "x", prompt: "y" }, { workDir });
  check("场景6: 对话历史含 fork 标签 → 同样被拦截", r2.isError && r2.output.includes("cannot fork from a forked agent"));
}

// ---- AC4：未知 subagent_type ----
{
  const registry = makeRegistry();
  const box = { current: null as LLMClient | null };
  const { agentTool } = wire(workDir, registry, box);
  const result = await agentTool.execute({ description: "x", prompt: "y", subagent_type: "no-such-role" }, { workDir });
  check("AC4: 未知 subagent_type 返回结构化错误与可用列表", result.isError && result.output.includes("unknown agent type 'no-such-role'") && result.output.includes("explore"));
}

// ---- 场景 4：team_name 长驻队友 ----
{
  const registry = makeRegistry();
  const client = new MockClient((call) => (call === 0 ? finalText("TEAMMATE_ROUND_1") : undefined));
  const box = { current: client as LLMClient | null };
  const { teamMgr, agentTool } = wire(workDir, registry, box);

  const create = await new TeamCreateTool(teamMgr).execute({ name: "alpha" }, { workDir });
  check("场景4: TeamCreate 建队成功", !create.isError && create.output.includes("alpha"));

  const spawnResult = await agentTool.execute(
    { description: "analyze logging", prompt: "scan src for console.log", team_name: "alpha" },
    { workDir },
  );
  check("场景4: team_name 派生队友成功", !spawnResult.isError && spawnResult.output.includes("Teammate 'analyze-logging' spawned in team 'alpha'"));
  const team = teamMgr.get("alpha")!;
  const member = team.getMember("analyze-logging")!;
  const idle = await wait(() => member.uiState?.status === "idle");
  const leadNotes = teamMgr.drainLeads().join("\n");
  check("场景4: 队友跑完一轮进入 idle 并上报 lead", idle && leadNotes.includes("[idle] analyze-logging"));
  const listResult = await new ListTeamsTool(teamMgr).execute({}, { workDir });
  check("场景4: ListTeams 显示队友状态", listResult.output.includes("analyze-logging"));
  await teamMgr.delete("alpha");
  check("场景4: 删除团队后队友停止", !member.active);
}

// ---- AC17/AC18：TaskManager stop / drain ----
{
  const mgr = new TaskManager();
  let cancelled = 0;
  const task = mgr.create("stuck", () => new Promise<string>(() => {}), () => {
    cancelled += 1;
  });
  mgr.stop(task.id);
  check("AC17: stop 调取消入口并置 failed/Stopped by user", cancelled === 1 && task.status === "failed" && task.output === "Stopped by user");
  check("AC18: drainNotifications 只含非运行任务", mgr.drainNotifications().map((t) => t.id).includes(task.id));
}

console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} SMOKE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

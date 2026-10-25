import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { LLMClient } from "../llm/client.ts";
import type { ProviderConfig } from "../config/config.ts";
import type { StreamEvent } from "../llm/events.ts";
import { emptyUsage } from "../llm/events.ts";
import { resolveModelId } from "../llm/model-resolver.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentDefinition } from "./definition.ts";
import type { AgentEventSink } from "./spawn.ts";

// mock.module 捕获 createClient 的 (cfg, systemPrompt)，模型切换时返回可控假 client。
const createClientCalls: Array<{ cfg: Record<string, unknown>; systemPrompt: string }> = [];
let createdClient: LLMClient | null = null;
mock.module("../llm/client.ts", () => ({
  createClient: async (cfg: Record<string, unknown>, systemPrompt: string): Promise<LLMClient> => {
    createClientCalls.push({ cfg: { ...cfg }, systemPrompt });
    if (!createdClient) throw new Error("no fake client configured for createClient");
    return createdClient;
  },
}));

import { spawnSubAgent } from "./spawn.ts";

type Script = StreamEvent[] | { events: StreamEvent[]; thenThrow: Error };

/** 按调用序吐事件的假 client（与 tests/agent 同模式）；记录每次收到的消息与工具 schema。 */
class FakeLLMClient implements LLMClient {
  calls = 0;
  receivedTools: Array<Array<Record<string, unknown>>> = [];
  receivedContents: string[][] = [];
  constructor(private readonly scripts: Script[]) {}

  async *stream(conv: { getRequestMessages(): Array<{ content: unknown }> }, tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    this.receivedTools.push([...tools]);
    this.receivedContents.push(conv.getRequestMessages().map((m) => String(m.content ?? "")));
    const script = this.scripts[this.calls - 1];
    if (!script) throw new Error(`unexpected stream call #${this.calls}`);
    const events = Array.isArray(script) ? script : script.events;
    for (const event of events) yield event;
    if (!Array.isArray(script)) throw script.thenThrow;
  }
}

const finalText = (text: string): StreamEvent[] => [
  { type: "text_delta", text },
  { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() },
];

const echoTool: Tool = {
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({ name: "Echo", description: "echo", input_schema: { type: "object", properties: {} } }),
  execute: async () => ({ output: "echoed", isError: false }),
};

const workDir = mkdtempSync(join(tmpdir(), "mewcode-spawn-"));
const provider: ProviderConfig = {
  name: "p",
  protocol: "openai-compat",
  base_url: "http://127.0.0.1:9",
  model: "parent-model",
};

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

const def = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "test-agent",
  description: "test",
  ...extra,
});

/** T8：派生行为、模型切换、事件透传、错误与空输出兜底（AC15）。 */
describe("spawnSubAgent", () => {
  test("returns the accumulated text without creating a new client (no model override)", async () => {
    const client = new FakeLLMClient([finalText("ok")]);
    createClientCalls.length = 0;
    const result = await spawnSubAgent(def(), "do it", client, makeRegistry(), provider, workDir);
    expect(result).toBe("ok");
    expect(createClientCalls).toHaveLength(0);
  });

  test("model override resolves the alias and creates a new client with it", async () => {
    createdClient = new FakeLLMClient([finalText("haiku says hi")]);
    createClientCalls.length = 0;
    const result = await spawnSubAgent(def(), "task", new FakeLLMClient([]), makeRegistry(), provider, workDir, undefined, undefined, "haiku");
    expect(createClientCalls).toHaveLength(1);
    expect(createClientCalls[0]!.cfg.model).toBe(resolveModelId("haiku"));
    expect(result).toBe("haiku says hi");
  });

  test("systemPromptOverride replaces the built system prompt verbatim", async () => {
    createdClient = new FakeLLMClient([finalText("x")]);
    createClientCalls.length = 0;
    await spawnSubAgent(def({ systemPromptOverride: "OVERRIDE-PROMPT" }), "t", new FakeLLMClient([]), makeRegistry(), provider, workDir, undefined, undefined, "sonnet");
    expect(createClientCalls[0]!.systemPrompt).toBe("OVERRIDE-PROMPT");
  });

  test("forwards tool_use and usage events to onEvent and progress to onProgress", async () => {
    const client = new FakeLLMClient([
      [
        { type: "tool_call_complete", toolId: "t1", toolName: "Echo", arguments: { x: 1 } },
        { type: "stream_end", stopReason: "tool_use", usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 } },
      ],
      finalText("done after tool"),
    ]);
    const events: Parameters<AgentEventSink>[0][] = [];
    const progress: Array<{ turn?: number; lastTool?: string }> = [];
    const result = await spawnSubAgent(
      def(),
      "use echo",
      client,
      makeRegistry(),
      provider,
      workDir,
      (p) => progress.push({ ...p }),
      (e) => events.push({ ...e }),
    );
    expect(result).toBe("done after tool");
    expect(events).toContainEqual({ type: "tool_use", toolName: "Echo", args: { x: 1 } });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(progress).toContainEqual({ lastTool: "Echo" });
    expect(progress.some((p) => p.turn === 1)).toBe(true);
  });

  test("an error event is appended to the partial output", async () => {
    const client = new FakeLLMClient([{ events: [{ type: "text_delta", text: "partial" }], thenThrow: new Error("boom") }]);
    const result = await spawnSubAgent(def(), "t", client, makeRegistry(), provider, workDir);
    expect(result).toContain("partial");
    expect(result).toContain("[Error: boom]");
  });

  test("empty output falls back to the [No output] placeholder", async () => {
    const client = new FakeLLMClient([[{ type: "stream_end", stopReason: "end_turn", usage: emptyUsage() }]]);
    const result = await spawnSubAgent(def(), "t", client, makeRegistry(), provider, workDir);
    expect(result).toBe("[No output]");
  });

  test("maxTurns from the definition bounds the loop iterations", async () => {
    const client = new FakeLLMClient([
      [
        { type: "tool_call_complete", toolId: "t1", toolName: "Echo", arguments: {} },
        { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
      ],
    ]);
    const result = await spawnSubAgent(def({ maxTurns: 1 }), "t", client, makeRegistry(), provider, workDir);
    expect(client.calls).toBe(1);
    expect(result).toContain("最大迭代轮次");
  });

  test("the sub-agent registry drops the Agent tool (nesting guard, AC9)", async () => {
    const registry = makeRegistry();
    registry.register({
      name: "Agent",
      description: "agent",
      category: "read",
      schema: () => ({ name: "Agent", description: "agent", input_schema: { type: "object", properties: {} } }),
      execute: async () => ({ output: "", isError: false }),
    });
    const client = new FakeLLMClient([finalText("ok")]);
    await spawnSubAgent(def(), "t", client, registry, provider, workDir);
    const toolNames = client.receivedTools[0]!.map((s) => String(s.name));
    expect(toolNames).toContain("Echo");
    expect(toolNames).not.toContain("Agent");
  });
});

describe("spawnSubAgent hook integration", () => {
  test("hook engine fires pre_tool_use/post_tool_use inside the sub-agent (checklist 集成项)", async () => {
    const { HookEngine } = await import("../hooks/hooks.ts");
    const engine = new HookEngine([
      { event: "pre_tool_use", action: { type: "prompt", prompt: "PRE_NOTE" } },
      { event: "post_tool_use", action: { type: "prompt", prompt: "POST_NOTE" } },
    ]);
    const client = new FakeLLMClient([
      [
        { type: "tool_call_complete", toolId: "t1", toolName: "Echo", arguments: {} },
        { type: "stream_end", stopReason: "tool_use", usage: emptyUsage() },
      ],
      finalText("after hooks"),
    ]);
    const result = await spawnSubAgent(def(), "t", client, makeRegistry(), provider, workDir, undefined, undefined, undefined, engine);
    expect(result).toBe("after hooks");
    // post_tool_use 输出进通知队列后被子 Agent 下一轮 drain 成 system-reminder（day10 F25）；
    // pre_tool_use 非拦截输出按 day10 语义不回流（G6）。
    const secondTurn = client.receivedContents[1]!.join("\n");
    expect(secondTurn).toContain("POST_NOTE");
    expect(engine.drainNotifications()).toEqual([]);
  });
});

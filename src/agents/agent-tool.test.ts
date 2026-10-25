import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ConversationManager } from "../conversation/conversation.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import { TeamManager } from "../teams/team.ts";
import { AgentTool, FORK_QUERY_SOURCE } from "./agent-tool.ts";
import type { AgentDefinition } from "./definition.ts";

const ctx = { workDir: "/tmp" };
const workDir = mkdtempSync(join(tmpdir(), "mewcode-agent-tool-"));

const echoTool: Tool = {
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({ name: "Echo" }),
  execute: async () => ({ output: "", isError: false }),
};

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

type SpawnCall = { def: AgentDefinition; prompt: string; background: boolean; model?: string };
type ForkCall = { prompt: string; model?: string };

function makeHandlers() {
  const spawnCalls: SpawnCall[] = [];
  const forkCalls: ForkCall[] = [];
  return {
    spawnCalls,
    forkCalls,
    spawnHandler: async (def: AgentDefinition, prompt: string, background: boolean, model?: string) => {
      spawnCalls.push({ def, prompt, background, model });
      return "ok";
    },
    forkHandler: async (prompt: string, _conv: ConversationManager, _reg: ToolRegistry, model?: string) => {
      forkCalls.push({ prompt, model });
      return JSON.stringify({ task_id: "1", status: "async_launched" });
    },
  };
}

/** T12：schema、三条派生路径、嵌套阻断、团队路由（AC2-AC8、AC19-AC20）。 */
describe("AgentTool", () => {
  test("schema exposes the loaded role names as the subagent_type enum", () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    const schema = tool.schema() as {
      input_schema: { properties: { subagent_type: { enum: string[] } } };
    };
    for (const name of ["general-purpose", "plan", "explore"]) {
      expect(schema.input_schema.properties.subagent_type.enum).toContain(name);
    }
  });

  test("missing description or prompt is rejected", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    const result = await tool.execute({ description: "x" }, ctx);
    expect(result.output).toBe("Error: description and prompt are required");
    expect(result.isError).toBe(true);
  });

  test("unknown subagent_type returns a structured error with the available list", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    const result = await tool.execute({ description: "x", prompt: "y", subagent_type: "foo" }, ctx);
    expect(result.output).toContain("unknown agent type 'foo'");
    expect(result.output).toContain("explore");
    expect(result.isError).toBe(true);
  });

  test("a known subagent_type dispatches to the spawn handler with the definition", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    const result = await tool.execute({ description: "x", prompt: "y", subagent_type: "explore" }, ctx);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.def.name).toBe("explore");
    expect(h.spawnCalls[0]!.prompt).toBe("y");
    expect(h.spawnCalls[0]!.background).toBe(false);
    expect(result).toEqual({ output: "ok", isError: false });
  });

  test("run_in_background=true is passed through to the spawn handler", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    await tool.execute({ description: "x", prompt: "y", subagent_type: "explore", run_in_background: true }, ctx);
    expect(h.spawnCalls[0]!.background).toBe(true);
  });

  test("fork without conversation/forkHandler returns the context error (AC5)", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler);
    const result = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(result.output).toContain("fork requires parent conversation context");
    expect(result.isError).toBe(true);
  });

  test("fork with context launches the fork handler with boilerplate + task (AC6)", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, new ConversationManager(), h.forkHandler);
    const result = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(h.forkCalls).toHaveLength(1);
    expect(h.forkCalls[0]!.prompt.startsWith("<fork_boilerplate>")).toBe(true);
    expect(h.forkCalls[0]!.prompt).toContain("\n\nYour task:\ny");
    expect(result.output).toContain("launched in background");
    expect(result.isError).toBe(false);
  });

  test("querySource=FORK blocks re-forking (AC7)", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, new ConversationManager(), h.forkHandler);
    tool.querySource = FORK_QUERY_SOURCE;
    const result = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(result.output).toContain("cannot fork from a forked agent");
    expect(h.forkCalls).toHaveLength(0);
  });

  test("a conversation containing the fork tag is blocked by the history scan (AC8)", async () => {
    const h = makeHandlers();
    const conv = new ConversationManager();
    conv.addUserMessage("<fork_boilerplate>\nprior fork\n</fork_boilerplate>");
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, conv, h.forkHandler);
    const result = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(result.output).toContain("cannot fork from a forked agent");
    expect(h.forkCalls).toHaveLength(0);
  });

  test("team_name is ignored when no TeamManager is injected (falls through to fork)", async () => {
    const h = makeHandlers();
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, new ConversationManager(), h.forkHandler);
    await tool.execute({ description: "x", prompt: "y", team_name: "alpha" }, ctx);
    expect(h.forkCalls).toHaveLength(1);
  });

  test("team_name with an injected TeamManager spawns a derived-name teammate (AC19)", async () => {
    const h = makeHandlers();
    const teamMgr = new TeamManager(mkdtempSync(join(tmpdir(), "mewcode-team-")));
    teamMgr.create("alpha");
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, new ConversationManager(), h.forkHandler);
    tool.setTeamManager(teamMgr, async () => "done");
    const result = await tool.execute(
      { description: "analyze logging", prompt: "count console.log", team_name: "alpha" },
      ctx,
    );
    const team = teamMgr.get("alpha")!;
    expect(team.getMember("analyze-logging")).toBeDefined();
    expect(result.output).toContain("Teammate 'analyze-logging' spawned in team 'alpha'");
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("team_name pointing at a missing team returns the TeamCreate hint (AC20)", async () => {
    const h = makeHandlers();
    const teamMgr = new TeamManager(mkdtempSync(join(tmpdir(), "mewcode-team-")));
    const tool = new AgentTool(workDir, makeRegistry(), h.spawnHandler, new ConversationManager(), h.forkHandler);
    tool.setTeamManager(teamMgr, async () => "done");
    const result = await tool.execute({ description: "x", prompt: "y", team_name: "alpha" }, ctx);
    expect(result.output).toContain("team 'alpha' not found. Create it first with TeamCreate.");
    expect(result.isError).toBe(true);
  });

  test("spawn handler errors surface as Agent error results", async () => {
    const tool = new AgentTool(workDir, makeRegistry(), async () => {
      throw new Error("boom");
    });
    const result = await tool.execute({ description: "x", prompt: "y", subagent_type: "explore" }, ctx);
    expect(result.output).toContain("Agent error: boom");
    expect(result.isError).toBe(true);
  });
});

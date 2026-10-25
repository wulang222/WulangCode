import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  filterToolsForAgent,
  isMCPTool,
} from "./tool-filter.ts";

function mockTool(name: string): Tool {
  return {
    name,
    description: name,
    category: "read",
    schema: () => ({ name }),
    execute: async () => ({ output: "", isError: false }),
  };
}

function makeRegistry(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) registry.register(mockTool(name));
  return registry;
}

const namesOf = (registry: ToolRegistry) => registry.listTools().map((t) => t.name);

/** T6：过滤多层防线全组合（AC9-AC12）。 */
describe("filterToolsForAgent", () => {
  test("default config drops Agent/AskUserQuestion but keeps plain and MCP tools", () => {
    const registry = makeRegistry(["ReadFile", "Agent", "AskUserQuestion", "mcp__foo"]);
    const filtered = filterToolsForAgent(registry, undefined, undefined, false);
    const names = namesOf(filtered);
    expect(names).toContain("ReadFile");
    expect(names).toContain("mcp__foo");
    expect(names).not.toContain("Agent");
    expect(names).not.toContain("AskUserQuestion");
  });

  test("isAsync keeps only whitelist plus MCP tools", () => {
    const registry = makeRegistry(["ReadFile", "WriteFile", "SomeUnknown", "mcp__bar"]);
    const names = namesOf(filterToolsForAgent(registry, undefined, undefined, true));
    expect(names).toContain("ReadFile");
    expect(names).toContain("WriteFile");
    expect(names).toContain("mcp__bar");
    expect(names).not.toContain("SomeUnknown");
  });

  test("definition whitelist narrows to the listed tools", () => {
    const registry = makeRegistry(["ReadFile", "WriteFile", "Grep"]);
    const names = namesOf(filterToolsForAgent(registry, ["ReadFile", "Grep"], undefined, false));
    expect(names).toEqual(["ReadFile", "Grep"]);
  });

  test('whitelist ["*"] is treated as wildcard and does not narrow (still drops globally disallowed)', () => {
    const registry = makeRegistry(["ReadFile", "WriteFile", "Agent"]);
    const names = namesOf(filterToolsForAgent(registry, ["*"], undefined, false));
    expect(names).toContain("ReadFile");
    expect(names).toContain("WriteFile");
    expect(names).not.toContain("Agent");
  });

  test("definition disallowedTools removes the listed tool", () => {
    const registry = makeRegistry(["ReadFile", "Bash"]);
    const names = namesOf(filterToolsForAgent(registry, undefined, ["Bash"], false));
    expect(names).not.toContain("Bash");
    expect(names).toContain("ReadFile");
  });

  test("whitelist narrows first, then disallowedTools removes from what remains", () => {
    const registry = makeRegistry(["ReadFile", "Grep", "Bash"]);
    const names = namesOf(filterToolsForAgent(registry, ["ReadFile", "Bash"], ["Bash"], false));
    expect(names).toEqual(["ReadFile"]);
  });

  test("isCustom applies the custom disallowed set", () => {
    const registry = makeRegistry(["ReadFile", "Agent", "TaskStop"]);
    const names = namesOf(filterToolsForAgent(registry, undefined, undefined, false, true));
    expect(names).toEqual(["ReadFile"]);
  });

  test("MCP tools pass through even when not in the async whitelist", () => {
    expect(isMCPTool("mcp__foo__bar")).toBe(true);
    expect(isMCPTool("ReadFile")).toBe(false);
    const registry = makeRegistry(["mcp__x__y"]);
    expect(namesOf(filterToolsForAgent(registry, undefined, undefined, true))).toContain("mcp__x__y");
  });

  test("global sets contain the control-plane tools", () => {
    for (const name of ["Agent", "AskUserQuestion", "TaskStop", "Workflow", "TaskOutput", "EnterPlanMode", "ExitPlanMode"]) {
      expect(ALL_AGENT_DISALLOWED_TOOLS.has(name)).toBe(true);
      expect(CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)).toBe(true);
    }
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("ReadFile")).toBe(true);
  });
});

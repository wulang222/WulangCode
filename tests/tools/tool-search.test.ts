import { expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolSearchTool } from "../../src/tools/tool-search.ts";
import type { Tool, ToolResult, ToolContext } from "../../src/tools/types.ts";

const ctx: ToolContext = { workDir: "/tmp" };

function fakeTool(name: string, description: string, deferred: boolean): Tool {
  return {
    name,
    description,
    category: "command",
    deferred,
    schema: () => ({ name, description, input_schema: { type: "object" } }),
    execute: async (): Promise<ToolResult> => ({ output: "ok", isError: false }),
  };
}

function makeRegistry(): { registry: ToolRegistry; search: ToolSearchTool } {
  const registry = new ToolRegistry();
  registry.register(fakeTool("Bash", "Run a shell command", false));
  registry.register(fakeTool("mcp__github__create_issue", "Create a GitHub issue", true));
  registry.register(fakeTool("mcp__github__list_issues", "List GitHub issues", true));
  registry.register(fakeTool("mcp__sqlite__query", "Run a SQL query", true));
  const search = new ToolSearchTool(registry);
  registry.register(search);
  return { registry, search };
}

test("空 query 返回 isError（F9）", async () => {
  const { search } = makeRegistry();
  const result = await search.execute({ query: "" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toBe("Error: query is required");
});

test("关键词检索返回 name + 简短描述，不激活工具（AC7）", async () => {
  const { registry, search } = makeRegistry();
  const result = await search.execute({ query: "github" }, ctx);
  expect(result.isError).toBe(false);
  const lines = result.output.split("\n");
  expect(lines).toContain("- mcp__github__create_issue: Create a GitHub issue");
  expect(lines).toContain("- mcp__github__list_issues: List GitHub issues");
  expect(lines.some((line) => line.includes("sqlite"))).toBe(false);
  expect(registry.isDiscovered("mcp__github__create_issue")).toBe(false);
});

test("关键词也匹配 description；max_results 截断", async () => {
  const { search } = makeRegistry();
  const result = await search.execute({ query: "issue", max_results: 1 }, ctx);
  expect(result.output.split("\n").length).toBe(1);
});

test("select: 精确激活并返回 schema JSON，下一轮 getAllSchemas 包含（AC6/AC7）", async () => {
  const { registry, search } = makeRegistry();
  const result = await search.execute(
    { query: "select:mcp__github__create_issue,mcp__github__list_issues" },
    ctx,
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain('"name": "mcp__github__create_issue"');
  expect(result.output).toContain('"name": "mcp__github__list_issues"');
  expect(registry.isDiscovered("mcp__github__create_issue")).toBe(true);
  expect(registry.isDiscovered("mcp__github__list_issues")).toBe(true);
  const names = registry
    .getAllSchemas("anthropic")
    .map((schema) => (schema as { name?: string }).name);
  expect(names).toContain("mcp__github__create_issue");
  expect(names).not.toContain("mcp__sqlite__query");
});

test("select: 命中不存在或非 deferred 名字时不报错（AC7）", async () => {
  const { registry, search } = makeRegistry();
  const result = await search.execute({ query: "select:not-exist" }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toBe("No deferred tools found matching: not-exist");
  const builtin = await search.execute({ query: "select:Bash" }, ctx);
  expect(builtin.isError).toBe(false);
  expect(builtin.output).toBe("No deferred tools found matching: Bash");
  expect(registry.isDiscovered("Bash")).toBe(false);
});

test("关键词无命中时返回固定文案", async () => {
  const { search } = makeRegistry();
  const result = await search.execute({ query: "nomatch" }, ctx);
  expect(result.output).toBe("No deferred tools matched the query.");
  expect(result.isError).toBe(false);
});

test("ToolSearch 自身：非 deferred、system 标记、schema 合法", () => {
  const { registry, search } = makeRegistry();
  expect((search as Tool).deferred).toBeUndefined();
  expect((search as Tool).system).toBe(true);
  const schema = search.schema() as { name: string; input_schema: { required: string[] } };
  expect(schema.name).toBe("ToolSearch");
  expect(schema.input_schema.required).toEqual(["query"]);
  expect(registry.getAllSchemas("anthropic").some((s) => (s as { name: string }).name === "ToolSearch")).toBe(true);
});

import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool } from "../../src/tools/types.ts";
import { BashTool } from "../../src/tools/bash.ts";
import { EditFileTool } from "../../src/tools/edit-file.ts";
import { GlobTool } from "../../src/tools/glob.ts";
import { GrepTool } from "../../src/tools/grep.ts";
import { ReadFileTool } from "../../src/tools/read-file.ts";
import { WriteFileTool } from "../../src/tools/write-file.ts";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  return registry;
}

test("注册中心列出全部 6 个工具并按名查找", () => {
  const registry = makeRegistry();
  expect(registry.listTools().length).toBe(6);
  expect(registry.get("Bash")?.name).toBe("Bash");
  expect(registry.get("Nope")).toBeUndefined();
});

test("getAllSchemas(anthropic) 平铺 6 条且字段齐全", () => {
  const schemas = makeRegistry().getAllSchemas("anthropic");
  expect(schemas.length).toBe(6);
  for (const schema of schemas) {
    expect(typeof (schema as { name?: string }).name).toBe("string");
    expect(typeof (schema as { description?: string }).description).toBe("string");
    expect((schema as { input_schema?: { type?: string } }).input_schema?.type).toBe("object");
  }
});

test("getAllSchemas(openai) 包成 function 形态", () => {
  const schemas = makeRegistry().getAllSchemas("openai");
  expect(schemas.length).toBe(6);
  for (const schema of schemas) {
    const wrapped = schema as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } };
    expect(wrapped.type).toBe("function");
    expect(typeof wrapped.function?.name).toBe("string");
    expect(typeof wrapped.function?.description).toBe("string");
    expect(wrapped.function?.parameters).toBeDefined();
  }
});

describe("deferred 延迟加载（MCP）", () => {
  function deferredTool(name: string, description: string): Tool {
    return {
      name,
      description,
      category: "command",
      deferred: true,
      schema: () => ({ name, description, input_schema: { type: "object" } }),
      execute: async () => ({ output: "ok", isError: false }),
    };
  }

  test("deferred 未激活不进 getAllSchemas；markDiscovered 后进入（AC6）", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__github__create_issue", "Create an issue"));
    let names = registry.getAllSchemas("anthropic").map((s) => (s as { name?: string }).name);
    expect(names).not.toContain("mcp__github__create_issue");
    registry.markDiscovered("mcp__github__create_issue");
    names = registry.getAllSchemas("anthropic").map((s) => (s as { name?: string }).name);
    expect(names).toContain("mcp__github__create_issue");
  });

  test("deferred 工具在 openai 协议下同样按需出现且包成 function 形态（AC5/AC12）", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__github__create_issue", "Create an issue"));
    registry.markDiscovered("mcp__github__create_issue");
    const schemas = registry.getAllSchemas("openai") as Array<{
      type: string;
      function: { name: string; parameters: unknown };
    }>;
    const entry = schemas.find((s) => s.function.name === "mcp__github__create_issue");
    expect(entry?.type).toBe("function");
    expect(entry?.function.parameters).toEqual({ type: "object" });
  });

  test("getDeferredToolNames 只列未激活的 deferred 工具", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__a__t1", "one"));
    registry.register(deferredTool("mcp__a__t2", "two"));
    expect(registry.getDeferredToolNames()).toEqual(["mcp__a__t1", "mcp__a__t2"]);
    registry.markDiscovered("mcp__a__t1");
    expect(registry.getDeferredToolNames()).toEqual(["mcp__a__t2"]);
  });

  test("searchDeferred 子串匹配 name 与 description，截断 maxResults", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__github__create_issue", "Create an issue"));
    registry.register(deferredTool("mcp__github__list_issues", "List issues"));
    registry.register(deferredTool("mcp__sqlite__query", "Run SQL"));
    expect(registry.searchDeferred("github").map((t) => t.name)).toEqual([
      "mcp__github__create_issue",
      "mcp__github__list_issues",
    ]);
    expect(registry.searchDeferred("SQL").map((t) => t.name)).toEqual(["mcp__sqlite__query"]);
    expect(registry.searchDeferred("issue", 1).length).toBe(1);
  });

  test("findDeferredByNames 过滤非 deferred 与不存在的名字", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__a__t1", "one"));
    const found = registry.findDeferredByNames(["mcp__a__t1", "Bash", "nope", ""]);
    expect(found.map((t) => t.name)).toEqual(["mcp__a__t1"]);
  });

  test("已激活的 deferred 工具不再出现在 searchDeferred 结果中", () => {
    const registry = makeRegistry();
    registry.register(deferredTool("mcp__a__t1", "one"));
    registry.markDiscovered("mcp__a__t1");
    expect(registry.searchDeferred("one")).toEqual([]);
    expect(registry.getDeferredTools().map((t) => t.name)).toEqual(["mcp__a__t1"]);
  });
});

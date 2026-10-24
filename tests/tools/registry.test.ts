import { expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry.ts";
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

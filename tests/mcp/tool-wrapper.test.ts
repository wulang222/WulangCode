import { expect, test } from "bun:test";
import { MCPToolWrapper, sanitizeName } from "../../src/mcp/tool-wrapper.ts";
import type { MCPClient, MCPTool } from "../../src/mcp/client.ts";
import type { ToolContext } from "../../src/tools/types.ts";

const ctx: ToolContext = { workDir: "/tmp" };

class StubMCPClient {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  constructor(
    private readonly behavior: "ok" | "throw",
    private readonly output = "stub output",
  ) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push([name, args]);
    if (this.behavior === "throw") throw new Error("boom");
    return this.output;
  }
}

function stubClient(behavior: "ok" | "throw"): MCPClient {
  return new StubMCPClient(behavior) as unknown as MCPClient;
}

const tool: MCPTool = {
  name: "create.issue",
  description: "Create an issue",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};

test("sanitizeName 把非法字符替换为下划线并拼出 mcp__ 前缀（AC4）", () => {
  expect(sanitizeName("git.hub", "create.issue")).toBe("mcp__git_hub__create_issue");
  expect(sanitizeName("my server", "do thing!")).toBe("mcp__my_server__do_thing_");
  expect(sanitizeName("a-b", "c_d")).toBe("mcp__a-b__c_d");
});

test("wrapper 字段：name 清洗、description 透传、category command、deferred true（F7）", () => {
  const wrapper = new MCPToolWrapper(stubClient("ok"), "git.hub", tool);
  expect(wrapper.name).toBe("mcp__git_hub__create_issue");
  expect(wrapper.description).toBe("Create an issue");
  expect(wrapper.category).toBe("command");
  expect(wrapper.deferred).toBe(true);
});

test("schema() 透传远端原始 input_schema（AC5）", () => {
  const wrapper = new MCPToolWrapper(stubClient("ok"), "github", tool);
  const schema = wrapper.schema();
  expect(schema.name).toBe("mcp__github__create_issue");
  expect(schema.description).toBe("Create an issue");
  expect(schema.input_schema).toBe(tool.inputSchema);
});

test("execute 用远端原始名调用，成功返回 output（F7）", async () => {
  const stub = new StubMCPClient("ok", "issue #42 created");
  const wrapper = new MCPToolWrapper(stub as unknown as MCPClient, "github", tool);
  const result = await wrapper.execute({ title: "x" }, ctx);
  expect(result).toEqual({ output: "issue #42 created", isError: false });
  expect(stub.calls[0]).toEqual(["create.issue", { title: "x" }]);
});

test("execute 异常转 isError 结果，不抛给 Agent Loop（AC8/N1）", async () => {
  const wrapper = new MCPToolWrapper(stubClient("throw"), "github", tool);
  const result = await wrapper.execute({ title: "x" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/^MCP tool error: boom$/);
});

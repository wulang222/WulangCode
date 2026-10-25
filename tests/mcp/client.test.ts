import { describe, expect, test } from "bun:test";
import { MCPClient, expandEnv } from "../../src/mcp/client.ts";

test("expandEnv 支持 ${VAR} 与 $VAR，未定义变量替换为空串", () => {
  process.env.MCP_TEST_TOKEN = "tok-123";
  expect(expandEnv("${MCP_TEST_TOKEN}")).toBe("tok-123");
  expect(expandEnv("$MCP_TEST_TOKEN")).toBe("tok-123");
  expect(expandEnv("Bearer ${MCP_TEST_TOKEN}")).toBe("Bearer tok-123");
  delete process.env.MCP_TEST_TOKEN;
  expect(expandEnv("${MCP_TEST_UNDEFINED_VAR_X}")).toBe("");
  expect(expandEnv("$MCP_TEST_UNDEFINED_VAR_X")).toBe("");
});

test("command 与 url 均缺失时 connect 抛 needs either 错误", async () => {
  const client = new MCPClient({ name: "bare" });
  expect(client.connect()).rejects.toThrow(
    "MCP server 'bare': needs either 'command' (stdio) or 'url' (http/sse)",
  );
});

test("url 非法时早期失败", async () => {
  const client = new MCPClient({ name: "badurl", url: "not a url" });
  expect(client.connect()).rejects.toThrow("MCP server 'badurl': invalid url");
});

test("未连接时 listTools / callTool 抛错", async () => {
  const client = new MCPClient({ name: "idle" });
  expect(client.listTools()).rejects.toThrow("not connected");
  expect(client.callTool("echo", {})).rejects.toThrow("not connected");
});

describe("stdio transport 实连 fixture server", () => {
  const fixture = `${import.meta.dir}/../fixtures/echo-server.ts`;

  test("connect + listTools + getInstructions", async () => {
    const client = new MCPClient({ name: "echo-fixture", command: "bun", args: [fixture] });
    await client.connect();
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(3);
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo?.description).toBe("Echo the message back");
    expect((echo?.inputSchema as { type?: string }).type).toBe("object");
    expect(client.getInstructions()).toContain("Fixture echo server");
    await client.disconnect();
  });

  test("callTool 文本块取 text，echo 返回含消息", async () => {
    const client = new MCPClient({ name: "echo-fixture", command: "bun", args: [fixture] });
    await client.connect();
    const output = await client.callTool("echo", { message: "hi mewcode" });
    expect(output).toBe("echo: hi mewcode");
    await client.disconnect();
  });

  test("callTool 混合内容块：text 取文本，其余 JSON 序列化，换行分隔（AC8）", async () => {
    const client = new MCPClient({ name: "echo-fixture", command: "bun", args: [fixture] });
    await client.connect();
    const output = await client.callTool("mixed", {});
    const lines = output.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("part one");
    expect(lines[2]).toBe("part two");
    const image = JSON.parse(lines[1]!) as { type: string; data: string };
    expect(image.type).toBe("image");
    expect(image.data).toBe("aGVsbG8=");
    await client.disconnect();
  });

  test("env 值展开 ${VAR} 后注入子进程，配置覆盖宿主（AC3/F4）", async () => {
    process.env.FIXTURE_TOKEN = "host-value";
    const client = new MCPClient({
      name: "echo-fixture",
      command: "bun",
      args: [fixture],
      env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
    });
    await client.connect();
    const output = await client.callTool("env.check", {});
    expect(output).toBe("TOKEN=host-value");
    await client.disconnect();
    delete process.env.FIXTURE_TOKEN;
  });
});

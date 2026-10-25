import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { MCPClient } from "../../src/mcp/client.ts";

function makeHttpFixtureServer() {
  return new McpServer({ name: "http-fixture", version: "0.0.1" }, {});
}

function registerHttpHello(server: McpServer) {
  server.registerTool(
    "hello",
    { description: "Say hello over http", inputSchema: { who: z.string().optional() } },
    async ({ who }) => ({ content: [{ type: "text", text: `hello ${who ?? "http"}` }] }),
  );
}

describe("远程传输（Streamable HTTP / SSE）", () => {
  let httpServer: Server;
  let httpPort = 0;
  const capturedAuth: string[] = [];

  beforeAll(async () => {
    // 无状态 Streamable HTTP：每个请求新起一对 transport+server。
    httpServer = createServer(async (req, res) => {
      capturedAuth.push(String(req.headers.authorization ?? ""));
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
        });
        const server = makeHttpFixtureServer();
        registerHttpHello(server);
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    httpPort = (httpServer.address() as { port: number }).port;
  });

  afterAll(() => {
    httpServer.close();
  });

  test("默认走 Streamable HTTP：listTools + callTool 成功", async () => {
    const client = new MCPClient({ name: "http-fixture", url: `http://127.0.0.1:${httpPort}/mcp` });
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("hello");
    const output = await client.callTool("hello", { who: "mewcode" });
    expect(output).toBe("hello mewcode");
    await client.disconnect();
  });

  test("headers 值的 ${VAR} 在连接阶段展开并随每次请求到达 server（AC3/F5）", async () => {
    capturedAuth.length = 0;
    process.env.MCP_HTTP_TOKEN = "test-token-42";
    const client = new MCPClient({
      name: "http-fixture",
      url: `http://127.0.0.1:${httpPort}/mcp`,
      headers: { Authorization: "Bearer ${MCP_HTTP_TOKEN}" },
    });
    await client.connect();
    await client.listTools();
    await client.callTool("hello", {});
    await client.disconnect();
    delete process.env.MCP_HTTP_TOKEN;
    expect(capturedAuth.at(-1)).toBe("Bearer test-token-42");
    expect(capturedAuth.every((value) => value === "Bearer test-token-42")).toBe(true);
  });

  test("transport: 'sse' 时构造 SSEClientTransport 并完成三步会话（AC2）", async () => {
    const sseTransports = new Map<string, SSEServerTransport>();
    const sseServer = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/sse") {
          const transport = new SSEServerTransport("/messages", res);
          sseTransports.set(transport.sessionId, transport);
          const server = makeHttpFixtureServer();
          registerHttpHello(server);
          await server.connect(transport);
        } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
          const url = new URL(req.url, "http://127.0.0.1");
          const transport = sseTransports.get(url.searchParams.get("sessionId") ?? "");
          if (transport) await transport.handlePostMessage(req, res);
          else {
            res.writeHead(404).end();
          }
        } else {
          res.writeHead(404).end();
        }
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
    const port = (sseServer.address() as { port: number }).port;
    try {
      const client = new MCPClient({ name: "sse-fixture", url: `http://127.0.0.1:${port}/sse`, transport: "sse" });
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("hello");
      const output = await client.callTool("hello", { who: "sse" });
      expect(output).toBe("hello sse");
      await client.disconnect();
    } finally {
      for (const transport of sseTransports.values()) await transport.close();
      sseServer.close();
    }
  });
});

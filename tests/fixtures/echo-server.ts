#!/usr/bin/env bun
/** 测试专用 stdio MCP server：echo / mixed / env.check 三个工具 + 握手 instructions。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "echo-fixture", version: "0.0.1" },
  { instructions: "Fixture echo server for tests. Call echo with a message; mixed returns text+image blocks." },
);

server.registerTool(
  "echo",
  { description: "Echo the message back", inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

server.registerTool(
  "mixed",
  { description: "Returns a text block, an image block, then another text block", inputSchema: {} },
  async () => ({
    content: [
      { type: "text", text: "part one" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "part two" },
    ],
  }),
);

server.registerTool(
  "env.check",
  { description: "Return FIXTURE_TOKEN as seen by the server process", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: `TOKEN=${process.env.FIXTURE_TOKEN ?? ""}` }] }),
);

await server.connect(new StdioServerTransport());

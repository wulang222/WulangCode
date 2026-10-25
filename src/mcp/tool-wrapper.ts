import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import type { MCPClient, MCPTool } from "./client.js";

/** 非 [a-zA-Z0-9_-] 一律替换为下划线，拼出 mcp__<server>__<tool>。 */
export function sanitizeName(serverName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(serverName)}__${clean(toolName)}`;
}

/**
 * 把单个远端 MCP 工具包成统一 Tool 抽象：
 * category 固定 command（保守按有副作用对待）、deferred 固定 true（默认不进提示词）。
 * 调用时用远端原始工具名发起 tools/call；异常转 isError 结果，不抛给 Agent Loop。
 */
export class MCPToolWrapper implements Tool {
  readonly name: string;
  readonly description: string;
  readonly category = "command" as const;
  readonly deferred = true;
  private readonly client: MCPClient;
  private readonly originalName: string;
  private readonly inputSchema: Record<string, unknown>;

  constructor(client: MCPClient, serverName: string, tool: MCPTool) {
    this.client = client;
    this.name = sanitizeName(serverName, tool.name);
    this.description = tool.description;
    this.originalName = tool.name;
    this.inputSchema = tool.inputSchema;
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const output = await this.client.callTool(this.originalName, args);
      return { output, isError: false };
    } catch (err) {
      return { output: "MCP tool error: " + (err instanceof Error ? err.message : String(err)), isError: true };
    }
  }
}

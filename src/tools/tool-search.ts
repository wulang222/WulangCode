import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg, intArg } from "./types.js";
import type { ToolRegistry } from "./registry.js";

/** select: 前缀触发的多工具名分隔符。 */
const SELECT_PREFIX = "select:";

/**
 * 系统级检索工具：让模型按关键词找到、或按精确名激活延迟加载的 MCP 工具。
 * 关键词检索只展示不激活；select:name1,name2 把对应工具标记为已激活并返回其 schema，
 * 使下一轮系统提示词的工具清单带上它们。
 */
export class ToolSearchTool implements Tool {
  readonly name = "ToolSearch";
  readonly description =
    "Search for and load deferred tools by name or keyword. " +
    "Pass a keyword to list matching deferred tools (name + short description); " +
    `pass "${SELECT_PREFIX}<tool_name>[,<tool_name>...]" to activate specific tools and get their full schemas.`;
  readonly category = "read" as const;
  readonly system = true;
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword to search deferred tools, or 'select:<name>,<name>' to activate them.",
          },
          max_results: {
            type: "integer",
            description: "Max tools to return for keyword search.",
            default: 5,
          },
        },
        required: ["query"],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = strArg(args, "query");
    const maxResults = intArg(args, "max_results", 5);
    if (!query) return { output: "Error: query is required", isError: true };

    if (query.startsWith(SELECT_PREFIX)) {
      const names = query.slice(SELECT_PREFIX.length).split(",").map((n) => n.trim());
      const tools = this.registry.findDeferredByNames(names);
      for (const tool of tools) this.registry.markDiscovered(tool.name);
      if (tools.length === 0) {
        return { output: `No deferred tools found matching: ${names.join(", ")}`, isError: false };
      }
      const schemas = tools.map((tool) => JSON.stringify(tool.schema(), null, 2));
      return { output: schemas.join("\n\n"), isError: false };
    }

    const tools = this.registry.searchDeferred(query, maxResults);
    if (tools.length === 0) return { output: "No deferred tools matched the query.", isError: false };
    const lines = tools.map((tool) => `- ${tool.name}: ${tool.description.slice(0, 100)}`);
    return { output: lines.join("\n"), isError: false };
  }
}

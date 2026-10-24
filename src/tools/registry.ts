import type { Tool } from "./types.js";

/** 协议形态：anthropic 平铺；openai 系列包一层 function。 */
export type SchemaProtocol = "anthropic" | "openai" | "openai-compat";

/**
 * 工具注册中心：集中登记、按名查找、按协议导出工具定义列表。
 * 输入输出均为普通对象（Record<string, unknown>），不依赖任何 LLM SDK 类型。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * 按协议导出全部工具定义。
   * anthropic：平铺 { name, description, input_schema }。
   * openai / openai-compat：包成 { type: "function", function: { name, description, parameters } }。
   */
  getAllSchemas(protocol: SchemaProtocol = "anthropic"): Record<string, unknown>[] {
    const schemas: Record<string, unknown>[] = [];
    for (const base of this.tools.values()) {
      const schema = base.schema();
      if (protocol === "anthropic") {
        schemas.push(schema);
        continue;
      }
      schemas.push({
        type: "function",
        function: {
          name: base.name,
          description: base.description,
          parameters: schema.input_schema,
        },
      });
    }
    return schemas;
  }
}

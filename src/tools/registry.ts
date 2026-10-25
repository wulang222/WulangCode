import type { Tool } from "./types.js";

/** 协议形态：anthropic 平铺；openai 系列包一层 function。 */
export type SchemaProtocol = "anthropic" | "openai" | "openai-compat";

/**
 * 工具注册中心：集中登记、按名查找、按协议导出工具定义列表。
 * 输入输出均为普通对象（Record<string, unknown>），不依赖任何 LLM SDK 类型。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly discovered = new Set<string>();

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
   * deferred 且未 discovered 的工具默认跳过（远端 schema 不撑爆上下文，见 ToolSearch）。
   */
  getAllSchemas(protocol: SchemaProtocol = "anthropic"): Record<string, unknown>[] {
    const schemas: Record<string, unknown>[] = [];
    for (const base of this.tools.values()) {
      if (base.deferred && !this.discovered.has(base.name)) continue;
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

  /** 未激活的延迟加载工具名（含已 discovered 的不在此列）。 */
  getDeferredToolNames(): string[] {
    return [...this.tools.values()]
      .filter((tool) => tool.deferred === true && !this.discovered.has(tool.name))
      .map((tool) => tool.name);
  }

  getDeferredTools(): Tool[] {
    return [...this.tools.values()].filter((tool) => tool.deferred === true);
  }

  /** 关键词子串检索（name / description，大小写不敏感），仅返回未激活的 deferred 工具。 */
  searchDeferred(query: string, maxResults = 5): Tool[] {
    const lower = query.toLowerCase();
    return [...this.tools.values()]
      .filter(
        (tool) =>
          tool.deferred === true &&
          !this.discovered.has(tool.name) &&
          (tool.name.toLowerCase().includes(lower) ||
            tool.description.toLowerCase().includes(lower)),
      )
      .slice(0, maxResults);
  }

  /** 按精确名取 deferred 工具；非 deferred 或不存在的名字被过滤。 */
  findDeferredByNames(names: string[]): Tool[] {
    const found: Tool[] = [];
    for (const name of names) {
      const tool = this.tools.get(name.trim());
      if (tool && tool.deferred === true) found.push(tool);
    }
    return found;
  }

  markDiscovered(name: string): void {
    this.discovered.add(name);
  }

  isDiscovered(name: string): boolean {
    return this.discovered.has(name);
  }
}

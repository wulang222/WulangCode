import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServerConfig } from "../config/config.js";

/** server 侧 tools/list 返回的单个远端工具。 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** 宿主环境变量展开：同时支持 ${VAR} 与 $VAR；未定义替换为空串、不告警。 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced?: string, bare?: string) => {
    const name = braced ?? bare;
    return name ? (process.env[name] ?? "") : "";
  });
}

function expandRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) out[key] = expandEnv(value);
  return out;
}

/** 单个 MCP server 的"连接 + 三步会话"门面，协议细节全部由官方 SDK 承载。 */
export class MCPClient {
  readonly name: string;
  private readonly config: MCPServerConfig;
  private client: Client | null = null;
  private transport: AnyTransport | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.name = config.name;
  }

  /** 初始化握手（SDK 内部完成 initialize + 能力协商）。 */
  async connect(): Promise<void> {
    if (this.config.command) {
      // 宿主环境与配置 env 浅合并，同名时配置覆盖（按 server 注入凭据）。
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      const extra = expandRecord(this.config.env);
      if (extra) Object.assign(env, extra);
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env,
        // 子进程 stderr 不走 TUI 错误通道，避免污染界面。
        stderr: "ignore",
      });
    } else if (this.config.url) {
      let url: URL;
      try {
        url = new URL(this.config.url);
      } catch {
        throw new Error(`MCP server '${this.name}': invalid url '${this.config.url}'`);
      }
      const headers = expandRecord(this.config.headers);
      const opts = { requestInit: headers ? { headers } : undefined };
      this.transport =
        this.config.transport === "sse"
          ? new SSEClientTransport(url, opts)
          : new StreamableHTTPClientTransport(url, opts);
    } else {
      throw new Error(`MCP server '${this.name}': needs either 'command' (stdio) or 'url' (http/sse)`);
    }
    this.client = new Client({ name: "mewcode", version: "0.1.0" }, {});
    await this.client.connect(this.transport);
  }

  /** initialize 阶段 server 提供的使用说明；无则返回空串。 */
  getInstructions(): string {
    return this.client?.getInstructions() ?? "";
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) throw new Error(`MCP server '${this.name}': not connected`);
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name ?? "",
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * 调用远端工具并把 content 数组聚合成单个字符串：
   * 文本块取 .text，其它块序列化为 JSON，块间换行分隔；无 content 时整体 JSON。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error(`MCP server '${this.name}': not connected`);
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(result.content)) return JSON.stringify(result);
    const parts = result.content.map((block) =>
      block.type === "text" ? String(block.text ?? "") : JSON.stringify(block),
    );
    return parts.join("\n");
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // 关闭阶段的异常不影响退出
    }
    this.client = null;
    this.transport = null;
  }
}

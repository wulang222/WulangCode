import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

interface PendingCall {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ExecutedCall {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

/**
 * 工具执行器：submit 入队已完成的工具调用，collectResults 用 Promise.all 并发跑完。
 * 任何失败（未知工具 / execute 抛异常）都转成 isError 结果，绝不向上抛。
 */
export class StreamingExecutor {
  private pending: PendingCall[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolContext,
  ) {}

  submit(toolId: string, toolName: string, args: Record<string, unknown>): void {
    this.pending.push({ toolId, toolName, args });
  }

  async collectResults(): Promise<ExecutedCall[]> {
    const calls = this.pending;
    this.pending = [];
    return Promise.all(calls.map((call) => this.runOne(call)));
  }

  private async runOne(call: PendingCall): Promise<ExecutedCall> {
    const start = Date.now();
    const tool = this.registry.get(call.toolName);
    if (!tool) {
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: { output: `Error: unknown tool '${call.toolName}'`, isError: true },
        elapsed: (Date.now() - start) / 1000,
      };
    }
    try {
      const result = await tool.execute(call.args, this.ctx);
      return { toolId: call.toolId, toolName: call.toolName, result, elapsed: (Date.now() - start) / 1000 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolId: call.toolId,
        toolName: call.toolName,
        result: { output: `Error executing ${call.toolName}: ${message}`, isError: true },
        elapsed: (Date.now() - start) / 1000,
      };
    }
  }
}

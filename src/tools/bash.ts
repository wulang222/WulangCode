import { execSync } from "node:child_process";
import { basename } from "node:path";
import { BashDescription } from "./descriptions.js";
import { intArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

/** 超时上限（秒）。 */
const MAX_TIMEOUT = 600;

/**
 * 以非零退出码表达"无匹配 / 有差异 / 假"语义的命令及其错误阈值。
 * 退出码 < 阈值不算错误；例如 grep 退出 1 表示没匹配到，是正常结果。
 */
const commandErrorThresholds = new Map<string, number>([
  ["grep", 2],
  ["egrep", 2],
  ["fgrep", 2],
  ["rg", 2],
  ["diff", 2],
  ["test", 2],
  ["[", 2],
  ["find", 2],
]);

/**
 * 判定一条命令的退出码是否应视为错误。
 * 取管道最后一段命令、跳过 VAR=value 前缀、去路径前缀拿 basename 后查阈值表。
 */
export function interpretExitCode(command: string, exitCode: number): boolean {
  const lastSegment = command.split("|").pop()?.trim() ?? "";
  const tokens = lastSegment.split(/\s+/).filter((token) => token.length > 0);
  let commandName = "";
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // 跳过 VAR=value 前缀
    commandName = token;
    break;
  }
  const base = basename(commandName);
  const threshold = commandErrorThresholds.get(base);
  if (threshold !== undefined) return exitCode >= threshold;
  return exitCode !== 0;
}

/** Bash 工具：在工作目录下同步执行命令，超时杀进程，按命令语义判定错误。 */
export class BashTool implements Tool {
  readonly name = "Bash";
  readonly description = BashDescription;
  readonly category = "command" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute.",
          },
          timeout: {
            type: "integer",
            description: "Timeout in seconds (default 120, max 600).",
            default: 120,
          },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = strArg(args, "command");
    if (!command) return { output: "Error: command is required", isError: true };
    const timeout = Math.min(Math.max(1, intArg(args, "timeout", 120)), MAX_TIMEOUT);
    try {
      const stdout = execSync(command, {
        shell: "bash",
        cwd: ctx.workDir,
        timeout: timeout * 1000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      return { output: `$ ${command}\n${stdout}(exit code 0)`, isError: false };
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; code?: string; stdout?: string; stderr?: string; status?: number };
      // bun 下 execSync 超时的 killed 属性不一定为 true，以 ETIMEDOUT / SIGTERM 一并判定。
      if (e.killed === true || e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
        return { output: `Error: command timed out after ${timeout}s`, isError: true };
      }
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const exitCode = typeof e.status === "number" ? e.status : 1;
      const output = `$ ${command}\n${stdout}STDERR:\n${stderr}(exit code ${exitCode})`;
      return { output, isError: interpretExitCode(command, exitCode) };
    }
  }
}

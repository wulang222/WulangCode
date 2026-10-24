import { existsSync, readFileSync, statSync } from "node:fs";
import { ReadFileDescription } from "./descriptions.js";
import { ReadTracker, sharedReadTracker } from "./read-tracker.js";
import { intArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

/** 读文件工具：返回带行号的文本内容，支持 offset / limit 分页；成功后登记读档（F5）。 */
export class ReadFileTool implements Tool {
  readonly name = "ReadFile";
  readonly description = ReadFileDescription;
  readonly category = "read" as const;

  constructor(private readonly tracker: ReadTracker = sharedReadTracker) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to read. Prefer absolute paths.",
          },
          offset: {
            type: "integer",
            description: "0-based line offset to start reading from.",
            default: 0,
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read.",
            default: 2000,
          },
        },
        required: ["file_path"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    if (!filePath) {
      return { output: "Error: file_path is required", isError: true };
    }
    const offset = Math.max(0, intArg(args, "offset", 0));
    const limit = Math.max(1, intArg(args, "limit", 2000));
    try {
      if (!existsSync(filePath)) {
        return { output: `Error: file not found: ${filePath}`, isError: true };
      }
      if (statSync(filePath).isDirectory()) {
        return {
          output: `Error: path is a directory, not a file: ${filePath}. Use the Glob tool to list files instead.`,
          isError: true,
        };
      }
      const content = readFileSync(filePath, "utf-8");
      this.tracker.markRead(filePath, ctx.workDir);
      const lines = content.split("\n");
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
      return { output: numbered, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error reading file: ${message}`, isError: true };
    }
  }
}

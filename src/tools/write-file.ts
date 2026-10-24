import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WriteFileDescription } from "./descriptions.js";
import { ReadTracker, sharedReadTracker } from "./read-tracker.js";
import { strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

/** 写文件工具：覆盖写，父目录不存在时自动创建；写后内容已知，登记读档（F5）。 */
export class WriteFileTool implements Tool {
  readonly name = "WriteFile";
  readonly description = WriteFileDescription;
  readonly category = "write" as const;

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
            description: "Path to the file to write. Prefer absolute paths.",
          },
          content: {
            type: "string",
            description: "Full text content to write to the file (overwrites existing content).",
          },
        },
        required: ["file_path", "content"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    const content = strArg(args, "content");
    if (!filePath) return { output: "Error: file_path is required", isError: true };
    if (content === "") return { output: "Error: content is required", isError: true };
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      this.tracker.markRead(filePath, ctx.workDir);
      const lines = content.split("\n").length;
      return { output: `File written: ${filePath} (${lines} lines)`, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error writing file: ${message}`, isError: true };
    }
  }
}

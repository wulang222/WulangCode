import { readFileSync, writeFileSync } from "node:fs";
import { EditFileDescription } from "./descriptions.js";
import { ReadTracker, sharedReadTracker } from "./read-tracker.js";
import { boolArg, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

/** 改文件工具：对原文片段做唯一匹配替换；未读过该文件时直接失败（F5）。 */
export class EditFileTool implements Tool {
  readonly name = "EditFile";
  readonly description = EditFileDescription;
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
            description: "Path to the file to edit. Prefer absolute paths.",
          },
          old_string: {
            type: "string",
            description: "Exact text to replace (must be unique in the file unless replace_all is true).",
          },
          new_string: {
            type: "string",
            description: "Text to replace old_string with.",
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence of old_string instead of requiring a unique match.",
            default: false,
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    const oldString = strArg(args, "old_string");
    const newString = strArg(args, "new_string");
    const replaceAll = boolArg(args, "replace_all", false);

    if (!filePath) return { output: "Error: file_path is required", isError: true };
    if (!oldString) return { output: "Error: old_string is required", isError: true };
    if (!newString) return { output: "Error: new_string is required", isError: true };
    // 编辑前必先读（F5）：未读到档直接失败，与描述中的强约束一致。
    if (!this.tracker.hasRead(filePath, ctx.workDir)) {
      return {
        output: `Error: file has not been read yet: ${filePath}. You MUST read the file with ReadFile before editing.`,
        isError: true,
      };
    }
    if (oldString === newString) {
      return {
        output: "Error: old_string and new_string are exactly the same, nothing to replace.",
        isError: true,
      };
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return { output: "Error: old_string not found in file", isError: true };
      }
      if (!replaceAll && count > 1) {
        return {
          output: `Error: old_string found ${count} times in file. It must be unique. Add more surrounding context, or set replace_all to true.`,
          isError: true,
        };
      }
      const next = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);
      writeFileSync(filePath, next, "utf-8");
      // 编辑后内容已知，刷新读档，允许紧接着继续编辑。
      this.tracker.markRead(filePath, ctx.workDir);
      return {
        output: replaceAll && count > 1 ? `File edited: ${filePath} (${count} replacements)` : `File edited: ${filePath}`,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error editing file: ${message}`, isError: true };
    }
  }
}

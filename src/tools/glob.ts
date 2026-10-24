import { statSync } from "node:fs";
import { join } from "node:path";
import { GlobDescription } from "./descriptions.js";
import { SKIP_DIRS, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_MATCHES = 1000;

/** Glob 工具：Bun.Glob 扫描匹配文件，按 mtime 倒序。 */
export class GlobTool implements Tool {
  readonly name = "Glob";
  readonly description = GlobDescription;
  readonly category = "read" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. \"**/*.ts\".",
          },
          path: {
            type: "string",
            description: "Directory to search in (defaults to the working directory).",
          },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) return { output: "Error: pattern is required", isError: true };
    const basePath = strArg(args, "path", ctx.workDir);
    try {
      const matches: string[] = [];
      const glob = new Bun.Glob(pattern);
      for (const entry of glob.scanSync({ cwd: basePath, dot: false })) {
        // 路径中任意一段命中忽略目录即跳过。
        if (entry.split("/").some((segment) => SKIP_DIRS.has(segment))) continue;
        matches.push(entry);
        if (matches.length >= MAX_MATCHES) break;
      }
      if (matches.length === 0) {
        return { output: "No files matched the pattern.", isError: false };
      }
      matches.sort((a, b) => {
        try {
          return statSync(join(basePath, b)).mtimeMs - statSync(join(basePath, a)).mtimeMs;
        } catch {
          return a.localeCompare(b);
        }
      });
      return { output: matches.join("\n"), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error running glob: ${message}`, isError: true };
    }
  }
}

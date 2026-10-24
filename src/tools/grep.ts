import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GrepDescription } from "./descriptions.js";
import { SKIP_DIRS, strArg, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_RESULTS = 500;

/** Grep 工具：大小写不敏感正则按行搜文件内容，手写目录遍历。 */
export class GrepTool implements Tool {
  readonly name = "Grep";
  readonly description = GrepDescription;
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
            description: "Regular expression to search for (case-insensitive).",
          },
          path: {
            type: "string",
            description: "File or directory to search in (defaults to the working directory).",
          },
          include: {
            type: "string",
            description: 'Glob filter on file names, e.g. "*.ts".',
          },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) return { output: "Error: pattern is required", isError: true };
    const searchPath = strArg(args, "path", ctx.workDir);
    const include = strArg(args, "include");

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error: invalid regular expression: ${message}`, isError: true };
    }

    const includeGlob = include ? new Bun.Glob(include) : null;
    const results: string[] = [];

    const searchFile = (filePath: string): void => {
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (results.length >= MAX_RESULTS) return;
          if (regex.test(lines[i] ?? "")) {
            results.push(`${filePath}:${i + 1}:${lines[i]}`);
          }
        }
      } catch {
        // 二进制 / 不可读文件直接跳过。
      }
    };

    const walk = (dir: string): void => {
      if (results.length >= MAX_RESULTS) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (SKIP_DIRS.has(entry)) continue;
        const fullPath = join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          if (includeGlob && !includeGlob.match(entry)) continue;
          searchFile(fullPath);
        }
      }
    };

    try {
      let isFile = false;
      try {
        isFile = statSync(searchPath).isFile();
      } catch {
        return { output: `Error: path not found: ${searchPath}`, isError: true };
      }
      if (isFile) {
        searchFile(searchPath);
      } else {
        walk(searchPath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error running grep: ${message}`, isError: true };
    }

    if (results.length === 0) {
      return { output: "No matches found.", isError: false };
    }
    let output = results.join("\n");
    if (results.length >= MAX_RESULTS) {
      output += `\n(results truncated at ${MAX_RESULTS} matches)`;
    }
    return { output, isError: false };
  }
}

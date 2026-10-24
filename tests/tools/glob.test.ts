import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { GlobTool } from "../../src/tools/glob.ts";

const repoRoot = resolve(import.meta.dir, "../..");

test("**/*.ts 命中 src/tools 下的文件", async () => {
  const result = await new GlobTool().execute({ pattern: "**/*.ts", path: repoRoot }, { workDir: repoRoot });
  expect(result.isError).toBe(false);
  expect(result.output).toContain("src/tools/read-file.ts");
  expect(result.output).toContain("src/tools/grep.ts");
});

test("node_modules 等忽略目录被跳过", async () => {
  const result = await new GlobTool().execute({ pattern: "**/*.js", path: repoRoot }, { workDir: repoRoot });
  expect(result.output).not.toContain("node_modules/");
});

test("无匹配返回提示而非错误", async () => {
  const result = await new GlobTool().execute({ pattern: "**/*.mewcode-none" }, { workDir: repoRoot });
  expect(result.isError).toBe(false);
  expect(result.output).toContain("No files matched");
});

test("缺 pattern 返回错误", async () => {
  const result = await new GlobTool().execute({}, { workDir: repoRoot });
  expect(result.isError).toBe(true);
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { GrepTool } from "../../src/tools/grep.ts";

const repoRoot = resolve(import.meta.dir, "../..");

test("按关键字命中 file:line:content", async () => {
  const result = await new GrepTool().execute(
    { pattern: "ReadFileTool", path: resolve(repoRoot, "src/tools") },
    { workDir: repoRoot },
  );
  expect(result.isError).toBe(false);
  const lines = result.output.split("\n");
  const hit = lines.find((line) => line.includes("read-file.ts:"));
  expect(hit).toBeDefined();
  expect(hit).toContain(":");
});

test("include 过滤文件名", async () => {
  const result = await new GrepTool().execute(
    { pattern: "ToolRegistry", path: resolve(repoRoot, "src"), include: "registry.ts" },
    { workDir: repoRoot },
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("tools/registry.ts:");
});

test("无匹配返回提示而非错误", async () => {
  const result = await new GrepTool().execute(
    { pattern: "mewcode_no_such_symbol_xyz" },
    { workDir: resolve(repoRoot, "src/tools") },
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("No matches found");
});

test("非法正则返回结构化错误", async () => {
  const result = await new GrepTool().execute(
    { pattern: "([invalid" },
    { workDir: repoRoot },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("invalid regular expression");
});

test("命中达 500 条上限时截断并提示", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-grep-"));
  const lines = Array.from({ length: 600 }, (_, i) => `needle-line-${i + 1}`);
  writeFileSync(join(dir, "dense.txt"), lines.join("\n"), "utf-8");
  const result = await new GrepTool().execute(
    { pattern: "needle-line", path: dir },
    { workDir: dir },
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("(results truncated at 500 matches)");
  const matchCount = result.output.split("\n").filter((line) => line.includes("needle-line")).length;
  expect(matchCount).toBe(500);
});

test("大小写不敏感匹配", async () => {
  const result = await new GrepTool().execute(
    { pattern: "readfiletool", path: resolve(repoRoot, "src/tools/read-file.ts") },
    { workDir: repoRoot },
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("read-file.ts:7:");
});

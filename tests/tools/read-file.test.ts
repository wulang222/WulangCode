import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ReadFileTool } from "../../src/tools/read-file.ts";

const ctx = { workDir: process.cwd() };

test("读存在文件返回带行号内容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-read-"));
  const filePath = join(dir, "a.txt");
  writeFileSync(filePath, "hello\nworld\n", "utf-8");
  const result = await new ReadFileTool().execute({ file_path: filePath }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("1\thello");
  expect(result.output).toContain("2\tworld");
});

test("offset + limit 分页切片", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-read-"));
  const filePath = join(dir, "lines.txt");
  writeFileSync(filePath, "one\ntwo\nthree\nfour\n", "utf-8");
  const result = await new ReadFileTool().execute({ file_path: filePath, offset: 1, limit: 2 }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("2\ttwo");
  expect(result.output).toContain("3\tthree");
  expect(result.output).not.toContain("one");
  expect(result.output).not.toContain("four");
});

test("读不存在文件返回结构化错误", async () => {
  const result = await new ReadFileTool().execute({ file_path: "/tmp/mewcode-no-such-file-xyz" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toContain("Error");
});

test("读目录返回结构化错误并建议 Glob", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-read-"));
  mkdirSync(join(dir, "sub"));
  const result = await new ReadFileTool().execute({ file_path: join(dir, "sub") }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toContain("directory");
});

test("缺 file_path 返回错误", async () => {
  const result = await new ReadFileTool().execute({}, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toContain("file_path is required");
});

test("默认 2000 行截断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-read-"));
  const filePath = join(dir, "big.txt");
  const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
  writeFileSync(filePath, lines.join("\n"), "utf-8");
  const result = await new ReadFileTool().execute({ file_path: filePath }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("line-2000");
  expect(result.output).not.toContain("line-2001");
  // 带	offset 继续读能拿到剩余部分
  const rest = await new ReadFileTool().execute({ file_path: filePath, offset: 2000 }, ctx);
  expect(rest.output).toContain("line-2001");
  expect(rest.output).toContain("line-2500");
});

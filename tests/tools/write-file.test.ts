import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { WriteFileTool } from "../../src/tools/write-file.ts";

const ctx = { workDir: process.cwd() };

test("写嵌套路径自动创建父目录且内容落地", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-write-"));
  const filePath = join(dir, "a", "b", "c.txt");
  const result = await new WriteFileTool().execute({ file_path: filePath, content: "hello\nmewcode" }, ctx);
  expect(result.isError).toBe(false);
  expect(existsSync(filePath)).toBe(true);
  expect(readFileSync(filePath, "utf-8")).toBe("hello\nmewcode");
  expect(result.output).toContain("File written");
  expect(result.output).toContain("(2 lines)");
});

test("覆盖写已存在的文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-write-"));
  const filePath = join(dir, "same.txt");
  await new WriteFileTool().execute({ file_path: filePath, content: "first" }, ctx);
  const result = await new WriteFileTool().execute({ file_path: filePath, content: "second" }, ctx);
  expect(result.isError).toBe(false);
  expect(readFileSync(filePath, "utf-8")).toBe("second");
});

test("缺参数返回结构化错误", async () => {
  const tool = new WriteFileTool();
  expect((await tool.execute({ file_path: "/tmp/x.txt" }, ctx)).isError).toBe(true);
  expect((await tool.execute({ content: "no path" }, ctx)).isError).toBe(true);
});

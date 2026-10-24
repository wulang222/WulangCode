import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { EditFileTool } from "../../src/tools/edit-file.ts";
import { ReadFileTool } from "../../src/tools/read-file.ts";
import { ReadTracker } from "../../src/tools/read-tracker.ts";

const ctx = { workDir: process.cwd() };

/** 新建临时文件并登记读档（编辑前必先读，F5）。 */
function makeFile(content: string): { filePath: string; tracker: ReadTracker } {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-edit-"));
  const filePath = join(dir, "f.txt");
  writeFileSync(filePath, content, "utf-8");
  const tracker = new ReadTracker();
  tracker.markRead(filePath, ctx.workDir);
  return { filePath, tracker };
}

test("未读取过的文件直接失败（AC7）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-edit-"));
  const filePath = join(dir, "unread.txt");
  writeFileSync(filePath, "alpha\n", "utf-8");
  const result = await new EditFileTool(new ReadTracker()).execute(
    { file_path: filePath, old_string: "alpha", new_string: "ALPHA" },
    ctx,
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("not been read");
  expect(result.output).toContain("ReadFile");
  // 文件未被修改
  expect(readFileSync(filePath, "utf-8")).toBe("alpha\n");
});

test("ReadFile 读过之后 EditFile 放行（tracker 接线）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-edit-"));
  const filePath = join(dir, "rel.txt");
  writeFileSync(filePath, "hello\n", "utf-8");
  const tracker = new ReadTracker();
  const reader = new ReadFileTool(tracker);
  const read = await reader.execute({ file_path: filePath }, { workDir: dir });
  expect(read.isError).toBe(false);
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "hello", new_string: "hi" },
    { workDir: dir },
  );
  expect(result.isError).toBe(false);
  expect(readFileSync(filePath, "utf-8")).toBe("hi\n");
});

test("ReadTracker 按工作目录归一：绝对与相对写法视为同一文件", () => {
  const tracker = new ReadTracker();
  tracker.markRead("/tmp/x/a.txt", "/tmp/x");
  expect(tracker.hasRead("a.txt", "/tmp/x")).toBe(true);
  expect(tracker.hasRead("/tmp/x/a.txt", "/tmp/y")).toBe(true);
  expect(tracker.hasRead("b.txt", "/tmp/x")).toBe(false);
  tracker.clear();
  expect(tracker.hasRead("/tmp/x/a.txt", "/tmp/x")).toBe(false);
});

test("唯一匹配时替换成功", async () => {
  const { filePath, tracker } = makeFile("alpha\nbeta\ngamma\n");
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "beta", new_string: "BETA" },
    ctx,
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("File edited");
  expect(readFileSync(filePath, "utf-8")).toBe("alpha\nBETA\ngamma\n");
});

test("匹配 0 次返回 not found 错误", async () => {
  const { filePath, tracker } = makeFile("alpha\nbeta\n");
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "delta", new_string: "x" },
    ctx,
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("old_string not found");
});

test("匹配多次不带 replace_all 返回带匹配数的错误", async () => {
  const { filePath, tracker } = makeFile("foo\nfoo\nfoo\n");
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "foo", new_string: "bar" },
    ctx,
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("found 3 times");
  expect(result.output).toContain("replace_all");
  // 文件未被修改
  expect(readFileSync(filePath, "utf-8")).toBe("foo\nfoo\nfoo\n");
});

test("replace_all 多次匹配全部替换成功", async () => {
  const { filePath, tracker } = makeFile("foo\nfoo\nfoo\n");
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "foo", new_string: "bar", replace_all: true },
    ctx,
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain("(3 replacements)");
  expect(readFileSync(filePath, "utf-8")).toBe("bar\nbar\nbar\n");
});

test("old_string 与 new_string 相同返回错误", async () => {
  const { filePath, tracker } = makeFile("same\n");
  const result = await new EditFileTool(tracker).execute(
    { file_path: filePath, old_string: "same", new_string: "same" },
    ctx,
  );
  expect(result.isError).toBe(true);
});

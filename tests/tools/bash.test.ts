import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BashTool, interpretExitCode } from "../../src/tools/bash.ts";

const ctx = { workDir: process.cwd() };

test("echo 命令返回输出与退出码", async () => {
  const result = await new BashTool().execute({ command: "echo hi" }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("hi");
  expect(result.output).toContain("(exit code 0)");
});

test("超时命令被终止并返回超时错误", async () => {
  const result = await new BashTool().execute({ command: "sleep 5", timeout: 1 }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toContain("Error: command timed out after 1s");
});

test("grep 退出 1（无匹配）不被视为错误", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-bash-"));
  const filePath = join(dir, "data.txt");
  writeFileSync(filePath, "hello world\n", "utf-8");
  const result = await new BashTool().execute({ command: `grep nothing ${filePath}` }, ctx);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("(exit code 1)");
});

test("interpretExitCode 按命令语义判定", () => {
  expect(interpretExitCode("grep foo bar.txt", 1)).toBe(false);
  expect(interpretExitCode("grep foo bar.txt", 2)).toBe(true);
  expect(interpretExitCode("cat missing.txt", 1)).toBe(true);
  // 管道取最后一段命令
  expect(interpretExitCode("cat x | grep foo", 1)).toBe(false);
  // 跳过 VAR=value 前缀
  expect(interpretExitCode("LC_ALL=C grep foo bar", 1)).toBe(false);
  // 带路径前缀的 basename
  expect(interpretExitCode("/usr/bin/diff a b", 1)).toBe(false);
  expect(interpretExitCode("/usr/bin/diff a b", 2)).toBe(true);
});

test("普通命令非零退出是错误且带 stderr", async () => {
  const result = await new BashTool().execute({ command: "ls /definitely-not-exist-mewcode" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toContain("STDERR:");
});

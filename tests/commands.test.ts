import { describe, expect, test } from "bun:test";
import {
  CommandRegistry,
  createDefaultRegistry,
  parse,
  type Command,
  type CommandContext,
} from "../src/commands/commands.ts";

const ctx = (args = ""): CommandContext => ({ workDir: "/tmp", args });

const BUILTIN_NAMES = [
  "clear",
  "code-review",
  "compact",
  "help",
  "mcp",
  "memory",
  "permission",
  "plan",
  "quit",
  "resume",
  "review",
  "rewind",
  "session",
  "skills",
  "status",
  "worktree",
];

describe("createDefaultRegistry（day9 T3 / F15-F30）", () => {
  test("一次性注册 16 条内置命令且按字典序输出", () => {
    const registry = createDefaultRegistry();
    expect(registry.listCommands().map((c) => c.name)).toEqual(BUILTIN_NAMES);
  });

  test("find 同时按主名与别名命中", () => {
    const registry = createDefaultRegistry();
    expect(registry.find("compact")?.name).toBe("compact");
    expect(registry.find("c")?.name).toBe("compact");
    expect(registry.find("s")?.name).toBe("status");
    expect(registry.find("exit")?.name).toBe("quit");
    expect(registry.find("q")?.name).toBe("quit");
    expect(registry.find("nope")).toBeUndefined();
  });

  test("/help 无参列出全部命令，带参输出单条详情", () => {
    const registry = createDefaultRegistry();
    const help = registry.find("help")!;
    const full = help.handler(ctx());
    expect(full.startsWith("Available commands:")).toBe(true);
    expect(full).toContain("/compact, /c");
    expect(full).toContain("Force context compaction");
    expect(full.endsWith("Type /help <command> for details.")).toBe(true);
    const detail = help.handler(ctx("compact"));
    expect(detail).toBe("/compact — Force context compaction\nAliases: c");
  });

  test("/session 固定提示、/review 聚焦参数、/code-review usage 与回显", () => {
    const registry = createDefaultRegistry();
    expect(registry.find("session")?.handler(ctx())).toBe(
      "Session is active. Use /resume to list past sessions.",
    );
    const review = registry.find("review")!;
    expect(review.type).toBe("prompt");
    expect(review.handler(ctx())).toContain("`git status`");
    expect(review.handler(ctx())).toContain("`git diff`");
    expect(review.handler(ctx("focus on bash.ts"))).toContain("Focus on: focus on bash.ts");
    const cr = registry.find("code-review")!;
    expect(cr.handler(ctx())).toContain("Usage: /code-review");
    expect(cr.handler(ctx("create team-a"))).toBe("code-review:create team-a");
  });
});

describe("CommandRegistry 冲突检测（day9 T1 / F2-F3 / AC14）", () => {
  const mk = (name: string, aliases: string[] = []): Command => ({
    name,
    aliases,
    type: "local",
    description: "test",
    handler: () => name,
  });

  test("四种冲突都抛错且消息含具体冲突字符串", () => {
    const registry = createDefaultRegistry();
    // 1. 名字与已有命令名冲突
    expect(() => registry.register(mk("help"))).toThrow("Command 'help' already registered");
    // 2. 名字与已有别名冲突
    expect(() => registry.register(mk("c"))).toThrow("collides with alias of 'compact'");
    // 3. 新别名与已有命令名冲突
    expect(() => registry.register(mk("other", ["status"]))).toThrow(
      "Alias 'status' collides with existing command name 'status'",
    );
    // 4. 新别名与已有别名冲突
    expect(() => registry.register(mk("other", ["s"]))).toThrow("Alias 's' already registered by 'status'");
  });

  test("hasConflict 非抛版本返回 boolean", () => {
    const registry = createDefaultRegistry();
    expect(registry.hasConflict(mk("help"))).toBe(true);
    expect(registry.hasConflict(mk("c"))).toBe(true);
    expect(registry.hasConflict(mk("fresh", ["zz"]))).toBe(false);
  });

  test("complete 大小写不敏感前缀匹配主名与别名", () => {
    const registry = createDefaultRegistry();
    const names = registry.complete("ST").map((c) => c.name);
    expect(names).toEqual(["status"]);
    // 别名 s 前缀命中 status；p 前缀命中 plan / permission
    // complete 按注册序返回，断言排序后集合（plan / permission + 别名 p、perm 前缀）
    expect(registry.complete("P").map((c) => c.name).sort()).toEqual(["permission", "plan"]);
    expect(registry.complete("C").map((c) => c.name).sort()).toEqual(["clear", "code-review", "compact"]);
  });
});

describe("parse（day9 T2 / F7）", () => {
  test("四类输入解析", () => {
    expect(parse("hello")).toBeNull();
    expect(parse("/foo")).toEqual({ name: "foo", args: "" });
    expect(parse("/")).toEqual({ name: "", args: "" });
    expect(parse("/foo bar baz")).toEqual({ name: "foo", args: "bar baz" });
    expect(parse("/foo   bar  ")).toEqual({ name: "foo", args: "bar" });
  });
});

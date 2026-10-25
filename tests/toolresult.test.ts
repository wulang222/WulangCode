import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyBudget, buildSpillPreview, writeSpill } from "../src/toolresult/budget.ts";
import { ContentReplacementState } from "../src/toolresult/state.ts";
import type { Message } from "../src/conversation/conversation.ts";

function tempWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-toolresult-"));
}

function toolResultMessage(id: string, content: string): Message {
  return {
    role: "user",
    content: "",
    toolResults: [{ toolUseId: id, content, isError: false }],
  };
}

describe("ContentReplacementState（C3）", () => {
  test("record / has / getReplacement 基本语义", () => {
    const state = new ContentReplacementState();
    state.record("a", "x", "y");
    expect(state.has("a")).toBe(true);
    expect(state.getReplacement("a")).toBe("y");
    // original === replaced：只进 seenIds，不写 replacements
    state.record("b", "x", "x");
    expect(state.has("b")).toBe(true);
    expect(state.getReplacement("b")).toBeUndefined();
    expect(state.size()).toBe(2);
    // clone 拷贝两本账
    const copy = state.clone();
    expect(copy.has("a")).toBe(true);
    expect(copy.getReplacement("a")).toBe("y");
  });
});

describe("buildSpillPreview（C9）", () => {
  test("四个标志齐全且逐字节稳定", () => {
    const content = "Z".repeat(60_000);
    const preview = buildSpillPreview(content, "/tmp/spill/abc");
    expect(preview.startsWith("<persisted-output>")).toBe(true);
    expect(preview.endsWith("</persisted-output>")).toBe(true);
    expect(preview).toContain("输出太大（58KB）");
    expect(preview).toContain("/tmp/spill/abc");
    expect(preview).toContain("预览（前 2KB）：");
    expect(preview).toContain("Z".repeat(2000));
    expect(preview).toContain("\n...");
    expect(buildSpillPreview(content, "/tmp/spill/abc") === preview).toBe(true);
  });

  test("不足预览长度时无省略号", () => {
    const preview = buildSpillPreview("short", "/tmp/spill/x");
    expect(preview).not.toContain("\n...");
  });
});

describe("writeSpill（C8）", () => {
  test("wx flag 幂等：同 id 二次写不抛、文件内容不变", () => {
    const dir = tempWorkDir();
    const p1 = writeSpill(dir, "tid-1", "hello");
    const p2 = writeSpill(dir, "tid-1", "hello");
    expect(p1).toBe(p2);
    expect(readFileSync(p1, "utf-8")).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  test("非 EEXIST 错误冒泡且不进账本（N6/AC4）", () => {
    const dir = tempWorkDir();
    mkdirSync(join(dir, ".mewcode", "tool_results"), { recursive: true });
    chmodSync(join(dir, ".mewcode", "tool_results"), 0o500);
    const state = new ContentReplacementState();
    const messages = [toolResultMessage("tid-ro", "R".repeat(60_000))];
    expect(() => applyBudget(messages, dir, state)).toThrow();
    expect(state.has("tid-ro")).toBe(false);
    chmodSync(join(dir, ".mewcode", "tool_results"), 0o700);
    // 解锁后重新评估可正常落盘（AC4 子断言）
    const out = applyBudget(messages, dir, state);
    expect(out[0]!.toolResults![0]!.content.startsWith("<persisted-output>")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyBudget（C7/T28）", () => {
  test("单条超阈值：落盘 + 预览替换体（AC1）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const content = "A".repeat(60_000);
    const out = applyBudget([toolResultMessage("big-1", content)], dir, state);
    const replaced = out[0]!.toolResults![0]!.content;
    expect(replaced.startsWith("<persisted-output>")).toBe(true);
    expect(replaced).toContain("输出太大（58KB）");
    expect(replaced).toContain(join(dir, ".mewcode", "tool_results", "big-1"));
    expect(replaced).toContain("A".repeat(2000));
    expect(replaced).toContain("\n...");
    const spill = join(dir, ".mewcode", "tool_results", "big-1");
    expect(existsSync(spill)).toBe(true);
    expect(statSync(spill).size).toBe(60_000);
    expect(state.has("big-1")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("单轮聚合超标（3×80000 单条已超）：全部落盘、聚合回落（AC2）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const msg: Message = {
      role: "user",
      content: "",
      toolResults: [
        { toolUseId: "agg-1", content: "B".repeat(80_000), isError: false },
        { toolUseId: "agg-2", content: "C".repeat(80_000), isError: false },
        { toolUseId: "agg-3", content: "D".repeat(80_000), isError: false },
      ],
    };
    const out = applyBudget([msg], dir, state);
    const results = out[0]!.toolResults!;
    const spilled = results.filter((r) => r.content.startsWith("<persisted-output>"));
    expect(spilled.length).toBeGreaterThanOrEqual(2);
    const total = results.reduce((s, r) => s + r.content.length, 0);
    expect(total).toBeLessThanOrEqual(200_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("纯聚合路径（5×45000）：按大→小落盘到达标，替换数最小（AC2）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const msg: Message = {
      role: "user",
      content: "",
      toolResults: Array.from({ length: 5 }, (_, i) => ({
        toolUseId: `mid-${i}`,
        content: "E".repeat(45_000),
        isError: false,
      })),
    };
    const out = applyBudget([msg], dir, state);
    const results = out[0]!.toolResults!;
    const spilled = results.filter((r) => r.content.startsWith("<persisted-output>"));
    expect(spilled.length).toBe(1);
    const total = results.reduce((s, r) => s + r.content.length, 0);
    expect(total).toBeLessThanOrEqual(200_000);
    // 未被替换的项保持原文
    expect(results.filter((r) => r.content === "E".repeat(45_000)).length).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  test("幂等：同 state 二次调用逐字节相等，spill mtime 不变（AC3）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const messages = [toolResultMessage("idem-1", "F".repeat(60_000))];
    const first = applyBudget(messages, dir, state);
    const spill = join(dir, ".mewcode", "tool_results", "idem-1");
    const mtime = statSync(spill).mtimeMs;
    const second = applyBudget(messages, dir, state);
    expect(JSON.stringify(second) === JSON.stringify(first)).toBe(true);
    expect(statSync(spill).mtimeMs).toBe(mtime);
    rmSync(dir, { recursive: true, force: true });
  });

  test("决策冻结：落盘后改原内容仍用冻结字符串（AC4/E4）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const first = applyBudget([toolResultMessage("freeze-1", "G".repeat(60_000))], dir, state);
    const frozen = first[0]!.toolResults![0]!.content;
    // 同 id 但原始内容变了：账本冻结优先
    const second = applyBudget([toolResultMessage("freeze-1", "H".repeat(60_000))], dir, state);
    expect(second[0]!.toolResults![0]!.content).toBe(frozen);
    rmSync(dir, { recursive: true, force: true });
  });

  test("决策冻结：未超阈值的 id 不进账本，保持原文（AC4）", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const out = applyBudget([toolResultMessage("keep-1", "small")], dir, state);
    expect(out[0]!.toolResults![0]!.content).toBe("small");
    expect(state.has("keep-1")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("snipStale（C7/T28）", () => {
  test("12 轮后最旧 2 轮的大 toolResult 被裁，近期保留", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const messages: Message[] = [];
    for (let r = 1; r <= 12; r += 1) {
      messages.push({ role: "user", content: `q${r}` });
      messages.push({ role: "assistant", content: "", toolUses: [{ toolUseId: `t${r}`, toolName: "ReadFile", arguments: {} }] });
      messages.push(toolResultMessage(`t${r}`, `S${r}-`.repeat(1000)));
      messages.push({ role: "assistant", content: `a${r}` });
    }
    const out = applyBudget(messages, dir, state);
    const contentOf = (r: number) => out[r * 4 - 2]!.toolResults![0]!.content;
    // 最旧 2 轮：被裁剪为定长标注
    expect(contentOf(1)).toBe(`[Stale output snipped: ${`S1-`.repeat(1000).length} chars]`);
    expect(contentOf(2).startsWith("[Stale output snipped:")).toBe(true);
    // 近期 10 轮：原文保留
    for (let r = 3; r <= 12; r += 1) {
      expect(contentOf(r).startsWith("[Stale output snipped:")).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("轮次不足 KEEP_RECENT_TURNS 时不裁剪", () => {
    const dir = tempWorkDir();
    const state = new ContentReplacementState();
    const messages: Message[] = [];
    for (let r = 1; r <= 10; r += 1) {
      messages.push({ role: "user", content: `q${r}` });
      messages.push({ role: "assistant", content: "", toolUses: [{ toolUseId: `t${r}`, toolName: "ReadFile", arguments: {} }] });
      messages.push(toolResultMessage(`t${r}`, `S${r}-`.repeat(600)));
      messages.push({ role: "assistant", content: `a${r}` });
    }
    const out = applyBudget(messages, dir, state);
    for (let r = 1; r <= 10; r += 1) {
      expect(out[r * 4 - 2]!.toolResults![0]!.content.startsWith("[Stale output snipped:")).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

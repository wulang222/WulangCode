import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  cleanExpiredSessions,
  COMPACT_BOUNDARY,
  getSessionFilePath,
  listSessions,
  loadSession,
  newSessionId,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
  type SessionMessage,
} from "../src/session/session.ts";

function tempWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-session-"));
}

const msg = (role: string, content: string): SessionMessage => ({
  role,
  content,
  timestamp: new Date().toISOString(),
});

describe("newSessionId（F34）", () => {
  test("格式为 <base36 时间戳>-<8 位 hex>，进程内唯一", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
    expect(newSessionId() === newSessionId()).toBe(false);
  });
});

describe("saveCompactBoundary + loadSession round-trip（T31/I9）", () => {
  test("boundary 行按 system + compact_boundary 写入并可解析回原 payload", () => {
    const dir = tempWorkDir();
    const payload = { summary: "SUM", keep: [{ role: "user", content: "kept-q" }] };
    saveCompactBoundary(dir, "s1", payload);
    const saved = loadSession(dir, "s1");
    const boundary = saved.find((m) => m.type === COMPACT_BOUNDARY);
    expect(boundary?.role).toBe("system");
    expect(JSON.parse(boundary!.content)).toEqual(payload);
    rmSync(dir, { recursive: true, force: true });
  });

  test("saveMessage 追加 jsonl 行；目录按需创建（I12）", () => {
    const dir = tempWorkDir();
    saveMessage(dir, "s2", msg("user", "hello"));
    saveMessage(dir, "s2", msg("assistant", "hi"));
    const raw = readFileSync(getSessionFilePath(dir, "s2"), "utf-8");
    expect(raw.split("\n").filter(Boolean).length).toBe(2);
    expect(loadSession(dir, "s2").length).toBe(2);
    // 不存在的会话返回空数组
    expect(loadSession(dir, "nope")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadSession 坏行容错（T15/AC10）", () => {
  test("skips malformed and empty-content lines", () => {
    const dir = tempWorkDir();
    const lines = [
      JSON.stringify(msg("user", "q")),
      "{ not valid json",
      JSON.stringify({ role: "assistant", content: "", timestamp: "t" }),
      JSON.stringify(msg("assistant", "a")),
      "",
    ];
    mkdirSync(join(dir, ".mewcode", "sessions"), { recursive: true });
    writeFileSync(getSessionFilePath(dir, "s3"), `${lines.join("\n")}\n`, "utf-8");
    const saved = loadSession(dir, "s3");
    expect(saved.length).toBe(2);
    expect(saved[0]!.content).toBe("q");
    expect(saved[1]!.content).toBe("a");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("listSessions（T15/F15/AC13）", () => {
  test("labels a session by its first user message", () => {
    const dir = tempWorkDir();
    saveMessage(dir, "s4", msg("system", "sys-payload"));
    saveMessage(dir, "s4", msg("user", "第一条".repeat(60)));
    saveMessage(dir, "s4", msg("assistant", "回复"));
    const sessions = listSessions(dir);
    expect(sessions.length).toBe(1);
    const s = sessions[0]!;
    expect(s.id).toBe("s4");
    expect(s.messageCount).toBe(3);
    expect(s.firstMessage.startsWith("第一条")).toBe(true);
    expect(s.firstMessage.length).toBe(100);
    expect(s.size).toBeGreaterThan(0);
    expect(s.modTime instanceof Date).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("按 modTime 倒序排列", async () => {
    const dir = tempWorkDir();
    saveMessage(dir, "older", msg("user", "a"));
    await new Promise((r) => setTimeout(r, 20));
    saveMessage(dir, "newer", msg("user", "b"));
    const ids = listSessions(dir).map((s) => s.id);
    expect(ids).toEqual(["newer", "older"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cleanExpiredSessions（T2/F20/AC17/AC18）", () => {
  test("删除 30 天前的存档，刚创建的不动", () => {
    const dir = tempWorkDir();
    saveMessage(dir, "old", msg("user", "x"));
    saveMessage(dir, "fresh", msg("user", "y"));
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(getSessionFilePath(dir, "old"), oldTime, oldTime);
    expect(cleanExpiredSessions(dir)).toBe(1);
    expect(existsSync(getSessionFilePath(dir, "old"))).toBe(false);
    expect(existsSync(getSessionFilePath(dir, "fresh"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("rebuildFromSession（T19/I10）", () => {
  test("含 boundary：摘要 + keep + 边界之后的追加消息；边界前原始消息不回放", () => {
    const saved: SessionMessage[] = [
      msg("user", "user1"),
      msg("assistant", "asst1"),
      { role: "system", content: JSON.stringify({ summary: "EARLY SUMMARY", keep: [msg("user", "user2"), msg("assistant", "asst2")] }), timestamp: new Date().toISOString(), type: COMPACT_BOUNDARY },
      msg("user", "user3"),
      msg("assistant", "asst3"),
    ];
    const restored = rebuildFromSession(saved);
    expect(restored.map((m) => m.role)).toEqual(["user", "user", "assistant", "user", "assistant"]);
    expect(restored[0]!.content).toContain("本次会话延续自之前的对话");
    expect(restored[0]!.content).toContain("EARLY SUMMARY");
    expect(restored[0]!.content).toContain("近期消息已原样保留。");
    expect(restored.slice(1).map((m) => m.content)).toEqual(["user2", "asst2", "user3", "asst3"]);
    // 边界之前的原始消息（user1/asst1）不出现
    expect(restored.some((m) => m.content.includes("user1"))).toBe(false);
  });

  test("keep 为空：摘要消息无“近期消息”尾注", () => {
    const saved: SessionMessage[] = [
      msg("user", "u0"),
      { role: "system", content: JSON.stringify({ summary: "S", keep: [] }), timestamp: new Date().toISOString(), type: COMPACT_BOUNDARY },
    ];
    const restored = rebuildFromSession(saved);
    expect(restored.length).toBe(1);
    expect(restored[0]!.content).not.toContain("近期消息已原样保留");
  });

  test("无 boundary：全量 replay，兼容旧会话", () => {
    const saved = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")];
    const restored = rebuildFromSession(saved);
    expect(restored.map((m) => m.content)).toEqual(["u1", "a1", "u2"]);
  });

  test("boundary 之后还有第二条 boundary：只取最后一条，其余跳过", () => {
    const saved: SessionMessage[] = [
      msg("user", "u0"),
      { role: "system", content: JSON.stringify({ summary: "OLD", keep: [] }), timestamp: new Date().toISOString(), type: COMPACT_BOUNDARY },
      msg("user", "u1"),
      { role: "system", content: JSON.stringify({ summary: "NEW", keep: [msg("assistant", "k1")] }), timestamp: new Date().toISOString(), type: COMPACT_BOUNDARY },
      msg("user", "u2"),
    ];
    const restored = rebuildFromSession(saved);
    expect(restored.map((m) => m.content)).toEqual(["NEW", "k1", "u2"].map((c, i) => (i === 0 ? restored[0]!.content : c)));
    expect(restored[0]!.content).toContain("NEW");
    expect(restored.some((m) => m.content === "u1")).toBe(false);
  });

  test("boundary payload 损坏：不抛错，回放边界之后的普通消息", () => {
    const saved: SessionMessage[] = [
      msg("user", "u0"),
      { role: "system", content: "{not json", timestamp: new Date().toISOString(), type: COMPACT_BOUNDARY },
      msg("user", "u1"),
    ];
    const restored = rebuildFromSession(saved);
    expect(restored.map((m) => m.content)).toEqual(["u1"]);
  });
});

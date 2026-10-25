import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMailbox, withLock } from "../src/teams/file-mailbox.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-mailbox-"));
}

describe("FileMailbox", () => {
  it("delivers only unread messages and advances the cursor", async () => {
    const dir = tmpDir();
    const box = new FileMailbox(dir, "alice");

    await box.send("lead", "hi");
    const first = await box.receive();
    expect(first).toHaveLength(1);
    expect(first[0]!.from).toBe("lead");
    expect(first[0]!.text).toBe("hi");
    expect(first[0]!.timestamp).toBeTruthy();

    // 游标已推进：再接收为空
    expect(await box.receive()).toHaveLength(0);

    // 新消息只拿新的
    await box.send("lead", "second");
    const second = await box.receive();
    expect(second).toHaveLength(1);
    expect(second[0]!.text).toBe("second");
  });

  it("persists the read cursor across instances (process restart)", async () => {
    const dir = tmpDir();
    const writer = new FileMailbox(dir, "bob");
    await writer.send("lead", "m1");
    await writer.send("lead", "m2");

    // reader1 消费两条
    const reader1 = new FileMailbox(dir, "bob");
    expect(await reader1.receive()).toHaveLength(2);

    // 新进程视角：再写一条，reader2 从持久化游标继续
    await writer.send("lead", "m3");
    const reader2 = new FileMailbox(dir, "bob");
    expect(reader2.unreadCount()).toBe(1);
    const msgs = await reader2.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("m3");
  });

  it("markAllRead consumes without returning", async () => {
    const dir = tmpDir();
    const box = new FileMailbox(dir, "carol");
    await box.send("lead", "a");
    await box.send("lead", "b");

    box.markAllRead();
    expect(box.unreadCount()).toBe(0);
    expect(await box.receive()).toHaveLength(0);
  });

  it("receiveSync skips malformed lines", async () => {
    const dir = tmpDir();
    const box = new FileMailbox(dir, "dave");
    await box.send("lead", "good");
    // 手工追加坏行
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "dave.jsonl"), "{not-json\n", "utf-8");
    await box.send("lead", "after-bad");
    const msgs = await box.receive();
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.text)).toEqual(["good", "after-bad"]);
  });

  it("stale lock (>10s) is preempted by a new writer", async () => {
    const dir = tmpDir();
    const box = new FileMailbox(dir, "eve");
    const lockFile = join(dir, "eve.jsonl.lock");
    // 构造 mtime 在 11 秒前的锁文件
    writeFileSync(lockFile, "stale", "utf-8");
    const elevenSecsAgo = new Date(Date.now() - 11_000);
    utimesSync(lockFile, elevenSecsAgo, elevenSecsAgo);

    // 不应抛错：陈旧锁被抢占
    await box.send("lead", "preempted");
    const msgs = await box.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("preempted");
  });

  it("withLock releases the lock even when the callback throws", () => {
    const dir = tmpDir();
    const target = join(dir, "f.jsonl");
    expect(() =>
      withLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // 锁已释放：可以再次进入
    expect(withLock(target, () => 42)).toBe(42);
  });
});

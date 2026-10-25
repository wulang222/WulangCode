import { describe, expect, test } from "bun:test";
import { TaskManager } from "./task-manager.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** T10：Launch / Stop / drainNotifications（AC16-AC18）。 */
describe("TaskManager", () => {
  test("create returns a running task that completes with the runner output", async () => {
    const mgr = new TaskManager();
    const task = mgr.create("worker", async () => "done", () => {});
    expect(task.status).toBe("running");
    expect(task.output).toBe("");
    await tick();
    expect(task.status).toBe("completed");
    expect(task.output).toBe("done");
  });

  test("runner rejection flips the task to failed with the error text", async () => {
    const mgr = new TaskManager();
    const task = mgr.create("boom", async () => {
      throw new Error("boom");
    }, () => {});
    await tick();
    expect(task.status).toBe("failed");
    expect(task.output).toContain("Error: boom");
  });

  test("stop cancels a running task exactly once and marks it failed as user-stopped", async () => {
    const mgr = new TaskManager();
    let cancels = 0;
    const task = mgr.create(
      "forever",
      () => new Promise<string>(() => {}),
      () => {
        cancels += 1;
      },
    );
    mgr.stop(task.id);
    expect(cancels).toBe(1);
    expect(task.status).toBe("failed");
    expect(task.output).toBe("Stopped by user");
  });

  test("stop is a no-op for non-running tasks", async () => {
    const mgr = new TaskManager();
    const task = mgr.create("quick", async () => "ok", () => {});
    await tick();
    mgr.stop(task.id);
    expect(task.status).toBe("completed");
    expect(task.output).toBe("ok");
  });

  test("list returns all tasks and get finds by id", () => {
    const mgr = new TaskManager();
    const a = mgr.create("a", async () => "1", () => {});
    const b = mgr.create("b", async () => "2", () => {});
    expect(mgr.list().map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(mgr.get(b.id)?.name).toBe("b");
  });

  test("drainNotifications returns only non-running tasks", async () => {
    const mgr = new TaskManager();
    mgr.create("finished", async () => "x", () => {});
    mgr.create("running", () => new Promise<string>(() => {}), () => {});
    await tick();
    const drained = mgr.drainNotifications();
    expect(drained.map((t) => t.name)).toEqual(["finished"]);
  });
});

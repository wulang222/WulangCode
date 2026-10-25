import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamManager } from "../src/teams/team.js";
import { detectBackend, detectPaneBackend, spawnTeammate } from "../src/teams/backend.js";
import {
  TeamCreateTool,
  SpawnTeammateTool,
  SendMessageTool,
  ListTeamsTool,
  TeamDeleteTool,
} from "../src/teams/tools.js";
import { coordinatorToolFilter, isCoordinatorTool } from "../src/teams/coordinator.js";
import { createProgress, recordToolUse, formatTokens } from "../src/teams/progress.js";
import type { ToolContext } from "../src/tools/types.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workDir = () => mkdtempSync(join(tmpdir(), "mewcode-team-"));
const ctx: ToolContext = { workDir: "/tmp" };

describe("teams orchestration", () => {
  it("spawn → lead mailbox receives [idle] notification with member name", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    const team = mgr.create("demo");

    team.spawnTeammate("alice", "noop", async () => "done");
    expect(team.getMember("alice")?.active).toBe(true);

    // 等主循环跑完一轮 + idle 通知落盘
    await wait(300);
    const drained = mgr.drainLeads();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain('team="demo"');
    expect(drained[0]).toContain("from=alice");
    expect(drained[0]).toContain("[idle]");

    // 消耗性读取：再抽为空
    expect(mgr.drainLeads()).toHaveLength(0);
  });

  it("failing teammate sends failed notification and marks state failed", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    const team = mgr.create("t2");

    team.spawnTeammate("bob", "boom", async () => {
      throw new Error("kaboom");
    });
    await wait(300);

    const state = team.getTeammateStates().find((s) => s.name === "bob");
    expect(state?.status).toBe("failed");
    const drained = mgr.drainLeads().join("\n");
    expect(drained).toContain("from=bob");
    expect(drained).toContain("failed");
  });

  it("shutdown message exits the member loop (active=false)", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    const team = mgr.create("t3");

    // 长任务：跑的过程中被 shutdown
    team.spawnTeammate("carol", "long", async () => {
      await wait(2000);
      return "never";
    });
    await wait(50);
    await team.sendMessage("lead", "carol", "[shutdown] please exit");

    // shutdown 在任务跑完后的 idle 轮询里被消费；给足时间
    await wait(500);
    // 任务仍在跑时 active 还是 true；任务结束后轮询到 shutdown 退出
    await wait(2500);
    expect(team.getMember("carol")?.active).toBe(false);
  });

  it("Team constructor creates mailbox dir; multiple constructions don't throw", () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    mgr.create("demo");
    expect(readdirExists(join(dir, ".mewcode", "teams", "demo"))).toBe(true);
    expect(() => mgr.create("demo")).not.toThrow();
  });

  it("five tools happy path: create → spawn → sendMessage → list → delete", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    const noopAgent = async (task: string) => `ok:${task}`;

    const created = await new TeamCreateTool(mgr).execute({ name: "alpha" }, ctx);
    expect(created.isError).toBe(false);
    expect(created.output).toBe("Team 'alpha' created.");

    const again = await new TeamCreateTool(mgr).execute({ name: "alpha" }, ctx);
    expect(again.output).toBe("Team 'alpha' already exists.");
    expect(again.isError).toBe(false);

    const spawned = await new SpawnTeammateTool(mgr, noopAgent).execute(
      { team: "alpha", name: "dave", task: "count lines" },
      ctx,
    );
    expect(spawned.isError).toBe(false);
    expect(spawned.output).toContain("working and watch for it");

    // SpawnTeammate 到不存在的 team 自动创建
    const autoTeam = await new SpawnTeammateTool(mgr, noopAgent).execute(
      { team: "beta", name: "erin", task: "explore" },
      ctx,
    );
    expect(autoTeam.isError).toBe(false);
    expect(mgr.get("beta")).toBeDefined();

    const sent = await new SendMessageTool(mgr).execute(
      { team: "alpha", to: "dave", message: "hello" },
      ctx,
    );
    expect(sent.isError).toBe(false);
    // 队员信箱确实收到
    const member = mgr.get("alpha")!.getMember("dave")!;
    const msgs = member.mailbox.receiveSync();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.from).toBe("lead");
    expect(msgs[0]!.text).toBe("hello");

    const list = await new ListTeamsTool(mgr).execute({}, ctx);
    expect(list.output).toContain("alpha [in-process]");
    expect(list.output).toContain("dave");
    expect(list.output).toContain("beta [in-process]");

    await new TeamDeleteTool(mgr).execute({ name: "alpha" }, ctx);
    expect(mgr.get("alpha")).toBeUndefined();
  });

  it("tool required-field validation returns isError", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);

    const noName = await new TeamCreateTool(mgr).execute({}, ctx);
    expect(noName.isError).toBe(true);

    const partialSpawn = await new SpawnTeammateTool(mgr, async () => "").execute(
      { team: "x" },
      ctx,
    );
    expect(partialSpawn.isError).toBe(true);

    const unknownTeam = await new SendMessageTool(mgr).execute(
      { team: "nope", to: "a", message: "m" },
      ctx,
    );
    expect(unknownTeam.isError).toBe(true);
    expect(unknownTeam.output).toContain("not found");

    // 已知团队但收件人不存在 → isError
    await new TeamCreateTool(mgr).execute({ name: "y" }, ctx);
    const unknownMember = await new SendMessageTool(mgr).execute(
      { team: "y", to: "ghost", message: "m" },
      ctx,
    );
    expect(unknownMember.isError).toBe(true);
  });

  it("ListTeamsTool returns 'No teams.' when empty", async () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    const list = await new ListTeamsTool(mgr).execute({}, ctx);
    expect(list.output).toBe("No teams.");
  });
});

describe("coordinator filter", () => {
  it("allows everything when no team exists", () => {
    const mgr = new TeamManager(workDir());
    const filter = coordinatorToolFilter(mgr);
    expect(filter("WriteFile")).toBe(true);
    expect(filter("Bash")).toBe(true);
    expect(filter("mcp__anything")).toBe(true);
  });

  it("narrows to whitelist when a team exists; mcp__ always passes", () => {
    const dir = workDir();
    const mgr = new TeamManager(dir);
    mgr.create("c1");
    const filter = coordinatorToolFilter(mgr);

    expect(filter("WriteFile")).toBe(false);
    expect(filter("EditFile")).toBe(false);
    expect(filter("Bash")).toBe(true);
    expect(filter("Agent")).toBe(true);
    expect(filter("SpawnTeammate")).toBe(true);
    expect(filter("ReadFile")).toBe(true);
    expect(filter("mcp__foo")).toBe(true);
    expect(filter("SomeRandomTool")).toBe(false);
  });

  it("whitelist contains Bash but not WriteFile/EditFile", () => {
    expect(isCoordinatorTool("Bash")).toBe(true);
    expect(isCoordinatorTool("WriteFile")).toBe(false);
    expect(isCoordinatorTool("EditFile")).toBe(false);
  });
});

describe("backend & progress", () => {
  it("detectBackend always returns in-process", () => {
    expect(detectBackend()).toBe("in-process");
  });

  it("detectPaneBackend returns tmux when TMUX env set", () => {
    const prev = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-0/default,123,0";
    try {
      expect(detectPaneBackend()).toBe("tmux");
    } finally {
      if (prev === undefined) delete process.env.TMUX;
      else process.env.TMUX = prev;
    }
  });

  it("spawnTeammate rejects iterm mode", () => {
    expect(() =>
      spawnTeammate({ mode: "iterm", command: "echo", args: [], cwd: "/tmp" }),
    ).toThrow("iTerm backend not supported on this platform");
  });

  it("progress ring buffer caps at 5; formatTokens formats", () => {
    const p = createProgress();
    for (let i = 0; i < 6; i++) recordToolUse(p, "Bash", { command: `cmd-${i}` });
    expect(p.toolUseCount).toBe(6);
    expect(p.recentActivities).toHaveLength(5);
    expect(p.recentActivities[0]!.activityDescription).toBe("Running cmd-1");
    expect(p.recentActivities[4]!.activityDescription).toBe("Running cmd-5");

    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

/** existsSync 语义包装：目录存在才返回 true。 */
function readdirExists(path: string): boolean {
  const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
  try {
    return statSync(path).isDirectory();
  } catch {
    return existsSync(path);
  }
}

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamManager } from "../src/teams/team.js";
import { CodeReviewManager } from "../src/code-review/manager.js";
import { ReviewSession } from "../src/code-review/session.js";
import { handleCodeReviewCommand } from "../src/code-review/handler.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-review-"));
}

function makeManagers(dir: string) {
  const teamMgr = new TeamManager(dir);
  const mgr = new CodeReviewManager(dir, teamMgr);
  const session = new ReviewSession(dir, mgr);
  return { teamMgr, mgr, session };
}

describe("CodeReviewManager", () => {
  it("createTeam persists JSON and syncs bottom TeamManager", () => {
    const dir = tmpDir();
    const { teamMgr, mgr } = makeManagers(dir);

    mgr.createTeam("review-X", [
      { name: "alice", email: "a@x.com", role: "reviewer", expertise: ["ts"] },
      { name: "bob", email: "b@x.com", role: "reviewer", expertise: ["test"] },
    ]);

    // JSON 落地
    const configPath = join(dir, ".mewcode", "code-review-teams.json");
    expect(existsSync(configPath)).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toContain("review-X");

    // 底层团队同步
    const bottom = teamMgr.get("review-X");
    expect(bottom).toBeDefined();
    expect(bottom!.getMember("alice")).toBeDefined();
    expect(bottom!.getMember("bob")).toBeDefined();

    expect(mgr.listTeams().map((t) => t.name)).toContain("review-X");
  });

  it("addMember / removeMember / activate / deactivate update members and lastActive", () => {
    const dir = tmpDir();
    const { mgr } = makeManagers(dir);

    mgr.createTeam("t", [{ name: "alice", email: "a@x.com", role: "reviewer", expertise: [] }]);
    const before = mgr.getTeam("t")!.lastActive;

    mgr.addMember("t", { name: "bob", email: "b@x.com", role: "critic", expertise: [] });
    expect(mgr.getTeam("t")!.members.map((m) => m.name)).toContain("bob");
    expect(mgr.getTeam("t")!.lastActive >= before).toBe(true);

    mgr.deactivateMember("t", "alice");
    expect(mgr.getTeam("t")!.members.find((m) => m.name === "alice")!.active).toBe(false);
    expect(mgr.getActiveReviewers("t")).toHaveLength(0);

    mgr.activateMember("t", "alice");
    expect(mgr.getActiveReviewers("t")).toHaveLength(1);

    mgr.removeMember("t", "bob");
    expect(mgr.getTeam("t")!.members.map((m) => m.name)).toEqual(["alice"]);

    mgr.deleteTeam("t");
    expect(mgr.getTeam("t")).toBeUndefined();
  });

  it("loadTeams silently falls back on corrupted JSON", () => {
    const dir = tmpDir();
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, ".mewcode"), { recursive: true });
    writeFileSync(join(dir, ".mewcode", "code-review-teams.json"), "{not-json", "utf-8");

    const teamMgr = new TeamManager(dir);
    expect(() => new CodeReviewManager(dir, teamMgr)).not.toThrow();
    expect(new CodeReviewManager(dir, teamMgr).listTeams()).toHaveLength(0);
  });
});

describe("ReviewSession", () => {
  it("createReviewRequest throws when no active reviewers", () => {
    const dir = tmpDir();
    const { mgr, session } = makeManagers(dir);
    mgr.createTeam("r0", [{ name: "alice", email: "a@x.com", role: "reviewer", expertise: [] }]);
    mgr.deactivateMember("r0", "alice");

    expect(() => session.createReviewRequest("r0", "t", "d", "me", "main", [])).toThrow(
      "No active reviewers in team 'r0'",
    );
    // 团队不存在也抛
    expect(() => session.createReviewRequest("ghost", "t", "d", "me", "main", [])).toThrow(
      "not found",
    );
  });

  it("comment → critic → report pipeline", () => {
    const dir = tmpDir();
    const { mgr, session } = makeManagers(dir);
    mgr.createTeam("r1", [
      { name: "alice", email: "a@x.com", role: "reviewer", expertise: [] },
      { name: "bob", email: "b@x.com", role: "reviewer", expertise: [] },
      { name: "carol", email: "c@x.com", role: "junior", expertise: [] },
    ]);

    const request = session.createReviewRequest("r1", "fix bug", "desc", "me", "main", ["src/"]);
    expect(request.status).toBe("pending");
    expect(request.reviewers).toHaveLength(3);

    const c1 = session.addComment(request.id, "alice", "should sanitize input", "src/login.ts", 42);
    expect(c1.id).toMatch(/^comment-\d+-\d+$/);
    expect(c1.file).toBe("src/login.ts");

    const c2 = session.addComment(request.id, "bob", "naming could be clearer");

    const assessment = session.addCriticAssessment(
      request.id,
      c1.id,
      "critic-1",
      "reasonable",
      "good catch on input validation",
    );
    expect(assessment.evaluation).toBe("reasonable");

    session.acceptComment(request.id, c2.id, "will rename");

    // Critic 总结包含评估文本
    const criticSummary = session.getCriticSummary(request.id);
    expect(criticSummary).toContain("good catch on input validation");
    expect(criticSummary).toContain("critic-1");

    const summary = session.generateFinalReport(request.id);
    expect(summary.totalComments).toBe(2);
    expect(summary.accepted).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.verdict).toBe("changes-requested");
    expect(summary.fileFeedback.map((f) => f.file)).toContain("src/login.ts");

    const report = session.formatFinalReport(summary);
    expect(report).toContain("Total Comments: 2");
    expect(report).toContain("Accepted: 1");
    expect(report).toContain("File-specific Feedback");
    expect(report).toContain("Key Findings");

    session.updateRequestStatus(request.id, "approved");
    expect(session.getRequest(request.id)!.status).toBe("approved");
  });

  it("getActiveReviewers excludes critic role", () => {
    const dir = tmpDir();
    const { mgr } = makeManagers(dir);
    mgr.createTeam("r2", [
      { name: "alice", email: "a@x.com", role: "reviewer", expertise: [] },
      { name: "zed", email: "z@x.com", role: "critic", expertise: [] },
    ]);
    // critic 不算 reviewer
    expect(mgr.getActiveReviewers("r2").map((m) => m.name)).toEqual(["alice"]);
  });
});

describe("/code-review command handler", () => {
  it("create → list → request → comment → critic → report chain", () => {
    const dir = tmpDir();
    const { mgr, session } = makeManagers(dir);
    const ctx = (args: string) => ({ workDir: dir, args });

    const created = handleCodeReviewCommand(ctx("create review-A"), mgr, session);
    expect(created).toContain("created");

    const list = handleCodeReviewCommand(ctx("list"), mgr, session);
    expect(list).toContain("review-A");
    expect(list).toContain("3/3 active");

    const status = handleCodeReviewCommand(ctx("status review-A"), mgr, session);
    expect(status).toContain("alice");

    const request = handleCodeReviewCommand(
      ctx('request review-A "fix login bug" "session token leaked"'),
      mgr,
      session,
    );
    expect(request).toMatch(/Created review request 'review-\d+'/);

    const reqId = request.match(/review-\d+/)![0];
    const comment = handleCodeReviewCommand(
      ctx(`comment ${reqId} "should sanitize input"`),
      mgr,
      session,
    );
    const commentId = comment.match(/comment-\d+-\d+/)![0];
    expect(comment).toContain("added");

    const critic = handleCodeReviewCommand(
      ctx(`critic ${reqId} ${commentId} reasonable "good catch on input validation"`),
      mgr,
      session,
    );
    expect(critic).toContain("reasonable");

    const criticSummary = handleCodeReviewCommand(ctx(`critic-summary ${reqId}`), mgr, session);
    expect(criticSummary).toContain("good catch on input validation");

    const report = handleCodeReviewCommand(ctx(`report ${reqId}`), mgr, session);
    expect(report).toContain("Total Comments");
    expect(report).toContain("Accepted");
    expect(report).toContain("File-specific Feedback");
  });

  it("unknown command returns help text", () => {
    const dir = tmpDir();
    const { mgr, session } = makeManagers(dir);
    const help = handleCodeReviewCommand({ workDir: dir, args: "bogus" }, mgr, session);
    expect(help).toContain("Usage: /code-review");
  });

  it("errors surface as 'Error: ...'", () => {
    const dir = tmpDir();
    const { mgr, session } = makeManagers(dir);
    const out = handleCodeReviewCommand(ctx("status ghost"), mgr, session);
    expect(out).toContain("Error:");
    function ctx(args: string) {
      return { workDir: dir, args };
    }
  });
});

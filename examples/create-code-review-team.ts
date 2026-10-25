/**
 * 代码评审团队示例：构造 TeamManager + CodeReviewManager，
 * 创建默认三人评审组并打印团队摘要。
 *
 * 运行：bun run examples/create-code-review-team.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamManager } from "../src/teams/team.js";
import { CodeReviewManager, createDefaultCodeReviewTeam } from "../src/code-review/manager.js";

const workDir = mkdtempSync(join(tmpdir(), "mewcode-example-review-"));
const teamManager = new TeamManager(workDir);
const reviewManager = new CodeReviewManager(workDir, teamManager);

const team = reviewManager.createTeam("demo-review", createDefaultCodeReviewTeam());
console.log(`Created review team '${team.name}' with ${team.members.length} members:`);
console.log(reviewManager.getTeamSummary("demo-review"));
console.log(`\nConfig written to: ${join(workDir, ".mewcode", "code-review-teams.json")}`);

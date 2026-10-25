/**
 * 自定义团队示例：构造 TeamManager，创建团队并添加两名成员，
 * 打印成员列表。
 *
 * 运行：bun run examples/create-custom-team.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamManager } from "../src/teams/team.js";

const workDir = mkdtempSync(join(tmpdir(), "mewcode-example-team-"));
const manager = new TeamManager(workDir);

const team = manager.create("custom");
team.addMember("alice");
team.addMember("bob");

console.log(`Team 'custom' created at: ${join(workDir, ".mewcode", "teams", "custom")}`);
console.log("Members:");
for (const m of team.listMembers()) {
  console.log(`  - ${m.name} (active: ${m.active})`);
}

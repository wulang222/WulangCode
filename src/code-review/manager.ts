import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Team, TeamManager } from "../teams/team.js";
import { detectBackend } from "../teams/backend.js";

/** 评审成员角色（F62）：评审者 / 组长 / 初级 / 元评审（Critic）。 */
export type CodeReviewRole = "reviewer" | "lead" | "junior" | "critic";

/** 评审成员（F62）：名称、邮箱、角色、专业领域、活跃标记。 */
export interface CodeReviewMember {
  name: string;
  email: string;
  role: CodeReviewRole;
  expertise: string[];
  active: boolean;
}

/** 评审团队（F63）：名称、成员、创建时间、最近活跃时间。 */
export interface CodeReviewTeam {
  name: string;
  members: CodeReviewMember[];
  createdAt: string;
  lastActive: string;
}

/**
 * 评审团队管理器（F64-F66）：评审场景化封装，构建在 TeamManager 之上。
 * 评审团队 JSON 持久化到 <workDir>/.mewcode/code-review-teams.json；
 * 每次成员操作双写底层 TeamManager（复用同一套信箱基础设施）。
 */
export class CodeReviewManager {
  private teams = new Map<string, CodeReviewTeam>();
  private configPath: string;
  private teamManager: TeamManager;
  private workDir: string;

  constructor(workDir: string, teamManager: TeamManager) {
    this.workDir = workDir;
    this.configPath = join(workDir, ".mewcode", "code-review-teams.json");
    this.teamManager = teamManager;
    this.loadTeams();
  }

  /** 反序列化加载（F64）：文件不存在跳过；解析失败静默回退空 map。 */
  private loadTeams(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8")) as Record<
        string,
        CodeReviewTeam
      >;
      for (const [name, team] of Object.entries(raw)) {
        this.teams.set(name, team);
      }
    } catch {
      // 损坏的 JSON 静默回退
    }
  }

  private saveTeams(): void {
    mkdirSync(join(this.workDir, ".mewcode"), { recursive: true });
    const data: Record<string, CodeReviewTeam> = {};
    for (const [name, team] of this.teams.entries()) {
      data[name] = team;
    }
    writeFileSync(this.configPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** 创建评审团队（F65）：成员标记活跃后保存，并同步底层团队 + 逐个 addMember。 */
  createTeam(name: string, members: Omit<CodeReviewMember, "active">[]): CodeReviewTeam {
    const now = new Date().toISOString();
    const team: CodeReviewTeam = {
      name,
      members: members.map((m) => ({ ...m, active: true })),
      createdAt: now,
      lastActive: now,
    };
    this.teams.set(name, team);
    this.saveTeams();
    const teamInstance: Team = this.teamManager.create(name, detectBackend());
    for (const m of team.members) teamInstance.addMember(m.name);
    return team;
  }

  getTeam(name: string): CodeReviewTeam | undefined {
    return this.teams.get(name);
  }

  listTeams(): CodeReviewTeam[] {
    return [...this.teams.values()];
  }

  /** 添加成员（F66）：更新 lastActive 并写回 JSON；同步底层团队信箱。 */
  addMember(teamName: string, member: Omit<CodeReviewMember, "active">): void {
    const team = this.getRequiredTeam(teamName);
    team.members.push({ ...member, active: true });
    this.touchAndSave(team);
    this.bottomTeam(teamName)?.addMember(member.name);
  }

  /** 移除成员（F66）。 */
  removeMember(teamName: string, memberName: string): void {
    const team = this.getRequiredTeam(teamName);
    team.members = team.members.filter((m) => m.name !== memberName);
    this.touchAndSave(team);
  }

  /** 激活成员（F66）。 */
  activateMember(teamName: string, memberName: string): void {
    const team = this.getRequiredTeam(teamName);
    const member = team.members.find((m) => m.name === memberName);
    if (!member) throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    member.active = true;
    this.touchAndSave(team);
  }

  /** 停用成员（F66）。 */
  deactivateMember(teamName: string, memberName: string): void {
    const team = this.getRequiredTeam(teamName);
    const member = team.members.find((m) => m.name === memberName);
    if (!member) throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    member.active = false;
    this.touchAndSave(team);
  }

  /** 删除团队（F66）：更新 JSON；同步删底层团队（失败忽略）。 */
  deleteTeam(name: string): void {
    if (!this.teams.has(name)) throw new Error(`Team '${name}' not found`);
    this.teams.delete(name);
    this.saveTeams();
    try {
      void this.teamManager.delete(name);
    } catch {
      // 底层团队删除失败不影响评审层
    }
  }

  /** 活跃评审者（F65 校验用）：角色为 reviewer/lead/junior 且 active。 */
  getActiveReviewers(teamName: string): CodeReviewMember[] {
    const team = this.getRequiredTeam(teamName);
    return team.members.filter((m) => m.active && m.role !== "critic");
  }

  /** 团队摘要：`<name> (active/total active)` + 每成员一行。 */
  getTeamSummary(teamName: string): string {
    const team = this.getRequiredTeam(teamName);
    const active = team.members.filter((m) => m.active).length;
    const lines = [
      `${team.name} (${active}/${team.members.length} active)`,
      ...team.members.map(
        (m) => `  - ${m.name} <${m.email}> [${m.role}] expertise: ${m.expertise.join(", ") || "none"}`,
      ),
    ];
    return lines.join("\n");
  }

  private getRequiredTeam(teamName: string): CodeReviewTeam {
    const team = this.teams.get(teamName);
    if (!team) throw new Error(`Team '${teamName}' not found`);
    return team;
  }

  private touchAndSave(team: CodeReviewTeam): void {
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  private bottomTeam(teamName: string): Team | undefined {
    return this.teamManager.get(teamName);
  }
}

/** 默认三人评审组工厂：alice（senior reviewer）/ bob / charlie。 */
export function createDefaultCodeReviewTeam(): Omit<CodeReviewMember, "active">[] {
  return [
    {
      name: "alice",
      email: "alice@example.com",
      role: "reviewer",
      expertise: ["typescript", "architecture"],
    },
    {
      name: "bob",
      email: "bob@example.com",
      role: "reviewer",
      expertise: ["testing", "performance"],
    },
    {
      name: "charlie",
      email: "charlie@example.com",
      role: "junior",
      expertise: ["documentation"],
    },
  ];
}

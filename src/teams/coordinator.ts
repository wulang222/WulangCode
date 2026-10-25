import type { TeamManager } from "./team.js";

/**
 * Coordinator Mode 白名单（F49/G14）：协作类 + 只读类 + shell。
 * 存在至少一个 Team 时，Lead 只保留这些工具（剥夺写类）。
 */
const COORDINATOR_ALLOWED_TOOLS = new Set([
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "ListTeams",
  "SpawnTeammate",
  "ReadFile",
  "Glob",
  "Grep",
  "Bash",
]);

/** 查表白名单（F50）。 */
export function isCoordinatorTool(name: string): boolean {
  return COORDINATOR_ALLOWED_TOOLS.has(name);
}

/**
 * 工具过滤器构造（F51/N1/N2）：无 Team 时放行任意工具（软强制自动恢复）；
 * 插件来源（mcp__ 前缀）始终放行；否则按白名单判断。
 */
export function coordinatorToolFilter(teamMgr: TeamManager): (name: string) => boolean {
  return (name: string) => {
    if (teamMgr.list().length === 0) return true;
    if (name.startsWith("mcp__")) return true;
    return isCoordinatorTool(name);
  };
}

import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";

/**
 * 全局禁止列表：所有子 Agent 永远看不到的工具（F24/G9）——
 * Agent 工具自身（断绝嵌套）以及会破坏子 Agent 工作语义的控制类工具。
 */
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "TaskOutput",
  "ExitPlanMode",
  "EnterPlanMode",
  "Agent",
  "AskUserQuestion",
  "TaskStop",
  "Workflow",
]);

/** 自定义 Agent 额外禁止列表：本期与全局一致，独立维护以便未来分化（F24）。 */
export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([...ALL_AGENT_DISALLOWED_TOOLS]);

/** 后台 Agent 白名单：只保留基础读 / 写 / 搜索 / 命令 / 网络等核心工具（F24）。 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  "ReadFile",
  "WebSearch",
  "TodoWrite",
  "Grep",
  "WebFetch",
  "Glob",
  "Bash",
  "EditFile",
  "WriteFile",
  "NotebookEdit",
  "Skill",
  "LoadSkill",
  "SyntheticOutput",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
]);

/** MCP 工具按 mcp__ 前缀识别，过滤时永久放行（F25 第 1 层）。 */
export function isMCPTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * 多层防线过滤（F25）：MCP 放行 → 全局禁止 → 自定义禁止 → 后台白名单
 * → 定义层黑名单 → 定义层白名单（仅 "*" 时视为通配不再收窄，F26）。
 * 输出新的 ToolRegistry，主 Agent 的注册表不受影响（F27）。
 */
export function filterToolsForAgent(
  registry: ToolRegistry,
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  isAsync: boolean,
  isCustom = false,
): ToolRegistry {
  const disallowed = new Set(disallowedTools ?? []);
  const allowed = new Set(allowedTools ?? []);
  const hasWhitelist = allowed.size > 0 && !(allowed.size === 1 && allowed.has("*"));
  const filtered = new ToolRegistry();

  for (const tool of registry.listTools()) {
    if (isMCPTool(tool.name)) {
      filtered.register(tool);
      continue;
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) continue;
    if (isCustom && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) continue;
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) continue;
    if (disallowed.has(tool.name)) continue;
    if (hasWhitelist && !allowed.has(tool.name)) continue;
    filtered.register(tool);
  }
  return filtered;
}

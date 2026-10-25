import type { PermissionMode } from "../permissions/checker.js";

/**
 * 子 Agent 角色定义：内置静态数组 + Markdown frontmatter 文件（loader 加载）
 * 共用同一形态。除 name / description 外全部可选（F4）。
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /** 定义层工具白名单；仅含 "*" 视为通配（不再收窄）。 */
  tools?: string[];
  /** 定义层工具黑名单。 */
  disallowedTools?: string[];
  /** 直接替换默认系统提示词。 */
  systemPromptOverride?: string;
  maxTurns?: number;
  /** 模型档位别名（haiku/sonnet/opus）或完整 model id。 */
  model?: string;
  permissionMode?: PermissionMode;
  /** 强制后台执行开关。 */
  background?: boolean;
  /** 隔离模式保留位：文件级工作树隔离留给后续章节。 */
  isolation?: "worktree";
  /** 定义文件正文：作为角色附加指令注入子 Agent。 */
  initialPrompt?: string;
  omitMewcodeMd?: boolean;
  skills?: string[];
  memory?: boolean;
  mcpServers?: string[];
}

/** 内置三角色（F5/G10/AC21）。 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  },
  {
    name: "plan",
    description: "Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files.",
    disallowedTools: ["EditFile", "WriteFile"],
    permissionMode: "plan",
  },
  {
    name: "explore",
    description: "Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols or keywords.",
    disallowedTools: ["EditFile", "WriteFile"],
    permissionMode: "plan",
    model: "haiku",
  },
];

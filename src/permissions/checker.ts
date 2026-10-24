import type { ToolCategory } from "../tools/types.js";

/** 权限模式：default 正常放行；plan 计划态只放行只读；bypass 全放行（占位）。 */
export type PermissionMode = "default" | "plan" | "bypass";

export interface Decision {
  effect: "allow" | "ask" | "deny";
  reason?: string;
}

/**
 * 权限检查占位实现。
 * 本章只有 plan 模式做物理拦截（deny 非 read 工具），其余全部 allow；
 * ask 交互对话留待专门章节。
 */
export class PermissionChecker {
  mode: PermissionMode;
  planFilePath?: string;

  /** 已"始终允许"的工具名集合。本章仅记录，不参与判定。 */
  private readonly alwaysAllowed = new Set<string>();

  constructor(mode: PermissionMode = "default") {
    this.mode = mode;
  }

  check(_toolName: string, category: ToolCategory, _args: Record<string, unknown>): Decision {
    if (this.mode === "plan" && category !== "read") {
      return { effect: "deny", reason: "Plan mode: only read-only tools are allowed." };
    }
    return { effect: "allow" };
  }

  allowAlways(toolName: string, _args: Record<string, unknown>): void {
    this.alwaysAllowed.add(toolName);
  }
}

/** 工具类别：读 / 写 / 命令。本章仅用于语义分组，不驱动串并行策略。 */
export type ToolCategory = "read" | "write" | "command";

/** 工具执行结果。失败也是结果（isError: true），绝不抛异常给上层。 */
export interface ToolResult {
  output: string;
  isError: boolean;
}

/** 工具执行上下文：本章只承载工作目录所需的最小信息。 */
export interface ToolContext {
  workDir: string;
  abortSignal?: AbortSignal;
}

/**
 * 统一工具抽象。
 * schema() 返回 Anthropic 平铺形态 { name, description, input_schema }，
 * 协议翻译（OpenAI 包装）由 ToolRegistry.getAllSchemas / 各 client 完成。
 */
export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Glob / Grep 遍历时跳过的常见无关目录。 */
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".mewcode",
  ".claude",
  "vendor",
  ".venv",
  "venv",
]);

/** 取字符串参数；缺失或类型不对时回退 fallback。 */
export function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  if (typeof value === "string") return value;
  return fallback;
}

/** 取整数参数；接受数字与字符串数字（parseInt），其余回退 fallback。 */
export function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 取布尔参数；仅接受布尔值，其余回退 fallback。 */
export function boolArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  return fallback;
}

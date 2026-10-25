/** 工具活动（F33）：工具名 + 入参 + 人读描述。 */
export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription: string;
}

/** 队员进度（F32）：工具次数、token 计数、最近活动、容量 5 的环形缓冲。 */
export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[];
}

/** 队员 UI 状态（F34）：TUI 每 500ms 拷贝快照渲染 Spinner Tree。 */
export interface TeammateUIState {
  name: string;
  teamName: string;
  status: "running" | "idle" | "completed" | "failed" | "stopped";
  progress: AgentProgress;
  startTime: number;
  spinnerVerb: string;
  lastMessage?: string;
}

/** 创建零值进度（F35）。 */
export function createProgress(): AgentProgress {
  return { toolUseCount: 0, tokenCount: 0, lastActivity: undefined, recentActivities: [] };
}

/** 记录一次工具调用（F36）：计数 + 生成描述 + 更新最近活动与环形缓冲。 */
export function recordToolUse(
  p: AgentProgress,
  toolName: string,
  input: Record<string, unknown>,
): void {
  p.toolUseCount++;
  const desc = describeToolActivity(toolName, input);
  const activity: ToolActivity = { toolName, input, activityDescription: desc };
  p.lastActivity = activity;
  p.recentActivities.push(activity);
  if (p.recentActivities.length > 5) p.recentActivities.shift();
}

/** 记录 token 用量（F37）：输入 + 输出累加到 token 计数。 */
export function recordTokens(p: AgentProgress, inputTokens: number, outputTokens: number): void {
  p.tokenCount += inputTokens + outputTokens;
}

/** 工具活动描述（F38）：按工具名分支生成简短人读文本。 */
function describeToolActivity(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "ReadFile":
      return "Reading " + (input.file_path ?? "file");
    case "EditFile":
      return "Editing " + (input.file_path ?? "file");
    case "WriteFile":
      return "Writing " + (input.file_path ?? "file");
    case "Bash": {
      const cmd = String(input.command ?? "");
      return "Running " + (cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd);
    }
    case "Glob":
      return "Searching " + (input.pattern ?? "files");
    case "Grep":
      return "Grepping " + (input.pattern ?? "pattern");
    default:
      return toolName;
  }
}

/** 活动汇总（F39 上）：空返空串，否则返回最后一条活动的描述。 */
export function summarizeActivities(activities: ToolActivity[]): string {
  if (activities.length === 0) return "";
  return activities[activities.length - 1]!.activityDescription;
}

/** token 格式化（F39 下）：1.5M / 1.5k / 原值。 */
export function formatTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

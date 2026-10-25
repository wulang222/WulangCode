import chalk from "chalk";

/** 真彩色主题。chalk.level 在渲染入口设为 3。 */
export const brand = {
  primary: chalk.hex("#a78bfa"),
  bright: chalk.hex("#c4b5fd"),
  error: chalk.hex("#f87171"),
  success: chalk.hex("#4ade80"),
  warning: chalk.hex("#fbbf24"),
  muted: chalk.hex("#6b7280"),
  tool: chalk.hex("#38bdf8"),
  thinking: chalk.hex("#94a3b8"),
  user: chalk.hex("#e2e8f0"),
  assistant: chalk.hex("#f8fafc"),
};

export const symbols = {
  prompt: "❯",
  diamond: "◆",
  play: "▶",
  check: "✓",
  cross: "✗",
  arrow: "→",
  dot: "·",
};

/** 命令类型图标（day9 T7）：local/local_ui ⚙、skill_fork ★、prompt ◇。 */
export const commandIcons: Record<string, string> = {
  local: "⚙",
  local_ui: "⚙",
  skill_fork: "★",
  prompt: "◇",
};

export const borderColors = {
  idle: "#6b7280",
  focus: "#a78bfa",
  error: "#f87171",
};

/** 1200 → 1.2K，240 → 240。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const scaled = value / 1000;
  const text = scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
  return `${text}K`;
}

import { execSync, spawn } from "node:child_process";
import type { TeamMode } from "./team.js";

/**
 * 默认后端检测（F17）：始终返回进程内模式，不做环境探测——
 * 进度事件直接在同进程内流向 Spinner Tree，UX 最佳。
 */
export function detectBackend(): TeamMode {
  return "in-process";
}

/**
 * 显式窗格后端探测（F18）：仅在用户明确选择窗格模式时调用。
 * tmux 会话环境变量优先；否则尝试在 PATH 上找 tmux；都不行退回进程内。
 */
export function detectPaneBackend(): TeamMode {
  if (process.env.TMUX) return "tmux";
  try {
    execSync("which tmux", { stdio: ["pipe", "pipe", "pipe"] });
    return "tmux";
  } catch {
    return "in-process";
  }
}

/** 派遣配置（F19）：模式 + 命令 + 参数 + 工作目录 + 可选环境变量。 */
export interface SpawnConfig {
  mode: TeamMode;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/**
 * 派遣队员工厂（F20 / G7）：把后端差异收敛到一个函数。
 * - in-process：子进程启动，cancel 发 SIGTERM
 * - tmux：先 new-window，失败回退 detached new-session；cancel 杀会话；paneId 为会话名
 * - iterm：本期显式拒绝
 */
export function spawnTeammate(config: SpawnConfig): { cancel: () => void; paneId?: string } {
  switch (config.mode) {
    case "in-process": {
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...config.env },
      });
      return { cancel: () => child.kill("SIGTERM") };
    }
    case "tmux": {
      const sessionName = "mewcode-" + Date.now().toString(36);
      const cmd = [config.command, ...config.args].join(" ");
      try {
        execSync(`tmux new-window -t "${sessionName}" -n teammate "${cmd}"`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        execSync(`tmux new-session -d -s "${sessionName}" -n teammate "${cmd}"`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      return {
        cancel: () => {
          try {
            execSync(`tmux kill-session -t "${sessionName}"`);
          } catch {
            // 会话已不存在
          }
        },
        paneId: sessionName,
      };
    }
    case "iterm":
      throw new Error("iTerm backend not supported on this platform");
    default:
      throw new Error(`Unknown team mode: ${config.mode}`);
  }
}

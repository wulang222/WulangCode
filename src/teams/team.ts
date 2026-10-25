import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FileMailbox } from "./file-mailbox.js";
import { detectBackend } from "./backend.js";
import {
  createProgress,
  recordToolUse,
  recordTokens,
  type TeammateUIState,
} from "./progress.js";
import { randomVerb } from "../tui/verbs.js";
import type { ConversationManager } from "../conversation/conversation.js";
import { saveTranscript } from "./transcript.js";

/** 运行模式（F3）：进程内 / 终端复用器 / 其他终端（占位，使用即拒绝）。 */
export type TeamMode = "in-process" | "tmux" | "iterm";

/** 队员进度事件回调（N5）：团队侧与 Agent 实现解耦的事件接口。 */
export type AgentEventCallback = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

/** 成员对象（F2）：名称、活跃标记、取消回调、独立信箱、UI 状态、对话历史。 */
export interface Member {
  name: string;
  active: boolean;
  cancel?: () => void;
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  conversation?: ConversationManager;
}

/** 跑一轮任务到完成的执行器（依赖反转）：由宿主（app 层）注入。 */
export type RunAgent = (task: string, onEvent?: AgentEventCallback) => Promise<string>;

/**
 * 具名团队（F1/F4-F10）：持有成员表、Lead 信箱、信箱目录与工作目录。
 * 队员长存活：跑完一轮任务后 idle 通知 Lead，轮询信箱等待新任务，
 * 收到 shutdown 前缀的消息后优雅退出。
 */
export class Team {
  name: string;
  mode: TeamMode;
  members = new Map<string, Member>();
  leadMailbox: FileMailbox;
  private mailboxDir: string;
  private workDir: string;

  static readonly IDLE_POLL_INTERVAL_MS = 500;
  static readonly SHUTDOWN_PREFIX = "[shutdown]";

  constructor(name: string, mode: TeamMode, workDir: string) {
    this.name = name;
    this.mode = mode;
    this.workDir = workDir;
    this.mailboxDir = join(workDir, ".mewcode", "teams", name);
    mkdirSync(this.mailboxDir, { recursive: true });
    this.leadMailbox = new FileMailbox(this.mailboxDir, "lead");
  }

  /** 添加成员（F5）：为该名字建独立信箱，初始非活跃。 */
  addMember(name: string): Member {
    const mailbox = new FileMailbox(this.mailboxDir, name);
    const member: Member = { name, active: false, mailbox };
    this.members.set(name, member);
    return member;
  }

  /**
   * 派遣队员（F6）：标记活跃 → 挂 UI 状态 → 事件回调回灌进度 →
   * 异步主循环（跑任务 → idle 通知 → 等下一条提示或 shutdown）。
   */
  spawnTeammate(name: string, task: string, runAgent: RunAgent): void {
    const member = this.addMember(name);
    member.active = true;

    const uiState: TeammateUIState = {
      name,
      teamName: this.name,
      status: "running",
      progress: createProgress(),
      startTime: Date.now(),
      spinnerVerb: randomVerb(),
    };
    member.uiState = uiState;

    const onEvent: AgentEventCallback = (event) => {
      switch (event.type) {
        case "tool_use":
          if (event.toolName) recordToolUse(uiState.progress, event.toolName, event.args ?? {});
          break;
        case "usage":
          if (event.usage) {
            recordTokens(uiState.progress, event.usage.inputTokens, event.usage.outputTokens);
          }
          break;
        case "stream_text":
          if (event.text) uiState.lastMessage = event.text.slice(0, 200);
          break;
        default:
          break;
      }
    };

    void (async () => {
      let nextPrompt = task;
      let idleReason = "available";
      try {
        while (member.active) {
          uiState.status = "running";
          const result = await runAgent(nextPrompt, onEvent);
          uiState.lastMessage = result.length > 200 ? result.slice(0, 200) + "..." : result;
          uiState.status = "idle";
          await this.leadMailbox.send(name, `[idle] ${name} (reason: ${idleReason})`);
          idleReason = "available";
          const pollResult = await this.waitForNextPromptOrShutdown(member);
          if (pollResult.shutdown || !member.active) break;
          nextPrompt = pollResult.prompt;
        }
        // 被外部停止时保留「已停止」状态，不覆盖成 completed（F9）
        if (uiState.status !== "stopped") uiState.status = "completed";
      } catch (e) {
        uiState.status = "failed";
        uiState.lastMessage = (e as Error).message;
        await this.leadMailbox.send(name, `[idle] ${name} (reason: failed)`);
      } finally {
        member.active = false;
        if (uiState.status === "running") uiState.status = "idle";
        // 归档 best-effort（F12/N7）：仅在有对话上下文时持久化，失败静默
        if (member.conversation) {
          try {
            saveTranscript(this.workDir, this.name, name, member.conversation);
          } catch {
            // 归档失败不影响退出
          }
        }
      }
    })();
  }

  /**
   * 等待下一条提示或关停（F7）：活跃期间每 500ms 同步读一次信箱；
   * 命中 shutdown 前缀返回关停标记，否则把全部新消息拼成下一轮提示。
   */
  private async waitForNextPromptOrShutdown(
    member: Member,
  ): Promise<{ prompt: string; shutdown: boolean }> {
    while (member.active) {
      await new Promise((r) => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS));
      const msgs = member.mailbox.receiveSync();
      if (msgs.length === 0) continue;
      const hasShutdown = msgs.some((m) => m.text.trimStart().startsWith(Team.SHUTDOWN_PREFIX));
      if (hasShutdown) return { prompt: "", shutdown: true };
      const prompt = msgs.map((m) => `From ${m.from}: ${m.text}`).join("\n\n");
      return {
        prompt: `You have new messages from your team:\n\n${prompt}`,
        shutdown: false,
      };
    }
    return { prompt: "", shutdown: true };
  }

  getMember(name: string): Member | undefined {
    return this.members.get(name);
  }

  /** 发送消息（F8）：找不到收件人时抛含团队名与收件人名的错误。 */
  async sendMessage(from: string, to: string, content: string): Promise<void> {
    const member = this.members.get(to);
    if (!member) {
      throw new Error(`Member '${to}' not found in team '${this.name}'`);
    }
    await member.mailbox.send(from, content);
  }

  /** 停止单个成员（F9）：置非活跃、运行中转「已停止」、调取消回调。 */
  async stopMember(name: string): Promise<void> {
    const member = this.members.get(name);
    if (!member) return;
    member.active = false;
    if (member.uiState?.status === "running") member.uiState.status = "stopped";
    member.cancel?.();
  }

  /** 停止所有成员（F9）。 */
  async stopAll(): Promise<void> {
    for (const member of this.members.values()) {
      await this.stopMember(member.name);
    }
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  /** 提取所有有 UI 状态的成员快照（F10/N6）：值拷贝，避免渲染层持可变引用。 */
  getTeammateStates(): TeammateUIState[] {
    const out: TeammateUIState[] = [];
    for (const m of this.members.values()) {
      if (!m.uiState) continue;
      out.push({
        ...m.uiState,
        progress: {
          ...m.uiState.progress,
          recentActivities: [...m.uiState.progress.recentActivities],
        },
      });
    }
    return out;
  }
}

/**
 * 团队管理器（F11-F16）：单 mewcode 进程内同时管理多个 Team。
 */
export class TeamManager {
  private teams = new Map<string, Team>();
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  /** 创建团队（F12）：不做同名冲突检测，覆盖旧实例（工具层先查询决定复用）。 */
  create(name: string, mode: TeamMode = detectBackend()): Team {
    const team = new Team(name, mode, this.workDir);
    this.teams.set(name, team);
    return team;
  }

  get(name: string): Team | undefined {
    return this.teams.get(name);
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  /** 删除团队（F14）：先停止所有成员再移除。 */
  async delete(name: string): Promise<void> {
    const team = this.teams.get(name);
    if (!team) return;
    await team.stopAll();
    this.teams.delete(name);
  }

  /** 全部队员 UI 状态扁平合并（F15）。 */
  getAllTeammateStates(): TeammateUIState[] {
    return this.list().flatMap((t) => t.getTeammateStates());
  }

  /**
   * 抽取 Lead 信箱消息（F16/N8）：消耗性读取——每次调用推进游标；
   * 非空时拼成结构化提醒字符串（带团队名、按发件人分行）。
   */
  drainLeads(): string[] {
    const out: string[] = [];
    for (const team of this.teams.values()) {
      const msgs = team.leadMailbox.receiveSync();
      if (msgs.length === 0) continue;
      const lines = msgs.map((m) => `from=${m.from}: ${m.text}`).join("\n");
      out.push(`<team-notification team="${team.name}">\n${lines}\n</team-notification>`);
    }
    return out;
  }
}

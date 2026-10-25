import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import type { RunAgent, TeamManager } from "./team.js";

/** schema 子对象 helper：平铺 anthropic 形态。 */
function obj(
  props: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties: props, required };
}

/**
 * 创建团队工具（F43）：同名已存在返回「已存在」提示而非报错——
 * LLM 多次调用 TeamCreate 是常见行为，幂等 UX 更友好。
 */
export class TeamCreateTool implements Tool {
  name = "TeamCreate";
  description = "Create a team for coordinating multiple agents.";
  category = "read" as const;
  system = true;

  constructor(private mgr: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj({ name: { type: "string", description: "Team name" } }, ["name"]),
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const name = strArg(args, "name");
    if (!name) return { output: "Error: 'name' is required.", isError: true };
    if (this.mgr.get(name)) return { output: `Team '${name}' already exists.`, isError: false };
    this.mgr.create(name);
    return { output: `Team '${name}' created.`, isError: false };
  }
}

/**
 * 派遣队员工具（F44）：必填团队名、队员名、初始任务；
 * Team 不存在时自动创建（LLM 经常省略 TeamCreate 直接 spawn）。
 */
export class SpawnTeammateTool implements Tool {
  name = "SpawnTeammate";
  description = "Spawn a teammate into a team and assign it an initial task.";
  category = "read" as const;
  system = true;

  constructor(
    private mgr: TeamManager,
    private runAgent: RunAgent,
  ) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj(
        {
          team: { type: "string", description: "Team name" },
          name: { type: "string", description: "Teammate name" },
          task: { type: "string", description: "Initial task for the teammate" },
        },
        ["team", "name", "task"],
      ),
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const team = strArg(args, "team");
    const name = strArg(args, "name");
    const task = strArg(args, "task");
    if (!team || !name || !task) {
      return { output: "Error: 'team', 'name' and 'task' are required.", isError: true };
    }
    const t = this.mgr.get(team) ?? this.mgr.create(team);
    t.spawnTeammate(name, task, this.runAgent);
    return {
      output: `Teammate '${name}' spawned into team '${t.name}' with its initial task. Continue working and watch for it — results will arrive from the team channel.`,
      isError: false,
    };
  }
}

/** 发送消息工具（F45）：发件人固定为 lead；错误转 isError。 */
export class SendMessageTool implements Tool {
  name = "SendMessage";
  description = "Send a message to a teammate in a team.";
  category = "read" as const;
  system = true;

  constructor(private mgr: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj(
        {
          team: { type: "string", description: "Team name" },
          to: { type: "string", description: "Recipient teammate name" },
          message: { type: "string", description: "Message body" },
        },
        ["team", "to", "message"],
      ),
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const team = strArg(args, "team");
    const to = strArg(args, "to");
    const message = strArg(args, "message");
    if (!team || !to || !message) {
      return { output: "Error: 'team', 'to' and 'message' are required.", isError: true };
    }
    const t = this.mgr.get(team);
    if (!t) return { output: `Error: team '${team}' not found.`, isError: true };
    try {
      await t.sendMessage("lead", to, message);
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
    return { output: `Message delivered to '${to}' in team '${team}'.`, isError: false };
  }
}

/** 列出团队工具（F46）：每行 `<name> [<mode>]: <members>`。 */
export class ListTeamsTool implements Tool {
  name = "ListTeams";
  description = "List all teams and their members.";
  category = "read" as const;
  system = true;

  constructor(private mgr: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj({}, []),
    };
  }

  async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const teams = this.mgr.list();
    if (teams.length === 0) return { output: "No teams.", isError: false };
    const lines = teams.map((t) => {
      const members = t.listMembers();
      const memberText =
        members.length === 0
          ? "(no members)"
          : members.map((m) => `${m.name}${m.active ? " (active)" : ""}`).join(", ");
      return `${t.name} [${t.mode}]: ${memberText}`;
    });
    return { output: lines.join("\n"), isError: false };
  }
}

/** 删除团队工具（F47）：先停所有成员再移除。 */
export class TeamDeleteTool implements Tool {
  name = "TeamDelete";
  description = "Delete a team and stop all its members.";
  category = "read" as const;
  system = true;

  constructor(private mgr: TeamManager) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj({ name: { type: "string", description: "Team name" } }, ["name"]),
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const name = strArg(args, "name");
    if (!name) return { output: "Error: 'name' is required.", isError: true };
    await this.mgr.delete(name);
    return { output: `Team '${name}' deleted.`, isError: false };
  }
}

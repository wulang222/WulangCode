import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { boolArg, strArg } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { RunAgent, TeamManager } from "../teams/team.js";
import type { AgentDefinition } from "./definition.js";
import { loadAgentDefinitions } from "./loader.js";

/** Fork Boilerplate 标签：嵌套防护扫描对话历史时匹配（F22/G11）。 */
export const FORK_BOILERPLATE_TAG = "<fork_boilerplate>";
/** Fork 派生来源标记：命中即拒绝再次 Fork（F22/G11）。 */
export const FORK_QUERY_SOURCE = "agent:builtin:fork";

const FORK_BOILERPLATE = `${FORK_BOILERPLATE_TAG}
You are a forked worker process. You are NOT the main agent.
Rules (non-negotiable):
1. Do NOT fork again.
2. Do NOT converse, ask questions, or request confirmation.
3. Use tools directly: read files, search code, make changes.
4. Stay strictly within your assigned task scope.
5. Final report must be under 500 characters, starting with "Scope:".
</fork_boilerplate>`;

/** 定义式子 Agent 执行器：由宿主注入（后台与否在 handler 内分流，T13）。 */
export type SpawnHandler = (
  definition: AgentDefinition,
  prompt: string,
  background: boolean,
  modelOverride?: string,
) => Promise<string>;

/** Fork 后台启动器：接收 Boilerplate + 任务文本，登记后台任务并立即返回。 */
export type ForkHandler = (
  prompt: string,
  conversation: ConversationManager,
  registry: ToolRegistry,
  modelOverride?: string,
) => Promise<string>;

/**
 * Agent 工具（F1-F3）：主 Agent 统一的子代理入口。
 * 三条互斥派生路径：team_name > Fork（subagent_type 缺省）> 定义式命中。
 * schema 中的角色枚举来自构造时加载的定义列表，运行期稳定（N1/G1）。
 */
export class AgentTool implements Tool {
  name = "Agent";
  description =
    "Launch a sub-agent to handle complex, multi-step tasks. Pick a role via subagent_type, leave it empty to fork, or pass team_name for a long-lived teammate.";
  category = "read" as const;
  system = true;
  /** 被派生时设为 FORK_QUERY_SOURCE 启用嵌套防护（G11）。 */
  querySource = "";

  private readonly definitions: AgentDefinition[];
  private readonly registry: ToolRegistry;
  /** 宿主可在运行期重指（会话 /clear 重建 conversation 后同步，T13 接线）。 */
  conversation?: ConversationManager;
  private readonly spawnHandler: SpawnHandler;
  private readonly forkHandler?: ForkHandler;
  private teamManager?: TeamManager;
  private teamRunAgent?: RunAgent;

  constructor(
    workDir: string,
    registry: ToolRegistry,
    spawnHandler: SpawnHandler,
    conversation?: ConversationManager,
    forkHandler?: ForkHandler,
  ) {
    this.definitions = loadAgentDefinitions(workDir);
    this.registry = registry;
    this.spawnHandler = spawnHandler;
    this.conversation = conversation;
    this.forkHandler = forkHandler;
  }

  /** 启用 team_name 派生路径（T13：TaskManager / TeamManager 就绪后调用一次）。 */
  setTeamManager(mgr: TeamManager, runAgent: RunAgent): void {
    this.teamManager = mgr;
    this.teamRunAgent = runAgent;
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.buildDescription(),
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "One-line task label shown in the UI" },
          prompt: { type: "string", description: "The full task instructions for the sub-agent" },
          subagent_type: {
            type: "string",
            enum: this.definitions.map((d) => d.name),
            description: 'Role to use; leave empty to fork the current conversation',
          },
          model: { type: "string", enum: ["haiku", "sonnet", "opus"], description: "Optional model tier override" },
          run_in_background: { type: "boolean", description: "Run in background; result arrives via task-notification (default false)" },
          team_name: { type: "string", description: "Spawn a long-lived teammate into this team instead" },
        },
        required: ["description", "prompt"],
      },
    };
  }

  private buildDescription(): string {
    const roles = this.definitions.map((d) => `- ${d.name}: ${d.description}`).join("\n");
    return [
      this.description,
      "",
      `Available roles for the "subagent_type" parameter:`,
      roles,
      "",
      'Example: {"description": "Find auth code", "prompt": "Locate all auth-related files", "subagent_type": "explore"}',
    ].join("\n");
  }

  async execute(args: Record<string, unknown>, _ctx?: ToolContext): Promise<ToolResult> {
    const description = strArg(args, "description");
    const prompt = strArg(args, "prompt");
    if (!description || !prompt) {
      return { output: "Error: description and prompt are required", isError: true };
    }
    const subagentType = strArg(args, "subagent_type");
    const modelOverride = strArg(args, "model") || undefined;
    const background = boolArg(args, "run_in_background", false);
    const teamName = strArg(args, "team_name");

    // 路径优先级：团队 > Fork（角色缺省）> 定义式（F2）。
    if (teamName && this.teamManager && this.teamRunAgent) {
      return this.runAsTeammate(teamName, description, prompt);
    }
    if (!subagentType) {
      return await this.runFork(prompt, description, modelOverride);
    }
    const definition = this.definitions.find((d) => d.name === subagentType);
    if (!definition) {
      const available = this.definitions.map((d) => d.name).join(", ");
      return { output: `Error: unknown agent type '${subagentType}'. Available: ${available}`, isError: true };
    }
    try {
      const output = await this.spawnHandler(definition, prompt, background || !!definition.background, modelOverride);
      return { output, isError: false };
    } catch (err) {
      return { output: `Agent error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private runAsTeammate(teamName: string, description: string, prompt: string): ToolResult {
    const team = this.teamManager!.get(teamName);
    if (!team) {
      return { output: `Error: team '${teamName}' not found. Create it first with TeamCreate.`, isError: true };
    }
    let memberName = description.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
    const base = memberName;
    let suffix = 2;
    while (team.getMember(memberName)) {
      memberName = `${base}-${suffix++}`;
    }
    team.spawnTeammate(memberName, prompt, this.teamRunAgent!);
    return {
      output: `Teammate '${memberName}' spawned in team '${team.name}' (mode: ${team.mode}). The teammate is now working on the assigned task.`,
      isError: false,
    };
  }

  private async runFork(prompt: string, description: string, modelOverride?: string): Promise<ToolResult> {
    if (!this.conversation || !this.forkHandler) {
      return { output: "Error: fork requires parent conversation context", isError: true };
    }
    // 嵌套防护双闸门：来源标记 + 对话历史扫描（G11/F22）。
    if (this.querySource === FORK_QUERY_SOURCE) {
      return {
        output: "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
        isError: true,
      };
    }
    for (const message of this.conversation.getMessages()) {
      if (message.content.includes(FORK_BOILERPLATE_TAG)) {
        return {
          output: "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
          isError: true,
        };
      }
    }
    try {
      await this.forkHandler(`${FORK_BOILERPLATE}\n\nYour task:\n${prompt}`, this.conversation, this.registry, modelOverride);
      return {
        output: `Forked agent "${description}" launched in background. Results will arrive via task-notification.`,
        isError: false,
      };
    } catch (err) {
      return { output: `Fork error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

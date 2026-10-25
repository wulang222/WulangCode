import { loadConfig, type ProviderConfig } from "./config/config.js";
import { createClient } from "./llm/client.js";
import { ConversationManager } from "./conversation/conversation.js";
import { detectEnvironment, buildSystemPrompt } from "./prompt/builder.js";
import { ToolRegistry } from "./tools/registry.js";
import { ReadFileTool } from "./tools/read-file.js";
import { BashTool } from "./tools/bash.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { WriteFileTool } from "./tools/write-file.js";
import { EditFileTool } from "./tools/edit-file.js";
import { PermissionChecker } from "./permissions/checker.js";
import { Agent } from "./agent/agent.js";
import { FileMailbox, type FileMailMessage } from "./teams/file-mailbox.js";

/** --teammate 模式参数（F53）：teamDir / memberName / initialTask 必填。 */
export interface TeammateArgs {
  teamDir: string;
  memberName: string;
  initialTask: string;
  providerName?: string;
}

/**
 * 解析 --teammate 旗标（F53）：不含 --teammate 返回 null；
 * 三必填（--team-dir / --member-name / --task）缺一返回 null。
 */
export function parseTeammateFlags(args: string[]): TeammateArgs | null {
  if (!args.includes("--teammate")) return null;
  let teamDir = "";
  let memberName = "";
  let task = "";
  let providerName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--team-dir":
        teamDir = args[++i] ?? "";
        break;
      case "--member-name":
        memberName = args[++i] ?? "";
        break;
      case "--task":
        task = args[++i] ?? "";
        break;
      case "--provider":
        providerName = args[++i];
        break;
      default:
        break;
    }
  }
  if (!teamDir || !memberName || !task) return null;
  return { teamDir, memberName, initialTask: task, providerName };
}

const ShutdownPrefix = "[shutdown]";
const LeadName = "lead";

function isShutdownRequest(msg: FileMailMessage): boolean {
  return msg.text.trimStart().startsWith(ShutdownPrefix);
}

function createIdleNotification(name: string): string {
  return `[idle] ${name} has completed their task and is waiting for new instructions.`;
}

/**
 * 队员主流程（F54/G16）：不渲染 TUI，独立构造对话 + 权限上下文跑初始任务，
 * 完成后向 Lead 信箱发 idle 通知并轮询自己的信箱接续新任务，
 * 收到 shutdown 消息优雅退出。
 */
export async function runTeammate(args: TeammateArgs): Promise<void> {
  const cfg = loadConfig();
  const provider: ProviderConfig = args.providerName
    ? (cfg.providers.find((p) => p.name === args.providerName) ?? cfg.providers[0]!)
    : cfg.providers[0]!;

  // 环境探测 + 系统提示词 + 客户端（与 TUI 主路径同源）
  const env = detectEnvironment(process.cwd());
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);
  const client = await createClient(provider, systemPrompt);

  // 基础工具集（F54-4）：读文件、shell、glob、grep、写文件、编辑文件
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());

  const conv = new ConversationManager();
  const checker = new PermissionChecker(process.cwd(), "acceptEdits");
  const agent = new Agent({ client, registry, checker, conversation: conv, workDir: process.cwd() });

  /** 跑一轮 Agent：stream_text 实时上 stdout，错误直接抛给上层循环。 */
  const runOnce = async (prompt: string): Promise<void> => {
    conv.addUserMessage(prompt);
    for await (const event of agent.run()) {
      switch (event.type) {
        case "stream_text":
          process.stdout.write(event.text);
          break;
        case "tool_result":
          process.stdout.write(`\n[tool] ${event.toolName} -> ${event.output.slice(0, 120)}\n`);
          break;
        case "error":
          throw event.error;
        case "loop_complete":
          return;
        default:
          break;
      }
    }
  };

  // 初始任务（F54-6/7）
  await runOnce(args.initialTask);

  // 构造自己的信箱与 Lead 信箱，发 idle 通知
  const mailbox = new FileMailbox(args.teamDir, args.memberName);
  const leadMailbox = new FileMailbox(args.teamDir, LeadName);
  await leadMailbox.send(args.memberName, createIdleNotification(args.memberName));
  console.log(`[teammate:${args.memberName}] idle, waiting for messages...`);

  // 轮询循环（F54-8）：shutdown 跳出退出；普通消息进对话历史再跑一轮
  for await (const msg of mailbox.poll(2000)) {
    if (isShutdownRequest(msg)) {
      console.log("Shutdown requested");
      break;
    }
    console.log(`[teammate:${args.memberName}] new message from ${msg.from}, running...`);
    await runOnce(msg.text);
    await leadMailbox.send(args.memberName, createIdleNotification(args.memberName));
  }
}

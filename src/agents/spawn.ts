import type { ProviderConfig } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { resolveModelId } from "../llm/model-resolver.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { PermissionChecker } from "../permissions/checker.js";
import { ToolRegistry } from "../tools/registry.js";
import { Agent } from "../agent/agent.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { AgentDefinition } from "./definition.js";
import { filterToolsForAgent } from "./tool-filter.js";

/** 子 Agent 事件观察口：TUI 进度行与团队层共用，不耦合模型实现（F11）。 */
export type AgentEventSink = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

/**
 * 一次性同步派生子 Agent（F10/G2/G5）：独立会话 / 权限 / 客户端（模型覆盖时）/
 * token 计数，共享过滤后的工具集、Hook 引擎、工作目录与凭据。
 * 跑到模型不再调工具为止，把累计输出作为最终结果返回。
 */
export async function spawnSubAgent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  workDir: string,
  onProgress?: (p: { turn?: number; lastTool?: string }) => void,
  onEvent?: AgentEventSink,
  modelOverride?: string,
  hookEngine?: HookEngine,
): Promise<string> {
  const effectiveModel = modelOverride || definition.model || "";
  const resolvedModel = effectiveModel ? resolveModelId(effectiveModel) : parentProvider.model;
  const env = detectEnvironment(workDir);
  env.model = resolvedModel;
  const basePrompt = definition.systemPromptOverride ?? buildSystemPrompt(env);
  // 定义文件正文（initialPrompt）作为角色附加指令追加到系统提示词（F4）。
  const systemPrompt = definition.initialPrompt
    ? `${basePrompt}\n\n# Agent Role Instructions\n\n${definition.initialPrompt}`
    : basePrompt;
  const client = effectiveModel
    ? await createClient({ ...parentProvider, model: resolvedModel }, systemPrompt)
    : parentClient;
  const registry = filterToolsForAgent(parentRegistry, definition.tools, definition.disallowedTools, false);
  const permMode = definition.permissionMode ?? "acceptEdits";
  const checker = new PermissionChecker(workDir, permMode);

  const conv = new ConversationManager();
  conv.addUserMessage(prompt);
  const agent = new Agent({
    client,
    registry,
    checker,
    conversation: conv,
    workDir,
    maxIterations: definition.maxTurns ?? 200,
    hookEngine,
  });

  let output = "";
  let turn = 0;
  for await (const event of agent.run()) {
    switch (event.type) {
      case "stream_text":
        output += event.text;
        break;
      case "tool_use":
        onProgress?.({ lastTool: event.toolName });
        onEvent?.({ type: "tool_use", toolName: event.toolName, args: event.args });
        break;
      case "usage":
        onEvent?.({ type: "usage", usage: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } });
        break;
      case "turn_complete":
        onProgress?.({ turn: ++turn });
        break;
      case "loop_complete":
        return output || "[No output]";
      case "error":
        return output ? `${output}\n\n[Error: ${event.error.message}]` : `Error: ${event.error.message}`;
      default:
        break;
    }
  }
  return output || "[No output]";
}

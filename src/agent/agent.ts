import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ConversationManager, ThinkingBlock, ToolResultBlock, ToolUseBlock } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import { isAbortError } from "../llm/errors.js";
import type { Decision, PermissionChecker } from "../permissions/checker.js";
import { buildPlanModeReminder } from "../prompt/plan-mode.js";
import type { ToolCategory } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "./events.js";
import { StreamingExecutor, type ExecutedCall } from "./streaming-executor.js";

/** Agent 层对单个工具结果的字符级兜底截断（N4）。 */
const MAX_OUTPUT_CHARS = 10000;

/** 连续只请求未注册工具的停止阈值（内置常量，不配置化）。 */
const MAX_CONSECUTIVE_UNKNOWN = 3;

/** plan 模式未显式指定计划文件时的默认路径（相对工作目录）。 */
export const DEFAULT_PLAN_PATH = ".mewcode/plan.md";

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (output truncated)`;
}

export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  abortSignal?: AbortSignal;
  /** 已激活 Skill（名 → SOP 正文）；空/缺省不注入，本章预留同一补充消息通道。 */
  activeSkills?: Map<string, string>;
  /** 迭代上限，0 表示不限（默认）。 */
  maxIterations?: number;
  /** ask 决策的回调（本章占位，checker 不会产生 ask）。 */
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
  ) => Promise<"allow" | "deny" | "allowAlways">;
}

function isToolResultEvent(event: AgentEvent): event is Extract<AgentEvent, { type: "tool_result" }> {
  return event.type === "tool_result";
}

/**
 * ReAct 循环编排：流式收集 → 工具执行 → 结果回灌，直到模型不再请求工具。
 * 对外只吐 AgentEvent；所有终止路径（自然完成 / 上限 / 未知工具 / 出错 / 取消）
 * 都保证对话历史配对合法，会话可继续。
 */
export class Agent {
  constructor(private readonly config: AgentConfig) {}

  async *run(): AsyncGenerator<AgentEvent> {
    const { client, registry, checker, conversation, workDir, abortSignal } = this.config;
    const maxIterations = this.config.maxIterations ?? 0;
    const toolSchemas = registry.getAllSchemas();
    let iteration = 0;
    let consecutiveUnknown = 0;
    let looping = true;

    while (looping) {
      iteration += 1;
      if (maxIterations > 0 && iteration > maxIterations) {
        yield { type: "error", error: new Error(`已达到最大迭代轮次（${maxIterations}），强制停止。`) };
        return;
      }
      // 上一轮工具执行完到本轮启流之间被取消：历史已在上一轮完整落库，直接收尾。
      if (abortSignal?.aborted) {
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      // Plan Mode：每轮注入计划态提醒（首轮完整，之后精简，每 5 轮重复完整版）。
      if (checker.mode === "plan") {
        const planPath = checker.planFilePath ?? DEFAULT_PLAN_PATH;
        const absolute = isAbsolute(planPath) ? planPath : resolve(workDir, planPath);
        conversation.addSystemReminder(buildPlanModeReminder(planPath, existsSync(absolute), iteration));
      }
      // 已激活 Skill：与计划态提醒同一 <system-reminder> 通道（F6 机制对多类提醒通用）。
      const skillReminder = buildActiveSkillsReminder(this.config.activeSkills);
      if (skillReminder) conversation.addSystemReminder(skillReminder);

      // ---- 流式收集：一路实时转发文本增量，一路攒完整文本与工具调用（F4） ----
      let fullText = "";
      const thinkingBlocks: ThinkingBlock[] = [];
      const toolUses: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      try {
        const stream = client.stream(conversation, toolSchemas, abortSignal);
        try {
          for await (const event of stream) {
            switch (event.type) {
              case "text_delta":
                fullText += event.text;
                yield { type: "stream_text", text: event.text };
                break;
              case "thinking_delta":
                yield { type: "thinking_text", text: event.text };
                break;
              case "thinking_complete":
                thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
                yield { type: "thinking_complete", thinking: event.thinking, signature: event.signature };
                break;
              case "tool_call_complete":
                toolUses.push({ toolUseId: event.toolId, toolName: event.toolName, arguments: event.arguments });
                yield { type: "tool_use", toolName: event.toolName, toolId: event.toolId, args: event.arguments };
                break;
              case "stream_end":
                stopReason = event.stopReason;
                yield { type: "usage", usage: event.usage };
                break;
              default:
                break; // tool_call_start / tool_call_delta 仅供界面渐进展示，循环判断不依赖
            }
          }
        } finally {
          // 本轮请求已消费：清空待发提醒，下一轮按轮次重新注入（F6 不持久）。
          conversation.clearReminders();
        }
      } catch (err) {
        if (abortSignal?.aborted || isAbortError(err)) {
          this.finishInterrupted(conversation, fullText, thinkingBlocks);
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
        return;
      }

      // 流结束后被取消：丢弃已收集的 toolUses，只保留文本，避免悬空 tool_use。
      if (abortSignal?.aborted) {
        this.finishInterrupted(conversation, fullText, thinkingBlocks);
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      // ---- 无工具调用：纯文本即最终答复，循环自然结束（F2） ----
      if (toolUses.length === 0) {
        conversation.addAssistantFull(fullText, thinkingBlocks, []);
        looping = false;
        yield { type: "loop_complete", stopReason };
        continue;
      }

      // ---- 有工具调用：执行（保序分批），期间被取消同样走 interrupted 收尾 ----
      const events = await this.executeTools(toolUses);
      if (abortSignal?.aborted) {
        this.finishInterrupted(conversation, fullText, thinkingBlocks);
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      // assistant 回合与工具结果一起落库：任何后续退出路径都保持配对合法（F6）。
      conversation.addAssistantFull(fullText, thinkingBlocks, toolUses);
      const toolResults: ToolResultBlock[] = [];
      for (const event of events) {
        if (!isToolResultEvent(event)) continue;
        toolResults.push({ toolUseId: event.toolId, content: event.output, isError: event.isError });
      }
      conversation.addToolResultsMessage(toolResults);
      for (const event of events) yield event;

      // 连续未知工具：任一已注册即重置，达阈值即停（F2）。
      const hasKnown = toolUses.some((tu) => registry.get(tu.toolName) !== undefined);
      consecutiveUnknown = hasKnown ? 0 : consecutiveUnknown + 1;
      if (consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        yield {
          type: "error",
          error: new Error(`模型连续 ${MAX_CONSECUTIVE_UNKNOWN} 轮只请求未注册的工具，停止循环。`),
        };
        return;
      }

      // Plan Mode 出口：模型声明计划完成，循环停止，由界面切回全工具模式（F10）。
      if (checker.mode === "plan" && toolUses.some((tu) => tu.toolName === "ExitPlanMode")) {
        yield { type: "turn_complete" };
        yield { type: "loop_complete", stopReason: "end_turn" };
        return;
      }

      yield { type: "turn_complete" };
    }
  }

  /**
   * 取消收尾：只把已收集的文本（和思考块）写入历史，丢弃未落库的 toolUses，
   * 保证最后一条 assistant 消息无悬空 tool_use（F6/F7）。
   */
  private finishInterrupted(conversation: ConversationManager, fullText: string, thinkingBlocks: ThinkingBlock[]): void {
    if (fullText) conversation.addAssistantFull(fullText, thinkingBlocks, []);
  }

  /**
   * 保序分批执行（F5）：按模型给出的顺序扫描，连续只读合并为一个并发批，
   * 遇到写入/命令则先收尾当前只读批、再单独串行执行，不跨批重排。
   */
  private async executeTools(toolUses: ToolUseBlock[]): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    let readBatch: ToolUseBlock[] = [];

    const flushReadBatch = async () => {
      if (readBatch.length === 0) return;
      events.push(...(await this.executeBatch(readBatch, true)));
      readBatch = [];
    };

    for (const tu of toolUses) {
      const category = this.categoryOf(tu.toolName);
      if (category === "read") {
        readBatch.push(tu);
        continue;
      }
      await flushReadBatch();
      events.push(...(await this.executeBatch([tu], false)));
    }
    await flushReadBatch();
    return events;
  }

  private categoryOf(toolName: string): ToolCategory {
    return this.config.registry.get(toolName)?.category ?? "command";
  }

  /**
   * 执行一批工具调用。parallel=true 时全部 submit 后 Promise.all 并发收；
   * 否则逐个 submit / collect 串行。结果按模型调用顺序返回。
   * 权限 deny / ask 拒绝的调用转成 isError 结果，不执行。
   */
  private async executeBatch(toolUses: ToolUseBlock[], parallel: boolean): Promise<AgentEvent[]> {
    const { registry, checker, workDir, abortSignal, onPermissionRequest } = this.config;
    const executor = new StreamingExecutor(registry, { workDir, abortSignal });
    const outcomes: AgentEvent[] = [];

    for (let index = 0; index < toolUses.length; index += 1) {
      const tu = toolUses[index]!;
      const decision = checker.check(tu.toolName, this.categoryOf(tu.toolName), tu.arguments);
      if (decision.effect === "allow") {
        executor.submit(tu.toolUseId, tu.toolName, tu.arguments);
        if (!parallel) {
          const [call] = await executor.collectResults();
          if (call) outcomes[index] = this.processToolResult(call);
        }
        continue;
      }
      if (decision.effect === "ask" && onPermissionRequest) {
        outcomes[index] = { type: "permission_request", toolName: tu.toolName, args: tu.arguments };
        const answer = await onPermissionRequest(tu.toolName, tu.arguments, decision);
        if (answer === "allow" || answer === "allowAlways") {
          if (answer === "allowAlways") checker.allowAlways(tu.toolName, tu.arguments);
          executor.submit(tu.toolUseId, tu.toolName, tu.arguments);
          if (!parallel) {
            const [call] = await executor.collectResults();
            if (call) outcomes[index] = this.processToolResult(call);
          }
          continue;
        }
      }
      outcomes[index] = {
        type: "tool_result",
        toolName: tu.toolName,
        toolId: tu.toolUseId,
        output: truncateOutput(`Permission denied${decision.reason ? `: ${decision.reason}` : ""}`),
        isError: true,
        elapsed: 0,
      };
    }

    if (parallel) {
      const calls = await executor.collectResults();
      for (const call of calls) {
        const index = toolUses.findIndex((tu) => tu.toolUseId === call.toolId);
        if (index >= 0) outcomes[index] = this.processToolResult(call);
      }
    }

    return outcomes.filter((event): event is AgentEvent => event !== undefined);
  }

  /** 本章只做截断与字段转换；后续章节在此接 file snapshot / hooks。 */
  private processToolResult(call: ExecutedCall): AgentEvent {
    return {
      type: "tool_result",
      toolName: call.toolName,
      toolId: call.toolId,
      output: truncateOutput(call.result.output),
      isError: call.result.isError,
      elapsed: call.elapsed,
    };
  }
}

/** 已激活 Skill 的提醒文本；无激活时返回空串（不注入）。 */
function buildActiveSkillsReminder(active?: Map<string, string>): string {
  if (!active || active.size === 0) return "";
  const parts = [...active.entries()].map(([name, body]) => `## Active Skill: ${name}\n\n${body}`);
  return ["# Active Skills", "", "The following Skill SOPs are pinned to the environment context.", "", parts.join("\n\n")].join("\n");
}

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ConversationManager, ThinkingBlock, ToolUseBlock } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import { ContextTooLongError, isAbortError } from "../llm/errors.js";
import type { Decision, PermissionChecker } from "../permissions/checker.js";
import { buildPlanModeReminder } from "../prompt/plan-mode.js";
import {
  AutoCompactTrackingState,
  forceCompact,
  manageContext,
  type UsageAnchor,
} from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import { ContentReplacementState } from "../toolresult/state.js";
import { applyBudget } from "../toolresult/budget.js";
import { buildManager } from "../toolresult/reconstruct.js";
import { toToolResultBlocks } from "../toolresult/record.js";
import { getSessionFilePath } from "../session/session.js";
import type { ToolCategory } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventName, HookContext, HookEngine } from "../hooks/hooks.js";
import type { AgentEvent } from "./events.js";
import { StreamingExecutor, type ExecutedCall } from "./streaming-executor.js";

/** 连续只请求未注册工具的停止阈值（内置常量，不配置化）。 */
const MAX_CONSECUTIVE_UNKNOWN = 3;

/** plan 模式未显式指定计划文件时的默认路径（须落在 .mewcode/plans/ 内以享 Layer 0 豁免）。 */
export const DEFAULT_PLAN_PATH = ".mewcode/plans/plan.md";

export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  abortSignal?: AbortSignal;
  /** 上下文窗口（token），未配置按 Anthropic 风格默认 200000（F31/I11）。 */
  contextWindow?: number;
  /** 单次最大输出 token，默认 8192。 */
  maxOutput?: number;
  /** 压缩恢复段数据源；TUI 与 Agent 共享同一实例（/compact 手动路径）。 */
  recoveryState?: RecoveryState;
  /** 第 1 层替换决策账本；会话级单例。 */
  replacementState?: ContentReplacementState;
  /** 会话 id：用于压缩摘要里指回完整会话文件与 boundary 持久化。 */
  sessionId?: string;
  /** 已激活 Skill（名 → SOP 正文）；空/缺省不注入，本章预留同一补充消息通道。 */
  activeSkills?: Map<string, string>;
  /** 迭代上限，0 表示不限（默认）。 */
  maxIterations?: number;
  /** Hook 引擎（day10）：生命周期事件派发与 pre_tool_use 拦截；缺省不启用。 */
  hookEngine?: HookEngine;
  /** ask 决策的人在回路回调；返回 allow / deny / allowAlways 三选一。 */
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
  ) => Promise<"allow" | "deny" | "allowAlways">;
  /** loop 自然结束回调（后台记忆提取等宿主任务入口）；同步执行、异常被吞掉。 */
  onLoopComplete?: (conversation: ConversationManager) => void;
}

/** 从请求 schema 列表提取工具名清单：与 tools 参数严格同源（F17）。 */
function toolSchemaNamesOf(toolSchemas: Record<string, unknown>[]): string[] {
  return toolSchemas
    .map((s) => String((s as { name?: string }).name ?? ""))
    .filter(Boolean);
}

/**
 * run() 轮次级选项（day13 F59/G14）：Coordinator 工具过滤与团队通知注入。
 * 两者都可缺省；缺省时行为与旧签名完全一致。
 */
export interface AgentRunOptions {
  /** 每轮请求前按工具名过滤 schema（软强制：对模型隐藏，幻觉调用仍会被执行层拦）。 */
  toolFilter?: (name: string) => boolean;
  /** 每轮迭代调用一次；返回字符串逐条走 <system-reminder> 通道注入本轮上下文。 */
  notificationFn?: () => string[];
}

/**
 * ReAct 循环编排：流式收集 → 工具执行 → 结果回灌，直到模型不再请求工具。
 * 对外只吐 AgentEvent；所有终止路径（自然完成 / 上限 / 未知工具 / 出错 / 取消）
 * 都保证对话历史配对合法，会话可继续。
 */
export class Agent {
  private readonly contextWindow: number;
  private readonly maxOutput: number;
  private readonly recoveryState: RecoveryState;
  private readonly replacementState: ContentReplacementState;
  private readonly sessionFilePath: string;
  private readonly compactTracking = new AutoCompactTrackingState();
  private readonly hookEngine?: HookEngine;
  private usageAnchor: UsageAnchor | null = null;

  constructor(private readonly config: AgentConfig) {
    this.contextWindow = config.contextWindow ?? 200_000;
    this.maxOutput = config.maxOutput ?? 8192;
    this.recoveryState = config.recoveryState ?? new RecoveryState();
    this.replacementState = config.replacementState ?? new ContentReplacementState();
    this.sessionFilePath = config.sessionId ? getSessionFilePath(config.workDir, config.sessionId) : "";
    this.hookEngine = config.hookEngine;
  }

  /** 测试探针：读当前估算锚点（验证替换不累加）。 */
  _testGetUsageAnchor(): UsageAnchor | null {
    return this.usageAnchor;
  }

  /**
   * 派发单个生命周期事件并把非空输出写入通知队列（day10 T7）：
   * 下一轮循环顶部由 drainNotifications 以 <system-reminder> 注入（F24/F25）。
   */
  private async fireLifecycle(event: EventName, message?: string): Promise<void> {
    if (!this.hookEngine) return;
    const ctx: HookContext = { event, message };
    const results = await this.hookEngine.fire(event, ctx);
    for (const r of results) {
      if (r.output) this.hookEngine.recordNotification(r.output);
    }
  }

  async *run(options?: AgentRunOptions): AsyncGenerator<AgentEvent> {
    const { client, registry, checker, conversation, workDir, abortSignal } = this.config;
    const maxIterations = this.config.maxIterations ?? 0;
    // 全量 schema 只取一次；Coordinator 过滤按轮套用（Team 中途创建/删除即时生效）。
    const allSchemas = registry.getAllSchemas();
    // 已激活技能登记进恢复段：压缩后技能 SOP 仍可还原（F15）。
    if (this.config.activeSkills) {
      for (const [name, body] of this.config.activeSkills) this.recoveryState.recordSkillInvocation(name, body);
    }
    let iteration = 0;
    let consecutiveUnknown = 0;
    let looping = true;
    // 紧急自愈每次 run 只做一次：二次撞墙说明问题不在总量，按错误上抛（F26）。
    let emergencyCompacted = false;

    // 会话开始：进入主循环之前（day10 F4/T8-1）。
    await this.fireLifecycle("session_start");
    try {
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

        // ---- 第 2 层：每轮请求前做上下文预算检查（自动压缩 / 熔断）----
        // day13（F59/G14）：Coordinator 过滤按轮生效；恢复段工具清单与本次
        // 请求 tools 严格同源（F17）——过滤后的 schema 名单在这里重算。
        const toolSchemas = options?.toolFilter
          ? allSchemas.filter((s) => options.toolFilter!(String((s as { name?: string }).name ?? "")))
          : allSchemas;
        const toolSchemaNames = toolSchemaNamesOf(toolSchemas);
        const mc = await manageContext(
          conversation,
          client,
          this.contextWindow,
          this.maxOutput,
          this.compactTracking,
          this.recoveryState,
          toolSchemaNames,
          this.usageAnchor,
          this.sessionFilePath,
        );
        if (mc.message) yield { type: "compact", message: mc.message, boundary: mc.boundary };
        if (mc.compacted) this.usageAnchor = null;

        // Plan Mode：每轮注入计划态提醒（首轮完整，之后精简，每 5 轮重复完整版）。
        if (checker.mode === "plan") {
          const planPath = checker.planFilePath ?? DEFAULT_PLAN_PATH;
          const absolute = isAbsolute(planPath) ? planPath : resolve(workDir, planPath);
          conversation.addSystemReminder(buildPlanModeReminder(planPath, existsSync(absolute), iteration));
        }
        // 已激活 Skill：与计划态提醒同一 <system-reminder> 通道（F6 机制对多类提醒通用）。
        const skillReminder = buildActiveSkillsReminder(this.config.activeSkills);
        if (skillReminder) conversation.addSystemReminder(skillReminder);

        // day10：技能提醒之后取出通知队列，逐条以系统提醒注入本轮上下文（F25）；
        // 随后派发轮次开始与请求前事件（T8-2）。
        if (this.hookEngine) {
          for (const note of this.hookEngine.drainNotifications()) conversation.addSystemReminder(note);
        }
        // day13（F59/G13）：团队通知每轮注入一次，走同一 <system-reminder> 通道。
        if (options?.notificationFn) {
          for (const note of options.notificationFn()) conversation.addSystemReminder(note);
        }
        await this.fireLifecycle("turn_start");
        await this.fireLifecycle("pre_send");

        // ---- 流式收集：一路实时转发文本增量，一路攒完整文本与工具调用（F4） ----
        let fullText = "";
        const thinkingBlocks: ThinkingBlock[] = [];
        const toolUses: ToolUseBlock[] = [];
        let stopReason = "end_turn";

        // ---- 第 1 层：请求视图过预算（单条/聚合落盘 + 旧轮次裁剪）后重建 apiConv（F6） ----
        const apiConv = buildManager(applyBudget(conversation.getRequestMessages(), workDir, this.replacementState));
        const sentMessageCount = conversation.len();

        try {
          const stream = client.stream(apiConv, toolSchemas, abortSignal);
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
                  // 估算锚点用最近一次真实 usage 替换（不累加），锚定发送时条数（F13/F14）。
                  this.usageAnchor = {
                    baselineTokens:
                      event.usage.inputTokens +
                      event.usage.cacheReadInputTokens +
                      event.usage.cacheCreationInputTokens +
                      event.usage.outputTokens,
                    anchorCount: sentMessageCount,
                  };
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
          const e = err instanceof Error ? err : new Error(String(err));
          // 撞上下文上限：紧急压缩一次后用新消息列表重试本轮（F25/F26）。
          if (e instanceof ContextTooLongError && !emergencyCompacted) {
            emergencyCompacted = true;
            try {
              const result = await forceCompact(
                conversation,
                client,
                this.recoveryState,
                toolSchemaNames,
                this.sessionFilePath,
                this.contextWindow,
              );
              this.usageAnchor = null;
              yield {
                type: "compact",
                message: "Auto-compacted due to context length: " + result.message,
                boundary: result.boundary,
              };
              continue;
            } catch {
              yield { type: "error", error: e };
              return;
            }
          }
          yield { type: "error", error: e };
          return;
        }

        // 流结束后被取消：丢弃已收集的 toolUses，只保留文本，避免悬空 tool_use。
        if (abortSignal?.aborted) {
          this.finishInterrupted(conversation, fullText, thinkingBlocks);
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }

        // 接收大模型回复之后：流式响应完整接收完毕（day10 T8-3）。
        await this.fireLifecycle("post_receive", fullText);

        // ---- 无工具调用：纯文本即最终答复，循环自然结束（F2） ----
        if (toolUses.length === 0) {
          conversation.addAssistantFull(fullText, thinkingBlocks, []);
          looping = false;
          yield { type: "loop_complete", stopReason };
          // 宿主回调（day8 后台记忆提取）：异常吞掉，不影响 stream 完结。
          try {
            this.config.onLoopComplete?.(conversation);
          } catch {
            // 回调失败与主循环无关
          }
          continue;
        }

        // ---- 有工具调用：执行（保序分批），期间被取消同样走 interrupted 收尾 ----
        const events = await this.executeTools(toolUses);
        if (abortSignal?.aborted) {
          this.finishInterrupted(conversation, fullText, thinkingBlocks);
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }

        // ReadFile 成功后用磁盘纯净字节登记恢复段（F19/F19a）：在结果回灌前完成，
        // 保证下一次 manageContext 能观察到本轮读档。
        await this.recordReadFiles(toolUses, events);

        // assistant 回合与工具结果一起落库：任何后续退出路径都保持配对合法（F6）。
        conversation.addAssistantFull(fullText, thinkingBlocks, toolUses);
        const toolResults = toToolResultBlocks(events);
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
        // 轮次结束：工具结果写回、轮次完成事件已发出之后（day10 T8-4）。
        await this.fireLifecycle("turn_end");
      }
    } finally {
      // 会话结束收尾：异常路径也触发（day10 F4/T8-5）。
      await this.fireLifecycle("session_end");
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
   * ReadFile 成功结果 → 恢复段登记（F19）：用磁盘原始字节（不带行号前缀）
   * 重新读一次；失败静默跳过，不影响主循环。
   */
  private async recordReadFiles(toolUses: ToolUseBlock[], events: AgentEvent[]): Promise<void> {
    for (const r of events) {
      if (r.type !== "tool_result" || r.isError) continue;
      const tu = toolUses.find((u) => u.toolUseId === r.toolId);
      if (!tu) continue;
      if (tu.toolName !== "ReadFile" && tu.toolName !== "Read" && tu.toolName !== "read_file") continue;
      const raw =
        typeof tu.arguments.file_path === "string"
          ? tu.arguments.file_path
          : typeof tu.arguments.path === "string"
            ? tu.arguments.path
            : "";
      if (!raw) continue;
      const path = isAbsolute(raw) ? raw : resolve(this.config.workDir, raw);
      try {
        const content = await readFile(path, "utf-8");
        this.recoveryState.recordFileRead(path, content);
      } catch {
        // 读不到就跳过：恢复段只收确实可读的快照
      }
    }
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

  /** deny 回灌给模型的统一安全话术：讲清被拒 + 不复述命令行为（F11）。 */
  private static deniedOutput(reason: string): string {
    return `Permission denied: ${reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。`;
  }

  /**
   * 执行一批工具调用。parallel=true 时全部 submit 后 Promise.all 并发收；
   * 否则逐个 submit / collect 串行。结果按模型调用顺序返回。
   * 权限判定在 submit 前介入：deny / ask 拒绝的调用转成结构化 isError 结果回灌，
   * 不执行也不中断循环；同批中被拒的与放行的各自独立、按原调用序配对（F11/N3）。
   * day10：权限检查之前先过 pre_tool_use hook，拦截命中直接生成带错误标记的
   * 工具结果回灌，不进权限检查也不进实际执行（F16/T9-1）。
   */
  private async executeBatch(toolUses: ToolUseBlock[], parallel: boolean): Promise<AgentEvent[]> {
    const { registry, checker, workDir, abortSignal, onPermissionRequest } = this.config;
    const executor = new StreamingExecutor(registry, { workDir, abortSignal });
    const outcomes: AgentEvent[] = [];

    for (let index = 0; index < toolUses.length; index += 1) {
      const tu = toolUses[index]!;

      // pre_tool_use hook 拦截：拒绝原因作为工具结果回灌给模型（F16）。
      if (this.hookEngine) {
        const hookResult = await this.hookEngine.firePreToolHooks(tu.toolName, tu.arguments);
        if (hookResult.rejected) {
          outcomes[index] = {
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: `Rejected by hook: ${hookResult.reason}`,
            isError: true,
            elapsed: 0,
          };
          continue;
        }
      }

      const decision = checker.check(tu.toolName, this.categoryOf(tu.toolName), tu.arguments);
      let deniedOutput = "";

      if (decision.effect === "deny") {
        deniedOutput = Agent.deniedOutput(decision.reason);
      } else if (decision.effect === "ask") {
        if (onPermissionRequest) {
          outcomes[index] = { type: "permission_request", toolName: tu.toolName, args: tu.arguments };
          const answer = await onPermissionRequest(tu.toolName, tu.arguments, decision);
          if (answer === "deny") {
            deniedOutput = "Permission denied by user";
          } else {
            if (answer === "allowAlways") checker.allowAlways(tu.toolName, tu.arguments);
          }
        } else {
          // ask 无人在回路入口：按最严处理回灌拒绝，不放行（N7）。
          deniedOutput = Agent.deniedOutput(decision.reason);
        }
      }

      if (deniedOutput !== "") {
        outcomes[index] = {
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: deniedOutput,
          isError: true,
          elapsed: 0,
        };
        continue;
      }

      executor.submit(tu.toolUseId, tu.toolName, tu.arguments);
      if (!parallel) {
        const [call] = await executor.collectResults();
        if (call) outcomes[index] = await this.processToolResult(call);
      }
    }

    if (parallel) {
      const calls = await executor.collectResults();
      for (const call of calls) {
        const index = toolUses.findIndex((tu) => tu.toolUseId === call.toolId);
        if (index >= 0) outcomes[index] = await this.processToolResult(call);
      }
    }

    return outcomes.filter((event): event is AgentEvent => event !== undefined);
  }

  /**
   * 字段转换；超大结果的落盘与裁剪由第 1 层 applyBudget 统一接管。
   * day10：结果事件构造后派发 post_tool_use，非空输出入通知队列（F24/T9-2）。
   */
  private async processToolResult(call: ExecutedCall): Promise<AgentEvent> {
    const event: AgentEvent = {
      type: "tool_result",
      toolName: call.toolName,
      toolId: call.toolId,
      output: call.result.output,
      isError: call.result.isError,
      elapsed: call.elapsed,
    };
    if (this.hookEngine) {
      const hookResults = await this.hookEngine.fire("post_tool_use", {
        event: "post_tool_use",
        toolName: call.toolName,
        message: call.result.output,
      });
      for (const hr of hookResults) {
        if (hr.output) this.hookEngine.recordNotification(hr.output);
      }
    }
    return event;
  }
}

/** 已激活 Skill 的提醒文本；无激活时返回空串（不注入）。 */
function buildActiveSkillsReminder(active?: Map<string, string>): string {
  if (!active || active.size === 0) return "";
  const parts = [...active.entries()].map(([name, body]) => `## Active Skill: ${name}\n\n${body}`);
  return ["# Active Skills", "", "The following Skill SOPs are pinned to the environment context.", "", parts.join("\n\n")].join("\n");
}

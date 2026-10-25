import { useEffect, useRef, useState } from "react";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindow, getContextWindowAsync, getMaxOutputTokens } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { isAbortError, LLMError } from "../llm/errors.js";
import { PermissionChecker, type PermissionMode } from "../permissions/checker.js";
import { buildPlanModeExitReminder, buildPlanModeReentryReminder } from "../prompt/plan-mode.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { Agent, DEFAULT_PLAN_PATH } from "../agent/agent.js";
import { currentContextTokens, forceCompact } from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import { ContentReplacementState } from "../toolresult/state.js";
import {
  cleanExpiredSessions,
  getSessionFilePath,
  listSessions,
  loadSession,
  newSessionId,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "../session/session.js";
import { loadInstructions } from "../memory/instructions.js";
import { MemoryManager } from "../memory/manager.js";
import { MemoryExtractor } from "../memory/extractor.js";
import * as historyMod from "../history/history.js";
import { FileHistory, type Snapshot } from "../filehistory/filehistory.js";
import {
  createDefaultRegistry as createCommandRegistry,
  parse as parseCommand,
  type Command,
  type CommandContext,
  type CommandRegistry,
} from "../commands/commands.js";
import { loadUserCommands } from "../commands/loader.js";
import { CommandUsageTracker } from "../commands/usage-tracker.js";
import { runSkillInline, SkillCatalog } from "../skills/catalog.js";
import { MCPManager } from "../mcp/manager.js";
import { MCPToolWrapper } from "../mcp/tool-wrapper.js";
import { BashTool } from "../tools/bash.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { ReadFileTool } from "../tools/read-file.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import { WriteFileTool } from "../tools/write-file.js";
import { PermissionDialog, type PermissionAction } from "./permission-dialog.js";
import { RewindDialog, type RewindAction } from "./rewind-dialog.js";
import { ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { InputBox } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { formatArgs } from "./tool-display.js";
import { randomCompletionVerb } from "./verbs.js";

const VERSION = "0.1.0";

/** 四档权限模式的循环顺序（Shift+Tab 按此循环，F9）。 */
const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/** 同一次按键在裸 stdin 兜底与 Ink useInput 双通道重复到达的防抖窗口。 */
const MODE_SWITCH_DEBOUNCE_MS = 100;

/** 工具是无状态的，注册中心全局一份即可。 */
function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  // 系统级检索工具：让模型按关键词找到 / 按精确名激活延迟加载的 MCP 工具。
  registry.register(new ToolSearchTool(registry));
  return registry;
}

const toolRegistry = createToolRegistry();

/**
 * 技能接线（day9 T9 / F36-F39）：inline 技能注册为 prompt 命令（正文渲染进
 * user 提示词），fork 技能注册为 skill_fork 类型占位；已占名先短路不抛。
 * skillHost 参数预留给后续 Skill 派生运行时章节。
 */
export function wireSkillsToRegistry(catalog: SkillCatalog, cmdRegistry: CommandRegistry, _skillHost?: unknown): void {
  void _skillHost;
  for (const meta of catalog.list()) {
    if (cmdRegistry.find(meta.name)) continue;
    const description = `${meta.description} [skill]`;
    const cmd: Command =
      meta.mode === "fork"
        ? { name: meta.name, aliases: [], type: "skill_fork", description, handler: () => "" }
        : {
            name: meta.name,
            aliases: [],
            type: "prompt",
            description,
            handler: (ctx) => runSkillInline(catalog.get(meta.name)!, ctx.args),
          };
    try {
      cmdRegistry.register(cmd);
    } catch {
      // 与内置 / 用户命令撞名等异常静默跳过（F36）
    }
  }
}

type StaticRow =
  | { key: string; kind: "banner" }
  | { key: string; kind: "message"; message: ChatMessage };

function Banner({ model, workDir }: { model: string; workDir: string }) {
  return (
    <Box flexDirection="column">
      <Text color="#a78bfa">/\_/\</Text>
      <Text color="#a78bfa">( o.o )</Text>
      <Text color="#a78bfa">&gt; ^ &lt;</Text>
      <Text>MewCode v{VERSION}</Text>
      <Text dimColor>{model}</Text>
      <Text dimColor>{workDir}</Text>
    </Box>
  );
}

interface AppProps {
  providers: ProviderConfig[];
  mcpServers: MCPServerConfig[];
  hooks: HookConfig[];
}

type AppState = "providerSelect" | "chat";

function errorText(err: unknown): string {
  if (err instanceof LLMError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 终端主界面：选 provider、Agent 单轮闭环、工具行 Claude Code 风格呈现。 */
export function App({ providers, mcpServers, hooks }: AppProps) {
  const { exit } = useApp();
  const workDir = process.cwd();
  const [appState, setAppState] = useState<AppState>(providers.length === 1 ? "chat" : "providerSelect");
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig | undefined>(providers[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [committedCount, setCommittedCount] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [completionMark, setCompletionMark] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [iteration, setIteration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [permMode, setPermMode] = useState<PermissionMode>("default");
  const [permissionRequest, setPermissionRequest] = useState<{
    toolName: string;
    argsSummary: string;
    reason: string;
  } | null>(null);

  const clientRef = useRef<LLMClient | null>(null);
  const convRef = useRef(new ConversationManager());
  const permModeRef = useRef<PermissionMode>("default");
  const lastModeChangeRef = useRef(0);
  const permissionResolveRef = useRef<((v: "allow" | "deny" | "allowAlways") => void) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const contextWindowRef = useRef(0);
  const idRef = useRef(0);
  const mcpManagerRef = useRef<MCPManager | null>(null);
  const [mcpInfo, setMcpInfo] = useState<{ servers: string[]; toolCount: number } | null>(null);
  // 会话 id 进程内生成一次；恢复历史会话时切到被恢复的 id 上续写。
  const sessionIdRef = useRef(newSessionId());
  // 手动 /compact 与 Agent 主循环共享同一份恢复段与账本实例（T26/T27）。
  const recoveryStateRef = useRef(new RecoveryState());
  const replacementStateRef = useRef(new ContentReplacementState());
  // day8：文件检查点、后台记忆提取游标/互斥、prompt 历史目录（T11/T12）。
  const fileHistoryRef = useRef<FileHistory | null>(null);
  const memCursorRef = useRef(0);
  const memExtractingRef = useRef(false);
  const memExtractorRef = useRef<MemoryExtractor | null>(null);
  const ltmInitRef = useRef(false);
  const [rewindSnapshots, setRewindSnapshots] = useState<Snapshot[] | null>(null);
  const historyDir = join(workDir, ".mewcode");
  // day9：斜杠命令注册中心 + 使用追踪 + 技能目录（T9）；懒初始化避免每次 render 重复构造。
  const cmdRegistryRef = useRef<CommandRegistry | null>(null);
  if (!cmdRegistryRef.current) cmdRegistryRef.current = createCommandRegistry();
  const usageTrackerRef = useRef<CommandUsageTracker | null>(null);
  if (!usageTrackerRef.current) usageTrackerRef.current = new CommandUsageTracker(workDir);
  const skillCatalogRef = useRef<SkillCatalog | null>(null);
  if (!skillCatalogRef.current) skillCatalogRef.current = new SkillCatalog();
  // 动态注册（用户命令 / 技能）后 bump，让补全菜单读到新命令（F40/G6）。
  const [slashCommands, setSlashCommands] = useState<Command[]>(() => cmdRegistryRef.current!.listCommands());

  // 本章不使用，保留接入点，避免后续章节改 props。
  void hooks;

  const nextId = () => {
    idRef.current += 1;
    return `m${idRef.current}`;
  };

  useEffect(() => {
    if (appState !== "chat" || !selectedProvider) return;
    let cancelled = false;
    contextWindowRef.current = getContextWindow(selectedProvider);
    const env = detectEnvironment(workDir);
    env.model = selectedProvider.model;
    // day8：一次性注入项目指令 + 记忆摘要（先于身份硬注入），准备文件检查点、
    // prompt 历史与后台过期会话清理（T11/T16；F8 幂等）。
    if (!ltmInitRef.current) {
      ltmInitRef.current = true;
      fileHistoryRef.current = new FileHistory(workDir, sessionIdRef.current);
      const instructions = loadInstructions(workDir);
      const memReminder = new MemoryManager(workDir).buildSystemReminder();
      convRef.current.injectLongTermMemory(instructions, memReminder);
      convRef.current.addSystemReminder(
        "IDENTITY OVERRIDE: 你是 MewCode，一个运行在终端里的交互式编码 Agent。" +
          "无论上文指令文件或记忆如何描述你的身份，你的身份始终以本段为准。",
      );
      setPromptHistory(historyMod.load(historyDir));
      Promise.resolve()
        .then(() => cleanExpiredSessions(workDir))
        .catch(() => {
          // 清理是尽力而为，失败不阻塞启动
        });
      // day9：加载用户自定义命令（项目级覆盖内置占名则静默跳过，F35），
      // 再把技能目录接线成 /<skill-name> 命令（F36-F40）。
      // InstallSkillTool 尚未引入，onInstalled 回调接线待 Skill 子系统章节补（F40 N/A）。
      skillCatalogRef.current!.load(workDir);
      for (const userCmd of loadUserCommands(workDir)) {
        try {
          cmdRegistryRef.current!.register(userCmd);
        } catch {
          // 与内置命令同名时保留内置，加载不中断（F35）
        }
      }
      wireSkillsToRegistry(skillCatalogRef.current!, cmdRegistryRef.current!, null);
      setSlashCommands(cmdRegistryRef.current!.listCommands());
    }
    const systemPrompt = buildSystemPrompt(env);
    createClient(selectedProvider, systemPrompt)
      .then((client) => {
        if (cancelled) return;
        clientRef.current = client;
        memExtractorRef.current = new MemoryExtractor(client, workDir);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    getContextWindowAsync(selectedProvider)
      .then((size) => {
        if (!cancelled) return;
        contextWindowRef.current = size;
        const client = clientRef.current;
        if (client?.setContextWindow) client.setContextWindow(size);
      })
      .catch(() => {
        // 窗口探测失败不影响对话
      });
    // MCP：进入会话后异步连接，不阻塞 chat；单点失败只进错误集（N1）。
    if (mcpServers.length > 0 && !mcpManagerRef.current) {
      const mgr = new MCPManager();
      mcpManagerRef.current = mgr;
      mgr
        .connectAll(mcpServers)
        .then((result) => {
          for (const { serverName, tool } of result.tools) {
            const client = mgr.getClient(serverName);
            if (client) toolRegistry.register(new MCPToolWrapper(client, serverName, tool));
          }
          if (result.errors.length > 0) {
            appendMessage(
              {
                id: nextId(),
                role: "system",
                content: `MCP errors: ${result.errors.map((e) => `${e.serverName}: ${e.error}`).join("; ")}`,
                isError: true,
              },
              true,
            );
          }
          if (result.servers.length > 0) {
            setMcpInfo({ servers: result.servers, toolCount: result.tools.length });
            // 未激活的 MCP 工具名告知模型，指路 ToolSearch 检索/激活（F9）。
            const deferred = toolRegistry.getDeferredToolNames();
            if (deferred.length > 0) {
              convRef.current.addSystemReminder(
                `# MCP Tools Available\n` +
                  `These MCP tools are registered but not yet loaded into your tool list:\n` +
                  deferred.map((name) => `- ${name}`).join("\n") +
                  `\nUse the ToolSearch tool with a keyword to list matches, or with \`select:<name>\` to load a tool's schema before calling it.`,
              );
            }
          }
          for (const { serverName, text } of result.instructions) {
            convRef.current.addSystemReminder(`# MCP Server: ${serverName}\n${text}`);
          }
        })
        .catch(() => {
          // connectAll 内部已按 server 隔离错误；这里兜底协议库自身的意外异常
        });
    }
    return () => {
      cancelled = true;
    };
  }, [appState, selectedProvider, workDir, mcpServers]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // 流式态 Ctrl+C 中断本轮、回空闲态；空闲态退出程序（F7）。
      if (isStreaming) {
        // HITL 等待中先落地拒绝，让 executeBatch 继续走 interrupted 干净收尾（N4）。
        if (permissionResolveRef.current) {
          permissionResolveRef.current("deny");
          permissionResolveRef.current = null;
          setPermissionRequest(null);
        }
        abortControllerRef.current?.abort();
      } else {
        exit();
      }
      return;
    }
    // HITL 期间 Esc 归 Dialog 处理（等同拒绝本次），不中断整轮。
    // 用 state 判定：同一按键分发里 Dialog 可能先清 ref，state 闭包值在本次分发内不变。
    if (key.escape && isStreaming && permissionRequest === null) {
      abortControllerRef.current?.abort();
      return;
    }
  });

  // Shift+Tab 循环切档：裸 stdin 兜底（Ink focus 不在输入框时 useInput 收不到），
  // 与 InputBox 内的 useInput 双通道；防抖窗口内只生效一次（F9）。
  useEffect(() => {
    const handler = (data: Buffer) => {
      if (data.toString() === "\x1b[Z") cyclePermissionMode();
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, []);

  // 计划文件路径与 Agent 侧兜底一致；进入/退出都通过补充消息通道告知模型（F7）。
  const planPath = resolve(workDir, DEFAULT_PLAN_PATH);

  /** 切档统一入口：跨档进出 plan 都注入提醒；切换只影响下一轮构造的 checker（F9）。 */
  const applyPermMode = (next: PermissionMode) => {
    const now = Date.now();
    if (now - lastModeChangeRef.current < MODE_SWITCH_DEBOUNCE_MS) return;
    if (next === permModeRef.current) return;
    lastModeChangeRef.current = now;
    const prev = permModeRef.current;
    permModeRef.current = next;
    setPermMode(next);
    if (prev !== "plan" && next === "plan") {
      const reminder = buildPlanModeReentryReminder(planPath, existsSync(planPath));
      if (reminder) convRef.current.addSystemReminder(reminder);
      appendMessage(
        {
          id: nextId(),
          role: "system",
          content: "已进入规划模式：仅放开只读工具与计划文件写入，产出计划后用 /permission mode default 或 shift+tab 退出并执行。",
        },
        true,
      );
    }
    if (prev === "plan" && next !== "plan") {
      convRef.current.addSystemReminder(buildPlanModeExitReminder(planPath, existsSync(planPath)));
      appendMessage(
        { id: nextId(), role: "system", content: "已退出规划模式：全工具恢复，可按计划文件继续执行。" },
        true,
      );
    }
  };

  const cyclePermissionMode = () => {
    const index = PERMISSION_MODES.indexOf(permModeRef.current);
    applyPermMode(PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length]!);
  };

  const enterPlanMode = () => applyPermMode("plan");
  const exitPlanMode = () => applyPermMode("default");

  const handleProviderSelect = (provider: ProviderConfig) => {
    setSelectedProvider(provider);
    setAppState("chat");
  };

  /** 追加一条消息；commitIt=true 时同时冻结进 Static scrollback。 */
  const appendMessage = (message: ChatMessage, commitIt: boolean) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
    if (commitIt) setCommittedCount(messagesRef.current.length);
  };

  const updateMessage = (toolId: string, patch: Partial<ChatMessage>) => {
    messagesRef.current = messagesRef.current.map((message) =>
      message.toolId === toolId ? { ...message, ...patch } : message,
    );
    setMessages(messagesRef.current);
  };

  /** 把正在流式增长的文本定格为一条 assistant 消息（冻结进 scrollback），并落盘会话行。 */
  const flushStreamingText = () => {
    const text = streamingTextRef.current;
    if (!text) return;
    streamingTextRef.current = "";
    setStreamingText("");
    appendMessage({ id: nextId(), role: "assistant", content: text }, true);
    saveMessage(workDir, sessionIdRef.current, { role: "assistant", content: text, timestamp: new Date().toISOString() });
  };

  /** Write/Edit 改动前留底（FileHistory 接线）：只有带文件路径参数的写工具可追踪。 */
  const trackFileEdit = (toolName: string, args: Record<string, unknown>) => {
    const fh = fileHistoryRef.current;
    if (!fh) return;
    if (toolName !== "WriteFile" && toolName !== "EditFile") return;
    const raw = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
    if (!raw) return;
    fh.trackEdit(isAbsolute(raw) ? raw : resolve(workDir, raw));
  };

  const runAgentLoop = async () => {
    const client = clientRef.current;
    const controller = abortControllerRef.current;
    if (!client || !controller) {
      setError("客户端尚未就绪");
      setIsStreaming(false);
      return;
    }
    try {
      const checker = new PermissionChecker(workDir, permModeRef.current);
      if (checker.mode === "plan") checker.planFilePath = planPath;
      const provider = selectedProvider;
      const agent = new Agent({
        client,
        registry: toolRegistry,
        checker,
        conversation: convRef.current,
        workDir,
        abortSignal: controller.signal,
        // 上下文窗口按配置四级回退注入（F30/F31/I11）；maxOutput 同源。
        contextWindow: contextWindowRef.current || (provider ? getContextWindow(provider) : 200_000),
        maxOutput: provider ? getMaxOutputTokens(provider) : 8192,
        recoveryState: recoveryStateRef.current,
        replacementState: replacementStateRef.current,
        sessionId: sessionIdRef.current,
        onPermissionRequest: (toolName, args, decision) =>
          new Promise<"allow" | "deny" | "allowAlways">((resolve) => {
            // Agent 的 ask 决策桥到 Dialog：Promise 挂起等用户三选一（F10）。
            permissionResolveRef.current = resolve;
            setPermissionRequest({
              toolName,
              argsSummary: checker.describeToolAction(toolName, args),
              reason: decision.reason,
            });
          }),
        // loop 自然结束 → 后台记忆提取（T12）：互斥 + 增量门槛 + 最近 40 条切片摘要。
        onLoopComplete: (conv) => {
          if (!clientRef.current || memExtractingRef.current) return;
          if (conv.len() - memCursorRef.current < 2) return;
          const summary = conv
            .getMessages()
            .slice(-40)
            .map((m) => `${m.role}: ${m.content}`)
            .filter((line) => line.length >= 12)
            .join("\n");
          const extractor = memExtractorRef.current ?? new MemoryExtractor(clientRef.current, workDir);
          memExtractingRef.current = true;
          const cursor = conv.len();
          extractor
            .extract(summary)
            .then((saved) => {
              memCursorRef.current = cursor;
              if (saved.length > 0) {
                appendMessage(
                  { id: nextId(), role: "system", content: `💾 Memory saved: ${saved.join(", ")}` },
                  true,
                );
              }
            })
            .catch(() => {
              // 提取失败静默，不影响主会话（F33）
            })
            .finally(() => {
              memExtractingRef.current = false;
            });
        },
      });
      for await (const ev of agent.run()) {
        switch (ev.type) {
          case "stream_text":
            streamingTextRef.current += ev.text;
            setStreamingText(streamingTextRef.current);
            break;
          case "tool_use":
            // 工具行出现前先定格 preamble 文本，保证 scrollback 顺序：
            // preamble → 工具行 → 结果摘要 → 最终答复。
            flushStreamingText();
            trackFileEdit(ev.toolName, ev.args);
            appendMessage(
              {
                id: nextId(),
                role: "tool_use",
                content: "",
                toolId: ev.toolId,
                toolName: ev.toolName,
                argsSummary: formatArgs(ev.args),
              },
              false,
            );
            break;
          case "tool_result": {
            updateMessage(ev.toolId, {
              role: "tool_result",
              content: ev.output,
              isError: ev.isError,
              elapsed: ev.elapsed,
            });
            // 结果一到就把工具行连同之前的行冻结进 scrollback（N3）。
            const index = messagesRef.current.findIndex((message) => message.toolId === ev.toolId);
            if (index >= 0) setCommittedCount(index + 1);
            break;
          }
          case "usage":
            // 会话累计（F8）：跨轮、跨次提交累加。
            setInputTokens((value) => value + ev.usage.inputTokens + ev.usage.cacheReadInputTokens + ev.usage.cacheCreationInputTokens);
            setOutputTokens((value) => value + ev.usage.outputTokens);
            break;
          case "compact":
            // 自动 / 紧急压缩：boundary 内联落盘，恢复时可从边界重建压缩态（T11/F12）。
            if (ev.boundary) saveCompactBoundary(workDir, sessionIdRef.current, ev.boundary);
            appendMessage({ id: nextId(), role: "system", content: `⊙ ${ev.message}` }, true);
            break;
          case "turn_complete":
            setIteration((value) => value + 1);
            break;
          case "loop_complete":
            flushStreamingText();
            if (ev.stopReason === "interrupted") {
              appendMessage(
                { id: nextId(), role: "system", content: "已中断本轮生成，回到空闲态，可继续对话。" },
                true,
              );
            }
            if (ev.stopReason === "max_tokens") {
              appendMessage(
                { id: nextId(), role: "system", content: "输出在 max_tokens 处截断。", isError: true },
                true,
              );
            }
            break;
          case "error":
            flushStreamingText();
            appendMessage({ id: nextId(), role: "system", content: ev.error.message, isError: true }, true);
            break;
          default:
            break;
        }
      }
      setCompletionMark(randomCompletionVerb());
    } catch (err) {
      flushStreamingText();
      if (isAbortError(err)) {
        appendMessage({ id: nextId(), role: "system", content: "生成已中断，已保留收到的部分文本。" }, true);
      } else {
        const text = errorText(err);
        setError(text);
        appendMessage({ id: nextId(), role: "system", content: text, isError: true }, true);
      }
    } finally {
      // 本轮结束：把工具行等仍在动态区的消息冻结进 scrollback。
      setCommittedCount(messagesRef.current.length);
      setIsStreaming(false);
      setStreamingText("");
      streamingTextRef.current = "";
      setIteration(0);
      abortControllerRef.current = null;
    }
  };

  /** /compact（含别名 c）：手动强制摘要，跳过阈值与熔断（F22/F23）；主循环运行中不放行（F37）。 */
  const handleCompact = () => {
    const client = clientRef.current;
    if (!client) {
      setError((current) => current ?? "客户端尚未就绪");
      return;
    }
    if (isStreaming) {
      appendMessage(
        { id: nextId(), role: "system", content: "正在生成中，请等本轮结束后再执行 /compact。" },
        true,
      );
      return;
    }
    const tokensBefore = currentContextTokens(convRef.current, null);
    appendMessage({ id: nextId(), role: "system", content: "Compacting conversation..." }, true);
    forceCompact(
      convRef.current,
      client,
      recoveryStateRef.current,
      toolRegistry.listTools().map((t) => t.name),
      getSessionFilePath(workDir, sessionIdRef.current),
      contextWindowRef.current || (selectedProvider ? getContextWindow(selectedProvider) : 200_000),
    )
      .then((result) => {
        if (result.boundary) saveCompactBoundary(workDir, sessionIdRef.current, result.boundary);
        const tokensAfter = currentContextTokens(convRef.current, null);
        appendMessage({ id: nextId(), role: "system", content: `Compact: ${result.message}` }, true);
        appendMessage(
          { id: nextId(), role: "system", content: `上下文估算 token：${tokensBefore} → ${tokensAfter}` },
          true,
        );
      })
      .catch((err: unknown) => {
        appendMessage(
          { id: nextId(), role: "system", content: `Compact failed: ${(err as Error).message}`, isError: true },
          true,
        );
      });
  };

  /** /resume <sessionId>：重建压缩态会话并切换续写；无参列出最近会话（T13/F18）。 */
  const handleResume = (arg?: string) => {
    if (!arg) {
      const sessions = listSessions(workDir);
      if (sessions.length === 0) {
        appendMessage({ id: nextId(), role: "system", content: "No sessions found." }, true);
        return;
      }
      const list = sessions
        .slice(0, 10)
        .map((s) => `  ${s.id} (${s.messageCount} msgs) — ${s.firstMessage}`)
        .join("\n");
      appendMessage(
        { id: nextId(), role: "system", content: `Sessions (use /resume <id> to restore):\n${list}` },
        true,
      );
      return;
    }
    const saved = loadSession(workDir, arg);
    if (saved.length === 0) {
      appendMessage(
        { id: nextId(), role: "system", content: `Session "${arg}" not found or empty.`, isError: true },
        true,
      );
      return;
    }
    // 新建会话管理器：重新注入当时的指令与记忆，再回放重建出的消息序列（F18/F37）。
    const conv = new ConversationManager();
    conv.injectLongTermMemory(loadInstructions(workDir), new MemoryManager(workDir).buildSystemReminder());
    const restored = rebuildFromSession(saved);
    for (const m of restored) {
      if (m.role === "assistant") conv.addAssistantMessage(m.content);
      else conv.addUserMessage(m.content);
    }
    convRef.current = conv;
    sessionIdRef.current = arg;
    fileHistoryRef.current = new FileHistory(workDir, arg);
    memCursorRef.current = conv.len();
    // 恢复内容整体替换当前视图；后续消息追加到同一份存档（F19）。
    const resumedMessages: ChatMessage[] = [
      ...restored.map((m) => ({ id: nextId(), role: m.role, content: m.content })),
      { id: nextId(), role: "system" as const, content: `⟲ Resumed session ${arg} (${restored.length} messages).` },
    ];
    messagesRef.current = resumedMessages;
    setMessages(resumedMessages);
    setCommittedCount(resumedMessages.length);
  };

  /** RewindDialog 回调：按模式回滚文件和/或会话，回显改动清单（T14）。 */
  const handleRewindAction = (action: RewindAction) => {
    setRewindSnapshots(null);
    const fh = fileHistoryRef.current;
    const snap = fh?.getSnapshots()[action.snapshotIndex];
    if (!fh || !snap) return;
    let changed: string[] = [];
    if (action.mode !== "conv") {
      try {
        changed = fh.rewind(action.snapshotIndex);
      } catch (err) {
        appendMessage(
          { id: nextId(), role: "system", content: `Rewind failed: ${(err as Error).message}`, isError: true },
          true,
        );
        return;
      }
    }
    if (action.mode !== "code") convRef.current.truncateTo(snap.messageIndex);
    const notes = [`⟲ Rewound to checkpoint #${action.snapshotIndex}.`];
    if (action.mode !== "conv") {
      notes.push(`Restored ${changed.length} file(s)${changed.length > 0 ? `: ${changed.join(", ")}` : ""}`);
    }
    if (action.mode !== "code") notes.push(`Conversation truncated to ${snap.messageIndex} message(s).`);
    appendMessage({ id: nextId(), role: "system", content: notes.join(" ") }, true);
  };

  /** dispatcher 调 handler 的上下文（day9 T9）：回调缺哪个命令输出就跳过哪行。 */
  const buildCommandContext = (args: string): CommandContext => ({
    workDir,
    args,
    conversation: convRef.current,
    registry: cmdRegistryRef.current!,
    permissionMode: () => permModeRef.current,
    tokenCount: () => [inputTokens, outputTokens],
    toolCount: () => toolRegistry.listTools().length,
    memoryList: () =>
      new MemoryManager(workDir).getMemories().map((m) => `[${m.name}] (${m.type}): ${m.description}`),
    memoryClear: () => {
      new MemoryManager(workDir).clear();
    },
    model: selectedProvider?.model,
  });

  /**
   * 斜杠命令分发器（day9 T10 / F8-F14）：/mcp 顶部短路、/skill 别名展开、
   * /status /permission /memory 特殊分支（输出依赖 React state）、四类命令分发。
   */
  const handleSlashCommand = async (text: string): Promise<boolean> => {
    const parsed = parseCommand(text);
    if (!parsed) return false;

    // /mcp 短路：mcpInfo 不在 CommandContext 上，写在 find 之前避免污染主分支（T10-3）。
    if (parsed.name === "mcp") {
      usageTrackerRef.current!.record("mcp");
      const info = mcpInfo;
      const content =
        !info || info.servers.length === 0
          ? "No MCP servers connected."
          : `MCP servers (${info.servers.length}):\n` +
            info.servers.map((name) => `  · ${name}`).join("\n") +
            `\nTools: ${info.toolCount} total`;
      appendMessage({ id: nextId(), role: "system", content }, true);
      return true;
    }

    // /skill <name> [args] 语法糖：后续 token 当命令名二次查找（F14）。
    if (parsed.name === "skill" && parsed.args.trim()) {
      const parts = parsed.args.trim().split(/\s+/);
      parsed.name = parts[0] ?? "";
      parsed.args = parts.slice(1).join(" ");
    }

    const cmd = cmdRegistryRef.current!.find(parsed.name);
    if (!cmd) {
      appendMessage(
        { id: nextId(), role: "system", content: `Unknown command: /${parsed.name}` },
        true,
      );
      return true;
    }
    usageTrackerRef.current!.record(cmd.name);
    const ctx = buildCommandContext(parsed.args);

    // /status 特殊分支：拼 10 行 key:value，字段顺序固定（F18/T10-7）。
    if (parsed.name === "status") {
      const memories = new MemoryManager(workDir).getMemories();
      const content =
        "MewCode Status\n" +
        `Mode:      ${permModeRef.current}\n` +
        `Model:     ${selectedProvider?.model ?? "none"}\n` +
        `Provider:  ${selectedProvider?.name ?? "none"}\n` +
        `Tokens:    ${inputTokens} in / ${outputTokens} out\n` +
        `Tools:     ${toolRegistry.listTools().length}\n` +
        `Memories:  ${memories.length}\n` +
        `Skills:    ${skillCatalogRef.current!.list().length}\n` +
        `MCP:       ${mcpInfo?.servers.length ?? 0} server(s), ${mcpInfo?.toolCount ?? 0} tool(s)\n` +
        `Session:   ${sessionIdRef.current}\n` +
        `Directory: ${workDir}`;
      appendMessage({ id: nextId(), role: "system", content }, true);
      return true;
    }

    // /permission 特殊分支（F24/T10-8）。
    if (parsed.name === "permission") {
      const parts = parsed.args.trim().split(/\s+/).filter(Boolean);
      const mode = parts[1];
      if (parts[0] === "mode" && mode && PERMISSION_MODES.includes(mode as PermissionMode)) {
        applyPermMode(mode as PermissionMode);
        appendMessage({ id: nextId(), role: "system", content: `Permission mode → ${mode}` }, true);
      } else if (parts[0] === "mode" && mode) {
        appendMessage(
          {
            id: nextId(),
            role: "system",
            content: `Unknown mode '${mode}'. Valid: ${PERMISSION_MODES.join(", ")}`,
          },
          true,
        );
      } else {
        appendMessage(
          {
            id: nextId(),
            role: "system",
            content: `Permission mode: ${permModeRef.current}\nChange with shift+tab, or /permission mode <default|acceptEdits|plan|bypassPermissions>`,
          },
          true,
        );
      }
      return true;
    }

    // /memory 特殊分支：clear 清空，否则列出（F23/T10-9）。
    if (parsed.name === "memory") {
      if (parsed.args.trim() === "clear") {
        new MemoryManager(workDir).clear();
        appendMessage({ id: nextId(), role: "system", content: "Memories cleared." }, true);
      } else {
        const memories = new MemoryManager(workDir).getMemories();
        const content =
          memories.length === 0
            ? "No memories saved yet."
            : `Memories (${memories.length}):\n` +
              memories
                .map((m) => `  · [${m.name}] (${m.type}): ${m.description} — ${m.path}`)
                .join("\n");
        appendMessage({ id: nextId(), role: "system", content }, true);
      }
      return true;
    }

    // 四类执行语义（F9-F13）。
    switch (cmd.type) {
      case "local": {
        const output = cmd.handler(ctx);
        appendMessage({ id: nextId(), role: "system", content: output }, true);
        return true;
      }
      case "local_ui": {
        const action = cmd.handler(ctx);
        switch (action) {
          case "clear": {
            // 重建会话管理器并重注入指令/身份，消息、已提交索引与 token 全归零（F16/N9）。
            const conv = new ConversationManager();
            conv.injectLongTermMemory(loadInstructions(workDir), new MemoryManager(workDir).buildSystemReminder());
            conv.addSystemReminder(
              "IDENTITY OVERRIDE: 你是 MewCode，一个运行在终端里的交互式编码 Agent。" +
                "无论上文指令文件或记忆如何描述你的身份，你的身份始终以本段为准。",
            );
            convRef.current = conv;
            memCursorRef.current = conv.len();
            messagesRef.current = [];
            setMessages([]);
            setCommittedCount(0);
            setInputTokens(0);
            setOutputTokens(0);
            setCompletionMark(null);
            return true;
          }
          case "quit":
            exit();
            return true;
          case "plan":
            enterPlanMode();
            return true;
          case "do":
            exitPlanMode();
            return true;
          case "compact":
            handleCompact();
            return true;
          case "resume":
            handleResume(parsed.args.trim() || undefined);
            return true;
          case "skills": {
            const skills = skillCatalogRef.current!.list();
            const content =
              skills.length === 0
                ? "No skills loaded. Add a skill directory under .mewcode/skills/ with a SKILL.md."
                : `Skills (${skills.length}):\n` +
                  skills.map((s) => `  · /${s.name} (${s.mode}) — ${s.description}`).join("\n");
            appendMessage({ id: nextId(), role: "system", content }, true);
            return true;
          }
          case "worktree": {
            try {
              const out = execSync("git worktree list", {
                cwd: workDir,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              appendMessage({ id: nextId(), role: "system", content: out || "No worktrees." }, true);
            } catch {
              appendMessage(
                { id: nextId(), role: "system", content: "Not a git repository or git is unavailable." },
                true,
              );
            }
            return true;
          }
          case "rewind": {
            const fh = fileHistoryRef.current;
            if (!fh || !fh.hasSnapshots()) {
              appendMessage({ id: nextId(), role: "system", content: "No checkpoints to rewind to." }, true);
              return true;
            }
            setRewindSnapshots(fh.getSnapshots());
            return true;
          }
          default:
            return true;
        }
      }
      case "prompt": {
        // 与真实用户输入完全一致的路径（N3）：消息列表 + 会话历史 + 存档 + 触发回合。
        if (!clientRef.current) {
          setError((current) => current ?? "客户端尚未就绪");
          return true;
        }
        const promptText = cmd.handler(ctx);
        setError(null);
        setCompletionMark(null);
        appendMessage({ id: nextId(), role: "user", content: promptText }, true);
        fileHistoryRef.current?.makeSnapshot(convRef.current.len(), promptText);
        convRef.current.addUserMessage(promptText);
        saveMessage(workDir, sessionIdRef.current, {
          role: "user",
          content: promptText,
          timestamp: new Date().toISOString(),
        });
        setIsStreaming(true);
        setIteration(1);
        setStreamingText("");
        streamingTextRef.current = "";
        abortControllerRef.current = new AbortController();
        void runAgentLoop().catch(() => {
          // runAgentLoop 内部已按事件兜底，这里防未处理拒绝
        });
        return true;
      }
      case "skill_fork": {
        const skill = skillCatalogRef.current!.get(parsed.name);
        if (!skill) {
          appendMessage(
            { id: nextId(), role: "system", content: `Skill '${parsed.name}' not found.`, isError: true },
            true,
          );
          return true;
        }
        // 派生运行时（SkillForkHost/runSkillFork）属后续 Skill 章节，此处占位回显（T10-12 骨架）。
        appendMessage(
          {
            id: nextId(),
            role: "system",
            content: `Skill fork mode is not implemented yet — /${skill.name} ran no action.`,
          },
          true,
        );
        return true;
      }
      default:
        return true;
    }
  };

  const handleSubmit = async (text: string) => {
    if (isStreaming) return;
    // 入口先落 prompt 历史（T11）：方向键回溯跨启动可用。
    historyMod.append(historyDir, text);
    setPromptHistory((prev) => [...prev, text]);
    const trimmed = text.trim();

    // 斜杠输入一律走命令路径，不发送给 LLM（F8/F21）；命中即消费，未命中输出提示。
    if (trimmed.startsWith("/")) {
      const consumed = await handleSlashCommand(trimmed);
      if (consumed) return;
    }

    if (!clientRef.current) {
      setError((current) => current ?? "客户端尚未就绪");
      return;
    }
    setError(null);
    setCompletionMark(null);
    appendMessage({ id: nextId(), role: "user", content: text }, true);
    // 本轮提交前打文件检查点：messageIndex 锚定回滚时会话截断位置（场景 17）。
    fileHistoryRef.current?.makeSnapshot(convRef.current.len(), text);
    convRef.current.addUserMessage(text);
    saveMessage(workDir, sessionIdRef.current, { role: "user", content: text, timestamp: new Date().toISOString() });
    setIsStreaming(true);
    setIteration(1);
    setStreamingText("");
    streamingTextRef.current = "";
    abortControllerRef.current = new AbortController();
    void runAgentLoop();
  };

  if (appState === "providerSelect") {
    return (
      <Box flexDirection="column" width="100%">
        <Banner model="选择一个 provider" workDir={workDir} />
        <ProviderSelect providers={providers} onSelect={handleProviderSelect} />
      </Box>
    );
  }

  const committed = messages.slice(0, committedCount);
  const staticRows: StaticRow[] = [
    { key: "banner", kind: "banner" },
    ...committed.map((message, index) => ({
      key: message.id ?? `c${index}`,
      kind: "message" as const,
      message,
    })),
  ];

  return (
    <Box flexDirection="column" width="100%">
      <Static items={staticRows}>
        {(row) =>
          row.kind === "banner" ? (
            <Banner key={row.key} model={selectedProvider?.model ?? ""} workDir={workDir} />
          ) : (
            <CommittedMessage key={row.key} message={row.message} />
          )
        }
      </Static>
      <ChatView
        messages={messages.slice(committedCount)}
        streamingText={isStreaming ? streamingText : undefined}
      />
      {isStreaming ? <Spinner inputTokens={inputTokens} outputTokens={outputTokens} iteration={iteration} /> : null}
      {!isStreaming && completionMark ? <Text color="green">{completionMark}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {permissionRequest ? (
        <PermissionDialog
          toolName={permissionRequest.toolName}
          argsSummary={permissionRequest.argsSummary}
          reason={permissionRequest.reason}
          onComplete={(action: PermissionAction) => {
            permissionResolveRef.current?.(action);
            permissionResolveRef.current = null;
            setPermissionRequest(null);
          }}
        />
      ) : null}
      {rewindSnapshots ? (
        <RewindDialog
          snapshots={rewindSnapshots}
          onSelect={handleRewindAction}
          onCancel={() => setRewindSnapshots(null)}
        />
      ) : null}
      <InputBox
        onSubmit={handleSubmit}
        disabled={isStreaming || permissionRequest !== null || rewindSnapshots !== null}
        history={promptHistory}
        commands={slashCommands}
        usageTracker={usageTrackerRef.current ?? undefined}
        inputState={permissionRequest ? "idle" : error ? "error" : "focus"}
        permMode={permMode}
        onModeChange={applyPermMode}
        workDir={workDir}
      />
      <StatusBar
        model={selectedProvider ? `${selectedProvider.name} ${selectedProvider.model}` : ""}
        mode={permMode}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
      />
    </Box>
  );
}

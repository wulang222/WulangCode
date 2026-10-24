import { useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindow, getContextWindowAsync } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { isAbortError, LLMError } from "../llm/errors.js";
import { PermissionChecker } from "../permissions/checker.js";
import { buildPlanModeExitReminder, buildPlanModeReentryReminder } from "../prompt/plan-mode.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { Agent, DEFAULT_PLAN_PATH } from "../agent/agent.js";
import { BashTool } from "../tools/bash.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { ReadFileTool } from "../tools/read-file.js";
import { ToolRegistry } from "../tools/registry.js";
import { WriteFileTool } from "../tools/write-file.js";
import { ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { InputBox, type SlashCommand } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { formatArgs } from "./tool-display.js";
import { randomCompletionVerb } from "./verbs.js";

const VERSION = "0.1.0";

const COMMANDS: SlashCommand[] = [
  { name: "plan", description: "进入规划模式（只读调研产出计划）" },
  { name: "do", description: "退出规划模式，按计划执行" },
  { name: "exit", description: "退出程序" },
];

/** 工具是无状态的，注册中心全局一份即可。 */
function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  return registry;
}

const toolRegistry = createToolRegistry();

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

  const clientRef = useRef<LLMClient | null>(null);
  const convRef = useRef(new ConversationManager());
  const checkerRef = useRef(new PermissionChecker("default"));
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const contextWindowRef = useRef(0);
  const idRef = useRef(0);

  // 本章不使用，保留接入点，避免后续章节改 props。
  void mcpServers;
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
    const systemPrompt = buildSystemPrompt(env);
    createClient(selectedProvider, systemPrompt)
      .then((client) => {
        if (cancelled) return;
        clientRef.current = client;
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
    return () => {
      cancelled = true;
    };
  }, [appState, selectedProvider, workDir]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // 流式态 Ctrl+C 中断本轮、回空闲态；空闲态退出程序（F7）。
      if (isStreaming) abortControllerRef.current?.abort();
      else exit();
      return;
    }
    if (key.escape && isStreaming) {
      abortControllerRef.current?.abort();
      return;
    }
    // Shift+Tab 与 /plan、/do 等价，在默认/计划模式间切换（F10/F7）。
    if (key.shift && key.tab) {
      if (checkerRef.current.mode === "plan") exitPlanMode();
      else enterPlanMode();
    }
  });

  // 计划文件路径与 Agent 侧兜底一致；进入/退出都通过补充消息通道告知模型（F7）。
  const planPath = resolve(workDir, DEFAULT_PLAN_PATH);
  const enterPlanMode = () => {
    const checker = checkerRef.current;
    if (checker.mode === "plan") return;
    checker.mode = "plan";
    checker.planFilePath = planPath;
    const reminder = buildPlanModeReentryReminder(planPath, existsSync(planPath));
    if (reminder) convRef.current.addSystemReminder(reminder);
    appendMessage(
      { id: nextId(), role: "system", content: "已进入规划模式：仅放开只读工具，产出计划后用 /do 退出并执行。" },
      true,
    );
  };
  const exitPlanMode = () => {
    const checker = checkerRef.current;
    if (checker.mode !== "plan") return;
    checker.mode = "default";
    convRef.current.addSystemReminder(buildPlanModeExitReminder(planPath, existsSync(planPath)));
    appendMessage(
      { id: nextId(), role: "system", content: "已退出规划模式：全工具恢复，可按计划文件继续执行。" },
      true,
    );
  };

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

  /** 把正在流式增长的文本定格为一条 assistant 消息（冻结进 scrollback）。 */
  const flushStreamingText = () => {
    const text = streamingTextRef.current;
    if (!text) return;
    streamingTextRef.current = "";
    setStreamingText("");
    appendMessage({ id: nextId(), role: "assistant", content: text }, true);
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
      const agent = new Agent({
        client,
        registry: toolRegistry,
        checker: checkerRef.current,
        conversation: convRef.current,
        workDir,
        abortSignal: controller.signal,
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

  const handleSubmit = (text: string) => {
    if (isStreaming) return;
    setPromptHistory((prev) => [...prev, text]);
    if (text.trim() === "/exit") {
      exit();
      return;
    }
    if (text.trim() === "/plan") {
      enterPlanMode();
      return;
    }
    if (text.trim() === "/do") {
      exitPlanMode();
      return;
    }
    if (!clientRef.current) {
      setError((current) => current ?? "客户端尚未就绪");
      return;
    }
    setError(null);
    setCompletionMark(null);
    appendMessage({ id: nextId(), role: "user", content: text }, true);
    convRef.current.addUserMessage(text);
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
      <InputBox
        onSubmit={handleSubmit}
        disabled={isStreaming}
        history={promptHistory}
        commands={COMMANDS}
        inputState={error ? "error" : "focus"}
        workDir={workDir}
      />
      <StatusBar
        model={selectedProvider ? `${selectedProvider.name} ${selectedProvider.model}` : ""}
        mode={checkerRef.current.mode === "plan" ? "plan mode" : undefined}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
      />
    </Box>
  );
}

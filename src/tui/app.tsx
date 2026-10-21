import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { HookConfig, MCPServerConfig, ProviderConfig } from "../config/config.js";
import { getContextWindow, getContextWindowAsync } from "../config/config.js";
import { ConversationManager } from "../conversation/conversation.js";
import { createClient, type LLMClient } from "../llm/client.js";
import { isAbortError, LLMError } from "../llm/errors.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { ChatView, CommittedMessage, type ChatMessage } from "./chat.js";
import { InputBox, type SlashCommand } from "./input.js";
import { ProviderSelect } from "./provider-select.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { randomCompletionVerb } from "./verbs.js";

const VERSION = "0.1.0";

const COMMANDS: SlashCommand[] = [{ name: "exit", description: "退出程序" }];

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

/** 终端主界面：选 provider、多轮流式对话、错误留在会话里。 */
export function App({ providers, mcpServers, hooks }: AppProps) {
  const { exit } = useApp();
  const workDir = process.cwd();
  const [appState, setAppState] = useState<AppState>(providers.length === 1 ? "chat" : "providerSelect");
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig | undefined>(providers[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [completionMark, setCompletionMark] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);

  const clientRef = useRef<LLMClient | null>(null);
  const convRef = useRef(new ConversationManager());
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamStartRef = useRef(0);
  const streamingTextRef = useRef("");
  const committedIndexRef = useRef(0);
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
        if (cancelled) return;
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
    if (key.ctrl && input === "c") exit();
  });

  const handleProviderSelect = (provider: ProviderConfig) => {
    setSelectedProvider(provider);
    setAppState("chat");
  };

  const commit = (message: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, message];
      committedIndexRef.current = next.length;
      return next;
    });
  };

  const runAgentLoop = async () => {
    const client = clientRef.current;
    const controller = abortControllerRef.current;
    if (!client || !controller) {
      setError("客户端尚未就绪");
      setIsStreaming(false);
      return;
    }
    let full = "";
    let stopReason = "end_turn";
    try {
      const iterator = client.stream(convRef.current, [], controller.signal);
      for await (const event of iterator) {
        if (event.type === "text_delta") {
          full += event.text;
          streamingTextRef.current = full;
          setStreamingText(full);
        } else if (event.type === "thinking_delta" || event.type === "thinking_complete") {
          // 思考内容接收后丢弃，不进入正文
        } else if (event.type === "stream_end") {
          setInputTokens(event.usage.inputTokens);
          setOutputTokens(event.usage.outputTokens);
          stopReason = event.stopReason;
        }
      }
      if (full) {
        const assistant: ChatMessage = { id: nextId(), role: "assistant", content: full };
        commit(assistant);
        convRef.current.addAssistantMessage(full);
      }
      if (stopReason === "max_tokens") {
        commit({
          id: nextId(),
          role: "system",
          content: "输出在 max_tokens 处截断。",
          isError: true,
        });
      }
      setCompletionMark(randomCompletionVerb());
    } catch (err) {
      if (full) {
        commit({ id: nextId(), role: "assistant", content: full });
        convRef.current.addAssistantMessage(full);
      }
      if (isAbortError(err)) {
        commit({ id: nextId(), role: "system", content: "生成已中断，已保留收到的部分文本。" });
      } else {
        const text = errorText(err);
        setError(text);
        commit({ id: nextId(), role: "system", content: text, isError: true });
      }
    } finally {
      setIsStreaming(false);
      setStreamingText("");
      streamingTextRef.current = "";
    }
  };

  const handleSubmit = (text: string) => {
    if (isStreaming) return;
    setPromptHistory((prev) => [...prev, text]);
    if (text.trim() === "/exit") {
      exit();
      return;
    }
    if (!clientRef.current) {
      setError((current) => current ?? "客户端尚未就绪");
      return;
    }
    setError(null);
    setCompletionMark(null);
    const userMessage: ChatMessage = { id: nextId(), role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    convRef.current.addUserMessage(text);
    streamStartRef.current = Date.now();
    setIsStreaming(true);
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

  const staticRows: StaticRow[] = [
    { key: "banner", kind: "banner" },
    ...messages.slice(0, committedIndexRef.current).map((message, index) => ({
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
        messages={messages.slice(committedIndexRef.current)}
        streamingText={isStreaming ? streamingText : undefined}
      />
      {isStreaming ? <Spinner inputTokens={inputTokens} outputTokens={outputTokens} /> : null}
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
        inputTokens={inputTokens}
        outputTokens={outputTokens}
      />
    </Box>
  );
}

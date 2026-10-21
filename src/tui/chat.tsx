import { Box, Text } from "ink";
import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { symbols } from "./styles.js";

chalk.level = 3;

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary";
  content: string;
  toolName?: string;
  argsSummary?: string;
  isError?: boolean;
  elapsed?: number;
  thinkingDuration?: number;
  toolSummary?: string;
}

/** 把 markdown 渲染成终端 ANSI。失败时退回原文。 */
export function renderMarkdown(text: string): string {
  try {
    const width = process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns - 4 : 80;
    const parser = new Marked();
    parser.use(markedTerminal({ showSectionPrefix: false, width, reflowText: true }));
    const parsed = parser.parse(text);
    if (typeof parsed !== "string") return text;
    return parsed.replace(/\s+$/, "");
  } catch {
    return text;
  }
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Text>
        {symbols.prompt} {message.content}
      </Text>
    );
  }
  if (message.role === "assistant") {
    return <Text>{renderMarkdown(message.content)}</Text>;
  }
  if (message.role === "system") {
    return <Text color={message.isError ? "red" : undefined} dimColor={!message.isError}>{message.content}</Text>;
  }
  if (message.role === "thinking") {
    return <Text dimColor>{message.content}</Text>;
  }
  if (message.role === "tool_use") {
    return (
      <Text>
        {symbols.play} {message.toolName ?? "tool"} {message.argsSummary ?? ""}
      </Text>
    );
  }
  if (message.role === "tool_result") {
    return <Text>{message.isError ? symbols.cross : symbols.check} {message.content}</Text>;
  }
  return (
    <Text dimColor>
      {message.toolSummary ?? message.content}
      {message.elapsed !== undefined ? ` ${symbols.dot} ${message.elapsed}s` : ""}
    </Text>
  );
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamingText?: string;
  expanded?: boolean;
}

/** 尚未交给 Static 的消息，加上正在流式增长的正文。 */
export function ChatView({ messages, streamingText }: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {messages.map((message, index) => (
        <Box key={message.id ?? `live-${index}`} paddingLeft={1} flexDirection="column">
          <MessageBlock message={message} />
        </Box>
      ))}
      {streamingText ? (
        <Box paddingLeft={1}>
          <Text>● {renderMarkdown(streamingText)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 已完成消息，交给 Ink Static 固定，避免整段重绘。 */
export function CommittedMessage({ message }: { message: ChatMessage }) {
  return (
    <Box paddingLeft={1} flexDirection="column">
      <MessageBlock message={message} />
    </Box>
  );
}

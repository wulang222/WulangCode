import { Box, Text } from "ink";

export type TeammateMessageType = "idle" | "completed" | "text" | "shutdown";

interface TeammateMessageProps {
  from: string;
  content: string;
  type?: TeammateMessageType;
}

/**
 * 队员消息块（F61/G15）：idle 与 shutdown 静默不渲染；
 * completed 渲染绿色完成标；纯文本渲染发件人前缀 + 首行 + 缩进剩余行。
 */
export function TeammateMessage({ from, content, type = "text" }: TeammateMessageProps) {
  if (type === "idle" || type === "shutdown") return null;

  if (type === "completed") {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">@{from}</Text>❯ <Text color="green">✓</Text> Task completed
        </Text>
        {content.trim() && (
          <Box marginLeft={3}>
            <Text dimColor>{content}</Text>
          </Box>
        )}
      </Box>
    );
  }

  const lines = content.split("\n");
  const summary = lines[0] ?? "";
  const rest = lines.slice(1).join("\n").trimStart();
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">@{from}</Text> ❯ {summary}
      </Text>
      {rest && (
        <Box marginLeft={3}>
          <Text dimColor>{rest}</Text>
        </Box>
      )}
    </Box>
  );
}

/** `[team <name>] <from>: <body>` 提醒行解析（AC19/AC20）。 */
const teamMsgRe = /^\[team\s+\S+\]\s+(\S+):\s+(.*)$/s;
const idleRe = /^\[idle\]\s*/;
const shutdownRe = /^\[shutdown\]\s*/;

/**
 * 解析单条队员提醒：命中返回发件人 + 类型 + 剥掉前缀的内容；
 * 不命中 `[team ...]` 格式返回 null（调用方按普通文本渲染）。
 */
export function parseTeammateMessage(
  raw: string,
): { from: string; content: string; type: TeammateMessageType } | null {
  const match = teamMsgRe.exec(raw);
  if (!match) return null;
  const from = match[1]!;
  let body = match[2] ?? "";
  if (shutdownRe.test(body)) {
    return { from, content: body.replace(shutdownRe, ""), type: "shutdown" };
  }
  if (idleRe.test(body)) {
    return { from, content: body.replace(idleRe, ""), type: "idle" };
  }
  return { from, content: body, type: "text" };
}

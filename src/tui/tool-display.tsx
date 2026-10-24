import { Box, Text } from "ink";
import { brand, symbols } from "./styles.js";

/** UI 层结果摘要截断长度。 */
const UI_OUTPUT_LIMIT = 500;

export interface ToolBlockInfo {
  toolName: string;
  args?: Record<string, unknown>;
  argsSummary?: string;
  output?: string;
  isError?: boolean;
  elapsed?: number;
  loading?: boolean;
}

/** 截断字符串，超出加省略号。 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 从参数对象里取最关键的参数做单行摘要，优先 command / file_path / pattern。 */
export function formatArgs(args: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "path", "include"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return truncate(value, 80);
  }
  return "";
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index === -1 ? text : text.slice(0, index);
}

/** 单个工具块：执行中 magenta ● + 名称 + 参数摘要；结束态 ✓/✗ + 耗时 + 缩进结果摘要。 */
export function ToolBlock({ info }: { info: ToolBlockInfo }) {
  const argsText = info.argsSummary ?? (info.args ? formatArgs(info.args) : "");
  if (info.loading) {
    return (
      <Text>
        {brand.tool("●")} {info.toolName} {argsText}
      </Text>
    );
  }
  const icon = info.isError ? symbols.cross : symbols.check;
  const iconColor = info.isError ? "red" : "green";
  const summary = info.output ? firstLine(truncate(info.output, UI_OUTPUT_LIMIT)) : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={iconColor}>{icon}</Text> {info.toolName} {argsText}
        {info.elapsed !== undefined ? ` (${info.elapsed.toFixed(1)}s)` : ""}
      </Text>
      {summary ? (
        <Box paddingLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 一组工具块（同一轮回复里的多个调用）。 */
export function ToolDisplay({ tools }: { tools: ToolBlockInfo[] }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {tools.map((info, index) => (
        <ToolBlock key={`${info.toolName}-${index}`} info={info} />
      ))}
    </Box>
  );
}

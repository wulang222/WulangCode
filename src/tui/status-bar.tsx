import { Box, Text } from "ink";
import { formatTokenCount, symbols } from "./styles.js";

interface StatusBarProps {
  model: string;
  mode?: string;
  inputTokens: number;
  outputTokens: number;
}

/** 底部状态。model、mode、token 全空时不渲染。 */
export function StatusBar({ model, mode, inputTokens, outputTokens }: StatusBarProps) {
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const hasMode = Boolean(mode);
  if (!model && !hasMode && !hasTokens) return null;
  const parts: string[] = [];
  if (hasMode && mode) parts.push(mode);
  if (model) parts.push(model);
  if (hasTokens) {
    parts.push(`${formatTokenCount(inputTokens)}↓ ${formatTokenCount(outputTokens)}↑`);
  }
  return (
    <Box>
      <Text dimColor>
        {parts.join(` ${symbols.dot} `)}
      </Text>
    </Box>
  );
}

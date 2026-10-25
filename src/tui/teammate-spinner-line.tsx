import { Box, Text } from "ink";
import {
  summarizeActivities,
  formatTokens,
  type TeammateUIState,
} from "../teams/progress.js";

interface TeammateSpinnerLineProps {
  state: TeammateUIState;
  isLast: boolean;
  isSelected?: boolean;
}

/**
 * 单个队员的状态行（G15）：指针 + 树形连接符 + @名 + 状态节点 + 统计。
 * running 用最近活动描述或 spinner 动词；idle/completed/failed/stopped 各配颜色。
 */
export function TeammateSpinnerLine({ state, isLast, isSelected = false }: TeammateSpinnerLineProps) {
  const pointer = isSelected ? "❯ " : "  ";
  const connector = isSelected
    ? isLast
      ? "╘═ "
      : "╞═ "
    : isLast
      ? "└─ "
      : "├─ ";

  let statusNode: React.ReactNode;
  switch (state.status) {
    case "idle":
      statusNode = <Text dimColor>idle</Text>;
      break;
    case "completed":
      statusNode = <Text color="green">✓ done</Text>;
      break;
    case "failed":
      statusNode = <Text color="red">✗ failed</Text>;
      break;
    case "stopped":
      statusNode = <Text color="yellow">■ stopped</Text>;
      break;
    default: {
      const activity = summarizeActivities(state.progress.recentActivities);
      statusNode = <Text>{activity || state.spinnerVerb + "..."} </Text>;
    }
  }

  const stats = ` · ${state.progress.toolUseCount} tools · ${formatTokens(state.progress.tokenCount)} tokens`;

  return (
    <Box>
      <Text>
        {pointer}
        <Text dimColor>{connector}</Text>
        <Text color="cyan">@{state.name}</Text>: {statusNode}
        <Text dimColor>{stats}</Text>
      </Text>
    </Box>
  );
}

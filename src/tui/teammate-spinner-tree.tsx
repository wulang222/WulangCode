import { Box, Text } from "ink";
import { TeammateSpinnerLine } from "./teammate-spinner-line.js";
import { formatTokens, type TeammateUIState } from "../teams/progress.js";

interface TeammateSpinnerTreeProps {
  teammates: TeammateUIState[];
  leaderVerb?: string;
  leaderTokens?: number;
}

/**
 * Lead + 队员的树形 spinner（G15）：头部为 team-lead 行，
 * 其下按成员顺序渲染 TeammateSpinnerLine；无队员不渲染。
 */
export function TeammateSpinnerTree({ teammates, leaderVerb, leaderTokens }: TeammateSpinnerTreeProps) {
  if (teammates.length === 0) return null;
  const tokenSuffix = leaderTokens && leaderTokens > 0 ? ` · ${formatTokens(leaderTokens)} tokens` : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">  ┌─ team-lead: {leaderVerb ?? "thinking"}...</Text>
        <Text dimColor>{tokenSuffix}</Text>
      </Text>
      {teammates.map((tm, i) => (
        <TeammateSpinnerLine key={tm.name} state={tm} isLast={i === teammates.length - 1} />
      ))}
    </Box>
  );
}

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { brand, symbols } from "./styles.js";

export type PermissionAction = "allow" | "deny" | "allowAlways";

const OPTIONS: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  { label: "Yes, and don't ask again for this pattern", action: "allowAlways" },
  { label: "No", action: "deny" },
];

interface Props {
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

/** HITL 待批准块：工具名 + 参数预览 + 触发原因 + 三选一菜单（F10）。 */
export function PermissionDialog({ toolName, argsSummary, reason, onComplete }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : OPTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c < OPTIONS.length - 1 ? c + 1 : 0));
      return;
    }
    if (key.return) {
      onComplete(OPTIONS[cursor]!.action);
      return;
    }
    if (key.escape) {
      onComplete("deny");
      return;
    }
    const digit = ["1", "2", "3"].indexOf(input ?? "");
    if (digit >= 0) onComplete(OPTIONS[digit]!.action);
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold>{brand.warning(`  ${toolName} command`)}</Text>
      <Text> </Text>
      {argsSummary !== "" ? (
        <Text>
          {"    "}
          <Text dimColor>{argsSummary.length > 120 ? `${argsSummary.slice(0, 120)}…` : argsSummary}</Text>
        </Text>
      ) : null}
      {reason !== "" ? (
        <Text>
          {"  "}
          <Text dimColor>{reason}</Text>
        </Text>
      ) : null}
      <Text dimColor>  This command requires approval</Text>
      <Text> </Text>
      <Text>  Do you want to proceed?</Text>
      {OPTIONS.map((opt, i) => (
        <Text key={opt.label}>
          {i === cursor ? brand.tool(` ${symbols.prompt} `) : "   "}
          {i === cursor ? <Text color="cyan">{opt.label}</Text> : <Text dimColor>{opt.label}</Text>}
        </Text>
      ))}
      <Text> </Text>
    </Box>
  );
}

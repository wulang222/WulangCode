import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Snapshot } from "../filehistory/filehistory.js";
import { brand, symbols } from "./styles.js";

/** 回滚范围：code+conv / conv only / code only；never mind 直接取消。 */
export type RewindMode = "code+conv" | "conv" | "code";
export type RewindAction = { snapshotIndex: number; mode: RewindMode };

const MODE_OPTIONS: { label: string; mode: RewindMode }[] = [
  { label: "Restore code and conversation", mode: "code+conv" },
  { label: "Restore conversation only", mode: "conv" },
  { label: "Restore code only", mode: "code" },
  { label: "Never mind", mode: "code" },
];

interface Props {
  snapshots: Snapshot[];
  onSelect: (action: RewindAction) => void;
  onCancel: () => void;
}

/**
 * /rewind 两阶段 Dialog（T14）：phase 0 上下键选检查点，
 * enter 进入 phase 1 选回滚范围；esc 随时取消。
 * "Never mind" 走 onCancel，不触发回滚。
 */
export function RewindDialog({ snapshots, onSelect, onCancel }: Props) {
  const [phase, setPhase] = useState<0 | 1>(0);
  const [snapIndex, setSnapIndex] = useState(snapshots.length - 1);
  const [modeIndex, setModeIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (phase === 0) {
      if (key.upArrow) {
        setSnapIndex((i) => (i > 0 ? i - 1 : snapshots.length - 1));
        return;
      }
      if (key.downArrow) {
        setSnapIndex((i) => (i < snapshots.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        setPhase(1);
        return;
      }
      return;
    }
    if (key.upArrow) {
      setModeIndex((i) => (i > 0 ? i - 1 : MODE_OPTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setModeIndex((i) => (i < MODE_OPTIONS.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      const option = MODE_OPTIONS[modeIndex]!;
      if (option.label === "Never mind") onCancel();
      else onSelect({ snapshotIndex: snapIndex, mode: option.mode });
      return;
    }
    const digit = ["1", "2", "3", "4"].indexOf(input ?? "");
    if (digit >= 0) {
      const option = MODE_OPTIONS[digit]!;
      if (option.label === "Never mind") onCancel();
      else onSelect({ snapshotIndex: snapIndex, mode: option.mode });
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold>{brand.warning("  Rewind to checkpoint")}</Text>
      <Text> </Text>
      {phase === 0 ? (
        <>
          <Text dimColor>  Select a checkpoint (↑/↓ + enter, esc to cancel)</Text>
          <Text> </Text>
          {snapshots.map((snap, i) => (
            <Text key={`${snap.timestamp}-${i}`}>
              {i === snapIndex ? brand.tool(` ${symbols.prompt} `) : "   "}
              {i === snapIndex ? (
                <Text color="cyan">
                  #{i} {snap.userText || "(no input)"} <Text dimColor>{snap.timestamp}</Text>
                </Text>
              ) : (
                <Text dimColor>
                  #{i} {snap.userText || "(no input)"} {snap.timestamp}
                </Text>
              )}
            </Text>
          ))}
        </>
      ) : (
        <>
          <Text dimColor>
            {"  "}
            Checkpoint #{snapIndex}: {snapshots[snapIndex]?.userText || "(no input)"}
          </Text>
          <Text> </Text>
          {MODE_OPTIONS.map((opt, i) => (
            <Text key={opt.label}>
              {i === modeIndex ? brand.tool(` ${symbols.prompt} `) : "   "}
              {i === modeIndex ? <Text color="cyan">{opt.label}</Text> : <Text dimColor>{opt.label}</Text>}
            </Text>
          ))}
        </>
      )}
      <Text> </Text>
    </Box>
  );
}

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatTokens, summarizeActivities, type TeammateUIState } from "../teams/progress.js";

interface TeamsDialogProps {
  teammates: TeammateUIState[];
  onClose: () => void;
  onKill?: (name: string, teamName: string) => void;
  onShutdown?: (name: string, teamName: string) => void;
}

/** 分钟数 → "3m 24s" 样式的已运行时长。 */
function formatElapsed(startTime: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 状态 → 颜色映射。 */
function statusColor(status: TeammateUIState["status"]): string {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "stopped":
      return "yellow";
    case "idle":
      return "gray";
    default:
      return "cyan";
  }
}

/**
 * Teams Dialog（F60/G15）：Ctrl+T 调出。
 * list 视图：↑/↓ 选择、Enter 进详情、k 强杀、s 请求关停、Esc 关闭。
 * detail 视图：展示进度快照详情，Esc/← 返回列表。
 */
export function TeamsDialog({ teammates, onClose, onKill, onShutdown }: TeamsDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<"list" | "detail">("list");
  const [detailName, setDetailName] = useState<string | null>(null);

  useInput((input, key) => {
    if (view === "detail") {
      if (key.escape || key.leftArrow) {
        setView("list");
        setDetailName(null);
      }
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(teammates.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const tm = teammates[selectedIndex];
      if (tm) {
        setDetailName(tm.name);
        setView("detail");
      }
      return;
    }
    if (input === "k") {
      const tm = teammates[selectedIndex];
      if (tm) onKill?.(tm.name, tm.teamName);
      return;
    }
    if (input === "s") {
      const tm = teammates[selectedIndex];
      if (tm) onShutdown?.(tm.name, tm.teamName);
    }
  });

  if (teammates.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Teams</Text>
        <Text dimColor>No active teammates</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  const detail = detailName ? teammates.find((t) => t.name === detailName) : undefined;

  const renderList = () => (
    <Box flexDirection="column">
      {teammates.map((tm, i) => {
        const selected = i === selectedIndex;
        const activity =
          tm.status === "running"
            ? summarizeActivities(tm.progress.recentActivities) || tm.spinnerVerb
            : tm.status;
        return (
          <Text key={tm.name} color={selected ? "cyan" : undefined}>
            {selected ? "❯ " : "  "}@{tm.name} <Text dimColor>[{tm.teamName}]</Text>{" "}
            <Text color={statusColor(tm.status)}>{activity}</Text>
            <Text dimColor>
              {" "}
              · {formatElapsed(tm.startTime)} · {tm.progress.toolUseCount} tools ·{" "}
              {formatTokens(tm.progress.tokenCount)} tokens
            </Text>
          </Text>
        );
      })}
    </Box>
  );

  const renderDetail = () =>
    detail && (
      <Box flexDirection="column">
        <Text bold>
          <Text color="cyan">@{detail.name}</Text>{" "}
          <Text dimColor>[{detail.teamName}]</Text>
        </Text>
        <Text>
          status: <Text color={statusColor(detail.status)}>{detail.status}</Text>
        </Text>
        <Text dimColor>elapsed: {formatElapsed(detail.startTime)}</Text>
        <Text dimColor>tools used: {detail.progress.toolUseCount}</Text>
        <Text dimColor>tokens: {formatTokens(detail.progress.tokenCount)}</Text>
        {detail.lastMessage && <Text dimColor>last message: {detail.lastMessage}</Text>}
        {detail.progress.recentActivities.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>recent activity:</Text>
            {detail.progress.recentActivities
              .slice()
              .reverse()
              .map((a, i) => (
                <Text key={i} dimColor>
                  {"  · "}
                  {a.activityDescription}
                </Text>
              ))}
          </Box>
        )}
        <Text dimColor>Esc/← back to list</Text>
      </Box>
    );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Teams</Text>
      {view === "list" ? renderList() : renderDetail()}
      {view === "list" && (
        <Text dimColor>↑/↓ select · Enter detail · k kill · s shutdown · Esc close</Text>
      )}
    </Box>
  );
}

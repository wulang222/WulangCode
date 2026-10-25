import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Fuse from "fuse.js";
import type { PermissionMode } from "../permissions/checker.js";
import type { Command } from "../commands/commands.js";
import type { CommandUsageTracker } from "../commands/usage-tracker.js";
import { borderColors, commandIcons, symbols } from "./styles.js";

/** 权限模式徽标：名称 + 颜色（F9）。default 不显示徽标。 */
const modeDisplay: Record<PermissionMode, { name: string; color: string }> = {
  default: { name: "default", color: "gray" },
  acceptEdits: { name: "Accept Edits", color: "green" },
  plan: { name: "Plan", color: "yellow" },
  bypassPermissions: { name: "YOLO", color: "red" },
};

const modeCycle: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/** 补全菜单最多展示的候选行数（F45）。 */
const DROPDOWN_MAX_ROWS = 8;

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  history?: string[];
  commands?: Command[];
  usageTracker?: CommandUsageTracker;
  onEscape?: () => void;
  inputState?: "idle" | "focus" | "error";
  permMode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  workDir?: string;
}

/** 多行输入。Enter 提交，Shift+Enter / Ctrl+J 换行，↑↓ 在顶底回放历史；`/` 开头弹命令补全菜单。 */
export function InputBox({
  onSubmit,
  disabled = false,
  history = [],
  commands = [],
  usageTracker,
  onEscape,
  inputState = "focus",
  permMode,
  onModeChange,
  workDir,
}: InputBoxProps) {
  const [lines, setLines] = useState<string[]>([""]);
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const linesRef = useRef(lines);
  const cursorLineRef = useRef(0);
  const cursorColRef = useRef(0);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef<string[] | null>(null);

  const writeBuffer = (next: string[], line: number, col: number) => {
    linesRef.current = next;
    cursorLineRef.current = line;
    cursorColRef.current = col;
    setLines(next);
    setCursorLine(line);
    setCursorCol(col);
  };

  const rememberHistory = (index: number | null, saved: string[] | null = draftRef.current) => {
    historyIndexRef.current = index;
    draftRef.current = saved;
    setHistoryIndex(index);
    setDraft(saved);
  };

  const submitBuffer = () => {
    const text = linesRef.current.join("\n").trim();
    if (!text) return;
    onSubmit(text);
    writeBuffer([""], 0, 0);
    rememberHistory(null, null);
    setDropdownIndex(0);
    setDropdownDismissed(false);
  };

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((value) => !value), 530);
    return () => clearInterval(timer);
  }, []);

  const isMultiline = lines.length > 1;
  const slashFirst = lines[0] ?? "";
  const slashQuery = slashFirst.startsWith("/") && !isMultiline ? slashFirst.slice(1) : null;

  /** 候选计算（F42-F44）：空 query 走最近使用排序；非空走 5 层 Tier 合并去重。 */
  const { filteredCmds, recentCount } = useMemo(() => {
    if (slashQuery === null) return { filteredCmds: [] as Command[], recentCount: 0 };
    const query = slashQuery.toLowerCase();
    if (query === "") {
      if (usageTracker) {
        const recentNames = new Set(usageTracker.getRecentlyUsed(5));
        const recent = commands.filter((cmd) => recentNames.has(cmd.name));
        const rest = commands.filter((cmd) => !recentNames.has(cmd.name));
        return { filteredCmds: [...recent, ...rest], recentCount: recent.length };
      }
      return { filteredCmds: commands, recentCount: 0 };
    }
    if (query.includes(" ")) return { filteredCmds: [] as Command[], recentCount: 0 };
    const seen = new Set<string>();
    const merged: Command[] = [];
    const push = (cmd: Command) => {
      if (seen.has(cmd.name)) return;
      seen.add(cmd.name);
      merged.push(cmd);
    };
    // Tier 1 精确主名 → Tier 2 精确别名 → Tier 3 主名前缀 → Tier 4 别名前缀 → Tier 5 Fuse 模糊兜底。
    for (const cmd of commands) if (cmd.name.toLowerCase() === query) push(cmd);
    for (const cmd of commands) if (cmd.aliases.some((alias) => alias.toLowerCase() === query)) push(cmd);
    for (const cmd of commands) if (cmd.name.toLowerCase().startsWith(query)) push(cmd);
    for (const cmd of commands)
      if (cmd.aliases.some((alias) => alias.toLowerCase().startsWith(query))) push(cmd);
    const fuse = new Fuse(commands, {
      keys: [
        { name: "name", weight: 3 },
        { name: "aliases", weight: 2 },
        { name: "description", weight: 0.5 },
      ],
      threshold: 0.4,
    });
    for (const hit of fuse.search(query)) push(hit.item);
    return { filteredCmds: merged, recentCount: 0 };
  }, [slashQuery, commands, usageTracker]);

  /** 菜单激活：有候选 + `/` 起头单行 + 未被 ESC 关闭（F41/F48）。 */
  const showDropdown = filteredCmds.length > 0 && slashQuery !== null && !dropdownDismissed;
  /** 零匹配提示行（F49b）：Enter 走未命中分支、Tab/ESC 仅关闭。 */
  const showZeroMatchHint =
    filteredCmds.length === 0 && slashQuery !== null && slashQuery.trim() !== "" && !dropdownDismissed;
  const activeIndex = Math.min(dropdownIndex, Math.max(filteredCmds.length - 1, 0));

  /** ghost text（F49）：仅当第一候选 name 以当前输入开头时显示剩余后缀，避免 Fuse 命中误导。 */
  const ghostText = useMemo(() => {
    if (slashQuery === null || slashQuery === "" || slashQuery.includes(" ")) return "";
    const query = slashQuery.toLowerCase();
    const first = filteredCmds[0];
    if (!first || !first.name.toLowerCase().startsWith(query)) return "";
    return first.name.slice(query.length);
  }, [slashQuery, filteredCmds]);

  /** 菜单激活时 Enter/Tab 把高亮项写回 `/<name> `，等待补参数或再按回车提交（F47）。 */
  const acceptDropdownSelection = () => {
    const selected = filteredCmds[activeIndex];
    if (!selected) return;
    const filled = `/${selected.name} `;
    writeBuffer([filled], 0, filled.length);
    setDropdownIndex(0);
  };

  const replaceFromHistory = (text: string) => {
    const next = text.split("\n");
    const safe = next.length > 0 ? next : [""];
    writeBuffer(safe, 0, 0);
  };

  const insertNewline = () => {
    const prev = linesRef.current;
    const line = cursorLineRef.current;
    const col = cursorColRef.current;
    const next = [...prev];
    const current = next[line] ?? "";
    next[line] = current.slice(0, col);
    next.splice(line + 1, 0, current.slice(col));
    writeBuffer(next, line + 1, 0);
    rememberHistory(null, null);
  };

  const insertText = (text: string) => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const shouldSubmit = text.includes("\r");
    const body = shouldSubmit ? normalized.replace(/\n$/, "") : normalized;
    if (body.length > 0) {
      const parts = body.split("\n");
      const prev = linesRef.current;
      const line = cursorLineRef.current;
      const col = cursorColRef.current;
      const next = [...prev];
      const current = next[line] ?? "";
      const before = current.slice(0, col);
      const after = current.slice(col);
      let nextLine = line;
      let nextCol = col;
      if (parts.length === 1) {
        next[line] = before + (parts[0] ?? "") + after;
        nextCol = col + (parts[0]?.length ?? 0);
      } else {
        next[line] = before + (parts[0] ?? "");
        const middle = parts.slice(1, -1);
        const last = (parts[parts.length - 1] ?? "") + after;
        next.splice(line + 1, 0, ...middle, last);
        nextLine = line + parts.length - 1;
        nextCol = (parts[parts.length - 1] ?? "").length;
      }
      writeBuffer(next, nextLine, nextCol);
      rememberHistory(null, null);
    }
    if (shouldSubmit) submitBuffer();
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        // ESC 优先关菜单并保留输入文本，同次输入内不再自动弹出（F48）；F49b 零匹配同理。
        if (showDropdown || showZeroMatchHint) {
          setDropdownDismissed(true);
          setDropdownIndex(0);
          return;
        }
        onEscape?.();
        return;
      }
      if (key.ctrl && input === "c") return;
      const newline = (key.return && (key.shift || key.ctrl)) || (key.ctrl && input === "j");
      if (newline) {
        insertNewline();
        return;
      }
      if (key.return) {
        // 菜单激活时第一次 Enter 选中命令而非提交（F47）。
        if (showDropdown) {
          acceptDropdownSelection();
          return;
        }
        submitBuffer();
        return;
      }
      if (key.upArrow) {
        // 菜单激活时 ↑↓ 只切高亮不切 cursor（F47）；候选间循环。
        if (showDropdown && filteredCmds.length > 0) {
          setDropdownIndex((i) => {
            const cur = Math.min(i, filteredCmds.length - 1);
            return cur <= 0 ? filteredCmds.length - 1 : cur - 1;
          });
          return;
        }
        const line = cursorLineRef.current;
        const col = cursorColRef.current;
        const currentLines = linesRef.current;
        if (line === 0 && col === 0 && history.length > 0) {
          const nextIndex =
            historyIndexRef.current === null ? history.length - 1 : Math.max(0, historyIndexRef.current - 1);
          const saved = historyIndexRef.current === null ? currentLines : draftRef.current;
          rememberHistory(nextIndex, saved);
          replaceFromHistory(history[nextIndex] ?? "");
          return;
        }
        if (line > 0) {
          const nextLine = line - 1;
          writeBuffer(currentLines, nextLine, Math.min(col, (currentLines[nextLine] ?? "").length));
        }
        return;
      }
      if (key.downArrow) {
        if (showDropdown && filteredCmds.length > 0) {
          setDropdownIndex((i) => {
            const cur = Math.min(i, filteredCmds.length - 1);
            return cur >= filteredCmds.length - 1 ? 0 : cur + 1;
          });
          return;
        }
        const line = cursorLineRef.current;
        const col = cursorColRef.current;
        const currentLines = linesRef.current;
        const atEnd = line >= currentLines.length - 1 && col >= (currentLines[line] ?? "").length;
        if (atEnd && historyIndexRef.current !== null) {
          if (historyIndexRef.current >= history.length - 1) {
            const restored = draftRef.current ?? [""];
            rememberHistory(null, null);
            writeBuffer(restored, restored.length - 1, (restored[restored.length - 1] ?? "").length);
          } else {
            const nextIndex = historyIndexRef.current + 1;
            rememberHistory(nextIndex, draftRef.current);
            replaceFromHistory(history[nextIndex] ?? "");
          }
          return;
        }
        if (line < currentLines.length - 1) {
          const nextLine = line + 1;
          writeBuffer(currentLines, nextLine, Math.min(col, (currentLines[nextLine] ?? "").length));
        }
        return;
      }
      if (key.leftArrow) {
        const line = cursorLineRef.current;
        const col = cursorColRef.current;
        const currentLines = linesRef.current;
        if (col > 0) writeBuffer(currentLines, line, col - 1);
        else if (line > 0) writeBuffer(currentLines, line - 1, (currentLines[line - 1] ?? "").length);
        return;
      }
      if (key.rightArrow) {
        const line = cursorLineRef.current;
        const col = cursorColRef.current;
        const currentLines = linesRef.current;
        const current = currentLines[line] ?? "";
        if (col < current.length) writeBuffer(currentLines, line, col + 1);
        else if (line < currentLines.length - 1) writeBuffer(currentLines, line + 1, 0);
        return;
      }
      if (key.backspace || key.delete) {
        const line = cursorLineRef.current;
        const col = cursorColRef.current;
        const currentLines = linesRef.current;
        if (col > 0) {
          const next = [...currentLines];
          const current = next[line] ?? "";
          next[line] = current.slice(0, col - 1) + current.slice(col);
          writeBuffer(next, line, col - 1);
        } else if (line > 0) {
          const prevLine = currentLines[line - 1] ?? "";
          const current = currentLines[line] ?? "";
          const next = [...currentLines];
          next[line - 1] = prevLine + current;
          next.splice(line, 1);
          writeBuffer(next, line - 1, prevLine.length);
        }
        rememberHistory(null, null);
        return;
      }
      // Shift+Tab 循环切权限档（App 层裸 stdin 兜底同款，双通道防抖在 App 内处理，F9）。
      if ((input === "\x1b[Z" || (key.tab && key.shift)) && onModeChange && permMode) {
        const index = modeCycle.indexOf(permMode);
        onModeChange(modeCycle[(index + 1) % modeCycle.length]!);
        return;
      }
      if (key.tab && !key.shift) {
        if (showDropdown) {
          acceptDropdownSelection();
          return;
        }
        if (showZeroMatchHint) {
          setDropdownDismissed(true);
          return;
        }
        insertText("  ");
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        insertText(input);
        // 新字符输入即重置菜单状态：高亮归零、撤销 ESC 关闭（F48"同次输入"）。
        setDropdownIndex(0);
        setDropdownDismissed(false);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) return <Text dimColor>Waiting...</Text>;

  const borderColor =
    inputState === "error" ? borderColors.error : inputState === "idle" ? borderColors.idle : borderColors.focus;
  const empty = lines.length === 1 && lines[0] === "";
  const atActive = (lines[cursorLine] ?? "").includes("@");

  /** 菜单两段渲染：有最近使用数据时 RECENTLY USED 段在前，其余进 ALL COMMANDS 段（F42）。 */
  const dropdownRows = [];
  const visibleCmds = filteredCmds.slice(0, DROPDOWN_MAX_ROWS);
  if (showDropdown) {
    if (recentCount > 0) dropdownRows.push(<Text key="hdr-recent" dimColor>RECENTLY USED</Text>);
    visibleCmds.forEach((cmd, i) => {
      if (recentCount > 0 && i === recentCount) dropdownRows.push(<Text key="hdr-all" dimColor>ALL COMMANDS</Text>);
      const selected = i === activeIndex;
      dropdownRows.push(
        <Text key={cmd.name} color={selected ? "#a78bfa" : undefined} bold={selected}>
          {commandIcons[cmd.type] ?? symbols.dot} /{cmd.name}  {cmd.description}
        </Text>,
      );
    });
  }

  return (
    <Box flexDirection="column">
      {atActive ? (
        <Text dimColor>
          @ 文件提示（本章未启用）{workDir ? ` ${symbols.dot} ${workDir}` : ""}
        </Text>
      ) : null}
      {permMode && permMode !== "default" ? (
        <Text>
          <Text color={modeDisplay[permMode].color}>{modeDisplay[permMode].name} on </Text>
          <Text dimColor>(shift+tab to cycle)</Text>
        </Text>
      ) : null}
      <Box
        borderStyle="round"
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderColor={borderColor}
        flexDirection="column"
      >
        {lines.map((line, index) => {
          const prefix = index === 0 ? `${symbols.prompt} ` : "  ";
          return (
            <Text key={`line-${index}`}>
              {prefix}
              {renderLine(line, index === cursorLine ? cursorCol : -1, cursorVisible && index === cursorLine)}
              {!isMultiline && index === 0 && ghostText ? <Text dimColor>{ghostText}</Text> : null}
              {empty && index === 0 ? <Text dimColor> 给 MewCode 发消息… Enter 发送，Ctrl+J 换行</Text> : null}
            </Text>
          );
        })}
      </Box>
      {showDropdown ? <Box flexDirection="column">{dropdownRows}</Box> : null}
      {showZeroMatchHint ? (
        <Text dimColor>No matching commands {symbols.dot} Esc 关闭 {symbols.dot} Enter 按原样提交</Text>
      ) : null}
    </Box>
  );
}

function renderLine(line: string, col: number, showCursor: boolean) {
  if (!showCursor || col < 0) return line;
  const before = line.slice(0, col);
  const ch = line[col] ?? " ";
  const after = line.slice(col + (line[col] ? 1 : 0));
  return (
    <>
      {before}
      <Text inverse>{ch}</Text>
      {after}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Fuse from "fuse.js";
import { borderColors, symbols } from "./styles.js";

export interface SlashCommand {
  name: string;
  description: string;
}

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  history?: string[];
  commands?: SlashCommand[];
  onEscape?: () => void;
  inputState?: "idle" | "focus" | "error";
  permMode?: string;
  onModeChange?: (mode: string) => void;
  workDir?: string;
}

/** 多行输入。Enter 提交，Shift+Enter / Ctrl+J 换行，↑↓ 在顶底回放历史。 */
export function InputBox({
  onSubmit,
  disabled = false,
  history = [],
  commands = [],
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
  };

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((value) => !value), 530);
    return () => clearInterval(timer);
  }, []);

  const fuse = useMemo(
    () => new Fuse(commands, { keys: ["name", "description"], threshold: 0.4 }),
    [commands],
  );
  const slashQuery = lines.length === 1 && lines[0]?.startsWith("/") ? lines[0].slice(1) : null;
  const commandHits =
    slashQuery === null ? [] : slashQuery === "" ? commands : fuse.search(slashQuery).map((hit) => hit.item);
  const atActive = (lines[cursorLine] ?? "").includes("@");

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
        submitBuffer();
        return;
      }
      if (key.upArrow) {
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
      if (key.tab) {
        const first = commandHits[0];
        if (slashQuery !== null && first) {
          const filled = `/${first.name}`;
          writeBuffer([filled], 0, filled.length);
          return;
        }
        insertText("  ");
        return;
      }
      if (key.ctrl && input === "m" && permMode && onModeChange) {
        onModeChange(permMode);
        return;
      }
      if (input && !key.ctrl && !key.meta) insertText(input);
    },
    { isActive: !disabled },
  );

  if (disabled) return <Text dimColor>Waiting...</Text>;

  const borderColor =
    inputState === "error" ? borderColors.error : inputState === "idle" ? borderColors.idle : borderColors.focus;
  const empty = lines.length === 1 && lines[0] === "";

  return (
    <Box flexDirection="column">
      {slashQuery !== null && commandHits.length > 0 ? (
        <Box flexDirection="column">
          {commandHits.slice(0, 5).map((command) => (
            <Text key={command.name} dimColor>
              /{command.name} {symbols.dot} {command.description}
            </Text>
          ))}
        </Box>
      ) : null}
      {atActive ? (
        <Text dimColor>
          @ 文件提示（本章未启用）{workDir ? ` ${symbols.dot} ${workDir}` : ""}
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
              {empty && index === 0 ? <Text dimColor> 给 MewCode 发消息… Enter 发送，Ctrl+J 换行</Text> : null}
            </Text>
          );
        })}
      </Box>
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

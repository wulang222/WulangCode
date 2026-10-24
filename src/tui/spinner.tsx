import { useEffect, useState } from "react";
import { Text } from "ink";
import InkSpinner from "ink-spinner";
import { formatTokenCount, symbols } from "./styles.js";
import { randomVerb } from "./verbs.js";

interface SpinnerProps {
  label?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 当前迭代轮次（F9）：多轮循环时展示 Agent 正在第几轮推进。 */
  iteration?: number;
}

/** 流式期间的进行中指示：动词 + 轮次 + token + 每秒加一的秒数。 */
export function Spinner({ label, inputTokens = 0, outputTokens = 0, iteration = 0 }: SpinnerProps) {
  const [elapsed, setElapsed] = useState(0);
  const [verb] = useState(() => label ?? randomVerb());

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((value) => value + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const tokenPart = hasTokens
    ? `${formatTokenCount(inputTokens)}↓ ${formatTokenCount(outputTokens)}↑ ${symbols.dot} `
    : "";

  return (
    <Text>
      <InkSpinner type="dots" /> {verb}… (第 {Math.max(1, iteration)} 轮 {symbols.dot} {tokenPart}{elapsed}s)
    </Text>
  );
}

import { Text } from "ink";

/** 状态栏活跃队员计数（G15）：`● N teammate(s)`，无队员不渲染。 */
export function TeamStatus({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Text dimColor>
      <Text color="magenta">●</Text> {count} {count === 1 ? "teammate" : "teammates"}
    </Text>
  );
}

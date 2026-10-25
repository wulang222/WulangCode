import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 上限条数：从头丢弃最旧的，输入框上下键能回溯的范围与之对齐。 */
const MAX_ENTRIES = 200;
const FILENAME = "prompt_history.jsonl";

function filePathOf(dir: string): string {
  return join(dir, FILENAME);
}

/** 读出全部历史 prompt 文本；坏行（非法 JSON / 缺 text 字段）静默跳过。 */
export function load(dir: string): string[] {
  const path = filePathOf(dir);
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text === "string") out.push(parsed.text);
    } catch {
      // 单行脏数据不拖垮整份历史
    }
  }
  return out;
}

/** 追加一条；与最后一条相同不重复写，超上限从头丢弃，最终全量覆盖落盘。 */
export function append(dir: string, text: string): void {
  if (!text.trim()) return;
  mkdirSync(dir, { recursive: true });
  const entries = load(dir);
  if (entries[entries.length - 1] === text) return;
  entries.push(text);
  while (entries.length > MAX_ENTRIES) entries.shift();
  writeFileSync(
    filePathOf(dir),
    entries.map((t) => JSON.stringify({ text: t })).join("\n") + "\n",
    "utf-8",
  );
}

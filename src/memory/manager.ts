import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { ConversationManager } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";

/** 索引行数上限与字节上限：控制注入 conversation 首条 system-reminder 的 token 占比。 */
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MEMORY_INDEX_NAME = "MEMORY.md";

export interface MemoryFile {
  path: string;
  name: string;
  description: string;
  /** user / feedback / project / reference */
  type: string;
  /** frontmatter 之后的正文 */
  content: string;
}

export interface MemoryHeader {
  filename: string;
  filePath: string;
  /** "user" / "project" */
  scope: string;
  mtimeMs: number;
  description: string;
  type: string;
}

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

export interface ParsedNote {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * frontmatter 解析：顶层 `---` YAML 块，`type` 优先顶层、回退 `metadata.type`
 * （旧版嵌套写法，F26）；字段缺失或 YAML 损坏都返回可用回退值，不抛错。
 */
export function parseFrontmatter(content: string): ParsedNote {
  if (!content.startsWith("---")) return { body: content };
  const lines = content.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end <= 0) return { body: content };
  const body = lines.slice(end + 1).join("\n");
  let meta: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(lines.slice(1, end).join("\n"));
    if (loaded && typeof loaded === "object") meta = loaded as Record<string, unknown>;
  } catch {
    return { body };
  }
  const nested = (meta.metadata && typeof meta.metadata === "object" ? meta.metadata : {}) as Record<string, unknown>;
  return {
    name: str(meta.name),
    description: str(meta.description),
    type: str(meta.type) ?? str(nested.type),
    body,
  };
}

/** 从模型回复中提取第一个平衡的 JSON 对象文本；找不到返回空串。 */
function extractJSONObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

/** 列出单个目录下的笔记头信息，按 mtime 倒序封顶 MAX_ENTRYPOINT_LINES（F34）。 */
export function scanMemoryHeaders(dir: string, scope: string): MemoryHeader[] {
  if (!existsSync(dir)) return [];
  const headers: MemoryHeader[] = [];
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".md") || filename === MEMORY_INDEX_NAME) continue;
    const filePath = join(dir, filename);
    try {
      const parsed = parseFrontmatter(readFileSync(filePath, "utf-8"));
      headers.push({
        filename,
        filePath,
        scope,
        mtimeMs: statSync(filePath).mtimeMs,
        description: parsed.description ?? "",
        type: parsed.type ?? "user",
      });
    } catch {
      // 坏文件跳过，不拖垮整目录扫描
    }
  }
  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ENTRYPOINT_LINES);
}

/** 候选清单文本：含作用域、类型、路径、修改时间、描述（F34）。 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(
      (h) =>
        `- name: ${h.filename.replace(/\.md$/, "")}\n` +
        `  scope: ${h.scope}\n` +
        `  type: ${h.type}\n` +
        `  path: ${h.filePath}\n` +
        `  modified: ${new Date(h.mtimeMs).toISOString()}\n` +
        `  description: ${h.description}`,
    )
    .join("\n");
}

/**
 * 两级记忆目录（用户全局 + 项目本地）统一管理：
 * 摘要注入（buildSystemReminder）、索引重建（rebuildIndex）、按需 selector 检索。
 */
export class MemoryManager {
  private readonly userDir: string;
  private readonly projectDir: string;
  private readonly workDirAbs: string;

  constructor(workDir: string) {
    this.workDirAbs = resolve(workDir);
    this.userDir = join(homedir(), ".mewcode", "memory");
    this.projectDir = join(this.workDirAbs, ".mewcode", "memory");
  }

  /** 扫两级目录组装 MemoryFile；无副作用，供 loadAll / rebuildIndex 共用。 */
  private collect(): MemoryFile[] {
    const files: MemoryFile[] = [];
    for (const dir of [this.userDir, this.projectDir]) {
      if (!existsSync(dir)) continue;
      for (const filename of readdirSync(dir).sort()) {
        if (!filename.endsWith(".md") || filename === MEMORY_INDEX_NAME) continue;
        const filePath = join(dir, filename);
        try {
          const parsed = parseFrontmatter(readFileSync(filePath, "utf-8"));
          files.push({
            path: filePath,
            name: parsed.name ?? filename.replace(/\.md$/, ""),
            description: parsed.description ?? "",
            type: parsed.type ?? "user",
            content: parsed.body,
          });
        } catch {
          // 单文件读取失败跳过
        }
      }
    }
    return files;
  }

  loadAll(): MemoryFile[] {
    const files = this.collect();
    this.rebuildIndex();
    return files;
  }

  getMemories(): MemoryFile[] {
    return this.loadAll();
  }

  /** 摘要级注入文本：每条笔记只暴露 name/type/description（F7/F28）。 */
  buildSystemReminder(): string {
    const memories = this.loadAll();
    if (memories.length === 0) return "";
    return `Active memories:\n${memories.map((m) => `- [${m.name}] (${m.type}): ${m.description}`).join("\n")}`;
  }

  /** 重写项目级 MEMORY.md 索引：按 name 大小写不敏感字母序，行数 + 字节双重上限（F25）。 */
  rebuildIndex(): void {
    const memories = this.collect().sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    let lines = memories.map((m) => {
      const rel = m.path.startsWith(this.workDirAbs) ? relative(this.workDirAbs, m.path) : m.path;
      return `- [${m.name}](${rel}) — ${m.description}`;
    });
    lines = lines.slice(0, MAX_ENTRYPOINT_LINES);
    let text = lines.join("\n");
    if (Buffer.byteLength(text, "utf-8") > MAX_ENTRYPOINT_BYTES) {
      text = Buffer.from(text, "utf-8").subarray(0, MAX_ENTRYPOINT_BYTES).toString("utf-8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl > 0) text = text.slice(0, lastNl);
    }
    mkdirSync(this.projectDir, { recursive: true });
    writeFileSync(join(this.projectDir, MEMORY_INDEX_NAME), `${text}\n`, "utf-8");
  }

  /** 清空两级目录里的所有 .md（含索引）。 */
  clear(): void {
    for (const dir of [this.userDir, this.projectDir]) {
      if (!existsSync(dir)) continue;
      for (const filename of readdirSync(dir)) {
        if (filename.endsWith(".md")) {
          try {
            unlinkSync(join(dir, filename));
          } catch {
            // 删除失败跳过
          }
        }
      }
    }
  }

  /**
   * 按需 selector 检索（F34）：候选清单 + 查询交给模型挑最多 5 条；
   * 已注入过的（alreadySurfaced 按 name）过滤掉；任何失败统一返回空结果。
   */
  async findRelevantMemories(
    query: string,
    client: LLMClient,
    recentTools: string[] = [],
    alreadySurfaced: Set<string> = new Set(),
  ): Promise<RelevantMemory[]> {
    try {
      const headers = [
        ...scanMemoryHeaders(this.userDir, "user"),
        ...scanMemoryHeaders(this.projectDir, "project"),
      ].filter((h) => !alreadySurfaced.has(h.filename.replace(/\.md$/, "")));
      if (headers.length === 0) return [];
      const selector = [
        "You are a memory selector. From the candidate memories below, pick the ones relevant to the query.",
        "Respond with ONLY a JSON object: {\"selected_memories\": [\"<name>\", ...]}, at most 5 names.",
        "If none are relevant, respond with {\"selected_memories\": []}.",
      ].join("\n");
      const toolsLine = recentTools.length > 0 ? `Recently used tools: ${recentTools.join(", ")}\n\n` : "";
      const conv = new ConversationManager();
      conv.addUserMessage(`${selector}\n\n${toolsLine}Query: ${query}\n\nCandidate memories:\n${formatMemoryManifest(headers)}`);
      let response = "";
      for await (const ev of client.stream(conv, [])) {
        if (ev.type === "text_delta") response += ev.text;
      }
      const jsonText = extractJSONObject(response);
      if (!jsonText) return [];
      const parsed = JSON.parse(jsonText) as { selected_memories?: unknown };
      if (!Array.isArray(parsed.selected_memories)) return [];
      const names = new Set(parsed.selected_memories.slice(0, 5).map((n) => String(n)));
      return headers
        .filter((h) => names.has(h.filename.replace(/\.md$/, "")))
        .map((h) => ({ path: h.filePath, mtimeMs: h.mtimeMs }));
    } catch {
      return [];
    }
  }
}

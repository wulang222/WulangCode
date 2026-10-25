import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ConversationManager } from "../conversation/conversation.js";
import type { LLMClient } from "../llm/client.js";
import { MemoryManager } from "./manager.js";

/** 提取指令模板：要求模型按 MEMORY_* 字段块输出，块间 --- 分隔，无内容回 NONE（F31）。 */
const EXTRACT_PROMPT = [
  "You are a memory extraction engine. Analyze the conversation summary below and extract durable facts worth remembering across sessions.",
  "",
  "For EACH memory, output a block in exactly this format:",
  "MEMORY_NAME: <kebab-case-file-name-without-extension>",
  "MEMORY_TYPE: <user | feedback | project | reference>",
  "MEMORY_DESC: <one-line summary in the user's language>",
  "MEMORY_BODY: <the fact, rule, or reference, in the user's language>",
  "",
  "Separate blocks with a line containing only ---.",
  "Type guidance:",
  "- user: who the user is, stable preferences (language, style, expertise)",
  "- feedback: corrections or confirmed approaches the user gave on how you should work",
  "- project: ongoing work, goals, or constraints tied to this codebase",
  "- reference: pointers to external resources (URLs, dashboards, tickets)",
  "",
  "If nothing is worth remembering, output exactly: NONE",
  "",
  "Conversation summary:",
].join("\n");

/** 从一个 MEMORY 块中取字段值；MEMORY_BODY 取标记行之后的全部内容，其余取同行值。 */
function extractField(block: string, key: string): string {
  const marker = `${key}:`;
  const idx = block.indexOf(marker);
  if (idx === -1) return "";
  const rest = block.slice(idx + marker.length);
  const lineEnd = rest.indexOf("\n");
  if (key === "MEMORY_BODY") return rest.trim();
  return (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trim();
}

/**
 * 后台记忆提取（第 3 层）：Agent loop 自然结束后异步运行一次 LLM 提取。
 * inProgress 互斥 + pendingContext 暂存：抖动期间的多次请求合并为
 * "当前一次 + 一次尾部运行"，不会无限堆积（F30/N2）。
 */
export class MemoryExtractor {
  private inProgress = false;
  private pendingContext: string | null = null;

  constructor(
    private readonly client: LLMClient,
    private readonly workDir: string,
  ) {}

  /** 提取入口：返回新写入的笔记名数组；有任务在跑时暂存最新上下文并立即返回空。 */
  async extract(conversationSummary: string): Promise<string[]> {
    if (this.inProgress) {
      this.pendingContext = conversationSummary;
      return [];
    }
    return this.runExtraction(conversationSummary);
  }

  private async runExtraction(conversationSummary: string): Promise<string[]> {
    this.inProgress = true;
    let result: string[] = [];
    try {
      result = await this.doExtract(conversationSummary);
    } finally {
      this.inProgress = false;
      const pending = this.pendingContext;
      this.pendingContext = null;
      if (pending !== null) {
        const trailing = await this.runExtraction(pending);
        result = [...result, ...trailing];
      }
    }
    return result;
  }

  /**
   * 实际提取：纯文本进出（tools 传空数组），解析 MEMORY_* 块并按类型双路落盘
   * （project/reference → 项目目录，其余 → 用户全局，F24/F32）。
   * 任何失败静默返回空/部分结果，不影响主会话（F33）。
   */
  private async doExtract(conversationSummary: string): Promise<string[]> {
    let response = "";
    try {
      const conv = new ConversationManager();
      conv.addUserMessage(`${EXTRACT_PROMPT}\n${conversationSummary}`);
      for await (const ev of this.client.stream(conv, [])) {
        if (ev.type === "text_delta") response += ev.text;
      }
    } catch {
      return [];
    }
    if (response.trim() === "NONE" || !response.includes("MEMORY_NAME:")) return [];

    const saved: string[] = [];
    for (const block of response.split("---")) {
      if (!block.includes("MEMORY_NAME:")) continue;
      const name = extractField(block, "MEMORY_NAME").replace(/[\\/\0]/g, "-");
      const type = extractField(block, "MEMORY_TYPE");
      const description = extractField(block, "MEMORY_DESC");
      const body = extractField(block, "MEMORY_BODY");
      if (!name || !body) continue;
      const dir =
        type === "project" || type === "reference"
          ? join(resolve(this.workDir), ".mewcode", "memory")
          : join(homedir(), ".mewcode", "memory");
      try {
        mkdirSync(dir, { recursive: true });
        const frontmatter = [`---`, `name: ${name}`, `description: ${description}`, `type: ${type || "user"}`, `---`, "", ""].join("\n");
        writeFileSync(join(dir, `${name}.md`), `${frontmatter}${body}\n`, "utf-8");
        saved.push(name);
      } catch {
        // 单条写入失败跳过，不影响其他块
      }
    }

    if (saved.length > 0) {
      try {
        new MemoryManager(this.workDir).rebuildIndex();
      } catch {
        // 索引重建失败不影响提取结果
      }
    }
    return saved;
  }
}

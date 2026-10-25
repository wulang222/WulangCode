/** 恢复段文件快照数量上限（F16/F36）。 */
const RECOVERY_FILE_LIMIT = 5;
/** 单文件快照 token 上限（F16/F36）。 */
const RECOVERY_TOKENS_PER_FILE = 5_000;
/** 技能段总 token 预算（F36）。 */
const RECOVERY_SKILLS_BUDGET = 25_000;
/** 单个技能正文 token 上限。 */
const RECOVERY_TOKENS_PER_SKILL = 5_000;
/** 字符 → token 估算比（F36）。 */
const RECOVERY_CHARS_PER_TOKEN = 3.5;

/** 最近读过的文件记录（F19：content 为磁盘纯净字节）。 */
export interface FileReadRecord {
  path: string;
  content: string;
  timestamp: number;
}

/** 已激活技能记录（name → SOP 正文）。 */
export interface SkillInvocationRecord {
  name: string;
  body: string;
  timestamp: number;
}

function approxTokens(s: string): number {
  return s ? Math.floor(s.length / RECOVERY_CHARS_PER_TOKEN) : 0;
}

/** 超预算时保留头部 tokenBudget*3.5 字符，尾部追加截断标注。 */
function truncateByTokens(s: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || !s) return s;
  if (approxTokens(s) <= tokenBudget) return s;
  const maxChars = Math.floor(tokenBudget * RECOVERY_CHARS_PER_TOKEN);
  if (maxChars <= 0 || maxChars >= s.length) return s;
  return `${s.slice(0, maxChars)}\n… (content truncated)`;
}

/**
 * 压缩后恢复段的数据源（F15）：维护最近文件与已激活技能两本账。
 * 单线程模型（JS 事件循环串行），不加锁（F20）。
 */
export class RecoveryState {
  private readonly files = new Map<string, FileReadRecord>();
  private readonly skills = new Map<string, SkillInvocationRecord>();

  /** 同名文件后写覆盖前写（时间戳刷新）。 */
  recordFileRead(path: string, content: string): void {
    this.files.set(path, { path, content, timestamp: Date.now() });
  }

  recordSkillInvocation(name: string, body: string): void {
    this.skills.set(name, { name, body, timestamp: Date.now() });
  }

  /** 最近 limit 个文件快照，按读取时间倒序。 */
  snapshotFiles(limit = RECOVERY_FILE_LIMIT): FileReadRecord[] {
    return [...this.files.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /** 全量技能快照（倒序），预算裁剪交给 buildRecoveryAttachment。 */
  snapshotSkills(): SkillInvocationRecord[] {
    return [...this.skills.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 拼装恢复段（F15/F18）：最近文件 / 激活技能 / 可用工具三块按可用性出现，
   * 只要有任意内容就追加固定的 ## Note 边界提示；三块全空返回空字符串。
   */
  buildRecoveryAttachment(toolSchemaNames: string[]): string {
    const sections: string[] = [];

    const recentFiles = this.snapshotFiles();
    if (recentFiles.length > 0) {
      const parts: string[] = [
        "## Recently read files",
        "",
        "These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.",
      ];
      for (const f of recentFiles) {
        const content = truncateByTokens(f.content, RECOVERY_TOKENS_PER_FILE);
        const ts = new Date(f.timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
        parts.push(`### ${f.path}  (read ${ts})`, "", "```", content + (content.endsWith("\n") ? "" : "\n"), "```");
      }
      sections.push(parts.join("\n"));
    }

    const skills = this.snapshotSkills();
    if (skills.length > 0) {
      const skillParts: string[] = ["## Active skills", ""];
      let used = 0;
      for (const sk of skills) {
        const body = truncateByTokens(sk.body, RECOVERY_TOKENS_PER_SKILL);
        const tokens = approxTokens(body) + approxTokens(sk.name) + 8;
        if (used + tokens > RECOVERY_SKILLS_BUDGET) break;
        used += tokens;
        skillParts.push(`### ${sk.name}`, "", body);
      }
      // 头部已 push；只有确实输出过至少一个技能才成段
      if (skillParts.length > 2) sections.push(skillParts.join("\n"));
    }

    if (toolSchemaNames.length > 0) {
      sections.push(
        "## Available tools",
        "",
        "You still have access to the following tools — call them directly when the task needs one:",
        "",
        toolSchemaNames.map((n) => `- ${n}`).join("\n"),
      );
    }

    if (sections.length === 0) return "";
    sections.push(
      "## Note",
      "",
      "Everything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.",
    );
    return sections.join("\n\n");
  }
}

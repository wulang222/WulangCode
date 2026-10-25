/**
 * 命令使用追踪（day9 T5 / F50-F53）：把「命令名 → 次数 + 最后使用时间」
 * 持久化到 <workDir>/.mewcode/command_usage.json；评分按 7 天半衰、地板 0.1。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

interface UsageEntry {
  usageCount: number;
  lastUsedAt: number;
}

export class CommandUsageTracker {
  private usage = new Map<string, UsageEntry>();
  private readonly filePath: string;

  constructor(workDir: string) {
    this.filePath = join(workDir, ".mewcode", "command_usage.json");
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {
      // 目录创建失败也不阻塞：后续 save 再尝试
    }
    this.load();
  }

  record(name: string): void {
    const existing = this.usage.get(name);
    this.usage.set(name, { usageCount: (existing?.usageCount ?? 0) + 1, lastUsedAt: Date.now() });
    this.save();
  }

  /** count × max(0.5^(daysSince/7), 0.1)：一周前用过一次得 0.5 分，地板 10%。 */
  getScore(name: string): number {
    const entry = this.usage.get(name);
    if (!entry) return 0;
    const daysSince = (Date.now() - entry.lastUsedAt) / 86_400_000;
    const recency = Math.pow(0.5, daysSince / 7);
    return entry.usageCount * Math.max(recency, 0.1);
  }

  /** 得分大于零的条目按分数降序截断（F53）。 */
  getRecentlyUsed(limit = 5): string[] {
    return [...this.usage.keys()]
      .map((name) => ({ name, score: this.getScore(name) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.name);
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<string, UsageEntry>;
      for (const [name, entry] of Object.entries(raw)) this.usage.set(name, entry);
    } catch {
      // 文件不存在或损坏：空 Map 起步
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.usage), null, 2), "utf-8");
    } catch {
      // 写盘失败静默吞掉，不阻塞主线程（N8）
    }
  }
}

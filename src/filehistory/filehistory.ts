import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** 快照滑动窗口上限：超限丢弃最旧的（与 Claude Code 检查点行为一致）。 */
const MAX_SNAPSHOTS = 100;

/** 单个文件在某个版本时刻的备份。 */
export interface Backup {
  backupPath: string;
  version: number;
  time: string;
}

/** 一次用户输入对应的全量检查点：messageIndex 锚定会话截断位置。 */
export interface Snapshot {
  messageIndex: number;
  userText: string;
  backups: Record<string, Backup>;
  timestamp: string;
}

/** 备份文件名：路径哈希前 16 位 + 版本号，避免同名冲突与路径注入。 */
function backupName(filePath: string, version: number): string {
  return `${createHash("sha256").update(filePath).digest("hex").slice(0, 16)}@v${version}`;
}

/**
 * 文件级快照与回滚（/rewind 后端）：trackEdit 在改动前留底，
 * makeSnapshot 把当前 tracked 文件封装成检查点，rewind 按备份还原。
 * 备份缺失的含义是"快照时刻文件还不存在"，回滚时删除当前文件。
 */
export class FileHistory {
  private readonly sessionDir: string;
  private readonly trackedFiles = new Map<string, number>();
  private snapshots: Snapshot[] = [];

  constructor(baseDir: string, sessionID: string) {
    this.sessionDir = join(baseDir, ".mewcode", "file-history", sessionID);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /** 改动前调用：版本 +1，文件存在则把当前内容留底为该版本。 */
  trackEdit(path: string): void {
    const version = (this.trackedFiles.get(path) ?? 0) + 1;
    if (existsSync(path)) {
      writeFileSync(join(this.sessionDir, backupName(path, version)), readFileSync(path));
    }
    this.trackedFiles.set(path, version);
  }

  /**
   * 打一个检查点。缺备份但当前文件存在的（trackEdit 时文件尚未创建），
   * 此刻补写一次，保证快照内 backups 完整反映"快照时刻文件是否存在"。
   */
  makeSnapshot(msgIndex: number, userText: string): void {
    const label = userText.length > 60 ? `${userText.slice(0, 60)}…` : userText;
    const backups: Record<string, Backup> = {};
    for (const [path, version] of this.trackedFiles) {
      const backupPath = join(this.sessionDir, backupName(path, version));
      if (!existsSync(backupPath) && existsSync(path)) {
        writeFileSync(backupPath, readFileSync(path));
      }
      if (existsSync(backupPath)) {
        backups[path] = { backupPath, version, time: new Date().toISOString() };
      }
    }
    this.snapshots.push({ messageIndex: msgIndex, userText: label, backups, timestamp: new Date().toISOString() });
    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.save();
  }

  /**
   * 回滚到指定检查点：备份在则比对还原，备份缺则删除当前文件。
   * 回滚后丢弃该检查点之后的记录，并把 trackedFiles 版本回填到快照状态。
   * 返回被改动的文件路径。
   */
  rewind(snapshotIndex: number): string[] {
    const snapshot = this.snapshots[snapshotIndex];
    if (!snapshot) return [];
    const changed: string[] = [];
    for (const [path, backup] of Object.entries(snapshot.backups)) {
      if (!existsSync(backup.backupPath)) {
        if (existsSync(path)) {
          unlinkSync(path);
          changed.push(path);
        }
        continue;
      }
      const content = readFileSync(backup.backupPath);
      if (!existsSync(path) || !readFileSync(path).equals(content)) {
        writeFileSync(path, content);
        changed.push(path);
      }
    }
    this.snapshots = this.snapshots.slice(0, snapshotIndex + 1);
    const restored = new Map<string, number>();
    for (const [path, backup] of Object.entries(snapshot.backups)) restored.set(path, backup.version);
    this.trackedFiles.clear();
    for (const [path, version] of restored) this.trackedFiles.set(path, version);
    this.save();
    return changed;
  }

  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }

  /** 检查点清单落盘（best-effort）：进程内已够 /rewind 用，清单仅供外部排查。 */
  save(): void {
    try {
      writeFileSync(
        join(this.sessionDir, "snapshots.json"),
        JSON.stringify({ snapshots: this.snapshots, trackedFiles: [...this.trackedFiles] }),
        "utf-8",
      );
    } catch {
      // 清单写失败不影响快照主流程
    }
  }
}

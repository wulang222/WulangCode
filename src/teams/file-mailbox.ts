import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** 锁参数常量（F29）：最多重试 10 次、10 秒陈旧阈值、5-100ms 随机抖动。 */
const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 100;

/**
 * 同步休眠：Atomics.wait 阻塞当前事件循环而不让出（N4）。
 * 若改用 setTimeout 会把控制权交回事件循环，协作式调度下多个
 * acquireLock 可能同时进入 stat 检测阶段造成竞态，因此必须同步等待。
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 获取文件锁（F30）：以「独占创建」原语 openSync(..., "wx") 抢占。
 * 锁已存在时检查 mtime，超过陈旧阈值视为死锁强制删除后抢占；
 * 其他错误直接抛；每次失败后同步随机休眠 5-100ms 再重试，共 10 次。
 */
function acquireLock(lockFile: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      closeSync(fd);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const info = statSync(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockFile);
          } catch {
            // 抢占删除失败：继续走重试
          }
        }
      } catch {
        // stat 失败（锁刚好被释放）：直接进入重试
      }
    }
    const jitter =
      LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1));
    sleepSync(jitter);
  }
  throw lastErr instanceof Error ? lastErr : new Error(`acquireLock failed: ${lockFile}`);
}

/** 释放锁：删除锁文件；不存在（已被抢占）时静默。 */
function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // 已不存在视为已释放
  }
}

/** 锁内执行（F31）：try/finally 保证回调无论成败都释放锁。 */
export function withLock<T>(filePath: string, fn: () => T): T {
  const lockFile = filePath + ".lock";
  acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

/** 信箱消息（F21）：发件人 + 文本 + ISO 时间戳。 */
export interface FileMailMessage {
  from: string;
  text: string;
  timestamp: string;
}

/**
 * 基于文件的信箱（F22-F28）：
 * - `<dir>/<member>.jsonl` 追加式消息日志，每行一条 JSON
 * - `<dir>/<member>.read` 已读游标（行数），跨进程 / 重启不重读
 * - `<dir>/<member>.jsonl.lock` 互斥锁，配合 withLock 保证并发安全
 */
export class FileMailbox {
  private filePath: string;
  private readStatePath: string;
  private lastReadLines: number;

  constructor(dir: string, memberName: string) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, memberName + ".jsonl");
    this.readStatePath = join(dir, memberName + ".read");
    this.lastReadLines = this.loadReadState();
    // AC2：构造即落地空消息文件与初始游标文件，Lead 信箱可被外部直接观察
    if (!existsSync(this.filePath)) {
      try {
        writeFileSync(this.filePath, "", "utf-8");
      } catch {
        // 落地失败不影响后续 send（send 会以追加模式创建）
      }
    }
    if (!existsSync(this.readStatePath)) {
      try {
        writeFileSync(this.readStatePath, String(this.lastReadLines), "utf-8");
      } catch {
        // 游标文件写失败由 saveReadState 兜底
      }
    }
  }

  /** 游标文件不存在或解析失败时返回 0（F23）。 */
  private loadReadState(): number {
    try {
      return parseInt(readFileSync(this.readStatePath, "utf-8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private saveReadState(): void {
    try {
      writeFileSync(this.readStatePath, String(this.lastReadLines), "utf-8");
    } catch {
      // 游标写失败静默：下次读取会重复消费，但不致命
    }
  }

  /** 整个消息文件按行分割；空文件返回空数组。 */
  private allLines(): string[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean);
  }

  /** 发送（F24）：锁内追加一行 JSON。 */
  async send(from: string, text: string): Promise<void> {
    const msg: FileMailMessage = { from, text, timestamp: new Date().toISOString() };
    withLock(this.filePath, () => {
      writeFileSync(this.filePath, JSON.stringify(msg) + "\n", { flag: "a", encoding: "utf-8" });
    });
  }

  /**
   * 同步接收（F25）：锁内切出上次已读之后的新行、推进并持久化游标；
   * malformed 行静默跳过。返回本次消费到的新消息。
   */
  receiveSync(): FileMailMessage[] {
    return withLock(this.filePath, () => {
      const lines = this.allLines();
      const newLines = lines.slice(this.lastReadLines);
      this.lastReadLines = lines.length;
      this.saveReadState();
      const out: FileMailMessage[] = [];
      for (const line of newLines) {
        try {
          out.push(JSON.parse(line) as FileMailMessage);
        } catch {
          // 跳过坏行
        }
      }
      return out;
    });
  }

  /** 异步接收 = 同步接收的异步包装（F26）。 */
  async receive(): Promise<FileMailMessage[]> {
    return this.receiveSync();
  }

  /** 未读计数（不消费游标，F27 上）。 */
  unreadCount(): number {
    return Math.max(0, this.allLines().length - this.lastReadLines);
  }

  /** 全部标记已读（F27 下）：锁内推进游标到末尾，不返回消息。 */
  markAllRead(): void {
    withLock(this.filePath, () => {
      this.lastReadLines = this.allLines().length;
      this.saveReadState();
    });
  }

  /** 轮询（F28）：循环异步接收 + 逐条产出 + 间隔休眠。 */
  async *poll(intervalMs = 1000): AsyncGenerator<FileMailMessage> {
    while (true) {
      const msgs = await this.receive();
      for (const m of msgs) yield m;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

import { resolve } from "node:path";

/**
 * 「编辑前必先读」的读档记录（F5）：ReadFile 成功后登记路径，
 * EditFile 未读到档时直接失败；WriteFile 覆盖后内容已知，视作已读。
 * 相对路径按工作目录归一，避免同一文件因写法不同被判未读。
 */
export class ReadTracker {
  private readonly read = new Set<string>();

  private key(filePath: string, workDir: string): string {
    return resolve(workDir || process.cwd(), filePath);
  }

  markRead(filePath: string, workDir: string): void {
    this.read.add(this.key(filePath, workDir));
  }

  hasRead(filePath: string, workDir: string): boolean {
    return this.read.has(this.key(filePath, workDir));
  }

  /** 测试隔离用。 */
  clear(): void {
    this.read.clear();
  }
}

/** 全局共享实例：工具默认构造时自动接线，测试可注入独立实例。 */
export const sharedReadTracker = new ReadTracker();

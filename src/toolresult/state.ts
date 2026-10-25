/**
 * 替换决策账本（F5）：会话级冻结同一 toolUseId 的落盘决策。
 * - seenIds：已完成决策（保留或替换）的 id 集合；
 * - replacements：仅 original !== replaced 时记录的预览替换字符串。
 * 一旦写入，本会话内不再翻转，保证每轮回放字符串逐字节一致（G2/F5d）。
 */
export class ContentReplacementState {
  private readonly seenIds = new Set<string>();
  private readonly replacements = new Map<string, string>();

  /** 记录一次决策；original === replaced（保留原文）时只进 seenIds。 */
  record(toolUseId: string, original: string, replaced: string): void {
    this.seenIds.add(toolUseId);
    if (original !== replaced) this.replacements.set(toolUseId, replaced);
  }

  has(toolUseId: string): boolean {
    return this.seenIds.has(toolUseId);
  }

  /** 已决策为替换的 id 返回冻结的预览字符串；未决策或保留原文返回 undefined。 */
  getReplacement(toolUseId: string): string | undefined {
    return this.replacements.get(toolUseId);
  }

  clone(): ContentReplacementState {
    const copy = new ContentReplacementState();
    for (const id of this.seenIds) copy.seenIds.add(id);
    for (const [id, replacement] of this.replacements) copy.replacements.set(id, replacement);
    return copy;
  }

  size(): number {
    return this.seenIds.size;
  }
}

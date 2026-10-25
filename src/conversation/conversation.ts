export interface ToolUseBlock {
  toolUseId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}

/**
 * 进程内对话历史。退出即丢，不落盘。
 * 持久 history 只存真实对话；补充提醒（system-reminder）走待发队列，
 * 构造请求时以 user 角色追加到尾部、发完即弃，不污染历史与缓存前缀。
 */
export class ConversationManager {
  private history: Message[] = [];
  private pendingReminders: string[] = [];
  private ltmInjected = false;

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.history.push({ role: "assistant", content });
  }

  addAssistantFull(content: string, thinkingBlocks?: ThinkingBlock[], toolUses?: ToolUseBlock[]): void {
    const message: Message = { role: "assistant", content };
    if (thinkingBlocks && thinkingBlocks.length > 0) message.thinkingBlocks = thinkingBlocks;
    if (toolUses && toolUses.length > 0) message.toolUses = toolUses;
    this.history.push(message);
  }

  addToolUseMessage(tool: ToolUseBlock): void {
    this.history.push({ role: "assistant", content: "", toolUses: [tool] });
  }

  addAssistantMessageWithTools(content: string, toolUses: ToolUseBlock[]): void {
    this.history.push({ role: "assistant", content, toolUses });
  }

  addToolResultMessage(result: ToolResultBlock): void {
    this.history.push({ role: "user", content: result.content, toolResults: [result] });
  }

  addToolResultsMessage(results: ToolResultBlock[]): void {
    this.history.push({ role: "user", content: "", toolResults: results });
  }

  /**
   * 补充提醒（计划态 / Skill / 通知等）：只进待发队列，不写入持久历史。
   * 构造请求时经 getRequestMessages() 以 user 角色追加到历史尾部，
   * 外层加 <system-reminder> 标签与普通输入区分；发送后由 clearReminders() 清空。
   */
  addSystemReminder(content: string): void {
    if (!content.trim()) return;
    this.pendingReminders.push(content);
  }

  /** 请求视图：持久历史 + 待发提醒（合并为一条 user 消息，role 交替交给协议层合并）。 */
  getRequestMessages(): Message[] {
    if (this.pendingReminders.length === 0) return [...this.history];
    return [
      ...this.history,
      { role: "user", content: `<system-reminder>\n${this.pendingReminders.join("\n\n")}\n</system-reminder>` },
    ];
  }

  /** 本轮请求发出后清空待发提醒；下一轮由调用方按轮次重新注入。 */
  clearReminders(): void {
    this.pendingReminders = [];
  }

  /**
   * 长期记忆一次性注入（F8/F27）：项目指令（# mewcodeMd）+ 记忆摘要（# autoMemory）
   * + 当日日期（# currentDate）三段非空拼装，外包 <system-reminder> 写到首条 user 消息；
   * ltmInjected 守门保证每个实例最多注入一次（F37），恢复会话新建实例自然重注。
   */
  injectLongTermMemory(instructions: string, memories: string): void {
    if (this.ltmInjected) return;
    const sections: string[] = [];
    if (instructions.trim()) sections.push(`# mewcodeMd\n\n${instructions.trim()}`);
    if (memories.trim()) sections.push(`# autoMemory\n\n${memories.trim()}`);
    const today = new Date().toISOString().split("T")[0] ?? "";
    if (today) sections.push(`# currentDate\n\n${today}`);
    if (sections.length === 0) return;
    const wrapped =
      `<system-reminder>\n` +
      `As you answer the user's questions, you can use the following context:\n\n` +
      `${sections.join("\n\n")}\n\n` +
      `IMPORTANT: this context may or may not be relevant to your tasks. Do not respond to this context unless highly relevant to your task.\n` +
      `</system-reminder>`;
    this.history.unshift({ role: "user", content: wrapped });
    this.ltmInjected = true;
  }

  /** 原样回放一条消息（system 等无法用语义方法表达的历史项走这里）。 */
  addRawMessage(message: Message): void {
    this.history.push({ ...message });
  }

  /**
   * 压缩后整体替换（第 2 层）：摘要 user 消息 + verbatim 尾部。
   * keep 切片由调用方保证一致性，不做额外深拷贝；verbatim 尾部首条
   * 大多数情况下是 assistant，provider 对开头的 user/user 相邻已放宽。
   */
  replaceWithCompacted(summaryContent: string, keep: Message[]): void {
    this.history = [{ role: "user", content: summaryContent }, ...keep];
  }

  getMessages(): Message[] {
    return [...this.history];
  }

  len(): number {
    return this.history.length;
  }

  /** 保留 [0, index) 的消息。 */
  truncateTo(index: number): void {
    const end = index < 0 ? 0 : index;
    this.history = this.history.slice(0, end);
  }
}

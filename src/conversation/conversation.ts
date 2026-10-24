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

  /** 长期记忆只注入一次。本章不调用。 */
  injectLongTermMemory(content: string): void {
    if (this.ltmInjected || !content.trim()) return;
    this.history.unshift({ role: "system", content });
    this.ltmInjected = true;
  }

  replaceWithCompacted(messages: Message[]): void {
    this.history = messages.map((message) => ({ ...message }));
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

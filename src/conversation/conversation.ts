export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
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
 * 本章界面只走 user / assistant 纯文本；其余方法留给后续章节。
 */
export class ConversationManager {
  private history: Message[] = [];
  private ltmInjected = false;

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.history.push({ role: "assistant", content });
  }

  addAssistantFull(content: string, thinkingBlocks?: ThinkingBlock[], toolUses?: ToolUseBlock[]): void {
    this.history.push({ role: "assistant", content, thinkingBlocks, toolUses });
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
    this.history.push({
      role: "user",
      content: results.map((result) => result.content).join("\n"),
      toolResults: results,
    });
  }

  addSystemReminder(content: string): void {
    this.history.push({ role: "system", content });
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

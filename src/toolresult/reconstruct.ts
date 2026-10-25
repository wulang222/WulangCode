import { ConversationManager, type Message } from "../conversation/conversation.js";

/**
 * 把 Message[] 重新包成 ConversationManager（供 client.stream 第一参数使用）。
 * 消息逐条原样回放：assistant 走 addAssistantFull 保留 thinking / toolUses，
 * 工具结果消息走 addToolResultsMessage，其余按角色回填（system 原样保留，
 * 与 provider 侧"history 中的 system 不进 messages"的既有行为一致）。
 */
export function buildManager(messages: Message[]): ConversationManager {
  const conv = new ConversationManager();
  for (const message of messages) {
    if (message.role === "assistant") {
      conv.addAssistantFull(message.content, message.thinkingBlocks, message.toolUses);
      continue;
    }
    if (message.role === "user" && message.toolResults && message.toolResults.length > 0) {
      conv.addToolResultsMessage(message.toolResults);
      continue;
    }
    conv.addRawMessage(message);
  }
  return conv;
}

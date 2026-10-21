import { expect, test } from "bun:test";
import { ConversationManager } from "../src/conversation/conversation.ts";

test("user 与 assistant 按追加顺序保存", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("你好");
  conv.addAssistantMessage("你好，我是 MewCode");
  conv.addUserMessage("刚才那句再说一遍");
  const messages = conv.getMessages();
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[1]?.content).toBe("你好，我是 MewCode");
  expect(conv.len()).toBe(3);
});

test("getMessages 返回副本，改副本不影响内部历史", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("一");
  const copy = conv.getMessages();
  copy.push({ role: "assistant", content: "不该写进去" });
  expect(conv.len()).toBe(1);
  expect(conv.getMessages()[0]?.content).toBe("一");
});

test("truncateTo 截断到指定下标", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("a");
  conv.addAssistantMessage("b");
  conv.addUserMessage("c");
  conv.truncateTo(1);
  expect(conv.len()).toBe(1);
  expect(conv.getMessages()[0]?.content).toBe("a");
  conv.truncateTo(0);
  expect(conv.len()).toBe(0);
});

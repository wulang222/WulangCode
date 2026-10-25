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

test("addAssistantFull 写入含 toolUses 的 assistant 回合", () => {
  const conv = new ConversationManager();
  conv.addAssistantFull("我看一下文件", [], [
    { toolUseId: "t1", toolName: "ReadFile", arguments: { file_path: "a.txt" } },
  ]);
  const last = conv.getMessages()[conv.len() - 1];
  expect(last?.role).toBe("assistant");
  expect(last?.content).toBe("我看一下文件");
  expect(last?.toolUses?.length).toBe(1);
  expect(last?.toolUses?.[0]?.toolName).toBe("ReadFile");
  // 空数组不挂字段
  conv.addAssistantFull("纯文本", [], []);
  const plain = conv.getMessages()[conv.len() - 1];
  expect(plain?.toolUses).toBeUndefined();
});

test("addToolResultsMessage 把一组结果写进同一条 user 消息", () => {
  const conv = new ConversationManager();
  conv.addToolResultsMessage([
    { toolUseId: "t1", content: "ok", isError: false },
    { toolUseId: "t2", content: "boom", isError: true },
  ]);
  const last = conv.getMessages()[conv.len() - 1];
  expect(last?.role).toBe("user");
  expect(last?.toolResults?.length).toBe(2);
  expect(last?.toolResults?.[1]?.toolUseId).toBe("t2");
  expect(last?.toolResults?.[1]?.isError).toBe(true);
});

test("addSystemReminder 进请求视图但不写入持久历史（AC8）", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("你好");
  conv.addSystemReminder("Plan mode is active");
  // 请求视图：末条为 user、<system-reminder> 精确包裹
  const request = conv.getRequestMessages();
  const last = request[request.length - 1];
  expect(last?.role).toBe("user");
  expect(last?.content).toBe("<system-reminder>\nPlan mode is active\n</system-reminder>");
  // 持久历史不受影响
  expect(conv.getMessages().map((message) => message.role)).toEqual(["user"]);
  expect(conv.getMessages()[0]?.content).toBe("你好");
});

test("多条提醒合并为一条请求消息，clearReminders 后回到纯历史", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("问题");
  conv.addSystemReminder("提醒一");
  conv.addSystemReminder("提醒二");
  const request = conv.getRequestMessages();
  const last = request[request.length - 1];
  expect(last?.content).toBe("<system-reminder>\n提醒一\n\n提醒二\n</system-reminder>");
  conv.clearReminders();
  expect(conv.getRequestMessages().map((message) => message.role)).toEqual(["user"]);
  expect(conv.getRequestMessages()[0]?.content).toBe("问题");
});

test("空提醒被忽略", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("问题");
  conv.addSystemReminder("");
  conv.addSystemReminder("   ");
  expect(conv.getRequestMessages().length).toBe(1);
});

// ---------- ch08：压缩后整体替换（T30/C6） ----------

test("replaceWithCompacted：摘要 user 消息 + verbatim 尾部", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("旧问题一");
  conv.addAssistantMessage("旧回答一");
  conv.addUserMessage("旧问题二");
  const keep = [
    { role: "assistant" as const, content: "近期回答" },
    { role: "user" as const, content: "近期问题" },
  ];
  conv.replaceWithCompacted("SUMMARY", keep);
  const messages = conv.getMessages();
  expect(messages.length).toBe(3);
  expect(messages[0]!.role).toBe("user");
  expect(messages[0]!.content).toBe("SUMMARY");
  expect(messages[1]!.content).toBe("近期回答");
  expect(messages[2]!.content).toBe("近期问题");
});

test("replaceWithCompacted：keep 为空数组时仅剩摘要消息", () => {
  const conv = new ConversationManager();
  conv.addUserMessage("a");
  conv.addAssistantMessage("b");
  conv.replaceWithCompacted("ONLY SUMMARY", []);
  expect(conv.len()).toBe(1);
  expect(conv.getMessages()[0]!.content).toBe("ONLY SUMMARY");
});

test("replaceWithCompacted 不复制 keep：调用方切片即最终形态", () => {
  const conv = new ConversationManager();
  const keep = [{ role: "user" as const, content: "x" }];
  conv.replaceWithCompacted("S", keep);
  keep[0]!.content = "mutated";
  expect(conv.getMessages()[1]!.content).toBe("mutated");
});

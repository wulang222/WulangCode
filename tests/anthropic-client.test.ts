import { describe, expect, test } from "bun:test";
import {
  buildAnthropicMessages,
  buildAnthropicParams,
  markLastUserTailForCache,
} from "../src/llm/anthropic.ts";
import { ConversationManager } from "../src/conversation/conversation.ts";

const toolSchemas = [
  { name: "ReadFile", description: "read", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "Bash", description: "bash", input_schema: { type: "object", properties: {}, required: [] } },
];

function fixtureMessages() {
  return buildAnthropicMessages([
    { role: "user", content: "你好" },
    { role: "assistant", content: "在" },
    { role: "user", content: "读一下 a.txt" },
  ]);
}

describe("buildAnthropicParams 三层 ephemeral 断点（AC4/F3）", () => {
  test("system 单块打 cache_control，文本原样", () => {
    const params = buildAnthropicParams({
      model: "claude-3-5",
      maxTokens: 1024,
      systemPrompt: "SYS",
      messages: fixtureMessages(),
      toolSchemas,
    });
    expect(params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  });

  test("工具列表末项打 cache_control，其余不打", () => {
    const params = buildAnthropicParams({
      model: "claude-3-5",
      maxTokens: 1024,
      systemPrompt: "SYS",
      messages: fixtureMessages(),
      toolSchemas,
    });
    const tools = params.tools as unknown as Array<Record<string, unknown>>;
    expect(tools.length).toBe(2);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("无工具时不带 tools 字段；thinkingBudget 开启思考", () => {
    const params = buildAnthropicParams({
      model: "claude-3-5",
      maxTokens: 2048,
      thinkingBudget: 1024,
      systemPrompt: "SYS",
      messages: fixtureMessages(),
      toolSchemas: [],
    });
    expect(params.tools).toBeUndefined();
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("N1 确定性：同入参两次构造序列化相等（AC5）", () => {
    const a = buildAnthropicParams({
      model: "m",
      maxTokens: 10,
      systemPrompt: "SYS",
      messages: fixtureMessages(),
      toolSchemas,
    });
    const b = buildAnthropicParams({
      model: "m",
      maxTokens: 10,
      systemPrompt: "SYS",
      messages: fixtureMessages(),
      toolSchemas,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("markLastUserTailForCache", () => {
  test("字符串 content 转单 text 块并打 ephemeral", () => {
    const messages = fixtureMessages();
    markLastUserTailForCache(messages);
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toEqual([{ type: "text", text: "读一下 a.txt", cache_control: { type: "ephemeral" } }]);
  });

  test("块数组末块为 text 时在其上打断点", () => {
    const messages: Parameters<typeof markLastUserTailForCache>[0] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "<system-reminder>\nx\n</system-reminder>" },
        ],
      },
    ];
    markLastUserTailForCache(messages);
    const blocks = messages[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("buildAnthropicMessages 合并保证角色交替（AC12/N3）", () => {
  test("连续 user 纯文本合并为一条", () => {
    const messages = buildAnthropicMessages([
      { role: "user", content: "问题" },
      { role: "user", content: "补充" },
    ]);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toBe("问题\n补充");
  });

  test("tool_result 之后跟补充提醒：合并进同一 user 消息（不产生连续 user）", () => {
    const messages = buildAnthropicMessages([
      { role: "user", content: "读一下" },
      {
        role: "assistant",
        content: "",
        toolUses: [{ toolUseId: "t1", toolName: "ReadFile", arguments: {} }],
      },
      { role: "user", content: "", toolResults: [{ toolUseId: "t1", content: "ok", isError: false }] },
      { role: "user", content: "<system-reminder>\nPlan mode is active\n</system-reminder>" },
    ]);
    expect(messages.length).toBe(3);
    const tail = messages[messages.length - 1];
    expect(tail?.role).toBe("user");
    const blocks = tail?.content as Array<{ type: string }>;
    expect(blocks.map((block) => block.type)).toEqual(["tool_result", "text"]);
    // 全序列 user/assistant 交替
    const roles = messages.map((message) => message.role);
    for (let i = 1; i < roles.length; i += 1) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });
});

describe("端到端组装：请求视图 → Anthropic params", () => {
  test("补充提醒经请求视图进入末条 user 尾块，且整体可序列化", () => {
    const conv = new ConversationManager();
    conv.addUserMessage("给个方案");
    conv.addSystemReminder("Plan mode is active");
    const messages = buildAnthropicMessages(conv.getRequestMessages());
    markLastUserTailForCache(messages);
    const params = buildAnthropicParams({
      model: "claude-3-5",
      maxTokens: 1024,
      systemPrompt: "SYS",
      messages,
      toolSchemas,
    });
    const tail = params.messages[params.messages.length - 1];
    const blocks = tail?.content as unknown as Array<Record<string, unknown>>;
    const lastBlock = blocks[blocks.length - 1];
    expect(lastBlock?.type).toBe("text");
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(params).length).toBeGreaterThan(0);
  });
});

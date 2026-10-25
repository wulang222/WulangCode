import { describe, expect, test } from "bun:test";
import {
  AutoCompactTrackingState,
  computeCompactThreshold,
  computeKeepStartIndex,
  currentContextTokens,
  estimateMessages,
  estimateTokens,
  forceCompact,
  manageContext,
} from "../src/compact/compact.ts";
import { RecoveryState } from "../src/compact/recovery.ts";
import { ConversationManager, type Message } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.ts";
import { ContextTooLongError } from "../src/llm/errors.ts";
import type { StreamEvent } from "../src/llm/events.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** T29：可编程 stub client，记录每次摘要请求的 prompt 与 tools。 */
function stubClient(handler: (call: number, prompt: string) => string) {
  const seen: { prompt: string; tools: Record<string, unknown>[] }[] = [];
  const client: LLMClient = {
    async *stream(conv, tools): AsyncGenerator<StreamEvent> {
      const prompt = conv.getMessages()[0]?.content ?? "";
      seen.push({ prompt, tools });
      const text = handler(seen.length - 1, prompt);
      yield { type: "text_delta", text };
    },
  };
  return { client, seen };
}

/** 12 条短消息：前缀 7 条 OLD-PREFIX-*，尾部 5 条 marker-recent-*。 */
function longConversation(): ConversationManager {
  const conv = new ConversationManager();
  for (let i = 0; i < 3; i += 1) {
    conv.addUserMessage(`OLD-PREFIX-${i} 请继续调研背景材料`);
    conv.addAssistantMessage(`OLD-ANSWER-${i} 已经看完一部分`);
  }
  conv.addUserMessage("OLD-PREFIX-3 还有一条补问");
  // 后 5 条是 verbatim 尾部
  conv.addUserMessage("marker-recent-q1");
  conv.addAssistantMessage("marker-recent-a1");
  conv.addUserMessage("marker-recent-q2");
  conv.addAssistantMessage("marker-recent-a2");
  conv.addUserMessage("marker-recent-q3");
  return conv;
}

describe("估算与阈值（C13/C14/E9）", () => {
  test("estimateMessages 基本规则", () => {
    expect(estimateMessages([])).toBe(0);
    expect(estimateMessages([{ role: "user", content: "x".repeat(7) }])).toBe(Math.ceil(7 / 3.5));
    // toolUses / toolResults / thinking 都计入
    const msg: Message = {
      role: "assistant",
      content: "aaaa",
      toolUses: [{ toolUseId: "t", toolName: "ReadFile", arguments: { file_path: "a" } }],
      toolResults: undefined,
      thinkingBlocks: [{ thinking: "bbbb", signature: "s" }],
    };
    const chars = 4 + JSON.stringify(msg.toolUses).length + 4;
    expect(estimateMessages([msg])).toBe(Math.ceil(chars / 3.5));
  });

  test("currentContextTokens 冷启动 = estimateTokens", () => {
    const conv = new ConversationManager();
    conv.addUserMessage("hello");
    expect(currentContextTokens(conv, null)).toBe(estimateTokens(conv));
  });

  test("currentContextTokens 锚点 = baseline + 尾部增量", () => {
    const conv = new ConversationManager();
    conv.addUserMessage("a");
    conv.addAssistantMessage("b");
    conv.addUserMessage("y".repeat(70));
    expect(currentContextTokens(conv, { baselineTokens: 5000, anchorCount: 2 })).toBe(5000 + 20);
  });

  test("锚点越界 clamp：anchorCount > 消息数不切负数（C13a）", () => {
    const conv = new ConversationManager();
    conv.addUserMessage("only");
    expect(currentContextTokens(conv, { baselineTokens: 3000, anchorCount: 5 })).toBe(3000);
  });

  test("computeCompactThreshold 数值（200K/8192 → 178808 / 188808）", () => {
    expect(computeCompactThreshold(200_000, 8192)).toBe(178_808);
    expect(computeCompactThreshold(200_000, 8192, true)).toBe(188_808);
    // maxOutput > SUMMARY_OUTPUT_RESERVE 时取 reserve 封顶
    expect(computeCompactThreshold(200_000, 64_000)).toBe(200_000 - 20_000 - 13_000);
  });
});

describe("computeKeepStartIndex（E10/E11 前置）", () => {
  test("12 条短消息命中条数下界：keepStart = 7（保留 5 条）", () => {
    const conv = longConversation();
    const messages = conv.getMessages();
    expect(computeKeepStartIndex(messages)).toBe(7);
    expect(messages.slice(7).length).toBe(5);
  });

  test("不切断 tool_use/tool_result 对：起点前推到 assistant tool_use（E10）", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolUses: [{ toolUseId: "A", toolName: "ReadFile", arguments: {} }] },
      { role: "user", content: "", toolResults: [{ toolUseId: "A", content: "r-a", isError: false }] },
      { role: "assistant", content: "", toolUses: [{ toolUseId: "B", toolName: "ReadFile", arguments: {} }] },
      { role: "user", content: "", toolResults: [{ toolUseId: "B", content: "r-b", isError: false }] },
      { role: "assistant", content: "text-turn" },
      { role: "user", content: "q2" },
    ];
    const keepStart = computeKeepStartIndex(messages);
    // 起点不是落单的 tool_result，而是携带同一 toolUseId 的 assistant tool_use
    expect(keepStart).toBe(1);
    expect(messages[keepStart]!.role).toBe("assistant");
    expect(messages[keepStart]!.toolUses?.[0]?.toolUseId).toBe("A");
    // slice 后 A 的 tool_use 与 tool_result 配对完整
    const tail = messages.slice(keepStart);
    expect(tail.some((m) => m.toolUses?.some((tu) => tu.toolUseId === "A"))).toBe(true);
    expect(tail.some((m) => m.toolResults?.some((tr) => tr.toolUseId === "A"))).toBe(true);
  });

  test("token 上界严格不跨越：巨型消息被排除在 keep 之外", () => {
    const messages: Message[] = [
      { role: "user", content: "B".repeat(150_000) },
      { role: "user", content: "s1" },
      { role: "assistant", content: "s2" },
      { role: "user", content: "s3" },
      { role: "assistant", content: "s4" },
    ];
    // 尾部 4 条小消息后，加首条 42857 token 会破 40000 上界 → keepStart=1
    expect(computeKeepStartIndex(messages)).toBe(1);
  });
});

describe("forceCompact / doCompact（B4/C10/E5/E11）", () => {
  test("保留近期 verbatim、只摘要前缀，摘要请求 tools 严格为空", async () => {
    const { client, seen } = stubClient(() => "<analysis>x</analysis><summary>THE SUMMARY BODY</summary>tail");
    const conv = longConversation();
    const result = await forceCompact(conv, client, null, ["Bash", "ReadFile"]);

    expect(result.compacted).toBe(true);
    expect(result.boundary?.summary).toBe("THE SUMMARY BODY");
    expect(result.boundary?.keep.map((k) => k.content)).toEqual([
      "marker-recent-q1",
      "marker-recent-a1",
      "marker-recent-q2",
      "marker-recent-a2",
      "marker-recent-q3",
    ]);
    // 摘要 + 中文框架进首条 user 消息，verbatim 尾部跟在后面
    const messages = conv.getMessages();
    expect(messages.length).toBe(6);
    expect(messages[0]!.content).toContain("本次会话延续自之前的对话");
    expect(messages[0]!.content).toContain("THE SUMMARY BODY");
    expect(messages[0]!.content).toContain("近期消息已原样保留。");
    expect(messages[1]!.content).toBe("marker-recent-q1");
    // 摘要 prompt：两阶段指令 + 前缀内容；不含 verbatim 尾部；tools 为空数组
    expect(seen.length).toBe(1);
    expect(seen[0]!.prompt).toContain("Wrap your analysis in <analysis> tags");
    expect(seen[0]!.prompt).toContain("<summary> tags");
    expect(seen[0]!.prompt).toContain("OLD-PREFIX-0");
    expect(seen[0]!.prompt).not.toContain("marker-recent-q1");
    expect(seen[0]!.tools.length).toBe(0);
    // 消息模板
    expect(result.message).toBe("Compacted 7 messages into summary (16 chars), kept 5 recent messages verbatim");
  });

  test("无 <summary> 标签时降级为整段返回，不抛错", async () => {
    const { client } = stubClient(() => "NO TAGS PLAIN TEXT");
    const conv = longConversation();
    const result = await forceCompact(conv, client, null, []);
    expect(result.compacted).toBe(true);
    expect(result.boundary?.summary).toBe("NO TAGS PLAIN TEXT");
  });

  test("MIN_COMPACT_PREFIX 退化保护：过短对话跳过且不发起摘要请求（E11）", async () => {
    const { client, seen } = stubClient(() => "should not be called");
    const conv = new ConversationManager();
    conv.addUserMessage("hi");
    conv.addAssistantMessage("hello");
    const result = await forceCompact(conv, client, null, []);
    expect(result.compacted).toBe(false);
    expect(result.message).toBe("Compaction skipped: only 0 message(s) to summarize, kept verbatim");
    expect(seen.length).toBe(0);
    expect(conv.len()).toBe(2);
  });

  test("摘要请求指回会话文件路径", async () => {
    const { client, seen } = stubClient(() => "<summary>S</summary>");
    const conv = longConversation();
    const messages = conv.getMessages();
    await forceCompact(conv, client, null, [], "/w/.mewcode/sessions/s1.jsonl");
    expect(conv.getMessages()[0]!.content).toContain("/w/.mewcode/sessions/s1.jsonl");
    expect(seen.length).toBe(1);
    void messages;
  });
});

describe("F27：摘要请求自身 PTL 的丢组重试", () => {
  function groupedConversation(rounds: number): ConversationManager {
    const conv = new ConversationManager();
    for (let i = 0; i < rounds; i += 1) {
      conv.addUserMessage(`OLD-${i} request`);
      conv.addAssistantMessage(`OLD-${i} answer`);
    }
    conv.addUserMessage("recent-q");
    return conv;
  }

  test("首个摘要撞 PTL：丢最旧一组后重试成功，prompt 变短", async () => {
    let calls = 0;
    const { client, seen } = stubClient((call) => {
      if (call === 0) throw new ContextTooLongError("prompt is too long");
      return "<summary>RETRY OK</summary>";
    });
    const conv = groupedConversation(6);
    const result = await forceCompact(conv, client, null, []);
    expect(result.compacted).toBe(true);
    expect(result.boundary?.summary).toBe("RETRY OK");
    expect(seen.length).toBe(2);
    // 第二次请求丢掉了最旧一组（OLD-0 不再出现，OLD-1 仍在）
    expect(seen[0]!.prompt).toContain("OLD-0");
    expect(seen[1]!.prompt).not.toContain("OLD-0");
    expect(seen[1]!.prompt).toContain("OLD-1");
    expect(seen[1]!.prompt.length).toBeLessThan(seen[0]!.prompt.length);
    calls += 1;
    expect(calls).toBe(1);
  });

  test("组丢光仍 PTL：按一次摘要失败上抛（不发空请求）", async () => {
    const { client, seen } = stubClient(() => {
      throw new ContextTooLongError("prompt is too long");
    });
    const conv = groupedConversation(3);
    let rejected: unknown = null;
    await forceCompact(conv, client, null, []).catch((err) => {
      rejected = err;
    });
    expect(rejected).toBeInstanceOf(ContextTooLongError);
    // 每次请求都带着非空 messages（最后一次尝试仍有 1 组）
    expect(seen.every((s) => s.prompt.length > 0)).toBe(true);
  });
});

describe("manageContext（E7/C14/E19）", () => {
  function bigConversation(charsPerMessage: number, rounds: number): ConversationManager {
    const conv = new ConversationManager();
    for (let i = 0; i < rounds; i += 1) {
      conv.addUserMessage(`q${i}-` + "x".repeat(charsPerMessage));
      conv.addAssistantMessage(`a${i}-` + "y".repeat(charsPerMessage));
    }
    return conv;
  }

  test("低于阈值直通：不发起摘要请求", async () => {
    const { client, seen } = stubClient(() => "<summary>S</summary>");
    const conv = bigConversation(100, 3);
    const result = await manageContext(conv, client, 200_000, 8192, new AutoCompactTrackingState(), null, []);
    expect(result).toEqual({ compacted: false, message: "" });
    expect(seen.length).toBe(0);
  });

  test("熔断：连续 3 次失败后挡住自动路径（E7 触发 A）", async () => {
    const { client } = stubClient(() => "<summary>S</summary>");
    const conv = bigConversation(35_000, 9); // ≈180K token：越过 autoThreshold 但低于 hardBlock
    const tracking = new AutoCompactTrackingState();
    tracking.consecutiveFailures = 3;
    const result = await manageContext(conv, client, 200_000, 8192, tracking, null, []);
    expect(result.compacted).toBe(false);
    expect(result.message).toBe("Auto-compact circuit breaker: 3 consecutive failures");
  });

  test("hardBlock 强制压缩绕过熔断（E7 触发 A③）", async () => {
    const { client, seen } = stubClient(() => "<summary>S</summary>");
    const conv = bigConversation(50_000, 9); // ≈257K token：越过 hardBlock
    const tracking = new AutoCompactTrackingState();
    tracking.consecutiveFailures = 3;
    const result = await manageContext(conv, client, 200_000, 8192, tracking, null, []);
    expect(result.compacted).toBe(true);
    expect(seen.length).toBe(1);
    expect(tracking.consecutiveFailures).toBe(0);
  });

  test("摘要失败计数进熔断；成功清零（E7 触发 B / AC19）", async () => {
    const failing = stubClient(() => {
      throw new Error("provider 500");
    });
    const conv = bigConversation(40_000, 9);
    const tracking = new AutoCompactTrackingState();
    const r1 = await manageContext(conv, failing.client, 200_000, 8192, tracking, null, []);
    expect(r1.compacted).toBe(false);
    expect(r1.message).toBe("Auto-compact failed: provider 500");
    expect(tracking.consecutiveFailures).toBe(1);
    // 两次失败后再一次成功 → 清零
    const conv2 = bigConversation(40_000, 9);
    await manageContext(conv2, failing.client, 200_000, 8192, tracking, null, []);
    expect(tracking.consecutiveFailures).toBe(2);
    const ok = stubClient(() => "<summary>S</summary>");
    const conv3 = bigConversation(40_000, 9);
    const r3 = await manageContext(conv3, ok.client, 200_000, 8192, tracking, null, []);
    expect(r3.compacted).toBe(true);
    expect(tracking.consecutiveFailures).toBe(0);
  });

  test("自动压缩消息附压缩前后估算 token（F24a）", async () => {
    const { client } = stubClient(() => "<summary>S</summary>");
    const conv = bigConversation(50_000, 9);
    const result = await manageContext(conv, client, 200_000, 8192, new AutoCompactTrackingState(), null, []);
    expect(result.compacted).toBe(true);
    expect(result.message).toMatch(/^Compacted \d+ messages into summary \(\d+ chars\), kept \d+ recent messages verbatim（估算 tokens：\d+ → \d+）$/);
  });
});

describe("RecoveryState（C5/C11/C12/E8/E9 恢复段）", () => {
  test("7 个文件只留最近 5 个，按时间倒序", async () => {
    const recovery = new RecoveryState();
    for (let i = 1; i <= 7; i += 1) {
      recovery.recordFileRead(`/tmp/rec/f${i}.txt`, `content-${i}`);
      await sleep(2);
    }
    const snapshot = recovery.snapshotFiles();
    expect(snapshot.length).toBe(5);
    expect(snapshot.map((f) => f.path)).toEqual([
      "/tmp/rec/f7.txt",
      "/tmp/rec/f6.txt",
      "/tmp/rec/f5.txt",
      "/tmp/rec/f4.txt",
      "/tmp/rec/f3.txt",
    ]);
  });

  test("同名文件后写覆盖前写", async () => {
    const recovery = new RecoveryState();
    recovery.recordFileRead("/tmp/rec/same.txt", "v1");
    await sleep(2);
    recovery.recordFileRead("/tmp/rec/same.txt", "v2");
    const snapshot = recovery.snapshotFiles();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]!.content).toBe("v2");
  });

  test("三块按可用性出现：文件 5 个 + 无技能 + 工具清单 + Note（E8）", async () => {
    const recovery = new RecoveryState();
    for (let i = 1; i <= 7; i += 1) {
      recovery.recordFileRead(`/tmp/att/f${i}.txt`, `body-${i}`);
      await sleep(2);
    }
    const attachment = recovery.buildRecoveryAttachment(["Bash", "ReadFile", "Grep"]);
    expect(attachment).toContain("## Recently read files");
    expect(attachment).not.toContain("## Active skills");
    expect(attachment).toContain("## Available tools");
    expect(attachment).toContain("- Bash\n- ReadFile\n- Grep");
    expect(attachment).toContain("## Note");
    expect(attachment).toContain("Everything above the divider is reconstructed context");
    expect(attachment).toContain("re-read the source rather than guess from the summary");
    // 反向断言：第 6/7 个文件不出现
    expect(attachment).not.toContain("/tmp/att/f2.txt");
    expect(attachment).not.toContain("/tmp/att/f1.txt");
    expect(attachment).toContain("/tmp/att/f7.txt");
    // 逐字节稳定
    expect(recovery.buildRecoveryAttachment(["Bash", "ReadFile", "Grep"]) === attachment).toBe(true);
  });

  test("技能段出现且 newest 在前", async () => {
    const recovery = new RecoveryState();
    recovery.recordSkillInvocation("old-skill", "OLD BODY");
    await sleep(2);
    recovery.recordSkillInvocation("new-skill", "NEW BODY");
    const attachment = recovery.buildRecoveryAttachment([]);
    expect(attachment).toContain("## Active skills");
    expect(attachment.indexOf("new-skill")).toBeLessThan(attachment.indexOf("old-skill"));
  });

  test("超 5000 token 的文件内容被截断并标注（AC9）", () => {
    const recovery = new RecoveryState();
    recovery.recordFileRead("/tmp/big.txt", "z".repeat(20_000));
    const attachment = recovery.buildRecoveryAttachment([]);
    expect(attachment).toContain("… (content truncated)");
    // 头部 17500 字符保留
    expect(attachment).toContain("z".repeat(1000));
  });

  test("三块全空返回空字符串", () => {
    expect(new RecoveryState().buildRecoveryAttachment([])).toBe("");
  });
});

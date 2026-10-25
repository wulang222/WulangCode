#!/usr/bin/env bun
/**
 * 记忆系统端到端冒烟（day8，Agent 层脚本，expect 驱动不了 Bun+Ink）：
 * 1. 注入链：loadInstructions（含 @include）+ MemoryManager.buildSystemReminder
 *    → conv.injectLongTermMemory → 首条消息含三段与指令正文，且幂等（AC24/AC25）
 * 2. 存档链：saveMessage 往返 + compact_boundary + /resume 等价路径重建（AC8/AC9/AC14）
 * 3. 提取链：Agent onLoopComplete → MemoryExtractor（MockClient 吐 project 块）
 *    → .mewcode/memory/<name>.md 落盘 + MEMORY.md 索引同步（AC19/AC20/AC22）
 * 4. 回滚链：FileHistory trackEdit → makeSnapshot → rewind 还原文件内容（场景 17）
 * 5. 清理链：31 天前 mtime 的存档被 cleanExpiredSessions 删除（AC17）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";
import { emptyUsage } from "../src/llm/events.js";
import {
  cleanExpiredSessions,
  getSessionFilePath,
  loadSession,
  newSessionId,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "../src/session/session.ts";
import { loadInstructions } from "../src/memory/instructions.ts";
import { MemoryManager } from "../src/memory/manager.ts";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { FileHistory } from "../src/filehistory/filehistory.ts";
import { PermissionChecker } from "../src/permissions/checker.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** 按 extract 调用次序返回预置回复的假 client。 */
class MockClient implements LLMClient {
  streamCalls = 0;
  constructor(private readonly responses: string[]) {}
  async *stream(conv: Conv, _tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    void conv;
    const text = this.responses[this.streamCalls] ?? "NONE";
    this.streamCalls += 1;
    yield { type: "text_delta", text };
    yield { type: "stream_end", stopReason: "end_turn", usage: emptyUsage() };
  }
}

const root = mkdtempSync(join(tmpdir(), "mewcode-smoke-memory-"));
const workDir = join(root, "proj");
mkdirSync(workDir, { recursive: true });

// ---- 1. 注入链 ----
mkdirSync(join(workDir, "rules"), { recursive: true });
writeFileSync(join(workDir, "rules", "style.md"), "代码块必须带语言标记", "utf-8");
writeFileSync(
  join(workDir, "MEWCODE.md"),
  "所有回复必须以「喵~」开头\n@./rules/style.md",
  "utf-8",
);
mkdirSync(join(workDir, ".mewcode", "memory"), { recursive: true });
writeFileSync(
  join(workDir, ".mewcode", "memory", "use-bun.md"),
  "---\nname: use-bun\ndescription: 本项目用 bun\ntype: project\n---\n\n用 bun test 跑测试",
  "utf-8",
);

const instructions = loadInstructions(workDir);
check("1.1 指令加载含 MEWCODE.md 正文与 @include 展开", instructions.includes("喵~") && instructions.includes("代码块必须带语言标记"));
check("1.2 @include 来源注释存在", instructions.includes("<!-- included from ./rules/style.md -->"));

const memReminder = new MemoryManager(workDir).buildSystemReminder();
check("1.3 记忆摘要含 name/type/description 三段", memReminder.includes("[use-bun] (project): 本项目用 bun"));

const conv = new Conv();
conv.injectLongTermMemory(instructions, memReminder);
conv.injectLongTermMemory(instructions, memReminder); // 幂等
const first = conv.getMessages()[0]!;
check("1.4 首条消息是 <system-reminder> 且含 mewcodeMd/autoMemory/currentDate", first.role === "user" && first.content.startsWith("<system-reminder>") && first.content.includes("# mewcodeMd") && first.content.includes("# autoMemory") && first.content.includes("# currentDate"));
check("1.5 幂等：重复注入只写一条", conv.len() === 1);

// ---- 2. 存档链 ----
const sessionId = newSessionId();
const ts = () => new Date().toISOString();
saveMessage(workDir, sessionId, { role: "user", content: "读取 package.json", timestamp: ts() });
saveMessage(workDir, sessionId, { role: "assistant", content: "喵~ 已读取", timestamp: ts() });
saveCompactBoundary(workDir, sessionId, { summary: "用户要求读 package.json", keep: [{ role: "user", content: "最新一条" }] });
saveMessage(workDir, sessionId, { role: "user", content: "继续", timestamp: ts() });
const saved = loadSession(workDir, sessionId);
check("2.1 存档行数 = 4（含 boundary）", saved.length === 4);
const restored = rebuildFromSession(saved);
check("2.2 重建首条是中文摘要包装", restored[0]?.role === "user" && restored[0]!.content.includes("本次会话延续自之前的对话"));
check("2.3 keep + 边界后消息依次回放", restored.slice(1).map((m) => m.content).join("|") === "最新一条|继续");

// ---- 3. 提取链（经 Agent onLoopComplete 驱动）----
const extractorClient = new MockClient([
  "MEMORY_NAME: prefer-bun\nMEMORY_TYPE: project\nMEMORY_DESC: 测试工具选型\nMEMORY_BODY: bun test 全绿后再提交。\n---\nMEMORY_NAME: likes-cats\nMEMORY_TYPE: user\nMEMORY_DESC: 用户喜欢猫\nMEMORY_BODY: 回复里可以带猫。",
]);
const extractor = new MemoryExtractor(extractorClient, workDir);
const registry = new ToolRegistry();
const agent = new Agent({
  client: new MockClient([]), // 主循环本轮直接 end_turn
  registry,
  checker: new PermissionChecker(workDir, "bypassPermissions"),
  conversation: conv,
  workDir,
  onLoopComplete: (c) => {
    const summary = c.getMessages().slice(-40).map((m) => `${m.role}: ${m.content}`).join("\n");
    extractor.extract(summary).then((names) => {
      check("3.1 提取返回两个笔记名", names.length === 2, JSON.stringify(names));
      check("3.2 project 落项目目录", existsSync(join(workDir, ".mewcode", "memory", "prefer-bun.md")));
      const userNote = join(require("node:os").homedir(), ".mewcode", "memory", "likes-cats.md");
      check("3.3 user 落用户全局目录", existsSync(userNote), userNote);
      if (existsSync(userNote)) rmSync(userNote); // 不污染真实主目录
      const index = readFileSync(join(workDir, ".mewcode", "memory", "MEMORY.md"), "utf-8");
      check("3.4 MEMORY.md 索引含新笔记", index.includes("[prefer-bun]") && index.includes("[use-bun]"));
    }).catch(() => check("3.1 提取返回两个笔记名", false, "extract threw"));
  },
});
conv.addUserMessage("记住：测试用 bun");
void (async () => {
  for await (const ev of agent.run()) if (ev.type === "error") check("3.0 主循环无 error", false, ev.error.message);
})();
await new Promise((r) => setTimeout(r, 300));

// ---- 4. 回滚链 ----
const fh = new FileHistory(workDir, sessionId);
const target = join(workDir, "tracked.txt");
writeFileSync(target, "v1", "utf-8");
fh.trackEdit(target);
writeFileSync(target, "v2", "utf-8");
fh.makeSnapshot(0, "first snapshot");
fh.trackEdit(target);
writeFileSync(target, "v3", "utf-8");
fh.makeSnapshot(2, "second snapshot");
const changed = fh.rewind(0);
check("4.1 rewind 回到最早快照后文件是 v1", readFileSync(target, "utf-8") === "v1");
check("4.2 返回被改动文件路径", changed.includes(target));

// ---- 5. 清理链 ----
const oldId = newSessionId();
saveMessage(workDir, oldId, { role: "user", content: "ancient", timestamp: ts() });
const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
utimesSync(getSessionFilePath(workDir, oldId), past, past);
check("5.1 过期存档被清理", cleanExpiredSessions(workDir) >= 1 && !existsSync(getSessionFilePath(workDir, oldId)));

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

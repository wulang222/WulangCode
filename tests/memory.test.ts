import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { MemoryManager, parseFrontmatter } from "../src/memory/manager.ts";
import { loadInstructions } from "../src/memory/instructions.ts";
import type { ConversationManager as Conv } from "../src/conversation/conversation.ts";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";

function tempWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-memory-"));
}

/** 固定文本假 client：一次性把 response 作为 text_delta 吐出。 */
class MockClient implements LLMClient {
  constructor(private readonly response: string) {}

  async *stream(_conv: Conv, _tools: Record<string, unknown>[]): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: this.response };
  }
}

describe("MemoryExtractor（T5/T15）", () => {
  test("解析两个 MEMORY 块并按 project/reference 双路落盘到项目目录", async () => {
    const dir = tempWorkDir();
    const response = [
      "MEMORY_NAME: use-bun",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: 本项目用 bun 跑测试",
      "MEMORY_BODY: 运行测试用 bun test，不要用 npm test。",
      "---",
      "MEMORY_NAME: docs-pointer",
      "MEMORY_TYPE: reference",
      "MEMORY_DESC: 构建文档入口",
      "MEMORY_BODY: 文档见 docs/ 目录，按 dayN 分章节。",
    ].join("\n");
    const saved = await new MemoryExtractor(new MockClient(response), dir).extract("[user]: 我们项目用 bun");
    expect(saved).toEqual(["use-bun", "docs-pointer"]);

    const projDir = join(dir, ".mewcode", "memory");
    expect(existsSync(join(projDir, "use-bun.md"))).toBe(true);
    expect(existsSync(join(projDir, "docs-pointer.md"))).toBe(true);
    const raw = readFileSync(join(projDir, "use-bun.md"), "utf-8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("name: use-bun");
    expect(raw).toContain("description: 本项目用 bun 跑测试");
    expect(raw).toContain("type: project");
    expect(raw).toContain("bun test");
    // 索引同步重建（F25/AC22）
    expect(readFileSync(join(projDir, "MEMORY.md"), "utf-8")).toContain("[use-bun]");
    rmSync(dir, { recursive: true, force: true });
  });

  test("NONE 静默返回空数组，目录无新增（AC21）", async () => {
    const dir = tempWorkDir();
    const saved = await new MemoryExtractor(new MockClient("NONE"), dir).extract("[user]: 随便聊聊");
    expect(saved).toEqual([]);
    expect(existsSync(join(dir, ".mewcode"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("缺 name 或 body 的块被丢弃（F32）", async () => {
    const dir = tempWorkDir();
    const response = [
      "MEMORY_NAME: ok-note",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: 完整块",
      "MEMORY_BODY: 有正文。",
      "---",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: 缺 name",
      "MEMORY_BODY: 没有标识。",
    ].join("\n");
    const saved = await new MemoryExtractor(new MockClient(response), dir).extract("ctx");
    expect(saved).toEqual(["ok-note"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("并发合并（AC23）：进行中再 extract 立即返回空，结束后自动尾部运行", async () => {
    const dir = tempWorkDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    class GatedClient implements LLMClient {
      async *stream(conv: Conv): AsyncGenerator<StreamEvent> {
        const text = conv.getMessages().map((m) => m.content).join("\n");
        calls.push(text);
        if (calls.length === 1) await gate;
        yield { type: "text_delta", text: "NONE" };
      }
    }
    const extractor = new MemoryExtractor(new GatedClient(), dir);
    const first = extractor.extract("ctx-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 第一次还在跑：立即返回空，不并发发起
    expect(await extractor.extract("ctx-2")).toEqual([]);
    release();
    expect(await first).toEqual([]);
    // 尾部运行用最新上下文自动执行了一次
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("ctx-2");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MemoryManager（T4）", () => {
  test("parseFrontmatter：顶层 type 优先，回退 metadata.type，坏 YAML 不抛错", () => {
    const top = parseFrontmatter("---\nname: a\ndescription: d\ntype: project\n---\n\nbody-a\n");
    expect(top.name).toBe("a");
    expect(top.type).toBe("project");
    expect(top.body.trim()).toBe("body-a");
    const nested = parseFrontmatter("---\nmetadata:\n  type: reference\n---\nbody-b");
    expect(nested.type).toBe("reference");
    const broken = parseFrontmatter("---\nname: [unclosed\n---\nbody-c");
    expect(broken.body).toContain("body-c");
    expect(parseFrontmatter("no frontmatter").body).toBe("no frontmatter");
  });

  test("rebuildIndex 按 name 大小写不敏感字母序列出（场景 14）", () => {
    const dir = tempWorkDir();
    const projDir = join(dir, ".mewcode", "memory");
    mkdirSync(projDir, { recursive: true });
    for (const [name, desc] of [
      ["zeta", "最后"],
      ["Alpha", "首字母大写"],
      ["beta", "第二个"],
    ] as const) {
      writeFileSync(
        join(projDir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${desc}\ntype: project\n---\n\n正文`,
        "utf-8",
      );
    }
    new MemoryManager(dir).rebuildIndex();
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf-8");
    const lines = index.split("\n").filter((l) => l.startsWith("- ["));
    const mine = lines.filter((l) => /\[(Alpha|beta|zeta)\]/.test(l));
    expect(mine.map((l) => l.match(/\[([^\]]+)\]/)![1])).toEqual(["Alpha", "beta", "zeta"]);
    expect(mine[0]).toContain("(.mewcode/memory/Alpha.md)");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadInstructions（T3）", () => {
  test("@include 展开、代码块跳过、循环检测、深度上限（AC3-AC6）", () => {
    const root = tempWorkDir();
    // 伪装 git root：向上找 .git 的发现链生效
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "sub"), { recursive: true });

    writeFileSync(join(root, "b.md"), "B-start\n@./MEWCODE.md\nB-end", "utf-8");
    writeFileSync(join(root, "sub", "rules.md"), "rule body", "utf-8");
    // 深度链：f1..f6 各引用下一层；f6 处展开超限，@./f7.md 保留原文
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(join(root, `f${i}.md`), `f${i}-body\n@./f${i + 1}.md`, "utf-8");
    }
    writeFileSync(
      join(root, "MEWCODE.md"),
      ["A-start", "@./b.md", "A-end", "@./f1.md", "@./sub/rules.md", "```", "@./not-real.md", "```"].join("\n"),
      "utf-8",
    );

    const text = loadInstructions(root);
    // 循环检测：MEWCODE.md 本体只出现一次，b.md 对它的引用保留原 @ 行
    expect((text.match(/A-start/g) ?? []).length).toBe(1);
    expect(text).toContain("<!-- included from ./b.md -->");
    expect(text).toContain("B-start");
    expect(text).toContain("@./MEWCODE.md");
    // 深度上限：f6 内容已插入但其引用保留原文，f7 永不读取
    expect(text).toContain("f6-body");
    expect(text).toContain("@./f7.md");
    expect(text).not.toContain("f7-body");
    // 代码块内的 @ 行原样保留
    expect(text).toContain("@./not-real.md");
    // 相对引用展开 + 来源注释
    expect(text).toContain("<!-- included from ./sub/rules.md -->");
    expect(text).toContain("rule body");
    // 包装格式（F2）
    expect(text).toContain("Contents of MEWCODE.md:");
    rmSync(root, { recursive: true, force: true });
  });
});

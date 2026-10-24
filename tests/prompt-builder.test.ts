import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, detectEnvironment, PromptBuilder } from "../src/prompt/builder.ts";
import {
  environmentSection,
  identitySection,
  usingToolsSection,
  type EnvironmentContext,
} from "../src/prompt/sections.ts";
import { BashDescription, EditFileDescription } from "../src/tools/descriptions.ts";

const fakeEnv: EnvironmentContext = {
  workDir: "/tmp/demo",
  os: "darwin",
  arch: "arm64",
  shell: "/bin/zsh",
  isGitRepo: true,
  gitBranch: "main",
  model: "deepseek-chat",
  date: "2026-10-24",
};

describe("PromptBuilder", () => {
  test("按 priority 排序：Identity 在 UsingTools 之前，段间以空行分隔", () => {
    const built = new PromptBuilder().add(usingToolsSection()).add(identitySection()).build();
    expect(built.indexOf("你是 MewCode")).toBeGreaterThanOrEqual(0);
    expect(built.indexOf("你是 MewCode")).toBeLessThan(built.indexOf("# 使用你的工具"));
    expect(built).toContain("\n\n");
    expect(built).not.toContain("\n\n\n");
  });

  test("挂载即扩展：自定义 Section 落在对应优先级位置", () => {
    const built = new PromptBuilder()
      .add(usingToolsSection())
      .add({ name: "Extra", priority: 45, content: "EXTRA-45" })
      .add(identitySection())
      .build();
    const extraAt = built.indexOf("EXTRA-45");
    expect(extraAt).toBeGreaterThan(built.indexOf("# 使用你的工具"));
    expect(extraAt).toBeGreaterThan(built.indexOf("你是 MewCode"));
  });

  test("空 content 自动跳过，不留多余空行", () => {
    const built = new PromptBuilder()
      .add({ name: "X", priority: 50, content: "" })
      .add({ name: "Y", priority: 10, content: "  \n\t" })
      .add(identitySection())
      .build();
    expect(built).not.toContain("X");
    expect(built).not.toContain("\n\n\n");
    expect(built).toContain("你是 MewCode");
  });
});

describe("buildSystemPrompt", () => {
  test("N1 稳定性：同一 env 两次构造逐字节相等（AC5）", () => {
    expect(buildSystemPrompt(fakeEnv)).toBe(buildSystemPrompt(fakeEnv));
  });

  test("环境变化只影响环境段，稳定前缀逐字节不变（AC5）", () => {
    const a = buildSystemPrompt(fakeEnv);
    const b = buildSystemPrompt({ ...fakeEnv, workDir: "/other", gitBranch: "dev", model: "" });
    expect(a.split("# 环境")[0]).toBe(b.split("# 环境")[0]);
  });

  test("八个固定模块按优先级顺序出现（AC1）", () => {
    const prompt = buildSystemPrompt(fakeEnv);
    const order = [
      "你是 MewCode",
      "# 系统",
      "# 任务执行",
      "# 谨慎执行操作",
      "# 使用你的工具",
      "# 语气与风格",
      "# 文本输出",
      "# 环境",
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = prompt.indexOf(marker);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("可选空槽：无 opts 时不出现，传入时按 Skills / CustomInstructions / Memory 收尾（AC2）", () => {
    const bare = buildSystemPrompt(fakeEnv);
    expect(bare).not.toContain("SKILL-9");
    expect(bare).not.toContain("CUSTOM-9");
    expect(bare).not.toContain("MEMORY-9");
    expect(bare).not.toContain("\n\n\n");

    const full = buildSystemPrompt(fakeEnv, {
      skillSection: "SKILL-9",
      customInstructions: "CUSTOM-9",
      memorySection: "MEMORY-9",
    });
    const envAt = full.indexOf("# 环境");
    expect(full.indexOf("SKILL-9")).toBeGreaterThan(envAt);
    expect(full.indexOf("CUSTOM-9")).toBeGreaterThan(full.indexOf("SKILL-9"));
    expect(full.indexOf("MEMORY-9")).toBeGreaterThan(full.indexOf("CUSTOM-9"));
  });

  test("F5 双重强化：系统提示与工具描述两处都有（AC7）", () => {
    const section = usingToolsSection().content;
    expect(section).toContain("有专用工具时绝不要用 Bash");
    for (const tool of ["ReadFile", "EditFile", "WriteFile", "Glob", "Grep"]) {
      expect(section).toContain(tool);
    }
    const prompt = buildSystemPrompt(fakeEnv);
    expect(prompt).toContain("ReadFile");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("EditFile");
    // 工具描述侧
    expect(BashDescription).toContain("Avoid using this tool to run cat, head, tail, sed, awk, or echo");
    expect(EditFileDescription).toContain("You MUST read the file with ReadFile before editing. This tool will fail otherwise.");
  });

  test("systemSection 含 <system-reminder> 元提示（F6）", () => {
    expect(buildSystemPrompt(fakeEnv)).toContain("<system-reminder>");
  });
});

describe("environmentSection（AC3）", () => {
  test("Git 仓库：固定行 + 分支行 + 模型行", () => {
    const content = environmentSection(fakeEnv).content;
    expect(content).toContain("/tmp/demo");
    expect(content).toContain("darwin/arm64");
    expect(content).toContain("/bin/zsh");
    expect(content).toContain("Git 仓库: 是");
    expect(content).toContain("Git 分支: main");
    expect(content).toContain("2026-10-24");
    expect(content).toContain("模型: deepseek-chat");
  });

  test("非 Git 仓库：省略分支行；模型为空：省略模型行（AC13）", () => {
    const content = environmentSection({ ...fakeEnv, isGitRepo: false, gitBranch: "", model: "" }).content;
    expect(content).toContain("Git 仓库: 否");
    expect(content).not.toContain("Git 分支");
    expect(content).not.toContain("模型:");
  });
});

describe("detectEnvironment", () => {
  test("非 git 目录降级：isGitRepo=false、gitBranch 为空、不抛（AC13/N4）", () => {
    const dir = mkdtempSync(join(tmpdir(), "mewcode-env-"));
    const env = detectEnvironment(dir);
    expect(env.isGitRepo).toBe(false);
    expect(env.gitBranch).toBe("");
    expect(env.workDir).toBe(dir);
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("本仓库内探测：是 git 仓库且分支非空", () => {
    const env = detectEnvironment(process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.gitBranch.length).toBeGreaterThan(0);
  });
});

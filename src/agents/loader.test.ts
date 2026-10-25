import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAgentDefinitions, parseAgentDefinition } from "./loader.ts";

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-agents-"));
}

function writeAgent(workDir: string, file: string, content: string): void {
  const dir = join(workDir, ".mewcode", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf-8");
}

/** T4：三层加载、frontmatter 解析、同名覆盖、错误吞抹（AC13/AC14）。 */
describe("loadAgentDefinitions", () => {
  test("project-level definition overrides the built-in explore", () => {
    const workDir = makeWorkDir();
    writeAgent(
      workDir,
      "explore.md",
      `---
name: explore
description: project-level explore override
max_turns: 10
---

project body text`,
    );
    const defs = loadAgentDefinitions(workDir);
    const explore = defs.find((d) => d.name === "explore")!;
    expect(explore.description).toBe("project-level explore override");
    expect(explore.maxTurns).toBe(10);
    expect(explore.initialPrompt).toBe("project body text");
  });

  test("missing description falls back to first 200 chars of the body", () => {
    const workDir = makeWorkDir();
    writeAgent(workDir, "minimal.md", `---\nname: x\n---\n\n${"a".repeat(350)}`);
    const defs = loadAgentDefinitions(workDir);
    const found = defs.find((d) => d.name === "x")!;
    expect(found.description).toBe("a".repeat(200));
  });

  test("invalid file (missing ---) is skipped without throwing, other files still load", () => {
    const workDir = makeWorkDir();
    writeAgent(workDir, "bad.md", "no frontmatter here");
    writeAgent(workDir, "good.md", `---\nname: good\ndescription: ok\n---\n\nbody`);
    const defs = loadAgentDefinitions(workDir);
    expect(defs.find((d) => d.name === "good")).toBeDefined();
    expect(defs.find((d) => d.name === "bad")).toBeUndefined();
  });

  test("illegal YAML is swallowed and the file skipped", () => {
    const workDir = makeWorkDir();
    writeAgent(workDir, "broken.md", `---\nname: [unclosed\n---\n\nbody`);
    const defs = loadAgentDefinitions(workDir);
    expect(defs.find((d) => d.name === "broken")).toBeUndefined();
  });

  test("frontmatter without name returns null from the parser", () => {
    expect(parseAgentDefinition(`---\ndescription: no name\n---\n\nbody`)).toBeNull();
  });

  test("missing agents directory does not throw", () => {
    const defs = loadAgentDefinitions(makeWorkDir());
    expect(defs.length).toBeGreaterThanOrEqual(3);
  });

  test("maps permission_mode, model and background fields as-is without enum validation", () => {
    const def = parseAgentDefinition(
      `---\nname: bad\nmodel: gpt-5\npermission_mode: weirdMode\nbackground: true\n---\n\nbody`,
    )!;
    expect(def.model).toBe("gpt-5");
    expect(def.permissionMode as string).toBe("weirdMode");
    expect(def.background).toBe(true);
  });
});

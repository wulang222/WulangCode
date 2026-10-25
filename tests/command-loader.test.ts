import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserCommands, renderBody } from "../src/commands/loader.ts";

/** 新建临时 workDir 并预建 .mewcode/commands/ 子目录。 */
function cmdDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mewcode-cmd-"));
  const dir = join(root, ".mewcode", "commands");
  mkdirSync(dir, { recursive: true });
  return root;
}

describe("loadUserCommands（day9 T6）", () => {
  test("frontmatter 解析 + $ARGUMENTS 替换 + prompt 类型", () => {
    const root = cmdDir();
    writeFileSync(
      join(root, ".mewcode", "commands", "deploy.md"),
      "---\ndescription: Deploy it\nargument-hint: <target>\naliases: [d]\n---\nDeploy $ARGUMENTS to production.",
      "utf-8",
    );
    const commands = loadUserCommands(root);
    const deploy = commands.find((c) => c.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.description).toBe("Deploy it");
    expect(deploy?.aliases).toEqual(["d"]);
    expect(deploy?.type).toBe("prompt");
    expect(deploy?.handler({ workDir: root, args: "staging" })).toBe("Deploy staging to production.");
  });

  test("子目录路径以 : 命名空间化（git/sync.md → git:sync）", () => {
    const root = cmdDir();
    mkdirSync(join(root, ".mewcode", "commands", "git"), { recursive: true });
    writeFileSync(join(root, ".mewcode", "commands", "git", "sync.md"), "Sync the repo.", "utf-8");
    const commands = loadUserCommands(root);
    expect(commands.find((c) => c.name === "git:sync")).toBeDefined();
  });
});

describe("renderBody（day9 T6）", () => {
  test("含 $ARGUMENTS 时全量替换", () => {
    expect(renderBody("Hello $ARGUMENTS!", "world")).toBe("Hello world!");
  });

  test("不含占位但有参数时按正文 + 空行 + 参数拼接", () => {
    expect(renderBody("Body text", "extra args")).toBe("Body text\n\nextra args");
  });

  test("无参数时直接返回正文", () => {
    expect(renderBody("Body text", "")).toBe("Body text");
  });
});

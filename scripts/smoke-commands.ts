#!/usr/bin/env bun
/**
 * slash 命令体系端到端冒烟（day9，Agent/纯逻辑层脚本，expect 驱动不了 Bun+Ink）：
 * 1. 注册中心：16 条内置、别名查找、四类冲突报错、complete/parse（AC14/F2-F7）
 * 2. /help：全量清单格式 + 单条详情 + 末尾提示（AC1/AC2）
 * 3. 用户命令：frontmatter、$ARGUMENTS、子目录命名空间、项目级覆盖用户级、
 *    与内置同名静默跳过（AC15/F31-F35）
 * 4. 使用追踪：持久化 JSON、衰减排序、地板 0.1（F50-F53）
 * 5. 技能接线：inline → prompt、fork → skill_fork、[skill] 后缀、
 *    已占名短路不抛（AC16/F36-F39）
 * 交互菜单（场景 C）与真实终端启动项需人工 tmux 验证。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry, parse } from "../src/commands/commands.ts";
import type { CommandRegistry } from "../src/commands/commands.ts";
import { loadUserCommands } from "../src/commands/loader.ts";
import { CommandUsageTracker } from "../src/commands/usage-tracker.ts";
import { runSkillInline, SkillCatalog } from "../src/skills/catalog.ts";
import { wireSkillsToRegistry } from "../src/tui/app.tsx";

// Bun 的 os.homedir() 不吃进程内 process.env.HOME 修改（实测快照真实 home），
// 用户层两级扫描相关断言放子进程里跑、HOME 经 env 注入（启动前设置有效）。
const isolatedHome = mkdtempSync(join(tmpdir(), "mewcode-home-"));

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

/** 1. 注册中心与 parse */
function smokeRegistry(): void {
  section("注册中心");
  const registry = createDefaultRegistry();
  const names = registry.listCommands().map((c) => c.name);
  check("16 条内置命令", names.length === 16, `got ${names.length}`);
  check("字典序输出", JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))));
  check("别名查找 c→compact / s→status / exit→quit", registry.find("c")?.name === "compact" && registry.find("s")?.name === "status" && registry.find("exit")?.name === "quit");
  check("complete 前缀 st→status", registry.complete("st").map((c) => c.name).join(",") === "status");
  check("complete 大小写不敏感 ST→status", registry.complete("ST").map((c) => c.name).join(",") === "status");
  try {
    registry.register({ name: "help", aliases: [], type: "local", description: "dup", handler: () => "" });
    check("同名注册抛错（AC14）", false, "未抛错");
  } catch (err) {
    check(
      "同名注册抛错且含 already registered（AC14）",
      err instanceof Error && err.message.includes("already registered") && err.message.includes("help"),
      String(err),
    );
  }
  try {
    registry.register({ name: "fresh", aliases: ["status"], type: "local", description: "dup", handler: () => "" });
    check("别名撞命令名抛错", false, "未抛错");
  } catch (err) {
    check(
      "别名撞命令名抛错含 collides with existing command name",
      err instanceof Error && err.message.includes("collides with existing command name"),
      String(err),
    );
  }
  check("parse /foo bar baz", JSON.stringify(parse("/foo bar baz")) === JSON.stringify({ name: "foo", args: "bar baz" }));
  check("parse 非 / 返回 null", parse("hello") === null);
}

/** 2. /help 输出格式 */
function smokeHelp(): void {
  section("/help");
  const registry = createDefaultRegistry();
  const help = registry.find("help")!;
  const full = help.handler({ workDir: "/tmp", args: "" });
  check("全量清单含标题", full.startsWith("Available commands:"));
  check("全量清单含 16 个命令名", registry.listCommands().every((c) => full.includes(`/${c.name}`)));
  check("全量清单含别名展示 /compact, /c", full.includes("/compact, /c"));
  check("全量清单末尾提示", full.endsWith("Type /help <command> for details."));
  check("单条详情（AC2）", help.handler({ workDir: "/tmp", args: "compact" }) === "/compact — Force context compaction\nAliases: c");
}

/** 3. 用户命令加载（用户层覆盖、命名空间、内置冲突跳过） */
async function smokeLoader(): Promise<string> {
  section("用户命令");
  const workDir = mkdtempSync(join(tmpdir(), "mewcode-cmd-"));
  const projCmds = join(workDir, ".mewcode", "commands");
  mkdirSync(projCmds, { recursive: true });
  mkdirSync(join(isolatedHome, ".mewcode", "commands"), { recursive: true });

  writeFileSync(
    join(projCmds, "deploy.md"),
    "---\ndescription: Deploy it\naliases: [d]\n---\nDeploy $ARGUMENTS to production.",
    "utf-8",
  );
  mkdirSync(join(projCmds, "git"), { recursive: true });
  writeFileSync(join(projCmds, "git", "sync.md"), "Sync the repo.", "utf-8");
  // 用户层同名条目，应被项目层覆盖
  writeFileSync(join(isolatedHome, ".mewcode", "commands", "deploy.md"), "USER LEVEL deploy", "utf-8");
  // 用户层独有条目，应能加载
  writeFileSync(join(isolatedHome, ".mewcode", "commands", "global-tool.md"), "Global tool prompt.", "utf-8");

  const commands = loadUserCommands(workDir);
  const deploy = commands.find((c) => c.name === "deploy");
  check("deploy 加载且 type=prompt（AC15）", deploy?.type === "prompt");
  check(
    "$ARGUMENTS 替换（AC15）",
    deploy?.handler({ workDir, args: "staging" }) === "Deploy staging to production.",
    deploy?.handler({ workDir, args: "staging" }),
  );
  check("子目录命名空间 git:sync（F32）", commands.find((c) => c.name === "git:sync") !== undefined);

  // 用户层 / 项目层两级扫描与覆盖：子进程里 HOME 指到 isolatedHome 再跑一次加载。
  const loaderPath = new URL("../src/commands/loader.ts", import.meta.url).pathname;
  const childScript =
    `const { loadUserCommands } = await import(${JSON.stringify(loaderPath)});\n` +
    `const cmds = loadUserCommands(${JSON.stringify(workDir)});\n` +
    `console.log(JSON.stringify(cmds.map((c) => ({ name: c.name, description: c.description }))));`;
  const child = Bun.spawn(["bun", "-e", childScript], {
    env: { ...process.env, HOME: isolatedHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const childOut = await new Response(child.stdout).text();
  const userLevel = JSON.parse(childOut.trim()) as { name: string; description: string }[];
  check("用户层独有条目加载（F31）", userLevel.find((c) => c.name === "global-tool") !== undefined);
  check(
    "项目级覆盖用户级同名（F31）",
    userLevel.find((c) => c.name === "deploy")?.description === "Deploy it",
    childOut.trim(),
  );

  // 与内置同名：register 抛错后 try/catch 静默跳过（F35）
  writeFileSync(join(projCmds, "compact.md"), "hijack", "utf-8");
  const registry = createDefaultRegistry();
  let hijacked = false;
  for (const cmd of loadUserCommands(workDir)) {
    try {
      registry.register(cmd);
    } catch {
      // 内置占名静默跳过
    }
  }
  hijacked = registry.find("compact")?.description === "Force context compaction";
  check("与内置同名静默跳过、内置保留（F35）", hijacked);
  check("非冲突用户命令仍注册成功", registry.find("deploy")?.description === "Deploy it");
  return workDir;
}

/** 4. 使用追踪（持久化 + 衰减） */
function smokeTracker(): void {
  section("使用追踪");
  const workDir = mkdtempSync(join(tmpdir(), "mewcode-usage-"));
  const tracker = new CommandUsageTracker(workDir);
  tracker.record("help");
  tracker.record("help");
  tracker.record("status");
  const raw = JSON.parse(readFileSync(join(workDir, ".mewcode", "command_usage.json"), "utf-8")) as Record<
    string,
    { usageCount: number; lastUsedAt: number }
  >;
  check("JSON 结构 {usageCount,lastUsedAt}（F50）", raw.help?.usageCount === 2 && typeof raw.help?.lastUsedAt === "number");
  check("getRecentlyUsed 排序", JSON.stringify(tracker.getRecentlyUsed(5)) === JSON.stringify(["help", "status"]));

  // 手工塞入 30 天前的记录：衰减到地板 0.1×count；新记录排前面
  const old = { usageCount: 10, lastUsedAt: Date.now() - 30 * 86_400_000 };
  raw["ancient"] = old;
  writeFileSync(join(workDir, ".mewcode", "command_usage.json"), JSON.stringify(raw), "utf-8");
  const tracker2 = new CommandUsageTracker(workDir);
  check("30 天前记录衰减到地板 0.1（F52）", Math.abs(tracker2.getScore("ancient") - 1) < 0.01, String(tracker2.getScore("ancient")));
  check("衰减后仍排在最近使用之后（F53）", tracker2.getRecentlyUsed(5)[0] === "help");
  // 损坏 JSON：load 静默吞错，空 Map 起步
  writeFileSync(join(workDir, ".mewcode", "command_usage.json"), "NOT JSON {{{", "utf-8");
  const tracker3 = new CommandUsageTracker(workDir);
  check("损坏 JSON 静默吞错空起步", tracker3.getRecentlyUsed(5).length === 0 && tracker3.getScore("help") === 0);
  rmSync(workDir, { recursive: true, force: true });
}

/** 5. 技能接线 */
function smokeSkills(): void {
  section("技能接线");
  const workDir = mkdtempSync(join(tmpdir(), "mewcode-skill-"));
  const skillsDir = join(workDir, ".mewcode", "skills");
  mkdirSync(join(skillsDir, "example"), { recursive: true });
  writeFileSync(
    join(skillsDir, "example", "SKILL.md"),
    "---\ndescription: An example inline skill\n---\nDo the example thing for $ARGUMENTS.",
    "utf-8",
  );
  mkdirSync(join(skillsDir, "isolated-helper"), { recursive: true });
  writeFileSync(
    join(skillsDir, "isolated-helper", "SKILL.md"),
    "---\ndescription: Runs in a forked context\nmode: fork\n---\nFork body.",
    "utf-8",
  );
  // 与内置同名的技能：应短路跳过
  mkdirSync(join(skillsDir, "help"), { recursive: true });
  writeFileSync(join(skillsDir, "help", "SKILL.md"), "---\ndescription: evil override\n---\nHijack.", "utf-8");

  const catalog = new SkillCatalog();
  const loaded = catalog.load(workDir);
  check("扫到 3 个技能目录", loaded.length === 3, String(loaded.length));
  check("inline/fork 模式解析", catalog.get("example")?.mode === "inline" && catalog.get("isolated-helper")?.mode === "fork");

  const registry: CommandRegistry = createDefaultRegistry();
  wireSkillsToRegistry(catalog, registry, null);
  const example = registry.find("example");
  check("inline 技能注册为 prompt + [skill] 后缀（AC16/F37/F39）", example?.type === "prompt" && example?.description.endsWith("[skill]"), example?.description);
  check("inline 技能正文渲染（F37）", example?.handler({ workDir, args: "stuff" }) === "Do the example thing for stuff.");
  check("fork 技能注册为 skill_fork（F38）", registry.find("isolated-helper")?.type === "skill_fork");
  check("与内置同名的技能短路跳过（F36）", registry.find("help")?.description === "Show available commands");
  const fullHelp = registry.find("help")!.handler({ workDir, args: "" });
  check("帮助列表出现 /example 且带 [skill]（AC16）", fullHelp.includes("/example") && fullHelp.includes("[skill]"));
  check("runSkillInline 纯函数可用", runSkillInline(catalog.get("example")!, "x") === "Do the example thing for x.");
  rmSync(workDir, { recursive: true, force: true });
}

smokeRegistry();
smokeHelp();
const cmdWorkDir = await smokeLoader();
smokeTracker();
smokeSkills();
rmSync(cmdWorkDir, { recursive: true, force: true });
rmSync(isolatedHome, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);

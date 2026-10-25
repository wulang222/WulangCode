/**
 * 用户自定义命令加载器（day9 T4）：扫 ~/.mewcode/commands 与
 * <workDir>/.mewcode/commands 两层目录的 .md 文件，解析 frontmatter，
 * 注册为 prompt 类型命令；项目层同名覆盖用户层（F31-F35a）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { Command } from "./commands.js";

/** 两层目录先后扫描，后扫到的同名条目覆盖前者（项目级覆盖用户级）。 */
export function loadUserCommands(workDir: string): Command[] {
  const byName = new Map<string, Command>();
  const dirs = [join(homedir(), ".mewcode", "commands"), join(workDir, ".mewcode", "commands")];
  for (const dir of dirs) {
    for (const cmd of walkDir(dir, dir)) {
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()];
}

function walkDir(base: string, dir: string): Command[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const commands: Command[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      commands.push(...walkDir(base, full));
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const cmd = parseCommandFile(base, full);
    if (cmd) commands.push(cmd);
  }
  return commands;
}

/** 相对路径切段：每段 lower、空格转 `-`，用 `:` 拼接（git/sync.md → git:sync）。 */
function commandName(base: string, full: string): string {
  const rel = full.slice(base.length + 1).replace(/\.md$/, "");
  return rel
    .split(/[/\\]/)
    .map((seg) => seg.toLowerCase().replace(/ /g, "-"))
    .join(":");
}

function parseCommandFile(base: string, full: string): Command | null {
  let content: string;
  try {
    content = readFileSync(full, "utf-8");
  } catch {
    return null;
  }
  const name = commandName(base, full);
  let body = content;
  let description = "";
  let aliases: string[] = [];
  if (content.startsWith("---")) {
    const lines = content.split("\n");
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) {
      body = lines.slice(end + 1).join("\n");
      try {
        const meta = yaml.load(lines.slice(1, end).join("\n")) as Record<string, unknown> | string | null;
        if (meta && typeof meta === "object") {
          if (typeof meta.description === "string" && meta.description.trim()) description = meta.description.trim();
          // argument-hint 已支持读取（F33）；Command 接口暂无对应字段，先解析不落库。
          if (typeof meta["argument-hint"] === "string") void meta["argument-hint"];
          if (Array.isArray(meta.aliases)) aliases = meta.aliases.map((a) => String(a));
          else if (typeof meta.aliases === "string" && meta.aliases.trim()) aliases = [meta.aliases.trim()];
        }
      } catch {
        body = content; // frontmatter 解析失败：整文件作正文，命令仍能注册（F33 降级）
      }
    }
  }
  return {
    name,
    aliases,
    type: "prompt",
    description: description || name,
    handler: (ctx) => renderBody(body, ctx.args),
  };
}

/** 正文渲染（F34）：含 $ARGUMENTS 全量替换；无占位但有参数时按"正文 + 空行 + 参数"拼接。 */
export function renderBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replace(/\$ARGUMENTS/g, args);
  if (args.trim()) return `${body}\n\n${args.trim()}`;
  return body;
}

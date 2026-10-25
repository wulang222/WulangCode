/**
 * 最小技能目录（day9 场景 G / F36-F39 的支撑模块）：扫两级
 * .mewcode/skills 下每个技能子目录的 SKILL.md，读 frontmatter
 * （name/description/mode），
 * inline 技能正文渲染为 prompt，fork 技能留给派生分支。
 * 完整 Skill 子系统（安装工具、派生运行时）后续章节再建。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { renderBody } from "../commands/loader.js";

export type SkillMode = "inline" | "fork";

export interface SkillMeta {
  name: string;
  description: string;
  mode: SkillMode;
  /** frontmatter 之后的正文（inline 模式渲染进 user 提示词）。 */
  body: string;
  path: string;
}

/** inline 技能渲染：正文 + $ARGUMENTS 替换（host 参数预留，后续接入高级渲染）。 */
export function runSkillInline(skill: SkillMeta, args: string, _host?: unknown): string {
  return renderBody(skill.body, args);
}

function parseSkillFile(skillDir: string, file: string): SkillMeta | null {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const fallbackName = skillDir.split(/[/\\]/).pop() ?? "skill";
  let body = content;
  let name = fallbackName.toLowerCase().replace(/ /g, "-");
  let description = "";
  let mode: SkillMode = "inline";
  if (content.startsWith("---")) {
    const lines = content.split("\n");
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) {
      body = lines.slice(end + 1).join("\n");
      try {
        const meta = yaml.load(lines.slice(1, end).join("\n")) as Record<string, unknown> | string | null;
        if (meta && typeof meta === "object") {
          if (typeof meta.name === "string" && meta.name.trim()) name = meta.name.trim().toLowerCase().replace(/ /g, "-");
          if (typeof meta.description === "string" && meta.description.trim()) description = meta.description.trim();
          if (meta.mode === "fork") mode = "fork";
        }
      } catch {
        body = content; // frontmatter 损坏：整文件作正文
      }
    }
  }
  return { name, description: description || name, mode, body: body.trim(), path: file };
}

export class SkillCatalog {
  private skills = new Map<string, SkillMeta>();

  /** 用户层与项目层各扫一遍，项目层同名覆盖（与用户命令加载同规则）。 */
  load(workDir: string): SkillMeta[] {
    const dirs = [join(homedir(), ".mewcode", "skills"), join(workDir, ".mewcode", "skills")];
    for (const base of dirs) {
      if (!existsSync(base)) continue;
      let entries: string[];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const skillDir = join(base, entry);
        try {
          if (!statSync(skillDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const skill = parseSkillFile(skillDir, join(skillDir, "SKILL.md"));
        if (skill) this.skills.set(skill.name, skill);
      }
    }
    return this.list();
  }

  list(): SkillMeta[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }
}

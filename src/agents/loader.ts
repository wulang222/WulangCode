import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import type { PermissionMode } from "../permissions/checker.js";
import { BUILTIN_AGENTS, type AgentDefinition } from "./definition.js";

/**
 * 三层加载：内置 → 用户级 ~/.mewcode/agents/ → 项目级 <workDir>/.mewcode/agents/（F6）。
 * 同名定义后加载覆盖先加载（F8）；单文件解析失败静默吞掉（F9/N4）。
 */
export function loadAgentDefinitions(workDir: string): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];
  loadDir(join(homedir(), ".mewcode", "agents"), definitions);
  loadDir(join(workDir, ".mewcode", "agents"), definitions);
  return definitions;
}

function loadDir(dir: string, definitions: AgentDefinition[]): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"));
      if (!def) continue;
      const index = definitions.findIndex((d) => d.name === def.name);
      if (index >= 0) definitions[index] = def;
      else definitions.push(def);
    } catch {
      continue;
    }
  }
}

/**
 * 解析单个定义文件：`---` 起头的 YAML frontmatter + Markdown 正文（F7）。
 * 缺 name 丢弃；缺 description 以正文前 200 字符兜底；正文非空填 initialPrompt。
 * 枚举字段（model / permission_mode 等）不校验取值，原样填入（场景 8 语义）。
 */
export function parseAgentDefinition(content: string): AgentDefinition | null {
  try {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") return null;
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end === -1) return null;
    const frontmatter = lines.slice(1, end).join("\n");
    const body = lines.slice(end + 1).join("\n").trim();
    const raw = yaml.load(frontmatter);
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return null;
    const description =
      typeof record.description === "string" && record.description.trim() ? record.description : body.slice(0, 200);

    const def: AgentDefinition = { name, description };
    if (isStringList(record.tools)) def.tools = record.tools;
    if (isStringList(record.disallowed_tools)) def.disallowedTools = record.disallowed_tools;
    if (typeof record.system_prompt === "string" && record.system_prompt) def.systemPromptOverride = record.system_prompt;
    if (typeof record.max_turns === "number" && Number.isFinite(record.max_turns)) def.maxTurns = Math.trunc(record.max_turns);
    if (typeof record.model === "string" && record.model) def.model = record.model;
    if (typeof record.permission_mode === "string" && record.permission_mode) def.permissionMode = record.permission_mode as PermissionMode;
    if (typeof record.background === "boolean") def.background = record.background;
    if (record.isolation === "worktree") def.isolation = "worktree";
    if (typeof record.omit_mewcode_md === "boolean") def.omitMewcodeMd = record.omit_mewcode_md;
    if (isStringList(record.skills)) def.skills = record.skills;
    if (typeof record.memory === "boolean") def.memory = record.memory;
    if (isStringList(record.mcp_servers)) def.mcpServers = record.mcp_servers;
    if (body) def.initialPrompt = body;
    return def;
  } catch {
    return null;
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

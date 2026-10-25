import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import yaml from "js-yaml";
import type { ToolCategory } from "../tools/types.js";

export type DecisionEffect = "allow" | "deny" | "ask";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Decision {
  effect: DecisionEffect;
  reason: string;
}

interface RuleEffect {
  effect: "allow" | "deny";
}

interface Rule extends RuleEffect {
  tool: string;
  pattern: string;
}

interface DangerousPattern {
  re: RegExp;
  reason: string;
}

/**
 * 危险命令黑名单：包级内置常量，无加载入口，任何模式（含 bypassPermissions）都拦（F1/N1）。
 * 启发式防御而非完备保证，覆盖最常见的灾难命令。
 */
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { re: /\brm\s+(?:-\w+\s+)*[/~]/, reason: "recursive delete targeting root or home directory" },
  { re: /\brm\s+(?:-\w+\s+)+\*/, reason: "recursive delete with wildcard" },
  { re: /\bmkfs(?:\.\w+)?\s+\//, reason: "format a filesystem" },
  { re: /\bdd\s+[^\n]*\bif=/, reason: "raw disk copy with dd" },
  { re: />\s*\/dev\/(?:sd|hd|nvme|disk)/, reason: "write to a block device" },
  { re: /\bchmod\s+-\w*R\w*\s+\d+\s+\//, reason: "chmod recursively on root" },
  { re: /:\(\)\s*\{\s*:\s*\|/, reason: "fork bomb" },
  { re: /\bcurl\s[^|]*\|\s*(?:ba)?sh(?:\s|$)/, reason: "pipe remote content into a shell" },
  { re: /\bwget\s[^|]*\|\s*(?:ba)?sh(?:\s|$)/, reason: "pipe remote content into a shell" },
  { re: /\bgit\s+push\b[^\n]*\s--force\b/, reason: "force push overwrites remote history" },
  { re: /\bgit\s+reset\s+--hard\b/, reason: "hard reset discards uncommitted changes" },
  { re: /\bgit\s+clean\s+[^|;&]*-\w*f/, reason: "git clean deletes untracked files" },
  { re: /\bgit\s+checkout\s+\.(?:\s|$)/, reason: "git checkout discards working tree changes" },
  { re: /\bgit\s+branch\s+-D\b/, reason: "force delete a branch" },
];

/** 安全只读命令前缀：完全相等 / 前缀+空格 / 前缀+Tab 三种匹配（F2）。 */
const SAFE_PREFIXES: readonly string[] = [
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "date",
  "whoami",
  "uname",
  "hostname",
  "which",
  "type",
  "file",
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git show",
  "git rev-parse",
  "git remote",
  "bun test",
  "bun run",
  "npm test",
  "npm run",
  "go test",
  "go build",
  "go vet",
  "python -c",
  "node -e",
];

/** 每个内置工具取「内容」的参数字段；未知工具无内容（空串，不误命中规则）。 */
const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  ReadFile: "file_path",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

/** 取工具调用的判定内容；字段缺失或非字符串按「无内容」处理（N7）。 */
export function extractContent(toolName: string, args: Record<string, unknown>): string {
  const field = CONTENT_FIELDS[toolName];
  if (!field) return "";
  const value = args[field];
  return typeof value === "string" ? value : "";
}

/** 计划文件目录约定：plan 模式下仅此目录内的写入被 Layer 0 豁免（F8）。 */
export const PLANS_DIR = ".mewcode/plans";

/**
 * 路径沙箱：文件类工具目标路径规整为绝对路径后与允许的根目录做前缀比对（F3）。
 * 不解析符号链接——软链接是已知盲区。命令执行类工具不走沙箱。
 */
export class PathSandbox {
  private readonly allowedRoots: string[];

  constructor(projectDir: string) {
    this.allowedRoots = [resolve(projectDir), "/tmp"];
  }

  addRoot(root: string): void {
    this.allowedRoots.push(resolve(root));
  }

  /** 命中允许根返回 null（放行），否则返回 deny 决策。 */
  check(filePath: string): Decision | null {
    const abs = resolve(filePath);
    if (this.allowedRoots.some((root) => abs === root || abs.startsWith(root + sep))) return null;
    return { effect: "deny", reason: `Path ${filePath} is outside allowed directories` };
  }
}

/**
 * glob 模式匹配：`*` 匹配除路径分隔符外的任意序列、`?` 单个非分隔符字符，
 * 其余按字面解释，整体首尾锚定；任何异常视为不命中（F5）。
 */
function globMatch(pattern: string, content: string): boolean {
  try {
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`^${re}$`).test(content);
  } catch {
    return false;
  }
}

/** 规则串形如 `Tool(pattern)`。 */
const RULE_RE = /^(\w+)\((.+)\)$/;

/**
 * 读取一个规则文件；不存在、读失败、解析失败、顶层非数组 → 空规则集；
 * 单条非法（effect 非法 / rule 不符格式 / 非对象）静默跳过，绝不让评估抛错（N5）。
 */
function loadRulesFile(path: string): Rule[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const rules: Rule[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { rule, effect } = entry as Record<string, unknown>;
    if (effect !== "allow" && effect !== "deny") continue;
    if (typeof rule !== "string") continue;
    const match = RULE_RE.exec(rule);
    if (!match) continue;
    rules.push({ tool: match[1]!, pattern: match[2]!, effect });
  }
  return rules;
}

/** 三级规则文件的显式路径覆盖（测试注入用；缺省按约定路径计算）。 */
export interface RuleFilePaths {
  user?: string;
  project?: string;
  local?: string;
}

/**
 * 三级配置规则引擎（F4/F5）：每次评估现读现匹配，「永久允许」写入即生效；
 * 三层按 用户级 → 项目级 → 本地级 顺序逐层评估，先命中即返回；
 * 层内按书写顺序末条优先（后写的规则覆盖前面）。
 */
export class RuleEngine {
  private readonly userPath: string;
  private readonly projectPath: string;
  private readonly localPath: string;

  constructor(workDir: string, paths?: RuleFilePaths) {
    this.userPath = paths?.user ?? join(homedir(), ".mewcode", "permissions.yaml");
    this.projectPath = paths?.project ?? join(workDir, ".mewcode", "permissions.yaml");
    this.localPath = paths?.local ?? join(workDir, ".mewcode", "permissions.local.yaml");
  }

  evaluate(toolName: string, content: string): "allow" | "deny" | null {
    for (const path of [this.userPath, this.projectPath, this.localPath]) {
      const rules = loadRulesFile(path);
      for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i]!;
        if (rule.tool !== toolName && rule.tool !== "*") continue;
        if (!globMatch(rule.pattern, content)) continue;
        return rule.effect;
      }
    }
    return null;
  }

  /** 把规则追加到本地级配置文件（跨重启生效）；序列化为 `Tool(pattern)` + effect 条目。 */
  appendLocalRule(rule: Rule): void {
    mkdirSync(dirname(this.localPath), { recursive: true });
    const rules = loadRulesFile(this.localPath);
    rules.push(rule);
    const entries = rules.map((r) => ({ rule: `${r.tool}(${r.pattern})`, effect: r.effect }));
    writeFileSync(this.localPath, yaml.dump(entries), "utf-8");
  }
}

/** 命中黑名单返回可读原因，否则空串。 */
function detectDangerous(command: string): string {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.re.test(command)) return pattern.reason;
  }
  return "";
}

const SHELL_METACHARS = /[>|;]|&&|\$\(|`/;

/**
 * 安全只读命令判定：先做元字符筛查（`>` `|` `;` `&&` `$(` 反引号任一即不放行，
 * 防 `cat … > /etc/shadow` 类白名单陷阱），再与安全前缀做三种匹配（F2/N2）。
 */
function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (SHELL_METACHARS.test(trimmed)) return false;
  return SAFE_PREFIXES.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`),
  );
}

/** 模式矩阵兜底：只产 Allow 或 Ask，绝不产 Deny（F7）。 */
function modeDecide(mode: PermissionMode, category: ToolCategory): DecisionEffect {
  switch (mode) {
    case "bypassPermissions":
      return "allow";
    case "acceptEdits":
      return category === "command" ? "ask" : "allow";
    case "plan":
      return category === "read" ? "allow" : "ask";
    default:
      return category === "read" ? "allow" : "ask";
  }
}

/** 会话级临时放行的键。 */
function sessionKey(toolName: string, content: string): string {
  return `${toolName}:${content}`;
}

/** 「永久允许」生成 pattern 的长度上限：超长截断，不自动泛化（F10）。 */
const ALLOW_ALWAYS_MAX = 60;

/** HITL 参数预览的单值截断长度。 */
const DESCRIBE_VALUE_MAX = 80;

/**
 * 多层权限判定入口：一次工具调用依次穿过
 * Layer 0 计划文件豁免 → Layer 2 安全命令 → Layer 3 黑名单 → Layer 4 沙箱
 * → Layer 4b 会话级放行 → Layer 5 规则引擎 → Layer 6 模式兜底，
 * 任一层产出 Allow / Deny 即短路返回，全部未拦且兜底为 Ask 时进入人在回路。
 */
export class PermissionChecker {
  mode: PermissionMode;
  planFilePath = "";

  private readonly sandbox: PathSandbox;
  private readonly ruleEngine: RuleEngine;
  private readonly sessionAllowed = new Set<string>();

  constructor(workDir: string, mode: PermissionMode = "default") {
    this.mode = mode;
    this.sandbox = new PathSandbox(workDir);
    this.ruleEngine = new RuleEngine(workDir);
  }

  check(toolName: string, category: ToolCategory, args: Record<string, unknown>): Decision {
    const content = extractContent(toolName, args);

    // Layer 0：计划模式下计划文件写入豁免，先于其余所有层（F8）。
    if (
      this.mode === "plan" &&
      (toolName === "WriteFile" || toolName === "EditFile") &&
      String(args.file_path ?? "").includes(`${PLANS_DIR}/`)
    ) {
      return { effect: "allow", reason: "Plan file write allowed in plan mode" };
    }

    // Layer 2：安全只读命令快速放行（元字符筛查是硬前置，N2）。
    if (category === "command" && isSafeCommand(content)) {
      return { effect: "allow", reason: "Safe read-only command" };
    }

    // Layer 3：危险命令黑名单，不可绕过（F1/N1）。
    if (category === "command") {
      const dangerReason = detectDangerous(content);
      if (dangerReason !== "") {
        return { effect: "deny", reason: `Dangerous command blocked: ${dangerReason}` };
      }
    }

    // Layer 4：路径沙箱，仅文件类工具；路径参数缺失或为空时跳过（F3）。
    if (category === "read" || category === "write") {
      const filePath = String(args.file_path ?? args.path ?? "");
      if (filePath !== "") {
        const sandboxDecision = this.sandbox.check(filePath);
        if (sandboxDecision) return sandboxDecision;
      }
    }

    // Layer 4b：会话级临时放行，进程内生效（F6）。
    if (this.sessionAllowed.has(sessionKey(toolName, content))) {
      return { effect: "allow", reason: "Session allow: previously approved" };
    }

    // Layer 5：三级配置规则，现读现匹配（F4/F5）。
    const ruleEffect = this.ruleEngine.evaluate(toolName, content);
    if (ruleEffect) {
      return { effect: ruleEffect, reason: `Permission rule: ${ruleEffect}` };
    }

    // Layer 6：模式矩阵兜底（F7）。
    return { effect: modeDecide(this.mode, category), reason: `Mode: ${this.mode}` };
  }

  /** 会话级放行：写入即生效，进程退出即失效，不落盘。 */
  allowForSession(toolName: string, args: Record<string, unknown>): void {
    this.sessionAllowed.add(sessionKey(toolName, extractContent(toolName, args)));
  }

  /** 永久放行：基于本次具体调用内容的精确匹配（超长截断），写入本地级配置。 */
  allowAlways(toolName: string, args: Record<string, unknown>): void {
    const content = extractContent(toolName, args);
    const pattern = content.length > ALLOW_ALWAYS_MAX ? `${content.slice(0, ALLOW_ALWAYS_MAX)}*` : `${content}*`;
    this.ruleEngine.appendLocalRule({ tool: toolName, pattern, effect: "allow" });
  }

  /** HITL Dialog 的参数预览：优先取内容字段，未取到则拼 k: v 列表。 */
  describeToolAction(toolName: string, args: Record<string, unknown>): string {
    const content = extractContent(toolName, args);
    if (content !== "") {
      return content.length > DESCRIBE_VALUE_MAX ? `${content.slice(0, DESCRIBE_VALUE_MAX)}…` : content;
    }
    return Object.entries(args)
      .map(([key, value]) => `${key}: ${String(value).slice(0, DESCRIBE_VALUE_MAX)}`)
      .join(", ");
  }
}
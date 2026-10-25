import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

/** @include 最大递归深度：覆盖正常模块化需求，误配时静默截断而非递归爆栈（F4）。 */
const MAX_INCLUDE_DEPTH = 5;

export interface InstructionSource {
  /** 加载源的绝对路径 */
  path: string;
  /** 已展开 @include 的内容 */
  content: string;
}

/** 从 start 向上找 .git 所在目录；不在仓库内返回 null。 */
function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** git root → workDir 路径上每一层目录（外→内）；无 git root 时回退 [workDir]（F1）。 */
function projectInstructionDirs(workDir: string): string[] {
  const abs = resolve(workDir);
  const root = findGitRoot(abs);
  if (!root) return [abs];
  const dirs: string[] = [abs];
  let cur = abs;
  while (cur !== root) {
    cur = dirname(cur);
    dirs.push(cur);
  }
  return dirs.reverse();
}

/**
 * 行首 @ 引用解析：`@./x`、`@../x`、`@~/x`、`@/x` 四种前缀；
 * `@@` 转义、含空白（如 @username 标注）、其他前缀一律不识别（F3）。
 */
function parseInclude(trimmed: string): string {
  if (!trimmed.startsWith("@") || trimmed.startsWith("@@")) return "";
  if (/\s/.test(trimmed)) return "";
  const p = trimmed.slice(1);
  if (p.startsWith("./") || p.startsWith("../") || p.startsWith("~/") || p.startsWith("/")) return p;
  return "";
}

function resolveInclude(p: string, baseDir: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return join(baseDir, p);
}

/**
 * 递归展开 @include：跨 fenced code block 时置 inCode 跳过（F3）；
 * seen 集合做循环检测，已展开过的路径保留原 @ 行不替换（F5）；
 * 引用目标不存在时保留原行静默跳过（F6）。
 */
function expandIncludes(content: string, baseDir: string, seen: Set<string>, depth: number): string {
  if (depth > MAX_INCLUDE_DEPTH) return content;
  const out: string[] = [];
  let inCode = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      out.push(line);
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const ref = parseInclude(trimmed);
    if (!ref) {
      out.push(line);
      continue;
    }
    const abs = resolveInclude(ref, baseDir);
    if (seen.has(abs) || !existsSync(abs)) {
      out.push(line);
      continue;
    }
    seen.add(abs);
    const included = readFileSync(abs, "utf-8");
    out.push(`<!-- included from ${ref} -->`);
    out.push(expandIncludes(included, dirname(abs), seen, depth + 1).replace(/\n+$/, ""));
  }
  return out.join("\n");
}

/** 读一个指令源（存在才展开 @include），加入 seen 后递归；失败静默跳过（F6）。 */
function addSource(out: InstructionSource[], seen: Set<string>, filePath: string): void {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return;
  let data: string;
  try {
    data = readFileSync(abs, "utf-8");
  } catch {
    return;
  }
  seen.add(abs);
  out.push({ path: abs, content: expandIncludes(data, dirname(abs), seen, 0) });
}

/**
 * 按优先级顺序发现全部指令源（F1，越靠后覆盖力越强）：
 * 用户全局 → git root..workDir 每层 → .mewcode/INSTRUCTIONS.md → MEWCODE.local.md。
 */
export function discoverInstructions(workDir: string): InstructionSource[] {
  const out: InstructionSource[] = [];
  const seen = new Set<string>();
  const abs = resolve(workDir);
  const home = homedir();

  addSource(out, seen, join(home, ".mewcode", "MEWCODE.md"));
  addSource(out, seen, join(home, ".mewcode", "AGENTS.md"));
  for (const dir of projectInstructionDirs(abs)) {
    addSource(out, seen, join(dir, "MEWCODE.md"));
    addSource(out, seen, join(dir, "AGENTS.md"));
  }
  addSource(out, seen, join(abs, ".mewcode", "INSTRUCTIONS.md"));
  addSource(out, seen, join(abs, "MEWCODE.local.md"));
  return out;
}

/** 拼接全部指令源：每段带 `Contents of <path>:` 前缀，多段用分隔线隔开（F2）。 */
export function loadInstructions(workDir: string): string {
  const abs = resolve(workDir);
  return discoverInstructions(abs)
    .map((source) => {
      const display = source.path.startsWith(abs) ? relative(abs, source.path) : source.path;
      return `Contents of ${display}:\n\n${source.content.replace(/\n+$/, "")}`;
    })
    .join("\n\n---\n\n");
}

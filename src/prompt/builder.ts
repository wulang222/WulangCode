import { execSync } from "node:child_process";
import { arch, platform } from "node:os";
import {
  doingTasksSection,
  environmentSection,
  executingActionsSection,
  identitySection,
  outputEfficiencySection,
  systemSection,
  toneStyleSection,
  usingToolsSection,
  type EnvironmentContext,
  type Section,
} from "./sections.js";

export interface BuildOptions {
  skillSection?: string;
  customInstructions?: string;
  memorySection?: string;
}

/** 按 priority 升序拼接非空段落。 */
export class PromptBuilder {
  private sections: Section[] = [];

  add(section: Section): this {
    this.sections.push(section);
    return this;
  }

  build(): string {
    return this.sections
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((section) => section.content.trim())
      .filter((content) => content.length > 0)
      .join("\n\n");
  }
}

function runGit(workDir: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** 探测工作目录、系统和 git 状态。探测失败按“不是仓库”处理。 */
export function detectEnvironment(workDir: string): EnvironmentContext {
  const inside = runGit(workDir, "rev-parse --is-inside-work-tree");
  const isGitRepo = inside === "true";
  const gitBranch = isGitRepo ? runGit(workDir, "rev-parse --abbrev-ref HEAD") ?? "" : "";
  return {
    workDir,
    os: platform(),
    arch: arch(),
    shell: process.env.SHELL ?? "bash",
    isGitRepo,
    gitBranch,
    model: "",
    date: new Date().toISOString().split("T")[0] ?? "",
  };
}

/** 拼出内置系统提示词。可选段落只在传入时追加。 */
export function buildSystemPrompt(env: EnvironmentContext, opts?: BuildOptions): string {
  const builder = new PromptBuilder()
    .add(identitySection())
    .add(systemSection())
    .add(doingTasksSection())
    .add(executingActionsSection())
    .add(usingToolsSection())
    .add(toneStyleSection())
    .add(outputEfficiencySection())
    .add(environmentSection(env));
  if (opts?.skillSection?.trim()) {
    builder.add({ name: "Skills", priority: 90, content: opts.skillSection });
  }
  if (opts?.customInstructions?.trim()) {
    builder.add({ name: "CustomInstructions", priority: 95, content: opts.customInstructions });
  }
  if (opts?.memorySection?.trim()) {
    builder.add({ name: "Memory", priority: 100, content: opts.memorySection });
  }
  return builder.build();
}

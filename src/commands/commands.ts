/**
 * 斜杠命令抽象与注册中心（day9 T1-T3）：四类命令类型、双向冲突检测、
 * parse 纯函数与 16 条内置命令。纯领域模块，不依赖 Ink / React。
 */
export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

/** dispatcher 调 handler 时传入的上下文；回调缺哪个命令输出就跳过哪行。 */
export interface CommandContext {
  workDir: string;
  args: string;
  conversation?: unknown;
  registry?: unknown;
  permissionMode?: () => string;
  tokenCount?: () => [number, number];
  toolCount?: () => number;
  memoryList?: () => string[];
  memoryClear?: () => void;
  model?: string;
}

export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  /** local：返回要 push 的文本；local_ui：返回动作 key；prompt：返回注入的 user 消息；skill_fork：占位空串。 */
  handler: (ctx: CommandContext) => string;
}

/**
 * 命令注册中心：主名表 + 别名表双向冲突检测（F1-F6）。
 * 注册内置命令冲突应爆给开发者；动态加载先 hasConflict 预检再决定跳过。
 */
export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, string>();

  register(cmd: Command): void {
    if (this.commands.has(cmd.name)) {
      throw new Error(`Command '${cmd.name}' already registered`);
    }
    const nameAliasOwner = this.aliasMap.get(cmd.name);
    if (nameAliasOwner !== undefined) {
      throw new Error(`Command name '${cmd.name}' collides with alias of '${nameAliasOwner}'`);
    }
    for (const alias of cmd.aliases) {
      const cmdOwner = this.commands.get(alias);
      if (cmdOwner !== undefined) {
        throw new Error(`Alias '${alias}' collides with existing command name '${cmdOwner.name}'`);
      }
      const aliasOwner = this.aliasMap.get(alias);
      if (aliasOwner !== undefined) {
        throw new Error(`Alias '${alias}' already registered by '${aliasOwner}'`);
      }
    }
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases) this.aliasMap.set(alias, cmd.name);
  }

  /** 非抛版冲突预检（F3）：名字或任一别名与现有条目任一方向相撞即 true。 */
  hasConflict(cmd: Command): boolean {
    return this.find(cmd.name) !== undefined || cmd.aliases.some((alias) => this.find(alias) !== undefined);
  }

  /** 主名与别名同查；store 时原样存不做 lower（F4）。 */
  find(name: string): Command | undefined {
    const direct = this.commands.get(name);
    if (direct) return direct;
    return this.commands.get(this.aliasMap.get(name) ?? "");
  }

  /** 大小写不敏感前缀匹配主名或任一别名（F6）。 */
  complete(prefix: string): Command[] {
    const lower = prefix.toLowerCase();
    return [...this.commands.values()].filter(
      (cmd) => cmd.name.toLowerCase().startsWith(lower) || cmd.aliases.some((alias) => alias.toLowerCase().startsWith(lower)),
    );
  }

  /** 按名字典序返回全部命令（F5），供 /help 与补全菜单消费。 */
  listCommands(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * 解析斜杠输入（F7）：非 `/` 开头返回 null；
 * 名字取首个空白前 token，参数取剩余串去首尾空白。
 */
export function parse(input: string): { name: string; args: string } | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}

/** 默认注册中心：一次性注册 16 条内置命令（F15-F30）。 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({
    name: "help",
    aliases: ["h", "?"],
    type: "local",
    description: "Show available commands",
    handler: (ctx) => {
      const arg = ctx.args.trim();
      if (arg) {
        const cmd = registry.find(arg);
        if (!cmd) return `Unknown command: /${arg}`;
        const lines = [`/${cmd.name} — ${cmd.description}`];
        if (cmd.aliases.length > 0) lines.push(`Aliases: ${cmd.aliases.join(", ")}`);
        return lines.join("\n");
      }
      const body = registry
        .listCommands()
        .map((cmd) => `  /${[cmd.name, ...cmd.aliases].join(", /")}\n    ${cmd.description}`)
        .join("\n");
      return `Available commands:\n\n${body}\n\nType /help <command> for details.`;
    },
  });

  registry.register({
    name: "clear",
    aliases: [],
    type: "local_ui",
    description: "Clear the conversation and reset token counters",
    handler: () => "clear",
  });

  registry.register({
    name: "compact",
    aliases: ["c"],
    type: "local_ui",
    description: "Force context compaction",
    handler: () => "compact",
  });

  registry.register({
    name: "status",
    aliases: ["s"],
    type: "local",
    description: "Show session status overview",
    handler: (ctx) => {
      // 兜底 6 行版；dispatcher 的 /status 特殊分支输出完整 10 行实时状态。
      const lines: string[] = [];
      if (ctx.permissionMode) lines.push(`Mode:      ${ctx.permissionMode()}`);
      if (ctx.model) lines.push(`Model:     ${ctx.model}`);
      if (ctx.tokenCount) {
        const [inputTokens, outputTokens] = ctx.tokenCount();
        lines.push(`Tokens:    ${inputTokens} in / ${outputTokens} out`);
      }
      if (ctx.toolCount) lines.push(`Tools:     ${ctx.toolCount()}`);
      if (ctx.memoryList) lines.push(`Memories:  ${ctx.memoryList().length}`);
      lines.push(`Directory: ${ctx.workDir}`);
      return lines.join("\n");
    },
  });

  registry.register({
    name: "session",
    aliases: [],
    type: "local",
    description: "Show current session info",
    handler: () => "Session is active. Use /resume to list past sessions.",
  });

  registry.register({
    name: "plan",
    aliases: ["p"],
    type: "local_ui",
    description: "Enter plan mode (read-only exploration, write plan file)",
    handler: () => "plan",
  });

  registry.register({
    name: "resume",
    aliases: ["r"],
    type: "local_ui",
    description: "List past sessions or restore one (/resume <id>)",
    handler: () => "resume",
  });

  registry.register({
    name: "quit",
    aliases: ["exit", "q"],
    type: "local_ui",
    description: "Quit MewCode",
    handler: () => "quit",
  });

  registry.register({
    name: "memory",
    aliases: [],
    type: "local",
    description: "List memories; /memory clear wipes them",
    handler: () => "memory",
  });

  registry.register({
    name: "permission",
    aliases: ["perm"],
    type: "local",
    description: "Show or set permission mode (/permission mode <name>)",
    handler: () => "permission",
  });

  registry.register({
    name: "skills",
    aliases: [],
    type: "local_ui",
    description: "List loaded skills",
    handler: () => "skills",
  });

  registry.register({
    name: "worktree",
    aliases: ["wt"],
    type: "local_ui",
    description: "List git worktrees",
    handler: () => "worktree",
  });

  registry.register({
    name: "code-review",
    aliases: ["cr"],
    type: "local",
    description: "Manage the code review team",
    handler: (ctx) => {
      const args = ctx.args.trim();
      if (!args) {
        return "Usage: /code-review <create|add|remove|list|status> [args...]";
      }
      return `code-review:${args}`;
    },
  });

  registry.register({
    name: "review",
    aliases: [],
    type: "prompt",
    description: "Ask the LLM to review uncommitted changes",
    handler: (ctx) => {
      const base =
        "Review the current uncommitted changes. Run `git status` and `git diff` to see them, " +
        "then report bugs, security issues, and possible simplifications.";
      const focus = ctx.args.trim();
      return focus ? `${base}\n\nFocus on: ${focus}` : base;
    },
  });

  registry.register({
    name: "rewind",
    aliases: [],
    type: "local_ui",
    description: "Open the rewind dialog to restore a checkpoint",
    handler: () => "rewind",
  });

  registry.register({
    name: "mcp",
    aliases: [],
    type: "local",
    description: "List connected MCP servers and tools",
    handler: () => "mcp",
  });

  return registry;
}

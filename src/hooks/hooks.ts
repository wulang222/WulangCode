import { execSync } from "node:child_process";
import type { HookConfig } from "../config/config.js";

/** 生命周期事件枚举（F4）：shutdown 保留枚举位，本期不在主流程上触发。 */
export type EventName =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "pre_send"
  | "post_receive"
  | "pre_tool_use"
  | "post_tool_use"
  | "shutdown";

export const EVENT_NAMES: EventName[] = [
  "session_start",
  "session_end",
  "turn_start",
  "turn_end",
  "pre_send",
  "post_receive",
  "pre_tool_use",
  "post_tool_use",
  "shutdown",
];

/** 派发上下文（F6）：工具名/入参/文件路径/消息文本按事件类型选择性携带。 */
export interface HookContext {
  event: EventName;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  message?: string;
}

/** 所有动作统一的三要素结果（F15）。 */
export interface HookResult {
  output: string;
  success: boolean;
  reject: boolean;
}

/** 子 Agent 动作执行器：由外部注入，未注入时 agent 动作标记失败（F14）。 */
export type AgentRunner = (prompt: string, ctx: HookContext) => Promise<string>;

/** shell 动作固定超时上限（N2：耗时任务应标记 async 转后台）。 */
const COMMAND_TIMEOUT_MS = 30_000;

/** once 去重键：缺省 id 时退化为「事件名-动作类型」组合（F19）。 */
function onceKeyOf(hook: HookConfig): string {
  return hook.id ?? `${hook.event}-${hook.action.type}`;
}

/** execSync 抛错时尽量带出 stderr，让 on_error 路径的输出可诊断（F22）。 */
function commandErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err != null && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" ? stderr.trim() : "";
    if (text) return `${message}\n${text}`;
  }
  return message;
}

export class HookEngine {
  private hooks: HookConfig[];
  private firedOnce = new Set<string>();
  private notifications: string[] = [];
  agentRunner?: AgentRunner;

  constructor(hooks: HookConfig[]) {
    this.hooks = hooks;
  }

  /** trim 后非空才入队（F23）。 */
  recordNotification(message: string): void {
    const text = message.trim();
    if (text) this.notifications.push(text);
  }

  /** 取出全部并清空（F23）。 */
  drainNotifications(): string[] {
    const out = this.notifications;
    this.notifications = [];
    return out;
  }

  /**
   * 派发一个事件到所有匹配的 hook，按声明顺序执行（F5/F29）。
   * 仅 pre_tool_use 事件消费拦截信号：遇到 reject 结果即中断后续 hook（F16/F17）。
   */
  async fire(event: EventName, ctx: HookContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const hook of this.hooks) {
      if (hook.event !== event) continue;
      // once 检查先于 condition（task 伪码顺序）：事件匹配即消耗一次触发（F19）。
      if (hook.once) {
        const key = onceKeyOf(hook);
        if (this.firedOnce.has(key)) continue;
        this.firedOnce.add(key);
      }
      if (hook.condition && !evaluateCondition(hook.condition, ctx)) continue;

      // 异步：不阻塞主流程，输出/异常经通知队列回流（F21/F26）。
      // 注意 async 函数体在首个 await 前是同步执行的（execSync 会当场阻塞），
      // 必须经宏任务调度才能真正转后台，保证 fire 立即返回（G7）。
      if (hook.async) {
        setTimeout(() => {
          this.executeAction(hook, ctx)
            .then((r) => this.recordNotification(r.output))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              this.recordNotification(`Async hook error: ${message}`);
            });
        }, 0);
        results.push({ output: "(async)", success: true, reject: false });
        continue;
      }

      try {
        const result = await this.executeAction(hook, ctx);
        results.push(result);
        if (result.reject && event === "pre_tool_use") break;
      } catch (err) {
        // 同步动作抛错由错误策略决定行为（F22）。
        const policy = hook.on_error ?? "ignore";
        if (policy === "fail") {
          results.push({ output: `Hook error: ${commandErrorText(err)}`, success: false, reject: false });
        } else if (policy === "reject") {
          results.push({
            output: `Hook error (rejecting): ${commandErrorText(err)}`,
            success: false,
            reject: true,
          });
          if (event === "pre_tool_use") break;
        }
        // ignore（默认）：不进结果列表，不影响主流程
      }
    }
    return results;
  }

  /**
   * 「工具调用前」专用入口（F5/F6）：从工具入参自动提取文件路径，
   * 返回是否拦截与拒绝原因；调用方据此跳过权限检查与实际执行（F16）。
   */
  async firePreToolHooks(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ rejected: boolean; reason: string }> {
    const ctx: HookContext = {
      event: "pre_tool_use",
      toolName,
      args,
      filePath: String(args.file_path ?? args.path ?? ""),
    };
    const results = await this.fire("pre_tool_use", ctx);
    for (const r of results) {
      if (r.reject) return { rejected: true, reason: r.output };
    }
    return { rejected: false, reason: "" };
  }

  /** 四类动作执行器（F11-F14）。 */
  private async executeAction(hook: HookConfig, ctx: HookContext): Promise<HookResult> {
    const action = hook.action;
    switch (action.type) {
      case "command": {
        // 三个固定环境变量，不传完整工具入参（N6）；固定 30s 超时（N2）；
        // stderr 走管道留给 on_error 诊断，不直接打脏 TUI。
        const output = execSync(action.command ?? "", {
          encoding: "utf-8",
          timeout: COMMAND_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            MEWCODE_EVENT: ctx.event,
            MEWCODE_TOOL: ctx.toolName ?? "",
            MEWCODE_FILE_PATH: ctx.filePath ?? "",
          },
        });
        return { output: output.trim(), success: true, reject: hook.reject ?? false };
      }
      case "prompt":
        return { output: action.prompt ?? "", success: true, reject: false };
      case "http": {
        // 请求体固定为上下文 JSON 序列化，方法默认 POST（F13/N7）。
        const resp = await fetch(action.url ?? "", {
          method: action.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctx),
        });
        const output = await resp.text();
        return { output, success: resp.ok, reject: hook.reject ?? false };
      }
      case "agent": {
        // 子 Agent 需要外部注入执行器；未注入时失败但仍按拦截标记决定是否拦截（F14）。
        if (!this.agentRunner) {
          return {
            output: "agent-type hook configured but no AgentRunner registered",
            success: false,
            reject: hook.reject ?? false,
          };
        }
        try {
          const output = await this.agentRunner(action.prompt ?? action.command ?? "", ctx);
          return { output, success: true, reject: hook.reject ?? false };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { output: message, success: false, reject: hook.reject ?? false };
        }
      }
      default:
        return { output: "", success: false, reject: false };
    }
  }
}

// ---------- 条件表达式求值（F7-F10） ----------

/**
 * 单行条件表达式：按 && / || 切成原子条件，左结合累积求值，不支持括号（F7）。
 * 原子条件无副作用，短路与顺序累积等价。
 */
function evaluateCondition(condition: string, ctx: HookContext): boolean {
  const tokens = condition.split(/\s*(&&|\|\|)\s*/);
  let result = evaluateSingleCondition(tokens[0] ?? "", ctx);
  // split 保证奇数位是操作符、偶数位是原子；左结合顺序累积（无括号优先级）。
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i]!;
    const rhs = evaluateSingleCondition(tokens[i + 1]!, ctx);
    result = op === "&&" ? result && rhs : result || rhs;
  }
  return result;
}

/** 单个原子条件：! 取反前缀 + == / != / =~ / =* 四种二元算子；未命中规则返回 false（F8）。 */
function evaluateSingleCondition(expr: string, ctx: HookContext): boolean {
  const trimmed = expr.trim();
  if (trimmed.startsWith("!")) return !evaluateSingleCondition(trimmed.slice(1), ctx);
  let m = /^(\w+)\s*==\s*"([^"]*)"$/.exec(trimmed);
  if (m) return getContextValue(m[1]!, ctx) === m[2];
  m = /^(\w+)\s*!=\s*"([^"]*)"$/.exec(trimmed);
  if (m) return getContextValue(m[1]!, ctx) !== m[2];
  m = /^(\w+)\s*=~\s*"([^"]*)"$/.exec(trimmed);
  if (m) {
    // 运行时正则非法静默视为不匹配（N5）
    try {
      return new RegExp(m[2]!).test(getContextValue(m[1]!, ctx));
    } catch {
      return false;
    }
  }
  m = /^(\w+)\s*=\*\s*"([^"]*)"$/.exec(trimmed);
  if (m) return globToRegExp(m[2]!).test(getContextValue(m[1]!, ctx));
  return false;
}

/** glob → 正则：** 跨目录、* 不跨分隔符、? 单字符，其余按字面量（F8）。 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += ".";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** 字段取值：4 个保留 key + 任意工具入参兜底（按名取值并转字符串）；未命中返回空串（F9）。 */
function getContextValue(key: string, ctx: HookContext): string {
  if (key === "tool") return ctx.toolName ?? "";
  if (key === "event") return ctx.event;
  if (key === "file_path") return ctx.filePath ?? "";
  if (key === "message") return ctx.message ?? "";
  const value = ctx.args?.[key];
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

// ---------- 校验（F27-F29） ----------

const VALID_EVENTS = new Set<string>(EVENT_NAMES);
const VALID_ACTIONS = new Set<string>(["command", "prompt", "http", "agent"]);

/**
 * 聚合校验所有 hook 的配置错误，单条出错不阻塞其它（F28/F29）。
 * 返回 null 表示全部合法；错误用 "; " 拼成单条 Error，由调用方以系统消息呈现（F27）。
 */
export function validate(hooks: HookConfig[]): Error | null {
  const errors: string[] = [];
  hooks.forEach((hook, i) => {
    const tag = hook.id ? `hook[${i}] (id="${hook.id}")` : `hook[${i}]`;
    if (!hook.event) {
      errors.push(`${tag}: event is required`);
    } else if (!VALID_EVENTS.has(hook.event)) {
      errors.push(`${tag}: invalid event '${hook.event}'`);
    }
    const type = hook.action?.type;
    if (!type) {
      errors.push(`${tag}: action.type is required`);
    } else if (!VALID_ACTIONS.has(type)) {
      errors.push(`${tag}: invalid action type '${type}'`);
    } else if (type === "command" && !hook.action.command) {
      errors.push(`${tag}: command action requires 'command'`);
    } else if (type === "prompt" && !hook.action.prompt) {
      errors.push(`${tag}: prompt action requires 'prompt'`);
    } else if (type === "http" && !hook.action.url) {
      errors.push(`${tag}: http action requires 'url'`);
    } else if (type === "agent" && !hook.action.prompt && !hook.action.command) {
      errors.push(`${tag}: agent action requires 'prompt' or 'command'`);
    }
    if (hook.reject && hook.async) {
      errors.push(`${tag}: reject and async are mutually exclusive`);
    }
  });
  if (errors.length === 0) return null;
  return new Error(errors.join("; "));
}

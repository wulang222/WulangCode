import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

/** 配置层错误：缺文件、格式非法、字段缺失。启动期抛出，不带堆栈给用户。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ProviderConfig {
  name: string;
  /** "anthropic" | "openai" | "openai-compat" */
  protocol: string;
  base_url: string;
  model: string;
  api_key?: string;
  /** 仅 anthropic 协议生效 */
  thinking?: boolean;
  context_window?: number;
  max_output_tokens?: number;
}

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface HookConfig {
  event: string;
  command: string;
}

export interface AppConfig {
  providers: ProviderConfig[];
  permission_mode?: string;
  mcp_servers: MCPServerConfig[];
  hooks: HookConfig[];
}

const PROTOCOLS = ["anthropic", "openai", "openai-compat"] as const;

/** 协议 → 环境变量。配置里没写 api_key 时走这里。 */
const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

/**
 * 模型名子串 → 上下文窗口。更长、更具体的键放前面。
 * 返回 0 表示表里没有，交给调用方用保守默认值。
 */
const MODEL_CONTEXT_WINDOWS: Array<[string, number]> = [
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3-7", 200_000],
  ["claude-3-5", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-3-sonnet", 200_000],
  ["claude-3-haiku", 200_000],
  ["claude-3", 200_000],
  ["claude-2", 100_000],
  ["claude", 200_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 128_000],
  ["gpt-3.5", 16_385],
  ["o4", 200_000],
  ["o3", 200_000],
  ["o1", 200_000],
];

const contextWindowCache = new Map<string, number>();

function emptyConfig(): AppConfig {
  return { providers: [], mcp_servers: [], hooks: [] };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function parseProviders(raw: unknown): ProviderConfig[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ConfigError("providers 必须是列表");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError(`Provider #${index + 1}: 必须是映射`);
    }
    const row = item as Record<string, unknown>;
    const apiKey = row.api_key;
    return {
      name: asString(row.name),
      protocol: asString(row.protocol),
      base_url: asString(row.base_url),
      model: asString(row.model),
      api_key: apiKey == null || apiKey === "" ? undefined : String(apiKey),
      thinking: typeof row.thinking === "boolean" ? row.thinking : undefined,
      context_window: asOptionalNumber(row.context_window),
      max_output_tokens: asOptionalNumber(row.max_output_tokens),
    };
  });
}

function parseMCPServers(raw: unknown): MCPServerConfig[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ConfigError("mcp_servers 必须是列表");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError(`mcp_servers #${index + 1} 必须是映射`);
    }
    const row = item as Record<string, unknown>;
    return {
      name: asString(row.name),
      command: asString(row.command) || undefined,
      args: Array.isArray(row.args) ? row.args.map((part) => String(part)) : undefined,
      url: asString(row.url) || undefined,
      env: asStringRecord(row.env),
    };
  });
}

function parseHooks(raw: unknown): HookConfig[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ConfigError("hooks 必须是列表");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError(`hooks #${index + 1} 必须是映射`);
    }
    const row = item as Record<string, unknown>;
    return { event: asString(row.event), command: asString(row.command) };
  });
}

/** 读一个 YAML。空文件得到空列表。文件不存在或格式错误抛 ConfigError。 */
export function loadSingleFile(path: string): AppConfig {
  if (!existsSync(path)) throw new ConfigError(`No config file found: ${path}`);
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`配置文件格式错误 ${path}: ${message}`);
  }
  if (parsed == null) return emptyConfig();
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件格式错误 ${path}: 顶层必须是映射`);
  }
  const row = parsed as Record<string, unknown>;
  const config: AppConfig = {
    providers: parseProviders(row.providers),
    mcp_servers: parseMCPServers(row.mcp_servers),
    hooks: parseHooks(row.hooks),
  };
  if (typeof row.permission_mode === "string") config.permission_mode = row.permission_mode;
  return config;
}

/**
 * 后层覆盖前层。
 * providers 非空时整列替换；mcp_servers 按 name 合并；hooks 追加。
 */
export function mergeConfig(base: AppConfig, override: AppConfig): AppConfig {
  const servers = new Map<string, MCPServerConfig>();
  for (const server of base.mcp_servers) servers.set(server.name, server);
  for (const server of override.mcp_servers) servers.set(server.name, server);
  return {
    providers: override.providers.length > 0 ? override.providers : base.providers,
    permission_mode: override.permission_mode ?? base.permission_mode,
    mcp_servers: [...servers.values()],
    hooks: [...base.hooks, ...override.hooks],
  };
}

export function validateProviders(providers: ProviderConfig[]): void {
  if (providers.length === 0) {
    throw new ConfigError("At least one provider must be configured");
  }
  providers.forEach((provider, index) => {
    const missing: string[] = [];
    if (!provider.name) missing.push("name");
    if (!provider.protocol) missing.push("protocol");
    if (!provider.base_url) missing.push("base_url");
    if (!provider.model) missing.push("model");
    if (missing.length > 0) {
      throw new ConfigError(`Provider #${index + 1}: missing fields: ${missing.join(", ")}`);
    }
    if (!PROTOCOLS.includes(provider.protocol as (typeof PROTOCOLS)[number])) {
      throw new ConfigError(
        `Provider #${index + 1}: invalid protocol '${provider.protocol}', must be one of: ${PROTOCOLS.join(", ")}`,
      );
    }
  });
}

function configPaths(): string[] {
  return [
    join(homedir(), ".mewcode", "config.yaml"),
    join(process.cwd(), ".mewcode", "config.yaml"),
    join(process.cwd(), ".mewcode", "config.local.yaml"),
  ];
}

/**
 * 显式 path 只读那一个文件。
 * 否则按用户全局 → 项目 → 本地覆盖合并。三处都不存在则报错。缺的层跳过。
 */
export function loadConfig(path?: string): AppConfig {
  if (path) {
    const config = loadSingleFile(path);
    validateProviders(config.providers);
    return config;
  }
  const paths = configPaths();
  const existing = paths.filter((item) => existsSync(item));
  if (existing.length === 0) {
    throw new ConfigError(
      `No config file found. 已查找: ${paths.join(", ")}。可复制 .mewcode/config.yaml.example`,
    );
  }
  let config = emptyConfig();
  for (const item of existing) config = mergeConfig(config, loadSingleFile(item));
  validateProviders(config.providers);
  return config;
}

/** 优先配置里的密钥，否则按协议读环境变量。都没有则返回空字符串。 */
export function resolveAPIKey(provider: ProviderConfig): string {
  if (provider.api_key && provider.api_key.trim()) return provider.api_key.trim();
  const envName = ENV_KEY_MAP[provider.protocol];
  if (!envName) return "";
  return process.env[envName]?.trim() ?? "";
}

/** 显式 max_output_tokens > 0 优先；开了 thinking 用 64000；否则 8192。 */
export function getMaxOutputTokens(provider: ProviderConfig): number {
  if (provider.max_output_tokens && provider.max_output_tokens > 0) return provider.max_output_tokens;
  if (provider.thinking) return 64_000;
  return 8192;
}

/** 子串表查找。未命中返回 0。 */
export function lookupModelContextWindow(model: string): number {
  const lower = model.toLowerCase();
  for (const [key, value] of MODEL_CONTEXT_WINDOWS) {
    if (lower.includes(key)) return value;
  }
  return 0;
}

function conservativeWindow(provider: ProviderConfig): number {
  return provider.protocol === "anthropic" ? 200_000 : 128_000;
}

/** 同步四级回退的第 1、3、4 层（跳过网络探测）。 */
export function getContextWindow(provider: ProviderConfig): number {
  if (provider.context_window && provider.context_window > 0) return provider.context_window;
  const looked = lookupModelContextWindow(provider.model);
  if (looked > 0) return looked;
  return conservativeWindow(provider);
}

/**
 * 在同步结果上再加第 2 层：anthropic 时用 fetcher 拿 max_input_tokens。
 * 失败降级，不抛。结果按 name+model 缓存。
 */
export async function getContextWindowAsync(
  provider: ProviderConfig,
  fetcher?: (provider: ProviderConfig) => Promise<number>,
): Promise<number> {
  const cacheKey = `${provider.name}+${provider.model}`;
  const cached = contextWindowCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (provider.context_window && provider.context_window > 0) {
    contextWindowCache.set(cacheKey, provider.context_window);
    return provider.context_window;
  }

  let probe = fetcher;
  if (!probe && provider.protocol === "anthropic") {
    const mod = await import("../llm/anthropic.js");
    probe = mod.fetchModelContextWindow;
  }
  if (probe && provider.protocol === "anthropic") {
    try {
      const detected = await probe(provider);
      if (detected > 0) {
        contextWindowCache.set(cacheKey, detected);
        return detected;
      }
    } catch {
      // 探测失败就降级，不阻塞启动
    }
  }

  const looked = lookupModelContextWindow(provider.model);
  const value = looked > 0 ? looked : conservativeWindow(provider);
  contextWindowCache.set(cacheKey, value);
  return value;
}

/** 测试用：清空上下文窗口缓存。 */
export function _resetContextWindowCache(): void {
  contextWindowCache.clear();
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ConfigError,
  getContextWindow,
  getContextWindowAsync,
  getMaxOutputTokens,
  loadConfig,
  mergeConfig,
  resolveAPIKey,
  _resetContextWindowCache,
  type AppConfig,
  type MCPServerConfig,
  type ProviderConfig,
} from "../src/config/config.ts";

const dirs: string[] = [];

function writeYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mewcode-config-"));
  dirs.push(dir);
  const path = join(dir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  _resetContextWindowCache();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const sample = `
providers:
  - name: anthropic
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-5
    api_key: test-key
    thinking: true
`;

describe("loadConfig", () => {
  test("合法配置返回对应条数", () => {
    const path = writeYaml(sample);
    const config = loadConfig(path);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.model).toBe("claude-sonnet-4-5");
    expect(config.providers[0]?.thinking).toBe(true);
    expect(config.mcp_servers).toEqual([]);
    expect(config.hooks).toEqual([]);
  });

  test("缺字段抛 ConfigError", () => {
    const path = writeYaml(`
providers:
  - name: only-name
    protocol: anthropic
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("Provider #1: missing fields:");
      expect((err as Error).message).toContain("model");
    }
  });

  test("非法 protocol 抛 ConfigError", () => {
    const path = writeYaml(`
providers:
  - name: bad
    protocol: gemini
    base_url: https://example.com
    model: x
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      expect((err as Error).message).toContain("invalid protocol 'gemini'");
    }
  });

  test("文件不存在抛 ConfigError", () => {
    expect(() => loadConfig(join(tmpdir(), "mewcode-missing-config.yaml"))).toThrow(ConfigError);
  });
});

describe("resolveAPIKey", () => {
  const base: ProviderConfig = {
    name: "anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
  };

  test("优先使用 api_key", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "from-env";
    try {
      expect(resolveAPIKey({ ...base, api_key: "from-file" })).toBe("from-file");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("缺失 api_key 时读环境变量", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-openai";
    try {
      expect(
        resolveAPIKey({
          name: "compat",
          protocol: "openai-compat",
          base_url: "https://example.com/v1",
          model: "gpt-4o",
        }),
      ).toBe("env-openai");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("两处都缺返回空字符串", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(resolveAPIKey(base)).toBe("");
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("mergeConfig 与窗口推导", () => {
  test("providers 整列覆盖，hooks 追加，mcp 按 name 合并", () => {
    const base: AppConfig = {
      providers: [
        { name: "home", protocol: "anthropic", base_url: "https://api.anthropic.com", model: "old" },
      ],
      mcp_servers: [{ name: "a", command: "old" }, { name: "b", command: "keep" }],
      hooks: [{ event: "turn_start", action: { type: "prompt", prompt: "a" } }],
      permission_mode: "default",
    };
    const override: AppConfig = {
      providers: [
        { name: "project", protocol: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o" },
      ],
      mcp_servers: [{ name: "a", command: "new" }],
      hooks: [{ event: "session_end", action: { type: "command", command: "echo b" } }],
    };
    const merged = mergeConfig(base, override);
    expect(merged.providers.map((item) => item.name)).toEqual(["project"]);
    expect(merged.mcp_servers.find((item) => item.name === "a")?.command).toBe("new");
    expect(merged.mcp_servers.find((item) => item.name === "b")?.command).toBe("keep");
    expect(merged.hooks).toHaveLength(2);
    expect(merged.permission_mode).toBe("default");
  });

  test("appends hooks（day10 T12：后层 hooks 直接叠加，不按 id 覆盖）", () => {
    const base: AppConfig = {
      providers: [],
      mcp_servers: [],
      hooks: [{ id: "a", event: "turn_start", action: { type: "prompt", prompt: "请用中文回答" } }],
    };
    const override: AppConfig = {
      providers: [],
      mcp_servers: [],
      hooks: [{ id: "a", event: "turn_start", action: { type: "prompt", prompt: "同 id 也追加" } }],
    };
    const result = mergeConfig(base, override);
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0]?.id).toBe("a");
    expect(result.hooks[1]?.id).toBe("a");
  });

  test("getMaxOutputTokens 与 getContextWindow 回退", () => {
    const provider: ProviderConfig = {
      name: "a",
      protocol: "anthropic",
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      thinking: true,
    };
    expect(getMaxOutputTokens(provider)).toBe(64_000);
    expect(getMaxOutputTokens({ ...provider, max_output_tokens: 1000, thinking: false })).toBe(1000);
    expect(getContextWindow(provider)).toBe(200_000);
    expect(getContextWindow({ ...provider, context_window: 4096 })).toBe(4096);
    expect(
      getContextWindow({
        name: "o",
        protocol: "openai",
        base_url: "https://api.openai.com/v1",
        model: "unknown-model-xyz",
      }),
    ).toBe(128_000);
  });

  test("探测失败时降级到内置窗口，不抛错", async () => {
    const provider: ProviderConfig = {
      name: "a",
      protocol: "anthropic",
      base_url: "http://127.0.0.1:1",
      model: "claude-sonnet-4-5",
    };
    const value = await getContextWindowAsync(provider, async () => {
      throw new Error("probe failed");
    });
    expect(value).toBe(200_000);
  });
});

describe("mcp_servers 配置", () => {
  test("三层 mergeConfig 链式合并：同名后层完整覆盖前层、保位，新名追加尾部（AC1）", () => {
    const layer1 = emptyCfg([{ name: "github", command: "old-cmd", args: ["a"] }, { name: "keep", command: "keep-cmd" }]);
    const layer2 = emptyCfg([{ name: "github", url: "https://mcp.github.com", headers: { Authorization: "Bearer ${GH_TOKEN}" } }]);
    const layer3 = emptyCfg([{ name: "sqlite", command: "sqlite-server" }]);
    const merged = mergeConfig(mergeConfig(layer1, layer2), layer3);
    const names = merged.mcp_servers.map((server) => server.name);
    expect(names).toEqual(["github", "keep", "sqlite"]);
    // 完整覆盖：command/args 没有残留前层字段
    expect(merged.mcp_servers[0]).toEqual({
      name: "github",
      url: "https://mcp.github.com",
      headers: { Authorization: "Bearer ${GH_TOKEN}" },
    });
    expect(merged.mcp_servers[1]?.command).toBe("keep-cmd");
  });

  test("loadSingleFile 解析 transport / headers / env / args（AC2/F2）", () => {
    const path = writeYaml(`
providers:
  - name: p
    protocol: openai-compat
    base_url: https://example.com
    model: m
mcp_servers:
  - name: remote-sse
    url: https://sse.example.com/mcp
    transport: sse
    headers:
      Authorization: "Bearer \${TOKEN}"
  - name: local
    command: npx
    args: ["-y", "some-server"]
    env:
      GITHUB_TOKEN: "\${GITHUB_TOKEN}"
`);
    const config = loadConfig(path);
    expect(config.mcp_servers.length).toBe(2);
    expect(config.mcp_servers[0]).toEqual({
      name: "remote-sse",
      url: "https://sse.example.com/mcp",
      transport: "sse",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    expect(config.mcp_servers[1]?.command).toBe("npx");
    expect(config.mcp_servers[1]?.args).toEqual(["-y", "some-server"]);
    expect(config.mcp_servers[1]?.env).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}" });
  });

  test("mcp_servers 非 list 抛 ConfigError（进程退出路径）", () => {
    const path = writeYaml(`
providers:
  - name: p
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-3-5-sonnet
mcp_servers: not-a-list
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});

describe("hooks 配置（day10）", () => {
  test("loadSingleFile 解析完整 HookConfig 字段（F2）", () => {
    const path = writeYaml(`
providers:
  - name: p
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-3-5-sonnet
hooks:
  - id: block-write
    event: pre_tool_use
    condition: 'tool == "WriteFile"'
    reject: true
    once: false
    on_error: reject
    action:
      type: command
      command: "false"
  - id: notify
    event: post_receive
    async: true
    action:
      type: http
      url: "http://127.0.0.1:9999/recv"
      method: POST
`);
    const config = loadConfig(path);
    expect(config.hooks).toHaveLength(2);
    expect(config.hooks[0]).toEqual({
      id: "block-write",
      event: "pre_tool_use",
      condition: 'tool == "WriteFile"',
      action: { type: "command", command: "false" },
      reject: true,
      on_error: "reject",
    });
    expect(config.hooks[1]).toEqual({
      id: "notify",
      event: "post_receive",
      action: { type: "http", url: "http://127.0.0.1:9999/recv", method: "POST" },
      async: true,
    });
  });

  test("loadSingleFile 三层叠加后 hooks 全部生效（F1）", () => {
    const dir = mkdtempSync(join(tmpdir(), "mewcode-config-"));
    dirs.push(dir);
    const provider = `
providers:
  - name: p
    protocol: anthropic
    base_url: https://api.anthropic.com
    model: claude-3-5-sonnet
`;
    writeFileSync(join(dir, "config.yaml"), `${provider}hooks:\n  - event: turn_start\n    action: {type: prompt, prompt: "1"}`);
    writeFileSync(join(dir, "config.local.yaml"), `${provider}hooks:\n  - event: turn_end\n    action: {type: prompt, prompt: "2"}`);
    const config = loadConfig(join(dir, "config.yaml"));
    const local = loadConfig(join(dir, "config.local.yaml"));
    const merged = mergeConfig(mergeConfig(config, { providers: [], mcp_servers: [], hooks: [] }), local);
    expect(merged.hooks.map((h) => h.event)).toEqual(["turn_start", "turn_end"]);
  });
});

function emptyCfg(mcp_servers: MCPServerConfig[]): AppConfig {
  return { providers: [], mcp_servers, hooks: [] };
}

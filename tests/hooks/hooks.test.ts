import { describe, expect, test } from "bun:test";
import { HookEngine, validate } from "../../src/hooks/hooks.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ctx(event: Parameters<HookEngine["fire"]>[0], extra: Record<string, unknown> = {}) {
  return { event, ...extra } as Parameters<HookEngine["fire"]>[1];
}

// ---------- 主体：fire / firePreToolHooks / 通知队列 ----------

describe("HookEngine.fire 派发", () => {
  test("事件不匹配跳过、once 命中跳过、condition 不通过跳过（三个分支）", async () => {
    const engine = new HookEngine([
      { event: "turn_end", action: { type: "prompt", prompt: "其它事件" } },
      { event: "turn_start", once: true, action: { type: "prompt", prompt: "once" } },
      { event: "turn_start", condition: 'tool == "WriteFile"', action: { type: "prompt", prompt: "cond" } },
      { event: "turn_start", action: { type: "prompt", prompt: "命中" } },
    ]);
    const r1 = await engine.fire("turn_start", ctx("turn_start"));
    expect(r1.map((r) => r.output)).toEqual(["once", "命中"]);
    // 第二次 fire：once 已消耗，只剩第 4 条 + condition 不通过的第 3 条仍跳过
    const r2 = await engine.fire("turn_start", ctx("turn_start"));
    expect(r2.map((r) => r.output)).toEqual(["命中"]);
  });

  test("结果按声明顺序返回，prompt 动作 output 即 prompt 本身（F12）", async () => {
    const engine = new HookEngine([
      { event: "turn_start", action: { type: "prompt", prompt: "first" } },
      { event: "turn_start", action: { type: "prompt", prompt: "second" } },
    ]);
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(results.map((r) => r.output)).toEqual(["first", "second"]);
    expect(results.every((r) => r.success)).toBe(true);
  });
});

describe("firePreToolHooks", () => {
  test("自动从 args 提取 filePath（file_path 优先，path 兜底）", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        condition: 'file_path =* "**/*.txt"',
        action: { type: "prompt", prompt: "txt-hook" },
      },
    ]);
    const a = await engine.firePreToolHooks("WriteFile", { file_path: "/a/b/c.txt" });
    expect(a.rejected).toBe(false);
    const b = await engine.firePreToolHooks("WriteFile", { path: "rel.txt", other: 1 });
    expect(b.rejected).toBe(false);
    // 命中 reject 的路径在拦截用例里覆盖
  });

  test("命中 reject:true 返回 rejected 与 reason=hook.output（command 动作承载拦截标记）", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        reject: true,
        action: { type: "command", command: "echo blocked-by-policy" },
      },
    ]);
    const r = await engine.firePreToolHooks("Bash", { command: "rm -rf /" });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("blocked-by-policy");
  });
});

describe("通知队列", () => {
  test("recordNotification / drainNotifications 一进一出，drain 后清空；空串不入队", () => {
    const engine = new HookEngine([]);
    engine.recordNotification("a");
    engine.recordNotification("b");
    engine.recordNotification("   ");
    expect(engine.drainNotifications()).toEqual(["a", "b"]);
    expect(engine.drainNotifications()).toHaveLength(0);
  });
});

// ---------- 四类动作执行器 ----------

describe("command 动作", () => {
  test("execSync 同步执行并注入 MEWCODE_EVENT / MEWCODE_TOOL / MEWCODE_FILE_PATH（F11/N6）", async () => {
    const engine = new HookEngine([
      { event: "pre_tool_use", action: { type: "command", command: "printenv MEWCODE_EVENT" } },
    ]);
    const results = await engine.fire(
      "pre_tool_use",
      ctx("pre_tool_use", { toolName: "WriteFile", filePath: "/x/y.txt" }),
    );
    expect(results[0]?.output).toBe("pre_tool_use");
    expect(results[0]?.success).toBe(true);
  });

  test("MEWCODE_TOOL / MEWCODE_FILE_PATH 注入到命令环境", async () => {
    const engine = new HookEngine([
      { event: "pre_tool_use", action: { type: "command", command: `echo "$MEWCODE_TOOL:$MEWCODE_FILE_PATH"` } },
    ]);
    const results = await engine.fire(
      "pre_tool_use",
      ctx("pre_tool_use", { toolName: "EditFile", filePath: "a/b.md" }),
    );
    expect(results[0]?.output).toBe("EditFile:a/b.md");
  });
});

describe("http 动作", () => {
  test("默认 POST、Content-Type=application/json、body 为上下文 JSON（F13）", async () => {
    const received: { method: string; contentType: string; body: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({
          method: req.method,
          contentType: req.headers.get("content-type") ?? "",
          body: JSON.parse(await req.text()),
        });
        return new Response("pong");
      },
    });
    try {
      const engine = new HookEngine([
        { event: "post_receive", action: { type: "http", url: `http://127.0.0.1:${server.port}/recv` } },
      ]);
      const results = await engine.fire("post_receive", ctx("post_receive", { message: "hi" }));
      expect(received[0]?.method).toBe("POST");
      expect(received[0]?.contentType).toBe("application/json");
      expect(received[0]?.body).toMatchObject({ event: "post_receive", message: "hi" });
      expect(results[0]?.output).toBe("pong");
      expect(results[0]?.success).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("显式 method 生效；非 2xx 响应 success=false", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        methods.push(req.method);
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const engine = new HookEngine([
        { event: "post_receive", action: { type: "http", url: `http://127.0.0.1:${server.port}/x`, method: "PUT" } },
      ]);
      const results = await engine.fire("post_receive", ctx("post_receive"));
      expect(methods[0]).toBe("PUT");
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.output).toBe("nope");
    } finally {
      server.stop(true);
    }
  });
});

describe("agent 动作", () => {
  test("未注入 agentRunner 时返回固定失败信息（F14）", async () => {
    const engine = new HookEngine([{ event: "turn_start", action: { type: "agent", prompt: "sub" } }]);
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.output).toBe("agent-type hook configured but no AgentRunner registered");
  });

  test("注入 agentRunner 后执行并透传 ctx", async () => {
    const engine = new HookEngine([{ event: "turn_start", action: { type: "agent", prompt: "do it" } }]);
    const seen: { prompt: string; event: string }[] = [];
    engine.agentRunner = async (prompt, c) => {
      seen.push({ prompt, event: c.event });
      return "sub-agent done";
    };
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(seen).toEqual([{ prompt: "do it", event: "turn_start" }]);
    expect(results[0]).toEqual({ output: "sub-agent done", success: true, reject: false });
  });
});

// ---------- 条件表达式求值 ----------

describe("条件求值", () => {
  const base = (condition: string, c: Record<string, unknown>) =>
    new HookEngine([{ event: "pre_tool_use", condition, action: { type: "prompt", prompt: "hit" } }]).fire(
      "pre_tool_use",
      ctx("pre_tool_use", c),
    );

  test('tool == "WriteFile"：命中与不命中', async () => {
    expect((await base('tool == "WriteFile"', { toolName: "WriteFile" })).length).toBe(1);
    expect((await base('tool == "WriteFile"', { toolName: "Bash" })).length).toBe(0);
  });

  test('file_path =* "**/*.txt"：.txt 命中、.md 不命中', async () => {
    expect((await base('file_path =* "**/*.txt"', { filePath: "/deep/dir/a.txt" })).length).toBe(1);
    expect((await base('file_path =* "**/*.txt"', { filePath: "rel.md" })).length).toBe(0);
  });

  test('event =~ "^pre_" 对 pre_tool_use 命中', async () => {
    expect((await base('event =~ "^pre_"', {})).length).toBe(1);
  });

  test('!tool == "Bash"：WriteFile 命中、Bash 不命中', async () => {
    expect((await base('!tool == "Bash"', { toolName: "WriteFile" })).length).toBe(1);
    expect((await base('!tool == "Bash"', { toolName: "Bash" })).length).toBe(0);
  });

  test("&& 两原子都命中才通过（F7 左结合）", async () => {
    const c = { toolName: "WriteFile", filePath: "src/main.go" };
    expect((await base('tool == "WriteFile" && file_path =* "**/*.go"', c)).length).toBe(1);
    expect((await base('tool == "WriteFile" && file_path =* "**/*.md"', c)).length).toBe(0);
    // || 任一命中即通过
    expect((await base('tool == "Bash" || file_path =* "**/*.go"', c)).length).toBe(1);
  });

  test('=~ 正则编译失败静默返回 false（N5）', async () => {
    expect((await base('tool =~ "["', { toolName: "WriteFile" })).length).toBe(0);
  });

  test("未传递的字段取空字符串、不抛错（F9/AC9）", async () => {
    expect((await base('message == ""', {})).length).toBe(1);
    expect((await base('tool == ""', {})).length).toBe(1);
  });

  test("引用任意工具入参字段（args 兜底）", async () => {
    const r = await base('command == "ls -la"', { args: { command: "ls -la" } });
    expect(r.length).toBe(1);
  });
});

// ---------- 拦截与异步 ----------

describe("拦截语义", () => {
  test("pre_tool_use 下 reject 命中即中断后续 hook（F16）", async () => {
    const engine = new HookEngine([
      { event: "pre_tool_use", reject: true, action: { type: "command", command: "echo stop" } },
      { event: "pre_tool_use", action: { type: "command", command: "echo second" } },
    ]);
    const results = await engine.fire("pre_tool_use", ctx("pre_tool_use", { toolName: "x" }));
    expect(results).toHaveLength(1);
    expect(results[0]?.reject).toBe(true);
  });

  test("其它事件下 reject 不中断、调用方不消费（F17）", async () => {
    const engine = new HookEngine([
      { event: "turn_start", reject: true, action: { type: "command", command: "echo first" } },
      { event: "turn_start", action: { type: "command", command: "echo second" } },
    ]);
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(results).toHaveLength(2);
    expect(results[0]?.reject).toBe(true);
  });
});

describe("异步执行", () => {
  test("立即返回 (async) 占位，不阻塞主调用（<100ms）", async () => {
    const engine = new HookEngine([
      { event: "post_tool_use", async: true, action: { type: "command", command: "sleep 0.5; echo slow-done" } },
    ]);
    const started = Date.now();
    const results = await engine.fire("post_tool_use", ctx("post_tool_use", { toolName: "Bash" }));
    expect(Date.now() - started).toBeLessThan(100);
    expect(results[0]).toEqual({ output: "(async)", success: true, reject: false });
  });

  test("完成后 output 进通知队列；异常时 Async hook error 进队列（F21/F26）", async () => {
    const engine = new HookEngine([
      { event: "post_tool_use", async: true, action: { type: "command", command: "echo bg-ok" } },
      { event: "turn_end", async: true, action: { type: "command", command: "false" } },
    ]);
    await engine.fire("post_tool_use", ctx("post_tool_use", { toolName: "Bash" }));
    await engine.fire("turn_end", ctx("turn_end"));
    await sleep(200);
    const notes = engine.drainNotifications();
    expect(notes.some((n) => n === "bg-ok")).toBe(true);
    expect(notes.some((n) => n.startsWith("Async hook error:"))).toBe(true);
  });
});

// ---------- once 与错误策略 ----------

describe("once", () => {
  test("首次触发后同事件第二次不再执行（F19）", async () => {
    const engine = new HookEngine([
      { id: "only", event: "session_start", once: true, action: { type: "prompt", prompt: "once-note" } },
    ]);
    const r1 = await engine.fire("session_start", ctx("session_start"));
    const r2 = await engine.fire("session_start", ctx("session_start"));
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
  });

  test("id 缺省时 once key 为 <event>-<actionType>：同组合第二条被去重；不同组合独立（F19）", async () => {
    const engine = new HookEngine([
      { event: "session_start", once: true, action: { type: "prompt", prompt: "A" } },
      { event: "session_start", once: true, action: { type: "prompt", prompt: "B" } },
      { event: "session_start", once: true, action: { type: "command", command: "echo C" } },
    ]);
    const r = await engine.fire("session_start", ctx("session_start"));
    // A 消耗 "session_start-prompt"；B 同 key 跳过；C 是 "session_start-command" 独立执行
    expect(r.map((x) => x.output)).toEqual(["A", "C"]);
  });
});

describe("错误策略（F22）", () => {
  test("ignore（默认）：命令抛错不进结果列表", async () => {
    const engine = new HookEngine([{ event: "turn_start", action: { type: "command", command: "false" } }]);
    expect(await engine.fire("turn_start", ctx("turn_start"))).toHaveLength(0);
  });

  test("fail：追加 success=false、reject=false 的记录", async () => {
    const engine = new HookEngine([
      { event: "turn_start", on_error: "fail", action: { type: "command", command: "echo boom >&2; false" } },
    ]);
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.reject).toBe(false);
    expect(results[0]?.output).toContain("Hook error:");
  });

  test("reject：追加 reject=true，pre_tool_use 下产生拦截；stderr 带进输出", async () => {
    const engine = new HookEngine([
      {
        event: "pre_tool_use",
        reject: true,
        on_error: "reject",
        action: { type: "command", command: "echo 'blocked by hook policy' >&2; false" },
      },
    ]);
    const r = await engine.firePreToolHooks("WriteFile", { file_path: "hello.txt" });
    expect(r.rejected).toBe(true);
    expect(r.reason).toContain("Hook error (rejecting):");
    expect(r.reason).toContain("blocked by hook policy");
  });

  test("reject 策略在非 pre_tool_use 事件下只进结果、不产生拦截副作用（F22）", async () => {
    const engine = new HookEngine([
      { event: "turn_start", on_error: "reject", action: { type: "command", command: "false" } },
    ]);
    const results = await engine.fire("turn_start", ctx("turn_start"));
    expect(results[0]?.reject).toBe(true);
  });
});

// ---------- 校验 ----------

describe("validate", () => {
  test("空数组返回 null", () => {
    expect(validate([])).toBeNull();
  });

  test("合法配置返回 null", () => {
    expect(
      validate([
        { id: "a", event: "turn_start", action: { type: "prompt", prompt: "p" } },
        { id: "b", event: "pre_tool_use", condition: 'tool == "X"', reject: true, action: { type: "command", command: "false" } },
        { id: "c", event: "post_receive", async: true, action: { type: "http", url: "http://x" } },
        { event: "session_start", once: true, action: { type: "agent", prompt: "s" } },
      ]),
    ).toBeNull();
  });

  test("event 缺失 / 非法、action.type 缺失 / 非法", () => {
    const err = validate([
      { event: "", action: { type: "prompt", prompt: "p" } },
      { event: "not_a_real_event", action: { type: "command", command: "x" } },
      { event: "turn_start", action: { type: "" } },
      { event: "turn_start", action: { type: "shell" } },
    ]);
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toContain('hook[0]: event is required');
    expect(msg).toContain("hook[1]: invalid event 'not_a_real_event'");
    expect(msg).toContain("hook[2]: action.type is required");
    expect(msg).toContain("hook[3]: invalid action type 'shell'");
    expect(msg).toContain("; ");
  });

  test("各动作必填字段缺失", () => {
    const err = validate([
      { id: "c1", event: "turn_start", action: { type: "command" } },
      { id: "p1", event: "turn_start", action: { type: "prompt" } },
      { id: "h1", event: "turn_start", action: { type: "http" } },
      { id: "a1", event: "turn_start", action: { type: "agent" } },
    ]);
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toContain('hook[0] (id="c1"): command action requires \'command\'');
    expect(msg).toContain('hook[1] (id="p1"): prompt action requires \'prompt\'');
    expect(msg).toContain('hook[2] (id="h1"): http action requires \'url\'');
    expect(msg).toContain('hook[3] (id="a1"): agent action requires \'prompt\' or \'command\'');
  });

  test("reject 与 async 互斥（F18/AC6）", () => {
    const err = validate([
      { id: "bad-combo", event: "pre_tool_use", reject: true, async: true, action: { type: "command", command: "x" } },
    ]);
    expect(err).not.toBeNull();
    expect(err!.message).toContain('hook[0] (id="bad-combo"): reject and async are mutually exclusive');
  });

  test("多条错误聚合成单条 Error，合法条目不产生错误（F27/F29）", () => {
    const err = validate([
      { id: "good", event: "turn_start", action: { type: "prompt", prompt: "ok" } },
      { id: "bad", event: "nope", action: { type: "prompt", prompt: "ok" } },
    ]);
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("good");
    expect(err!.message).toContain('hook[1] (id="bad")');
  });
});

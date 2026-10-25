import { expect, test } from "bun:test";
import { MCPManager } from "../../src/mcp/manager.ts";

const fixture = `${import.meta.dir}/../fixtures/echo-server.ts`;

test("connectAll 失败隔离：坏 server 进 errors，好 server 工具照常（AC9）", async () => {
  const manager = new MCPManager();
  const result = await manager.connectAll([
    { name: "broken", command: "no-such-binary-xyz" },
    { name: "echo-fixture", command: "bun", args: [fixture] },
  ]);
  expect(result.errors.length).toBe(1);
  expect(result.errors[0]?.serverName).toBe("broken");
  expect(result.errors[0]?.error.length).toBeGreaterThan(0);
  expect(result.servers).toEqual(["echo-fixture"]);
  expect(result.tools.length).toBeGreaterThanOrEqual(3);
  expect(result.tools.every((item) => item.serverName === "echo-fixture")).toBe(true);
  expect(manager.getClient("echo-fixture")).toBeDefined();
  expect(manager.getClient("broken")).toBeUndefined();
  await manager.disconnectAll();
});

test("connectAll 收集握手 instructions，空说明不入列（F10）", async () => {
  const manager = new MCPManager();
  const result = await manager.connectAll([{ name: "echo-fixture", command: "bun", args: [fixture] }]);
  expect(result.instructions.length).toBe(1);
  expect(result.instructions[0]?.serverName).toBe("echo-fixture");
  expect(result.instructions[0]?.text).toContain("Fixture echo server");
  await manager.disconnectAll();
});

test("缺少 command 与 url 的 server 抛错进 errors，不影响其它（F2）", async () => {
  const manager = new MCPManager();
  const result = await manager.connectAll([
    { name: "bare" },
    { name: "echo-fixture", command: "bun", args: [fixture] },
  ]);
  expect(result.errors.length).toBe(1);
  expect(result.errors[0]?.error).toContain("needs either");
  expect(result.servers).toEqual(["echo-fixture"]);
  await manager.disconnectAll();
});

test("disconnectAll 后 getClient 返回 undefined", async () => {
  const manager = new MCPManager();
  await manager.connectAll([{ name: "echo-fixture", command: "bun", args: [fixture] }]);
  expect(manager.getClient("echo-fixture")).toBeDefined();
  await manager.disconnectAll();
  expect(manager.getClient("echo-fixture")).toBeUndefined();
  expect(manager.getClient("any")).toBeUndefined();
});

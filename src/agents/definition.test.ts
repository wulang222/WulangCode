import { describe, expect, test } from "bun:test";
import { BUILTIN_AGENTS } from "./definition.ts";

/** T2：内置角色字段断言（AC2/AC21）。 */
describe("BUILTIN_AGENTS", () => {
  test("has exactly 3 built-in roles with the expected names", () => {
    expect(BUILTIN_AGENTS).toHaveLength(3);
    const names = BUILTIN_AGENTS.map((d) => d.name);
    expect(new Set(names)).toEqual(new Set(["general-purpose", "plan", "explore"]));
  });

  test("plan and explore disallow EditFile and WriteFile and use plan permission mode", () => {
    for (const name of ["plan", "explore"]) {
      const def = BUILTIN_AGENTS.find((d) => d.name === name)!;
      expect(def.disallowedTools).toContain("EditFile");
      expect(def.disallowedTools).toContain("WriteFile");
      expect(def.permissionMode).toBe("plan");
    }
  });

  test("explore uses the haiku model tier", () => {
    expect(BUILTIN_AGENTS.find((d) => d.name === "explore")!.model).toBe("haiku");
  });

  test("all built-in names are lowercase hyphenated", () => {
    for (const def of BUILTIN_AGENTS) expect(def.name).toMatch(/^[a-z0-9-]+$/);
  });
});

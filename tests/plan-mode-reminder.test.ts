import { describe, expect, test } from "bun:test";
import {
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  buildPlanModeReminder,
  planModeSparseReminder,
  reminderInterval,
} from "../src/prompt/plan-mode.ts";

describe("buildPlanModeReminder 按轮次切换详略（AC9/F7）", () => {
  test("iteration=1 完整版：含 5 阶段工作流与计划文件信息", () => {
    const reminder = buildPlanModeReminder("docs/plan.md", false, 1);
    expect(reminder).toContain("Plan mode is active");
    expect(reminder).toContain("Phase 1: Initial Understanding");
    expect(reminder).toContain("Phase 2: Design");
    expect(reminder).toContain("Phase 3: Review");
    expect(reminder).toContain("Phase 4: Final Plan");
    expect(reminder).toContain("Phase 5: ExitPlanMode");
    expect(reminder).toContain("Plan file: docs/plan.md");
    expect(reminder).toContain("No plan file exists yet");
    expect(reminder).not.toContain("%PLAN_FILE_INFO%");
  });

  test("计划文件已存在时措辞切换为继续编辑", () => {
    const reminder = buildPlanModeReminder("docs/plan.md", true, 1);
    expect(reminder).toContain("A plan file already exists");
  });

  test("iteration=2 精简版：含 still active、不含 Phase 1", () => {
    const sparse = buildPlanModeReminder("docs/plan.md", false, 2);
    expect(sparse).toContain("Plan mode still active");
    expect(sparse).toContain("docs/plan.md");
    expect(sparse).not.toContain("Phase 1");
    expect(sparse).not.toContain("%PLAN_PATH%");
  });

  test(`每隔 ${reminderInterval} 轮重复完整版：1、6、11 完整，2、7 精简`, () => {
    expect(buildPlanModeReminder("p.md", false, 6)).toContain("Phase 1: Initial Understanding");
    expect(buildPlanModeReminder("p.md", false, 11)).toContain("Phase 1: Initial Understanding");
    expect(buildPlanModeReminder("p.md", false, 7)).toBe(planModeSparseReminder.replace("%PLAN_PATH%", "p.md"));
  });
});

describe("进入 / 退出告知（F7）", () => {
  test("退出提醒：有计划文件时附带位置", () => {
    const reminder = buildPlanModeExitReminder(".mewcode/plan.md", true);
    expect(reminder).toContain("You have exited plan mode");
    expect(reminder).toContain("The plan file is located at .mewcode/plan.md");
  });

  test("退出提醒：无计划文件时不附带位置", () => {
    const reminder = buildPlanModeExitReminder(".mewcode/plan.md", false);
    expect(reminder).toContain("You have exited plan mode");
    expect(reminder).not.toContain("The plan file is located at");
  });

  test("重入提醒：无计划文件返回空串，有则告知位置", () => {
    expect(buildPlanModeReentryReminder("p.md", false)).toBe("");
    const reminder = buildPlanModeReentryReminder("p.md", true);
    expect(reminder).toContain("You have re-entered plan mode");
    expect(reminder).toContain("p.md");
  });
});

/**
 * Plan Mode 计划态系统提醒（模型侧，经 <system-reminder> 通道注入）。
 * Agent 每轮请求前注入一份：首轮完整（含 5 阶段工作流），之后精简，
 * 每隔 reminderInterval 轮再重复完整版——省 token 的同时防止长会话中模型"忘记"自己在计划模式。
 */

/** 完整版：5 阶段工作流。%PLAN_FILE_INFO% 由 buildPlanModeReminder 替换。 */
export const planModeFullReminder = `Plan mode is active. You are in planning mode: gather information and produce a plan only. Do not make any changes to the system.

Follow this workflow:
1. Phase 1: Initial Understanding — Read files, search code (Glob/Grep), and build an understanding of the current system. Do not write or execute anything.
2. Phase 2: Design — Think through possible approaches, weigh trade-offs, and pick one.
3. Phase 3: Review — Re-read the relevant code and verify your design against reality: check every file, function, and dependency you plan to touch.
4. Phase 4: Final Plan — Write the plan in %PLAN_FILE_INFO%
5. Phase 5: ExitPlanMode — When the plan is complete and you are confident in it, call the ExitPlanMode tool. The user will review the plan before any execution begins.

Constraints:
- Only read-only tools (ReadFile / Glob / Grep) are available. Write and command tools are physically denied.
- Do not attempt to edit files, run commands, or otherwise modify the system while planning.
- The plan must be concrete: file paths, function names, and ordered steps.`;

/** 精简版：只剩关键规则。%PLAN_PATH% 由 buildPlanModeReminder 替换。 */
export const planModeSparseReminder = `Plan mode still active: read-only tools only. Continue the workflow and write the plan to %PLAN_PATH%, then call ExitPlanMode when it is ready. No edits, no commands.`;

/** 每隔多少轮重复一次完整提示。 */
export const reminderInterval = 5;

/** 退出计划模式的告知。%EXTRA% 由 buildPlanModeExitReminder 替换（计划文件位置，无则空）。 */
const planModeExitTemplate = `You have exited plan mode. Write and command tools are available again; the user can now ask you to execute the plan.
%EXTRA%`;

/** 重新进入计划模式且已有计划文件时的告知。%PLAN_PATH% 由 buildPlanModeReentryReminder 替换。 */
const planModeReentryTemplate = `You have re-entered plan mode: gather information and produce a plan only, with read-only tools. The existing plan file is located at %PLAN_PATH%. Continue editing it, and call ExitPlanMode when the plan is ready.`;

/** 每轮注入的计划态提醒：iteration 1 完整，之后每 reminderInterval 轮重复完整，其余精简。 */
export function buildPlanModeReminder(planPath: string, planExist: boolean, iteration: number): string {
  const planFileInfo = `Plan file: ${planPath} (${
    planExist ? "A plan file already exists — read it and continue editing it" : "No plan file exists yet — create it when you reach Phase 4"
  }).`;
  const useFull = ((iteration - 1) % reminderInterval + reminderInterval) % reminderInterval === 0;
  if (useFull) return planModeFullReminder.replace("%PLAN_FILE_INFO%", planFileInfo);
  return planModeSparseReminder.replace("%PLAN_PATH%", planPath);
}

/** 退出计划模式时告知模型；计划文件存在时附带位置。 */
export function buildPlanModeExitReminder(planPath: string, planExists: boolean): string {
  const extra = planExists ? `The plan file is located at ${planPath}. Read it and follow it when the user asks you to execute the plan.` : "";
  return planModeExitTemplate.replace("%EXTRA%", extra);
}

/** 重新进入计划模式时告知模型；尚无计划文件则无需提醒（首轮完整提醒会说明待创建）。 */
export function buildPlanModeReentryReminder(planPath: string, planFileExists: boolean): string {
  if (!planFileExists) return "";
  return planModeReentryTemplate.replace("%PLAN_PATH%", planPath);
}

/**
 * 模型别名解析（SubAgent 章节的前置模块）。
 * Agent 定义与 Agent 工具的 model 参数允许写档位别名（haiku/sonnet/opus），
 * 派生子 Agent 时经此表翻译成具体 model id；未命中别名的输入原样返回，
 * 交给 provider 在请求期报错（不做枚举校验，F7/N 场景 8 语义）。
 */
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-1",
};

export function resolveModelId(input: string): string {
  const key = input.trim().toLowerCase();
  return MODEL_ALIASES[key] ?? input;
}

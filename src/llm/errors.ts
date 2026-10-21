/** 对话请求失败的基类。界面按 name 显示，不退出进程。 */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends LLMError {
  retryAfter?: string;
  constructor(message: string, retryAfter?: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class ContextTooLongError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "ContextTooLongError";
  }
}

/** 用户或 Ctrl+C 中断流。保留已收到的正文。 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "APIUserAbortError";
}

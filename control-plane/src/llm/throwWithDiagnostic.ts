/** 供上层解析失败时附带可展示给用户的原始输出（HTTP 体或模型正文） */
export type LlmDiagnosticError = Error & { llmModelOutput?: string; llmHttpBody?: string };

export function throwWithLlmModelOutput(message: string, modelOutput: string, cause?: unknown): never {
  const e = new Error(message) as LlmDiagnosticError;
  e.llmModelOutput = modelOutput;
  if (cause !== undefined) e.cause = cause as Error;
  throw e;
}

export function throwWithLlmHttpBody(message: string, httpBody: string): never {
  const e = new Error(message) as LlmDiagnosticError;
  e.llmHttpBody = httpBody;
  throw e;
}

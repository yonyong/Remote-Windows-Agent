/** 可选诊断日志（与 Fastify / ParseLogger 结构兼容） */
export type LlmDiagnosticLogger = {
  warn?: (o: object, msg?: string) => void;
  error?: (o: object, msg?: string) => void;
};

export function clipForLlmLog(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated total=${s.length}]`;
}

export function llmLogBodyMaxChars(): number {
  const n = Number.parseInt(process.env.COMMAND_LLM_LOG_BODY_MAX_CHARS ?? '12000', 10);
  if (!Number.isFinite(n) || n < 500) return 12000;
  return Math.min(100_000, n);
}

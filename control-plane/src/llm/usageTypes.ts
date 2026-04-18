/** 单次大模型补全的可观测指标（厂商返回不一致时字段可能为空）。 */
export type LlmUsageSnapshot = {
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export function mergeLlmUsage(a: LlmUsageSnapshot | null, b: LlmUsageSnapshot | null): LlmUsageSnapshot | null {
  if (!a && !b) return null;
  const durationMs = (a?.durationMs ?? 0) + (b?.durationMs ?? 0);
  const out: LlmUsageSnapshot = { durationMs };
  const pt = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0);
  const ct = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0);
  const tt = (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0);
  if (pt > 0) out.promptTokens = pt;
  if (ct > 0) out.completionTokens = ct;
  if (tt > 0) out.totalTokens = tt;
  return out;
}

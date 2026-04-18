export function mergeLlmUsage(a, b) {
    if (!a && !b)
        return null;
    const durationMs = (a?.durationMs ?? 0) + (b?.durationMs ?? 0);
    const out = { durationMs };
    const pt = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0);
    const ct = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0);
    const tt = (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0);
    if (pt > 0)
        out.promptTokens = pt;
    if (ct > 0)
        out.completionTokens = ct;
    if (tt > 0)
        out.totalTokens = tt;
    return out;
}

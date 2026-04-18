// Pure server-side narrative generator: turns a signal's reasonJson into a single
// human-readable sentence. No LLM calls — deterministic and cheap so it can be
// computed for every signal at creation time.

export function summarizeSignal(
  strategy: string,
  direction: "LONG" | "SHORT",
  reasonJson: Record<string, any> | null | undefined,
): string {
  const r = reasonJson ?? {};
  const dirWord = direction === "LONG" ? "long" : "short";

  if (strategy === "TREND_CONTINUATION") {
    const parts: string[] = [];
    parts.push(direction === "LONG" ? "Uptrend continuation" : "Downtrend continuation");
    if (r.bias) parts.push(direction === "LONG" ? "price above rising EMA200 on 1h" : "price below falling EMA200 on 1h");
    if (r.emaStack === "aligned") parts.push("EMAs stacked");
    if (r.pullback) parts.push("pullback complete");
    if (r.macd) parts.push("MACD confirms");
    if (r.adx) parts.push(`ADX ${r.adx}`);
    return parts.join(", ") + ".";
  }

  if (strategy === "RANGE_BREAKOUT") {
    const parts: string[] = [];
    parts.push(direction === "LONG" ? "Range breakout to the upside" : "Range breakdown");
    if (r.bbWidth != null && r.medianBBWidth != null) {
      parts.push(`compressed BB (${r.bbWidth.toFixed?.(4) ?? r.bbWidth} vs median ${r.medianBBWidth.toFixed?.(4) ?? r.medianBBWidth})`);
    }
    if (r.adx != null) parts.push(`flat ADX ${r.adx}`);
    if (r.breakout) parts.push(String(r.breakout).toLowerCase());
    return parts.join(", ") + ".";
  }

  return `${strategy} ${dirWord} signal.`;
}

import OpenAI from "openai";
import { storage } from "./storage";
import { fetchTimeSeriesRange } from "./twelvedata";
import { canonicalToVendor } from "@shared/schema";
import { log } from "./logger";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "gpt-5.1";
const ADVISOR_FALLBACK_MODEL = process.env.ADVISOR_FALLBACK_MODEL || "gpt-4o";

type ChatParamsBase = Parameters<typeof openai.chat.completions.create>[0];
type ChatParamsNoModel = Omit<ChatParamsBase, "model" | "stream"> & { stream?: false };

async function createChatCompletion(params: ChatParamsNoModel): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  try {
    return await openai.chat.completions.create({ ...params, model: ADVISOR_MODEL, stream: false });
  } catch (err: any) {
    const msg = (err?.message ?? "").toLowerCase();
    const code = err?.code ?? err?.error?.code;
    const isModelError =
      err?.status === 404 ||
      code === "model_not_found" ||
      code === "invalid_model" ||
      (msg.includes("model") && (msg.includes("not found") || msg.includes("does not exist") || msg.includes("invalid")));
    if (isModelError && ADVISOR_FALLBACK_MODEL && ADVISOR_FALLBACK_MODEL !== ADVISOR_MODEL) {
      log(`Advisor model "${ADVISOR_MODEL}" unavailable, falling back to "${ADVISOR_FALLBACK_MODEL}"`, "advisor");
      return await openai.chat.completions.create({ ...params, model: ADVISOR_FALLBACK_MODEL, stream: false });
    }
    throw err;
  }
}

export async function analyzePortfolio(): Promise<string> {
  const stats = await storage.getBacktestStats();
  const archivedSignals = await storage.getArchivedSignals({ limit: 200 });

  if (!archivedSignals.length) {
    return "No completed signals to analyze yet. Run scans and let signals resolve (win/loss/missed) to build your dataset.";
  }

  const signalIds = archivedSignals.map((s) => s.id);
  const storedAnalyses = await storage.getTradeAnalyses(signalIds);
  const analysisMap = new Map(storedAnalyses.map((a) => [a.signalId, a]));
  const analyzedCount = storedAnalyses.length;

  const signalSummaries = archivedSignals.map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    const a = analysisMap.get(s.id);
    return {
      symbol: s.instrument.canonicalSymbol,
      assetClass: s.instrument.assetClass,
      strategy: s.strategy,
      direction: s.direction,
      timeframe: s.timeframe,
      score: s.score,
      outcome: s.outcome,
      detectedAt: s.detectedAt,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      riskRewardRatio: r.riskRewardRatio,
      atr: r.atr,
      adx: r.adx,
      bbWidth: r.bbWidth,
      bias: r.bias,
      emaStack: r.emaStack,
      pullback: r.pullback,
      macd: r.macd,
      breakout: r.breakout,
      ...(a ? {
        deepDiveVerified: true,
        entryQuality: a.entryQuality,
        keyFindings: a.keyFindings,
        winLossFactors: a.winLossFactors,
        priceActionPatterns: a.priceActionPatterns,
        chartPatterns: a.chartPatterns,
        lessonsLearned: a.lessonsLearned,
        marketPsychology: a.marketPsychology,
      } : { deepDiveVerified: false }),
    };
  });

  // Source of truth: shared SQL aggregates from getPerformanceAggregates
  const [pairAgg, assetAgg, hourAgg, strategyAgg, sessionAgg] = await Promise.all([
    storage.getPerformanceAggregates("pair"),
    storage.getPerformanceAggregates("asset"),
    storage.getPerformanceAggregates("hour"),
    storage.getPerformanceAggregates("strategy"),
    storage.getPerformanceAggregates("session"),
  ]);

  const withWinRate = <T extends { wins: number; losses: number }>(r: T) => ({
    ...r,
    resolved: r.wins + r.losses,
    winRate: r.wins + r.losses > 0 ? ((r.wins / (r.wins + r.losses)) * 100).toFixed(1) + "%" : "N/A",
  });

  const topPairs = pairAgg.map((r) => ({ symbol: r.key, ...withWinRate(r) })).sort((a, b) => b.total - a.total);
  const byAssetClass = Object.fromEntries(assetAgg.map((r) => [r.key, withWinRate(r)]));
  const byStrategy = Object.fromEntries(strategyAgg.map((r) => [r.key, withWinRate(r)]));
  const bySession = Object.fromEntries(sessionAgg.map((r) => [r.key, withWinRate(r)]));
  const hourlyPerformance = hourAgg
    .map((r) => ({ hourUTC: parseInt(r.key), ...withWinRate(r) }))
    .sort((a, b) => a.hourUTC - b.hourUTC);

  const signalLookup = new Map(archivedSignals.map((s) => [s.id, s]));
  const deepDiveInsights = analyzedCount > 0 ? storedAnalyses.map((a) => {
    const sig = signalLookup.get(a.signalId);
    return {
      symbol: sig?.instrument.canonicalSymbol || "?",
      strategy: sig?.strategy || "?",
      direction: sig?.direction || "?",
      outcome: sig?.outcome || "?",
      entryQuality: a.entryQuality,
      keyFindings: a.keyFindings,
      winLossFactors: a.winLossFactors,
      priceActionPatterns: a.priceActionPatterns,
      chartPatterns: a.chartPatterns,
      lessonsLearned: a.lessonsLearned,
      marketPsychology: a.marketPsychology,
    };
  }) : [];

  const prompt = `You are an expert quantitative trading analyst producing a comprehensive portfolio intelligence report. This is the "quarterly review" of a trader's automated scanning system.

DATA QUALITY: ${analyzedCount} of ${archivedSignals.length} signals have been individually deep-dive analyzed with 1-minute candle data. ${analyzedCount > 0 ? "Findings marked 'deepDiveVerified: true' are fact-checked. Prioritize these." : "No deep-dive analyses yet — all insights are based on raw signal parameters only."}

OVERALL STATS:
- Total resolved signals: ${stats.total}
- Wins: ${stats.wins}, Losses: ${stats.losses}, Missed: ${stats.missed}
- Overall win rate: ${stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0}%
- Taken trades win rate: ${stats.takenTotal > 0 ? ((stats.takenWins / stats.takenTotal) * 100).toFixed(1) : "N/A"}% (${stats.takenTotal} trades taken)

PRE-COMPUTED BREAKDOWNS:
- By Pair: ${JSON.stringify(topPairs.slice(0, 20))}
- By Asset Class: ${JSON.stringify(byAssetClass)}
- By Strategy: ${JSON.stringify(byStrategy)}
- By Session: ${JSON.stringify(bySession)}
- By Hour (UTC): ${JSON.stringify(hourlyPerformance)}

SIGNAL DATA (${archivedSignals.length} signals, ${analyzedCount} with deep-dive findings):
${JSON.stringify(signalSummaries, null, 1)}
${analyzedCount > 0 ? `
DEEP-DIVE VERIFIED INSIGHTS (${analyzedCount} trades with 1-minute candle analysis):
${JSON.stringify(deepDiveInsights, null, 1)}

These deep-dive findings are FACT-CHECKED from minute-by-minute price action review. Use them to validate or challenge patterns found in the raw data.
` : ""}
Provide a comprehensive portfolio intelligence analysis. This is the trader's "quarterly performance review." Structure your response:

## Performance Overview
Overall system effectiveness. Is this scanner generating edge? Win rate trends, strategy comparison. Reference actual numbers.

## Cross-Strategy Comparison
Compare TREND_CONTINUATION vs RANGE_BREAKOUT head-to-head. Which generates more edge? Under what market conditions does each excel? Are they complementary or redundant?

## Pair & Asset Class Rankings
Rank pairs by profitability. Which pairs are your edge? Which are bleeding money? Is there an asset class (FOREX/METAL/CRYPTO) that consistently outperforms?${analyzedCount > 0 ? " Cross-reference with deep-dive findings — do the entry quality ratings align with win rates?" : ""}

## Session & Timing Analysis
What hours (UTC) produce the best results? Map to trading sessions (London, NY, Asian overlap). Are there dead zones to avoid?

## Pattern Recognition
Identify cross-strategy correlations:
- ADX sweet spots that produce wins across both strategies
- Score thresholds where win rate meaningfully jumps
- R:R ratios that actually paid off vs those that didn't
- Direction bias — is LONG or SHORT consistently stronger?
${analyzedCount > 0 ? "- Entry quality patterns from deep dives — what separates EXCELLENT entries from POOR ones?" : ""}
${analyzedCount > 0 ? "- Common chart patterns from deep dives — which formations win most?" : ""}

## Your Edge Profile
Define exactly where this system's edge lives. What is the "ideal trade" across all strategies? What are the specific conditions (pair + strategy + direction + score + ADX range + session) that produce the highest probability?

## Performance Trends
Is the system improving or degrading over time? Are recent signals performing differently than earlier ones?

## Winner's Playbook
The definitive checklist for manually screening charts based on everything above. What to look for, what to avoid, when to trade, when to sit out.
${analyzedCount > 0 ? `
## Deep-Dive Intelligence
Insights that ONLY come from the ${analyzedCount} verified trade analyses:
- Most common market psychology patterns observed
- Recurring price action setups
- Smart money behavior patterns
- Entry timing refinements based on 1-minute data
` : ""}
CRITICAL: Be direct and data-driven. Reference actual numbers, pairs, and outcomes. ${analyzedCount > 0 ? "Ground insights in verified deep-dive findings wherever possible." : "Flag that deep-dive analysis would strengthen these conclusions."}`;

  const response = await createChatCompletion({
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 8192,
  });

  return response.choices[0]?.message?.content || "Analysis could not be generated.";
}

export async function analyzeTradeDeep(signalId: number): Promise<string> {
  const signal = await storage.getSignalById(signalId);
  if (!signal) throw new Error("Signal not found");

  const reason = (signal.reasonJson ?? {}) as Record<string, any>;
  const detectedAt = new Date(signal.detectedAt);
  const resolvedAt = signal.resolvedAt ? new Date(signal.resolvedAt) : new Date(detectedAt.getTime() + 3600000);

  let minuteCandles: any[] = [];
  try {
    const vendorSymbol = canonicalToVendor(signal.instrument.canonicalSymbol, signal.instrument.assetClass);
    const startDate = new Date(detectedAt.getTime() - 900000).toISOString().replace("T", " ").slice(0, 19);
    const endDate = new Date(resolvedAt.getTime() + 900000).toISOString().replace("T", " ").slice(0, 19);
    minuteCandles = await fetchTimeSeriesRange(vendorSymbol, "1min", startDate, endDate);
  } catch (err) {
    log(`Advisor: Failed to fetch 1m candles: ${err}`, "advisor");
  }

  const dbCandles = await storage.getCandles(signal.instrumentId, signal.timeframe, 50);
  const dbIndicators = await storage.getIndicators(signal.instrumentId, signal.timeframe, 50);

  const candleContext = dbCandles.slice(-20).map((c) => ({
    time: c.datetimeUtc,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  }));

  const indicatorContext = dbIndicators.slice(-10).map((ind) => ({
    time: ind.datetimeUtc,
    ema9: ind.ema9,
    ema21: ind.ema21,
    ema55: ind.ema55,
    ema200: ind.ema200,
    bbUpper: ind.bbUpper,
    bbLower: ind.bbLower,
    bbWidth: ind.bbWidth,
    macd: ind.macd,
    macdSignal: ind.macdSignal,
    macdHist: ind.macdHist,
    atr: ind.atr,
    adx: ind.adx,
  }));

  const minuteCandlesSummary = minuteCandles.length > 0
    ? minuteCandles.map((c: any) => `${c.datetime} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume || 0}`).join("\n")
    : "1-minute candle data not available for this time window.";

  const prompt = `You are a senior technical trading advisor with deep expertise in price action, market microstructure, order flow, and trading psychology. You are conducting a deep post-trade analysis.

SIGNAL DETAILS:
- Symbol: ${signal.instrument.canonicalSymbol} (${signal.instrument.assetClass})
- Strategy: ${signal.strategy}
- Direction: ${signal.direction}
- Timeframe: ${signal.timeframe}
- Score: ${signal.score}
- Detected At: ${signal.detectedAt}
- Status: ${signal.status}
- Outcome: ${signal.outcome || "Pending"}
- Outcome Price: ${signal.outcomePrice ?? "N/A"}
- Resolved At: ${signal.resolvedAt || "N/A"}

TRADE LEVELS:
- Entry Price: ${reason.entryPrice ?? "N/A"}
- Stop Loss: ${reason.stopLoss ?? "N/A"}
- Take Profit: ${reason.takeProfit ?? "N/A"}
- Stop Distance: ${reason.stopDistance ?? "N/A"}
- Risk:Reward: ${reason.riskRewardRatio ?? "N/A"}

SIGNAL REASONING FACTORS:
- ATR: ${reason.atr ?? "N/A"}
- ADX: ${reason.adx ?? "N/A"}
- Bias: ${reason.bias ?? "N/A"}
- EMA Stack: ${reason.emaStack ?? "N/A"}
- Pullback: ${reason.pullback ?? "N/A"}
- MACD: ${reason.macd ?? "N/A"}
- BB Width: ${reason.bbWidth ?? "N/A"}
- Breakout: ${reason.breakout ?? "N/A"}
- EMA21 Zone: ${reason.ema21Zone ?? "N/A"}
- EMA55 Zone: ${reason.ema55Zone ?? "N/A"}
- Range High: ${reason.rangeHigh ?? "N/A"}
- Range Low: ${reason.rangeLow ?? "N/A"}

${signal.timeframe} CANDLES (last 20 around signal):
${JSON.stringify(candleContext, null, 1)}

INDICATORS AT SIGNAL TIME (last 10):
${JSON.stringify(indicatorContext, null, 1)}

1-MINUTE CANDLES (signal lifespan, minute by minute):
${minuteCandlesSummary}

Provide a comprehensive deep-dive analysis structured as follows:

## Trade Summary
One-paragraph overview of what this trade was, what happened, and the result.

## Entry Analysis
Was the entry well-timed? What were the technical conditions telling us at entry? Was there confluence? What did the EMA stack, MACD histogram, ADX, and Bollinger Bands say about the trade direction at that exact moment?

## Minute-by-Minute Price Action Walkthrough
Walk through the key moments of this trade using the 1-minute candle data. Describe:
- How price behaved immediately after entry
- Key turning points (momentum shifts, rejections, consolidation periods)
- How price approached the SL or TP level
- Any false breakouts, stop hunts, or liquidity grabs
- The specific candle patterns that told the story

## Market Psychology & Order Flow
Explain what was likely happening from a market psychology perspective:
- Where were institutional/smart money orders likely sitting?
- Was there a liquidity grab before the real move?
- Did price sweep stops before reversing?
- What does the volume profile suggest about buyer/seller commitment?
- What were retail traders likely doing vs what smart money was doing?

## What Made This Trade ${signal.outcome === "WIN" ? "Win" : signal.outcome === "LOSS" ? "Lose" : "Play Out This Way"}
The specific technical and market structure reasons this trade resulted in ${signal.outcome || "this outcome"}.

## Chart Reading Guide
If you were looking at this chart live (without the scanner), what specific visual cues would have tipped you off to this setup? Describe exactly what patterns and formations to look for on the chart.

## Lessons & Takeaways
What can the trader learn from this specific trade? What should they replicate (if winner) or avoid (if loser) in the future? Be specific about the conditions.

Be extremely detailed and technical. Reference specific prices, candle formations, and indicator values from the data provided. This analysis should teach the trader to read charts independently.`;

  const response = await createChatCompletion({
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 8192,
  });

  const analysisText = response.choices[0]?.message?.content || "Analysis could not be generated.";

  try {
    const extractPrompt = `From the following trade analysis, extract structured fields. Return ONLY valid JSON with these keys:
- keyFindings: 2-3 sentence summary of the most important findings
- winLossFactors: The specific technical reasons this trade won or lost
- priceActionPatterns: Key price action patterns observed (candle formations, rejections, breakouts)
- marketPsychology: Smart money / institutional behavior observed
- entryQuality: One of "EXCELLENT", "GOOD", "FAIR", "POOR"
- chartPatterns: Visual chart patterns identified (e.g. "double bottom", "bull flag", "head and shoulders")
- lessonsLearned: The main actionable takeaway for the trader

ANALYSIS:
${analysisText.slice(0, 6000)}`;

    const extractRes = await createChatCompletion({
      messages: [{ role: "user", content: extractPrompt }],
      max_completion_tokens: 2048,
    });

    let extracted: any = {};
    try {
      const raw = extractRes.choices[0]?.message?.content || "{}";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
    } catch { extracted = {}; }

    await storage.upsertTradeAnalysis({
      signalId,
      analysis: analysisText,
      keyFindings: extracted.keyFindings || null,
      winLossFactors: extracted.winLossFactors || null,
      priceActionPatterns: extracted.priceActionPatterns || null,
      marketPsychology: extracted.marketPsychology || null,
      entryQuality: extracted.entryQuality || null,
      chartPatterns: extracted.chartPatterns || null,
      lessonsLearned: extracted.lessonsLearned || null,
    });
    log(`Advisor: Persisted analysis for signal ${signalId}`, "advisor");
  } catch (err) {
    log(`Advisor: Failed to persist analysis for signal ${signalId}: ${err}`, "advisor");
  }

  return analysisText;
}

export async function batchAnalyzeTrades(signalIds: number[], onProgress?: (completed: number, total: number, currentSymbol: string) => void): Promise<{ completed: number; failed: number; results: { signalId: number; success: boolean; error?: string }[] }> {
  const results: { signalId: number; success: boolean; error?: string }[] = [];
  let completed = 0;
  let failed = 0;

  for (const signalId of signalIds) {
    try {
      const signal = await storage.getSignalById(signalId);
      const symbolName = signal?.instrument.canonicalSymbol || `Signal #${signalId}`;
      if (onProgress) onProgress(completed, signalIds.length, symbolName);

      await analyzeTradeDeep(signalId);
      completed++;
      results.push({ signalId, success: true });
    } catch (err: any) {
      failed++;
      results.push({ signalId, success: false, error: err.message });
      log(`Advisor: Batch analysis failed for signal ${signalId}: ${err.message}`, "advisor");
    }

    if (signalIds.indexOf(signalId) < signalIds.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return { completed, failed, results };
}

export async function generateStrategyGuide(strategy: string): Promise<string> {
  const stats = await storage.getBacktestStats();
  const archivedSignals = await storage.getArchivedSignals({ strategy, limit: 100 });

  if (!archivedSignals.length) {
    return `No completed signals for the ${strategy} strategy yet. Run scans and let signals resolve to build data for this strategy.`;
  }

  const wins = archivedSignals.filter((s) => s.outcome === "WIN");
  const losses = archivedSignals.filter((s) => s.outcome === "LOSS");

  const signalIds = archivedSignals.map((s) => s.id);
  const storedAnalyses = await storage.getTradeAnalyses(signalIds);
  const analysisMap = new Map(storedAnalyses.map((a) => [a.signalId, a]));

  const winAnalyses = wins
    .filter((s) => analysisMap.has(s.id))
    .map((s) => {
      const a = analysisMap.get(s.id)!;
      const r = (s.reasonJson ?? {}) as Record<string, any>;
      return {
        symbol: s.instrument.canonicalSymbol,
        assetClass: s.instrument.assetClass,
        direction: s.direction,
        score: s.score,
        adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, pullback: r.pullback,
        macd: r.macd, bias: r.bias, breakout: r.breakout, riskRewardRatio: r.riskRewardRatio,
        atr: r.atr, stopDistance: r.stopDistance, entryPrice: r.entryPrice,
        entryQuality: a.entryQuality,
        keyFindings: a.keyFindings,
        winLossFactors: a.winLossFactors,
        priceActionPatterns: a.priceActionPatterns,
        chartPatterns: a.chartPatterns,
        lessonsLearned: a.lessonsLearned,
      };
    });

  const lossAnalyses = losses
    .filter((s) => analysisMap.has(s.id))
    .map((s) => {
      const a = analysisMap.get(s.id)!;
      const r = (s.reasonJson ?? {}) as Record<string, any>;
      return {
        symbol: s.instrument.canonicalSymbol,
        assetClass: s.instrument.assetClass,
        direction: s.direction,
        score: s.score,
        adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, pullback: r.pullback,
        macd: r.macd, bias: r.bias, breakout: r.breakout, riskRewardRatio: r.riskRewardRatio,
        atr: r.atr, stopDistance: r.stopDistance, entryPrice: r.entryPrice,
        entryQuality: a.entryQuality,
        keyFindings: a.keyFindings,
        winLossFactors: a.winLossFactors,
        priceActionPatterns: a.priceActionPatterns,
        chartPatterns: a.chartPatterns,
        lessonsLearned: a.lessonsLearned,
      };
    });

  const unanalyzedWins = wins.filter((s) => !analysisMap.has(s.id)).map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    return { symbol: s.instrument.canonicalSymbol, direction: s.direction, score: s.score, adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, riskRewardRatio: r.riskRewardRatio };
  });

  const unanalyzedLosses = losses.filter((s) => !analysisMap.has(s.id)).map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    return { symbol: s.instrument.canonicalSymbol, direction: s.direction, score: s.score, adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, riskRewardRatio: r.riskRewardRatio };
  });

  const analyzedCount = winAnalyses.length + lossAnalyses.length;
  const totalCount = archivedSignals.length;

  const strategyName = strategy === "TREND_CONTINUATION" ? "Trend Continuation" : "Range Breakout";
  const strategyDesc = strategy === "TREND_CONTINUATION"
    ? "Uses 1h bias (EMA200 slope) + 15m entry (EMA stack alignment, pullback to EMA zone, MACD confirmation, ADX>=18 for trend strength)"
    : "Detects low-volatility consolidation (ADX<=18, narrow BB width), then signals breakout above/below range with Bollinger Band confirmation";

  const deepDiveSection = analyzedCount > 0 ? `
DEEP DIVE ANALYZED WINNING TRADES (${winAnalyses.length} trades — verified with 1-minute candle data):
${JSON.stringify(winAnalyses, null, 1)}

DEEP DIVE ANALYZED LOSING TRADES (${lossAnalyses.length} trades — verified with 1-minute candle data):
${JSON.stringify(lossAnalyses, null, 1)}

These trades above have been individually analyzed with minute-by-minute price action review. Their findings (keyFindings, winLossFactors, priceActionPatterns, chartPatterns, lessonsLearned) are FACT-CHECKED observations, not inferences. Prioritize insights from these trades.
` : "";

  const rawSection = (unanalyzedWins.length + unanalyzedLosses.length) > 0 ? `
ADDITIONAL UNANALYZED TRADES (raw signal data only, ${unanalyzedWins.length} wins + ${unanalyzedLosses.length} losses):
Winners: ${JSON.stringify(unanalyzedWins, null, 1)}
Losers: ${JSON.stringify(unanalyzedLosses, null, 1)}
Note: These trades have NOT been deep-dive analyzed. Use their technical parameters for statistical patterns but do not fabricate price action narratives for them.
` : "";

  const prompt = `You are an expert trading strategy coach and technical analyst. You are creating a comprehensive strategy masterclass based on REAL performance data and VERIFIED trade analyses.

STRATEGY: ${strategyName}
DESCRIPTION: ${strategyDesc}

DATA QUALITY: ${analyzedCount} of ${totalCount} trades have been individually deep-dive analyzed with 1-minute candle data. ${analyzedCount > 0 ? "Prioritize findings from deep-dive analyzed trades — those are fact-checked." : "No trades have been deep-dive analyzed yet. Recommendations will be based on raw technical parameters only — flag this limitation."}

PERFORMANCE DATA:
- Total signals: ${archivedSignals.length}
- Wins: ${wins.length} (${archivedSignals.length > 0 ? ((wins.length / archivedSignals.length) * 100).toFixed(1) : 0}%)
- Losses: ${losses.length} (${archivedSignals.length > 0 ? ((losses.length / archivedSignals.length) * 100).toFixed(1) : 0}%)
- Strategy stats from backtest: ${JSON.stringify(stats.byStrategy[strategy] || {})}
${deepDiveSection}${rawSection}
Create a comprehensive strategy masterclass with these sections:

## Strategy Overview
Explain the ${strategyName} strategy in plain language.

## Performance Breakdown
Win rate by direction, asset class, symbol. Which pairs work best?

## The Winning Formula
Based on ${analyzedCount > 0 ? "deep-dive verified" : "raw"} data: what ADX range, EMA configurations, MACD patterns, BB width, score range, and R:R ratios produce winners?${analyzedCount > 0 ? " Reference the actual keyFindings and priceActionPatterns from analyzed trades." : ""}

## The Failure Patterns
What conditions correlate with losses?${analyzedCount > 0 ? " Reference actual winLossFactors and lessonsLearned from analyzed losing trades." : ""}

## Visual Chart Identification Guide
Step-by-step: what to look for on higher TF first, then entry TF. What does a perfect setup look like?${analyzedCount > 0 ? " Use the chartPatterns field from analyzed trades to describe real patterns observed." : ""}

## Entry Execution Checklist
Numbered checklist: "must have" vs "nice to have" conditions based on the win data.

## Risk Management Rules
Best stop loss placement and take profit strategy based on the data.

## Common Mistakes to Avoid
Based on losing trades. Be specific.

## Improvement Recommendations
How could this strategy be improved? Parameter adjustments? Pair exclusions?

CRITICAL: ${analyzedCount > 0 ? "Ground all insights in the verified deep-dive findings. Do not fabricate price action details for trades that weren't analyzed." : "All recommendations are based on raw parameters. Flag that deep-dive analysis of individual trades would strengthen these conclusions."}

Be extremely detailed, reference actual numbers from the data.`;

  const response = await createChatCompletion({
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 8192,
  });

  return response.choices[0]?.message?.content || "Strategy guide could not be generated.";
}

export async function generateStrategyOptimizer(): Promise<string> {
  const stats = await storage.getBacktestStats();
  const allAnalyses = await storage.getTradeAnalyses();
  const archivedSignals = await storage.getArchivedSignals({ limit: 200 });

  if (allAnalyses.length < 3) {
    return `Only ${allAnalyses.length} trade(s) have been deep-dive analyzed. Run Trade Deep Dive on at least 5-10 signals (mix of winners and losers) to generate meaningful optimization recommendations. The more trades analyzed, the better the recommendations.`;
  }

  const signalMap = new Map(archivedSignals.map((s) => [s.id, s]));

  const analyzedTrades = allAnalyses
    .filter((a) => signalMap.has(a.signalId))
    .map((a) => {
      const sig = signalMap.get(a.signalId)!;
      const r = (sig.reasonJson ?? {}) as Record<string, any>;
      return {
        symbol: sig.instrument.canonicalSymbol,
        assetClass: sig.instrument.assetClass,
        strategy: sig.strategy,
        direction: sig.direction,
        score: sig.score,
        outcome: sig.outcome,
        detectedAt: sig.detectedAt,
        adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, pullback: r.pullback,
        macd: r.macd, bias: r.bias, breakout: r.breakout, riskRewardRatio: r.riskRewardRatio,
        atr: r.atr, stopDistance: r.stopDistance,
        entryQuality: a.entryQuality,
        keyFindings: a.keyFindings,
        winLossFactors: a.winLossFactors,
        priceActionPatterns: a.priceActionPatterns,
        chartPatterns: a.chartPatterns,
        lessonsLearned: a.lessonsLearned,
        marketPsychology: a.marketPsychology,
      };
    });

  // === LAYER 1: Portfolio Intelligence data (cross-strategy, cross-pair, session patterns) ===
  const byPair: Record<string, { wins: number; losses: number; total: number }> = {};
  const byAssetClass: Record<string, { wins: number; losses: number }> = {};
  const byHour: Record<number, { wins: number; losses: number; total: number }> = {};
  const byStrategyDir: Record<string, { wins: number; losses: number }> = {};
  const scoreRanges: Record<string, { wins: number; losses: number }> = { "0-39": { wins: 0, losses: 0 }, "40-59": { wins: 0, losses: 0 }, "60-79": { wins: 0, losses: 0 }, "80-100": { wins: 0, losses: 0 } };

  for (const s of archivedSignals) {
    const sym = s.instrument.canonicalSymbol;
    const ac = s.instrument.assetClass;
    const hour = new Date(s.detectedAt).getUTCHours();
    const stratDir = `${s.strategy}_${s.direction}`;
    const scoreKey = s.score >= 80 ? "80-100" : s.score >= 60 ? "60-79" : s.score >= 40 ? "40-59" : "0-39";

    if (!byPair[sym]) byPair[sym] = { wins: 0, losses: 0, total: 0 };
    if (!byAssetClass[ac]) byAssetClass[ac] = { wins: 0, losses: 0 };
    if (!byHour[hour]) byHour[hour] = { wins: 0, losses: 0, total: 0 };
    if (!byStrategyDir[stratDir]) byStrategyDir[stratDir] = { wins: 0, losses: 0 };

    byPair[sym].total++;
    byHour[hour].total++;
    if (s.outcome === "WIN") { byPair[sym].wins++; byAssetClass[ac].wins++; byHour[hour].wins++; byStrategyDir[stratDir].wins++; scoreRanges[scoreKey].wins++; }
    if (s.outcome === "LOSS") { byPair[sym].losses++; byAssetClass[ac].losses++; byHour[hour].losses++; byStrategyDir[stratDir].losses++; scoreRanges[scoreKey].losses++; }
  }

  const pairRankings = Object.entries(byPair)
    .map(([sym, d]) => ({ symbol: sym, ...d, winRate: d.wins + d.losses > 0 ? ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + "%" : "N/A" }))
    .sort((a, b) => b.total - a.total);

  const hourPerf = Object.entries(byHour)
    .map(([h, d]) => ({ hourUTC: parseInt(h), ...d, winRate: d.wins + d.losses > 0 ? ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + "%" : "N/A" }))
    .sort((a, b) => a.hourUTC - b.hourUTC);

  const scorePerf = Object.entries(scoreRanges).map(([range, d]) => ({
    range, ...d, winRate: d.wins + d.losses > 0 ? ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + "%" : "N/A"
  }));

  // === LAYER 2: Per-strategy breakdowns (Strategy Masterclass data) ===
  const tcTrades = analyzedTrades.filter((t) => t.strategy === "TREND_CONTINUATION");
  const rbTrades = analyzedTrades.filter((t) => t.strategy === "RANGE_BREAKOUT");

  const buildStrategyProfile = (trades: typeof analyzedTrades, name: string) => {
    const wins = trades.filter((t) => t.outcome === "WIN");
    const losses = trades.filter((t) => t.outcome === "LOSS");
    const winAdxAvg = wins.length > 0 ? (wins.reduce((s, t) => s + (parseFloat(t.adx) || 0), 0) / wins.length).toFixed(1) : "N/A";
    const lossAdxAvg = losses.length > 0 ? (losses.reduce((s, t) => s + (parseFloat(t.adx) || 0), 0) / losses.length).toFixed(1) : "N/A";
    const excellentEntries = trades.filter((t) => t.entryQuality === "EXCELLENT" || t.entryQuality === "GOOD");
    const poorEntries = trades.filter((t) => t.entryQuality === "POOR" || t.entryQuality === "FAIR");
    const commonWinPatterns = wins.map((t) => t.chartPatterns).filter(Boolean);
    const commonLossFactors = losses.map((t) => t.winLossFactors).filter(Boolean);
    const commonLessons = trades.map((t) => t.lessonsLearned).filter(Boolean);
    return {
      name,
      total: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length + losses.length > 0 ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1) + "%" : "N/A",
      winAdxAvg, lossAdxAvg,
      excellentEntryCount: excellentEntries.length,
      poorEntryCount: poorEntries.length,
      commonWinPatterns: commonWinPatterns.slice(0, 10),
      commonLossFactors: commonLossFactors.slice(0, 10),
      commonLessons: commonLessons.slice(0, 10),
    };
  };

  const tcProfile = buildStrategyProfile(tcTrades, "TREND_CONTINUATION");
  const rbProfile = buildStrategyProfile(rbTrades, "RANGE_BREAKOUT");

  // === LAYER 3: Aggregated deep-dive insights ===
  const allKeyFindings = analyzedTrades.map((t) => `[${t.symbol} ${t.outcome}] ${t.keyFindings}`).filter((f) => f.length > 20);
  const allLessons = analyzedTrades.map((t) => `[${t.symbol} ${t.strategy} ${t.outcome}] ${t.lessonsLearned}`).filter((f) => f.length > 20);
  const allPsychology = analyzedTrades.map((t) => `[${t.symbol} ${t.outcome}] ${t.marketPsychology}`).filter((f) => f.length > 20);

  const prompt = `You are an expert quantitative trading systems architect and strategy optimizer. You are the FINAL LAYER in a 4-tier analysis system. You receive the complete intelligence from three upstream layers and must synthesize it all into concrete, actionable optimization recommendations.

YOUR DATA SOURCES (from upstream analysis layers):

=== LAYER 1: PORTFOLIO INTELLIGENCE (Cross-strategy, cross-pair, session patterns) ===

OVERALL PERFORMANCE:
- Total resolved: ${stats.total}, Wins: ${stats.wins}, Losses: ${stats.losses}, Missed: ${stats.missed}
- Win rate: ${stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0}%
- Taken trades win rate: ${stats.takenTotal > 0 ? ((stats.takenWins / stats.takenTotal) * 100).toFixed(1) : "N/A"}%
- By Strategy: ${JSON.stringify(stats.byStrategy)}
- By Direction: ${JSON.stringify(stats.byDirection)}
- By Strategy+Direction: ${JSON.stringify(byStrategyDir)}

PAIR RANKINGS (${pairRankings.length} pairs):
${JSON.stringify(pairRankings, null, 1)}

ASSET CLASS PERFORMANCE:
${JSON.stringify(byAssetClass, null, 1)}

SESSION/HOURLY PERFORMANCE (UTC):
${JSON.stringify(hourPerf, null, 1)}

WIN RATE BY SCORE RANGE:
${JSON.stringify(scorePerf, null, 1)}

=== LAYER 2: STRATEGY MASTERCLASS (Per-strategy winning formulas & failure patterns) ===

TREND_CONTINUATION PROFILE:
${JSON.stringify(tcProfile, null, 1)}

RANGE_BREAKOUT PROFILE:
${JSON.stringify(rbProfile, null, 1)}

=== LAYER 3: TRADE DEEP DIVE (${analyzedTrades.length} individually verified trade analyses) ===

ANALYZED TRADES WITH FINDINGS:
${JSON.stringify(analyzedTrades, null, 1)}

AGGREGATED KEY FINDINGS (across all analyzed trades):
${allKeyFindings.slice(0, 30).join("\n")}

AGGREGATED LESSONS LEARNED:
${allLessons.slice(0, 30).join("\n")}

AGGREGATED MARKET PSYCHOLOGY OBSERVATIONS:
${allPsychology.slice(0, 20).join("\n")}

=== CURRENT STRATEGY CODE LOGIC ===
1. TREND_CONTINUATION: Requires ADX >= 18, EMA stack alignment (EMA9 > EMA21 > EMA55 for LONG, reversed for SHORT), pullback to EMA21/EMA55 zone, MACD histogram confirmation, 1h bias via EMA200 slope direction.
2. RANGE_BREAKOUT: Requires ADX <= 18, narrow Bollinger Band width (< median width), price breaking above/below recent 20-bar range, BB band confirmation (close above upper BB for LONG, below lower BB for SHORT).

=== YOUR TASK ===
Synthesize ALL three layers of intelligence into concrete optimization recommendations. You are seeing the FULL picture that no individual tab can see.

## System Health Assessment
Overall system effectiveness based on all three intelligence layers. Is the scanner generating edge? What's the trajectory?

## TREND_CONTINUATION Optimizations
For each recommendation, provide:
- **Current Setting**: What the strategy currently does
- **Recommended Change**: The specific parameter or logic change
- **Evidence from Portfolio Intelligence**: Which pairs/sessions/scores support this?
- **Evidence from Deep-Dive Analyses**: Which specific trade findings validate this? (reference symbol, outcome, and findings)
- **Evidence from Strategy Profile**: What do the aggregated win/loss patterns show?
- **Expected Impact**: Quantified improvement estimate
- **Confidence**: HIGH/MEDIUM/LOW based on evidence strength

Focus: ADX thresholds, EMA requirements, pullback quality, MACD rules, score filters, pair-specific filters, session filters.

## RANGE_BREAKOUT Optimizations
Same format. Focus: ADX ceiling, BB width thresholds, breakout confirmation, pair suitability, session timing.

## Cross-Strategy Insights
Patterns that span BOTH strategies — things Portfolio Intelligence reveals that single-strategy analysis misses:
- Pair correlations across strategies
- Session timing that affects both
- Score thresholds that apply universally
- Direction biases across the board

## Pair Universe Optimization
Based on ALL layers, for each pair with sufficient data:
- **KEEP** (consistently profitable across strategies)
- **EXCLUDE** (consistently losing, deep-dive confirms poor setups)
- **RESTRICT** (profitable on one strategy but not the other)
- **MONITOR** (insufficient data)

## Session & Timing Rules
Should the scanner only run during certain hours? Are there dead zones that consistently produce losers?

## Score & Risk Calibration
- Optimal score threshold based on scoreRange win rates AND deep-dive entry quality ratings
- Stop placement improvements based on deep-dive price action observations
- R:R target adjustments based on what the data actually shows

## Market Psychology Integration
From deep-dive analyses: recurring smart money patterns, liquidity grabs, stop hunts — and how strategy parameters should account for them.

## Implementation Priority (Ranked)
Rank ALL recommendations from highest to lowest expected impact:
1. [Highest impact change] - Evidence: ... - Estimated win rate improvement: ...
2. ...

## Plain-English Code Changes
For each recommendation, describe the code change clearly:
- "Change ADX check from >= 18 to >= 22 in trend continuation evaluation"
- "Add session filter: skip signals detected between 21:00-01:00 UTC"
- "Exclude GBPJPY from range breakout strategy"
Do NOT write actual code. Describe changes so a developer can implement them.

CRITICAL RULES:
1. Every recommendation MUST cite evidence from at least 2 of the 3 layers. Cross-referenced findings are stronger.
2. Flag any recommendation where only 1 layer supports it — mark confidence as LOW.
3. If data is insufficient for a recommendation, say so explicitly.
4. These are RECOMMENDATIONS ONLY — nothing is auto-applied. The trader reviews and decides.
5. Quantify expected impact where possible (e.g., "based on the data, this would have prevented 3 of the 5 losses in the dataset").`;

  const response = await createChatCompletion({
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 12000,
  });

  return response.choices[0]?.message?.content || "Optimizer recommendations could not be generated.";
}

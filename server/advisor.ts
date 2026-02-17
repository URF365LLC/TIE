import OpenAI from "openai";
import { storage } from "./storage";
import { fetchTimeSeriesRange } from "./twelvedata";
import { canonicalToVendor } from "@shared/schema";
import { log } from "./logger";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export async function analyzePortfolio(): Promise<string> {
  const stats = await storage.getBacktestStats();
  const archivedSignals = await storage.getArchivedSignals({ limit: 200 });

  if (!archivedSignals.length) {
    return "No completed signals to analyze yet. Run scans and let signals resolve (win/loss/missed) to build your dataset.";
  }

  const signalSummaries = archivedSignals.map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    return {
      symbol: s.instrument.canonicalSymbol,
      assetClass: s.instrument.assetClass,
      strategy: s.strategy,
      direction: s.direction,
      timeframe: s.timeframe,
      score: s.score,
      status: s.status,
      outcome: s.outcome,
      outcomePrice: s.outcomePrice,
      detectedAt: s.detectedAt,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      stopDistance: r.stopDistance,
      riskRewardRatio: r.riskRewardRatio,
      atr: r.atr,
      adx: r.adx,
      bbWidth: r.bbWidth,
      bias: r.bias,
      emaStack: r.emaStack,
      pullback: r.pullback,
      macd: r.macd,
      breakout: r.breakout,
      ema21Zone: r.ema21Zone,
      ema55Zone: r.ema55Zone,
      rangeHigh: r.rangeHigh,
      rangeLow: r.rangeLow,
    };
  });

  const prompt = `You are an expert quantitative trading analyst and technical advisor. You are analyzing a dataset of ${archivedSignals.length} completed trading signals from an automated scanner.

OVERALL STATS:
- Total resolved signals: ${stats.total}
- Wins: ${stats.wins}, Losses: ${stats.losses}, Missed: ${stats.missed}
- Overall win rate: ${stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0}%
- Taken trades win rate: ${stats.takenTotal > 0 ? ((stats.takenWins / stats.takenTotal) * 100).toFixed(1) : "N/A"}% (${stats.takenTotal} trades taken)
- By Strategy: ${JSON.stringify(stats.byStrategy)}
- By Direction: ${JSON.stringify(stats.byDirection)}

SIGNAL DATA (last ${archivedSignals.length} signals):
${JSON.stringify(signalSummaries, null, 1)}

Provide a comprehensive portfolio intelligence analysis. Structure your response with these sections:

## Performance Overview
Summarize overall performance, win rates, and the effectiveness of the scanning system.

## Strategy Analysis
Break down each strategy (TREND_CONTINUATION, RANGE_BREAKOUT). Which performs better? Under what conditions? What score thresholds correlate with higher win rates?

## Best & Worst Performers
Which symbols/pairs win most often? Which lose? Is there an asset class (FOREX/METAL/CRYPTO) that outperforms?

## Pattern Recognition
Identify correlations between wins and specific technical factors:
- ADX ranges that produce more wins
- EMA stack configurations in winners vs losers
- Pullback quality patterns
- MACD alignment patterns
- Bollinger Band width thresholds
- Risk:reward ratios that actually paid off

## Timing Analysis
Are there time-of-day or session patterns? Do signals detected at certain hours perform better?

## Score Threshold Analysis
At what score level do win rates meaningfully improve? Should the minimum alert score be adjusted?

## Actionable Recommendations
Specific, data-driven recommendations to improve win rate and trading edge. Be concrete and reference the actual numbers.

## Winner's Playbook
Based on the winning signals, define the exact conditions that produce the most reliable setups. This is the checklist the trader should look for when screening charts manually.

Be direct, technical, and data-driven. Reference actual numbers from the dataset. Don't give generic trading advice — everything must be grounded in this specific data.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
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

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
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

    const extractRes = await openai.chat.completions.create({
      model: "gpt-5.2",
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

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
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
        adx: r.adx, bbWidth: r.bbWidth, emaStack: r.emaStack, pullback: r.pullback,
        macd: r.macd, bias: r.bias, breakout: r.breakout, riskRewardRatio: r.riskRewardRatio,
        atr: r.atr, stopDistance: r.stopDistance,
        entryQuality: a.entryQuality,
        keyFindings: a.keyFindings,
        winLossFactors: a.winLossFactors,
        priceActionPatterns: a.priceActionPatterns,
        chartPatterns: a.chartPatterns,
        lessonsLearned: a.lessonsLearned,
      };
    });

  const prompt = `You are an expert quantitative trading systems developer and strategy optimizer. You have access to ${analyzedTrades.length} trades that have been individually deep-dive analyzed with 1-minute candle data. Your job is to recommend specific, actionable improvements to the trading strategies.

CURRENT STRATEGY IMPLEMENTATIONS:
1. TREND_CONTINUATION: Requires ADX >= 18, EMA stack alignment (9 > 21 > 55 for LONG), pullback to EMA21/EMA55 zone, MACD histogram confirmation, 1h bias via EMA200 slope.
2. RANGE_BREAKOUT: Requires ADX <= 18, narrow Bollinger Band width, price breaking above/below recent range with BB band confirmation.

OVERALL PERFORMANCE:
- Total resolved: ${stats.total}, Wins: ${stats.wins}, Losses: ${stats.losses}, Missed: ${stats.missed}
- Win rate: ${stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0}%
- By Strategy: ${JSON.stringify(stats.byStrategy)}
- By Direction: ${JSON.stringify(stats.byDirection)}

DEEP-DIVE ANALYZED TRADES (${analyzedTrades.length} trades with verified 1-minute price action analysis):
${JSON.stringify(analyzedTrades, null, 1)}

Based on the VERIFIED findings from deep-dive analyzed trades, provide strategy optimization recommendations. Structure your response:

## Current Performance Assessment
How are the strategies performing? What's working and what isn't? Be specific with numbers.

## TREND_CONTINUATION Optimizations
For each recommendation, provide:
- **Current Setting**: What the strategy currently does
- **Recommended Change**: The specific parameter or logic change
- **Evidence**: Which analyzed trades support this recommendation (reference specific symbols, outcomes, and findings)
- **Expected Impact**: What improvement this should produce

Focus areas: ADX threshold, EMA stack requirements, pullback quality filters, MACD confirmation rules, score threshold, pair-specific adjustments.

## RANGE_BREAKOUT Optimizations
Same format as above. Focus areas: ADX ceiling, BB width threshold, breakout confirmation, volume requirements, pair suitability.

## Pair-Specific Recommendations
Which pairs should be:
- Kept (consistently profitable)
- Excluded (consistently losing)
- Monitored (mixed results, need more data)
Reference the deep-dive findings for each recommendation.

## Score Threshold Analysis
Should the minimum score for alerts be raised or lowered? What score range produces the highest win rate based on the analyzed trades?

## Risk Management Improvements
Based on the analyzed price action, are stops well-placed? Should stop distance calculations change? Is the R:R target appropriate?

## Implementation Priority
Rank the recommendations from highest to lowest impact. Which changes should be made first?

## Code Change Descriptions
For each recommendation, describe IN PLAIN ENGLISH what the code change would look like. Example: "In the trend continuation evaluation, change the ADX check from >= 18 to >= 22" or "Add a new filter that rejects signals where BB width is above 0.015".
Do NOT write actual code — describe the changes clearly so a developer can implement them.

CRITICAL RULES:
1. Every recommendation MUST be grounded in specific findings from the analyzed trades. No generic advice.
2. Reference specific trade outcomes and findings by symbol and outcome.
3. If the data is insufficient to support a recommendation, say so explicitly rather than guessing.
4. These are RECOMMENDATIONS ONLY — they will NOT be automatically applied. The trader reviews and decides.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 8192,
  });

  return response.choices[0]?.message?.content || "Optimizer recommendations could not be generated.";
}

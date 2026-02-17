import OpenAI from "openai";
import { storage } from "./storage";
import { fetchTimeSeriesRange } from "./twelvedata";
import { canonicalToVendor } from "@shared/schema";
import { log } from "./logger";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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

  return response.choices[0]?.message?.content || "Analysis could not be generated.";
}

export async function generateStrategyGuide(strategy: string): Promise<string> {
  const stats = await storage.getBacktestStats();
  const archivedSignals = await storage.getArchivedSignals({ strategy, limit: 100 });

  if (!archivedSignals.length) {
    return `No completed signals for the ${strategy} strategy yet. Run scans and let signals resolve to build data for this strategy.`;
  }

  const wins = archivedSignals.filter((s) => s.outcome === "WIN");
  const losses = archivedSignals.filter((s) => s.outcome === "LOSS");

  const winConditions = wins.map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    return {
      symbol: s.instrument.canonicalSymbol,
      assetClass: s.instrument.assetClass,
      direction: s.direction,
      score: s.score,
      adx: r.adx,
      bbWidth: r.bbWidth,
      emaStack: r.emaStack,
      pullback: r.pullback,
      macd: r.macd,
      bias: r.bias,
      breakout: r.breakout,
      riskRewardRatio: r.riskRewardRatio,
      atr: r.atr,
      stopDistance: r.stopDistance,
      entryPrice: r.entryPrice,
      detectedAt: s.detectedAt,
    };
  });

  const lossConditions = losses.map((s) => {
    const r = (s.reasonJson ?? {}) as Record<string, any>;
    return {
      symbol: s.instrument.canonicalSymbol,
      assetClass: s.instrument.assetClass,
      direction: s.direction,
      score: s.score,
      adx: r.adx,
      bbWidth: r.bbWidth,
      emaStack: r.emaStack,
      pullback: r.pullback,
      macd: r.macd,
      bias: r.bias,
      breakout: r.breakout,
      riskRewardRatio: r.riskRewardRatio,
      atr: r.atr,
      stopDistance: r.stopDistance,
      entryPrice: r.entryPrice,
      detectedAt: s.detectedAt,
    };
  });

  const strategyName = strategy === "TREND_CONTINUATION" ? "Trend Continuation" : "Range Breakout";
  const strategyDesc = strategy === "TREND_CONTINUATION"
    ? "Uses 1h bias (EMA200 slope) + 15m entry (EMA stack alignment, pullback to EMA zone, MACD confirmation, ADX>=18 for trend strength)"
    : "Detects low-volatility consolidation (ADX<=18, narrow BB width), then signals breakout above/below range with Bollinger Band confirmation";

  const prompt = `You are an expert trading strategy coach and technical analyst. You are creating a comprehensive strategy masterclass based on real performance data.

STRATEGY: ${strategyName}
DESCRIPTION: ${strategyDesc}

PERFORMANCE DATA:
- Total signals: ${archivedSignals.length}
- Wins: ${wins.length} (${archivedSignals.length > 0 ? ((wins.length / archivedSignals.length) * 100).toFixed(1) : 0}%)
- Losses: ${losses.length} (${archivedSignals.length > 0 ? ((losses.length / archivedSignals.length) * 100).toFixed(1) : 0}%)
- Strategy stats from backtest: ${JSON.stringify(stats.byStrategy[strategy] || {})}

WINNING TRADE CONDITIONS (${wins.length} trades):
${JSON.stringify(winConditions, null, 1)}

LOSING TRADE CONDITIONS (${losses.length} trades):
${JSON.stringify(lossConditions, null, 1)}

Create a comprehensive strategy masterclass with these sections:

## Strategy Overview
Explain the ${strategyName} strategy in plain language. How does it work? What market condition is it designed to exploit? What edge does it provide?

## Performance Breakdown
Analyze the actual performance data. Win rate by direction (LONG vs SHORT), by asset class, by symbol. Which pairs does this strategy work best on?

## The Winning Formula
Based on the winning trades data, what specific technical conditions are present in the majority of winners?
- What ADX range do winners cluster in?
- What EMA stack configurations appear in winners?
- What MACD patterns are present?
- What Bollinger Band width range correlates with wins?
- What score range produces the most winners?
- What risk:reward ratios worked best?

## The Failure Patterns
Based on losing trades, what conditions are present when this strategy fails?
- What ADX values correlate with losses?
- Are there common patterns in the losing trades?
- Were stops too tight? Too wide?
- Did losses cluster on specific pairs or times?

## Visual Chart Identification Guide
Describe EXACTLY what this setup looks like on a chart. A step-by-step visual guide:
1. What to look for on the higher timeframe (1h) first
2. What to look for on the entry timeframe (15m)
3. The exact sequence of visual confirmations before entry
4. What the "perfect" version of this setup looks like on the chart
5. What a "borderline" or "weak" version looks like (and whether to take it)

## Entry Execution Checklist
A numbered checklist the trader should mentally go through before entering:
- Each item should be a specific, observable condition
- Rate each condition as "must have" or "nice to have" based on the win data

## Risk Management Rules
Based on the data, what stop loss placement and take profit strategy works best for this strategy? What position sizing considerations are specific to this strategy?

## Common Mistakes to Avoid
Based on the losing trades, what mistakes lead to losses? Specific things the trader should NOT do.

## Improvement Recommendations
Based on all the data, how could this strategy be improved? Should filters be tightened? Score thresholds adjusted? Specific pairs excluded?

Be extremely detailed, reference actual numbers from the data. This should serve as a complete manual for mastering this specific strategy.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 8192,
  });

  return response.choices[0]?.message?.content || "Strategy guide could not be generated.";
}

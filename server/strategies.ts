import type { Candle, Indicator, InsertSignal } from "@shared/schema";

interface StrategyInput {
  instrumentId: number;
  entryCandles: Candle[];
  entryIndicators: Indicator[];
  biasCandles: Candle[];
  biasIndicators: Indicator[];
  entryTimeframe: string;
}

interface StrategyResult {
  strategy: string;
  direction: "LONG" | "SHORT";
  score: number;
  reasonJson: Record<string, any>;
}

export function evaluateStrategies(input: StrategyInput): StrategyResult[] {
  const results: StrategyResult[] = [];

  const trend = evaluateTrendContinuation(input);
  if (trend) results.push(trend);

  const breakout = evaluateRangeBreakout(input);
  if (breakout) results.push(breakout);

  return results;
}

function evaluateTrendContinuation(input: StrategyInput): StrategyResult | null {
  const { biasIndicators, entryCandles, entryIndicators } = input;

  if (biasIndicators.length < 4 || entryIndicators.length < 2 || entryCandles.length < 2) return null;

  const latestBias = biasIndicators[0];
  const bias3Ago = biasIndicators[3];
  const latestEntry = entryIndicators[0];
  const latestCandle = entryCandles[0];
  const prevCandle = entryCandles[1];

  if (!latestBias.ema200 || !bias3Ago?.ema200 || !latestEntry.ema9 || !latestEntry.ema21 || !latestEntry.ema55) return null;
  if (!latestEntry.macdHist || latestEntry.adx == null || !latestEntry.atr) return null;

  const ema200SlopeUp = latestBias.ema200 > bias3Ago.ema200;
  const ema200SlopeDown = latestBias.ema200 < bias3Ago.ema200;
  const closeBias = latestCandle.close;

  let direction: "LONG" | "SHORT" | null = null;
  const reasons: Record<string, any> = {};
  let score = 0;

  const longBias = closeBias > latestBias.ema200 && ema200SlopeUp;
  const shortBias = closeBias < latestBias.ema200 && ema200SlopeDown;

  if (!longBias && !shortBias) return null;

  direction = longBias ? "LONG" : "SHORT";
  reasons.bias = direction === "LONG" ? "close > EMA200, slope up" : "close < EMA200, slope down";
  score += 20;

  const emaStack = direction === "LONG"
    ? latestEntry.ema9 > latestEntry.ema21 && latestEntry.ema21 > latestEntry.ema55
    : latestEntry.ema9 < latestEntry.ema21 && latestEntry.ema21 < latestEntry.ema55;

  if (emaStack) {
    score += 25;
    reasons.emaStack = "aligned";
  }

  const ema21Val = latestEntry.ema21;
  const ema55Val = latestEntry.ema55;
  const pullbackZone = direction === "LONG"
    ? (prevCandle.low <= ema21Val * 1.002 || prevCandle.low <= ema55Val * 1.005) && latestCandle.close > ema21Val
    : (prevCandle.high >= ema21Val * 0.998 || prevCandle.high >= ema55Val * 0.995) && latestCandle.close < ema21Val;

  if (pullbackZone) {
    score += 20;
    reasons.pullback = "reclaim after dip";
  }

  const macdConfirm = direction === "LONG" ? latestEntry.macdHist >= 0 : latestEntry.macdHist <= 0;
  if (macdConfirm) {
    score += 15;
    reasons.macd = "histogram confirms direction";
  }

  if (latestEntry.adx >= 18) {
    score += 20;
    reasons.adx = `trending (${latestEntry.adx.toFixed(1)})`;
  }

  reasons.atr = latestEntry.atr;
  reasons.stopDistance = (1.2 * latestEntry.atr).toFixed(5);

  if (score < 40) return null;

  return { strategy: "TREND_CONTINUATION", direction, score: Math.min(score, 100), reasonJson: reasons };
}

function evaluateRangeBreakout(input: StrategyInput): StrategyResult | null {
  const { entryCandles, entryIndicators } = input;

  if (entryIndicators.length < 50 || entryCandles.length < 20) return null;

  const latestInd = entryIndicators[0];
  const latestCandle = entryCandles[0];

  if (latestInd.adx == null || !latestInd.bbWidth || !latestInd.bbUpper || !latestInd.bbLower || !latestInd.atr) return null;

  if (latestInd.adx > 18) return null;

  const bbWidths = entryIndicators.slice(0, 50).map((i) => i.bbWidth).filter((w): w is number => w != null);
  if (bbWidths.length < 10) return null;

  const sorted = [...bbWidths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  if (latestInd.bbWidth >= median) return null;

  const last20 = entryCandles.slice(0, 20);
  const rangeHigh = Math.max(...last20.map((c) => c.high));
  const rangeLow = Math.min(...last20.map((c) => c.low));

  const reasons: Record<string, any> = {
    adx: latestInd.adx,
    bbWidth: latestInd.bbWidth,
    medianBBWidth: median,
    rangeHigh,
    rangeLow,
    atr: latestInd.atr,
    stopDistance: (1.2 * latestInd.atr).toFixed(5),
  };

  let direction: "LONG" | "SHORT" | null = null;
  let score = 0;

  if (latestCandle.close > rangeHigh && latestCandle.close >= latestInd.bbUpper) {
    direction = "LONG";
    reasons.breakout = "above range high + BB upper";
    score = 65;
  } else if (latestCandle.close < rangeLow && latestCandle.close <= latestInd.bbLower) {
    direction = "SHORT";
    reasons.breakout = "below range low + BB lower";
    score = 65;
  }

  if (!direction) return null;

  return { strategy: "RANGE_BREAKOUT", direction, score: Math.min(score, 100), reasonJson: reasons };
}

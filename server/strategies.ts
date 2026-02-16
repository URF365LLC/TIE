import type { Candle, Indicator } from "@shared/schema";

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

function indicatorForCandle(indicators: Indicator[], candle: Candle): Indicator | undefined {
  return indicators.find((i) => i.datetimeUtc.getTime() === candle.datetimeUtc.getTime());
}

export function hasRequiredIndicators(ind: Indicator | undefined): boolean {
  return Boolean(
    ind &&
      ind.ema9 != null &&
      ind.ema21 != null &&
      ind.ema55 != null &&
      ind.ema200 != null &&
      ind.bbUpper != null &&
      ind.bbMiddle != null &&
      ind.bbLower != null &&
      ind.bbWidth != null &&
      ind.macdHist != null &&
      ind.atr != null &&
      ind.adx != null
  );
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

  if (biasIndicators.length < 4 || entryCandles.length < 2) return null;

  const latestClosed = entryCandles[0];
  const prevClosed = entryCandles[1];
  const latestEntry = indicatorForCandle(entryIndicators, latestClosed);
  const latestBias = biasIndicators[0];
  const bias3Ago = biasIndicators[3];

  if (!latestEntry || latestBias.ema200 == null || bias3Ago?.ema200 == null) return null;
  if (!hasRequiredIndicators(latestEntry)) return null;

  const ema200SlopeUp = latestBias.ema200 > bias3Ago.ema200;
  const ema200SlopeDown = latestBias.ema200 < bias3Ago.ema200;
  const closeBias = latestClosed.close;

  let direction: "LONG" | "SHORT" | null = null;
  const reasons: Record<string, any> = {};
  let score = 0;

  const longBias = closeBias > latestBias.ema200 && ema200SlopeUp;
  const shortBias = closeBias < latestBias.ema200 && ema200SlopeDown;

  if (!longBias && !shortBias) return null;

  direction = longBias ? "LONG" : "SHORT";
  reasons.bias = direction === "LONG" ? "close > EMA200, slope up" : "close < EMA200, slope down";
  score += 20;

  const emaStack =
    direction === "LONG"
      ? latestEntry.ema9! > latestEntry.ema21! && latestEntry.ema21! > latestEntry.ema55!
      : latestEntry.ema9! < latestEntry.ema21! && latestEntry.ema21! < latestEntry.ema55!;

  if (emaStack) {
    score += 25;
    reasons.emaStack = "aligned";
  }

  const ema21Val = latestEntry.ema21!;
  const ema55Val = latestEntry.ema55!;
  const pullbackZone =
    direction === "LONG"
      ? (prevClosed.low <= ema21Val * 1.002 || prevClosed.low <= ema55Val * 1.005) && latestClosed.close > ema21Val
      : (prevClosed.high >= ema21Val * 0.998 || prevClosed.high >= ema55Val * 0.995) && latestClosed.close < ema21Val;

  if (pullbackZone) {
    score += 20;
    reasons.pullback = "reclaim after dip";
  }

  const macdConfirm = direction === "LONG" ? latestEntry.macdHist! >= 0 : latestEntry.macdHist! <= 0;
  if (macdConfirm) {
    score += 15;
    reasons.macd = "histogram confirms direction";
  }

  if (latestEntry.adx! >= 18) {
    score += 20;
    reasons.adx = `trending (${latestEntry.adx!.toFixed(1)})`;
  }

  const entryPrice = latestClosed.close;
  const atr = latestEntry.atr!;
  const stopDist = 1.2 * atr;
  const stopLoss = direction === "LONG" ? entryPrice - stopDist : entryPrice + stopDist;
  const takeProfit = direction === "LONG" ? entryPrice + stopDist * 2 : entryPrice - stopDist * 2;

  reasons.entryPrice = parseFloat(entryPrice.toFixed(5));
  reasons.stopLoss = parseFloat(stopLoss.toFixed(5));
  reasons.takeProfit = parseFloat(takeProfit.toFixed(5));
  reasons.atr = parseFloat(atr.toFixed(5));
  reasons.stopDistance = parseFloat(stopDist.toFixed(5));
  reasons.riskRewardRatio = "1:2";
  reasons.ema21Zone = parseFloat(ema21Val.toFixed(5));
  reasons.ema55Zone = parseFloat(ema55Val.toFixed(5));

  if (score < 40) return null;

  return { strategy: "TREND_CONTINUATION", direction, score: Math.min(score, 100), reasonJson: reasons };
}

function evaluateRangeBreakout(input: StrategyInput): StrategyResult | null {
  const { entryCandles, entryIndicators } = input;

  if (entryCandles.length < 24 || entryIndicators.length < 50) return null;

  const latestClosed = entryCandles[0];
  const prevClosed = entryCandles[1];
  const latestInd = indicatorForCandle(entryIndicators, latestClosed);
  if (!latestInd || !hasRequiredIndicators(latestInd)) return null;

  // filters first: ADX -> BB width -> ATR present (in hasRequiredIndicators)
  if (latestInd.adx! > 18) return null;

  const bbWidths = entryIndicators.slice(0, 50).map((i) => i.bbWidth).filter((w): w is number => w != null);
  if (bbWidths.length < 10) return null;
  const sorted = [...bbWidths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (latestInd.bbWidth! >= median) return null;

  // Build range from candles BEFORE the two follow-through candles.
  const baseRange = entryCandles.slice(2, 22);
  const rangeHigh = Math.max(...baseRange.map((c) => c.high));
  const rangeLow = Math.min(...baseRange.map((c) => c.low));

  const atr = latestInd.atr!;
  const stopDist = 1.2 * atr;

  const reasons: Record<string, any> = {
    adx: parseFloat(latestInd.adx!.toFixed(1)),
    bbWidth: parseFloat(latestInd.bbWidth!.toFixed(5)),
    medianBBWidth: parseFloat(median.toFixed(5)),
    rangeHigh: parseFloat(rangeHigh.toFixed(5)),
    rangeLow: parseFloat(rangeLow.toFixed(5)),
    atr: parseFloat(atr.toFixed(5)),
    stopDistance: parseFloat(stopDist.toFixed(5)),
  };

  let direction: "LONG" | "SHORT" | null = null;
  let score = 0;

  const longFollowThrough =
    prevClosed.close > rangeHigh && latestClosed.close > rangeHigh && latestClosed.close >= latestInd.bbUpper!;
  const shortFollowThrough =
    prevClosed.close < rangeLow && latestClosed.close < rangeLow && latestClosed.close <= latestInd.bbLower!;

  if (longFollowThrough) {
    direction = "LONG";
    reasons.breakout = "2 consecutive closes above range high + BB upper";
    score = 70;
  } else if (shortFollowThrough) {
    direction = "SHORT";
    reasons.breakout = "2 consecutive closes below range low + BB lower";
    score = 70;
  }

  if (!direction) return null;

  const entryPrice = latestClosed.close;
  const stopLoss = direction === "LONG" ? entryPrice - stopDist : entryPrice + stopDist;
  const takeProfit = direction === "LONG" ? entryPrice + stopDist * 2 : entryPrice - stopDist * 2;

  reasons.entryPrice = parseFloat(entryPrice.toFixed(5));
  reasons.stopLoss = parseFloat(stopLoss.toFixed(5));
  reasons.takeProfit = parseFloat(takeProfit.toFixed(5));
  reasons.riskRewardRatio = "1:2";

  return { strategy: "RANGE_BREAKOUT", direction, score: Math.min(score, 100), reasonJson: reasons };
}

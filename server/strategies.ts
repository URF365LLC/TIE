import type { Candle, Indicator, StrategyParamsConfig } from "@shared/schema";
import { DEFAULT_STRATEGY_PARAMS } from "@shared/schema";

interface StrategyInput {
  instrumentId: number;
  entryCandles: Candle[];
  entryIndicators: Indicator[];
  biasCandles: Candle[];
  biasIndicators: Indicator[];
  entryTimeframe: string;
  params?: StrategyParamsConfig;
}

export interface StrategyResult {
  strategy: string;
  direction: "LONG" | "SHORT";
  score: number;
  reasonJson: Record<string, any>;
}

export interface StrategyRejection {
  strategy: string;
  reason: string;
  details?: Record<string, any>;
}

export interface StrategyEvaluation {
  accepted: StrategyResult[];
  rejections: StrategyRejection[];
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

export function evaluateStrategies(input: StrategyInput): StrategyEvaluation {
  const params = input.params ?? DEFAULT_STRATEGY_PARAMS;
  const accepted: StrategyResult[] = [];
  const rejections: StrategyRejection[] = [];

  const trend = evaluateTrendContinuation(input, params.trendContinuation);
  if ("score" in trend) accepted.push(trend);
  else rejections.push(trend);

  const breakout = evaluateRangeBreakout(input, params.rangeBreakout);
  if ("score" in breakout) accepted.push(breakout);
  else rejections.push(breakout);

  return { accepted, rejections };
}

function reject(strategy: string, reason: string, details?: Record<string, any>): StrategyRejection {
  return { strategy, reason, details };
}

function evaluateTrendContinuation(
  input: StrategyInput,
  params: StrategyParamsConfig["trendContinuation"],
): StrategyResult | StrategyRejection {
  const { biasIndicators, entryCandles, entryIndicators } = input;
  const STRAT = "TREND_CONTINUATION";

  if (biasIndicators.length < 4 || entryCandles.length < 2) {
    return reject(STRAT, "insufficient_data", { biasIndicators: biasIndicators.length, entryCandles: entryCandles.length });
  }

  const latestClosed = entryCandles[0];
  const prevClosed = entryCandles[1];
  const latestEntry = indicatorForCandle(entryIndicators, latestClosed);
  const latestBias = biasIndicators[0];
  const bias3Ago = biasIndicators[3];

  if (!latestEntry || latestBias.ema200 == null || bias3Ago?.ema200 == null) {
    return reject(STRAT, "missing_indicator_values");
  }
  if (!hasRequiredIndicators(latestEntry)) {
    return reject(STRAT, "incomplete_entry_indicators");
  }

  const ema200SlopeUp = latestBias.ema200 > bias3Ago.ema200;
  const ema200SlopeDown = latestBias.ema200 < bias3Ago.ema200;
  const closeBias = latestClosed.close;

  const longBias = closeBias > latestBias.ema200 && ema200SlopeUp;
  const shortBias = closeBias < latestBias.ema200 && ema200SlopeDown;

  if (!longBias && !shortBias) {
    return reject(STRAT, "no_directional_bias", {
      ema200: latestBias.ema200,
      slope: ema200SlopeUp ? "up" : ema200SlopeDown ? "down" : "flat",
      close: closeBias,
    });
  }

  const direction: "LONG" | "SHORT" = longBias ? "LONG" : "SHORT";
  const reasons: Record<string, any> = {
    bias: direction === "LONG" ? "close > EMA200, slope up" : "close < EMA200, slope down",
  };
  let score = 20;

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
  const tol = params.pullbackTolerance;
  const pullbackZone =
    direction === "LONG"
      ? (prevClosed.low <= ema21Val * (1 + tol) || prevClosed.low <= ema55Val * (1 + tol * 2.5)) && latestClosed.close > ema21Val
      : (prevClosed.high >= ema21Val * (1 - tol) || prevClosed.high >= ema55Val * (1 - tol * 2.5)) && latestClosed.close < ema21Val;

  if (pullbackZone) {
    score += 20;
    reasons.pullback = "reclaim after dip";
  }

  const macdConfirm = direction === "LONG" ? latestEntry.macdHist! >= 0 : latestEntry.macdHist! <= 0;
  if (macdConfirm) {
    score += 15;
    reasons.macd = "histogram confirms direction";
  }

  if (latestEntry.adx! >= params.adxThreshold) {
    score += 20;
    reasons.adx = `trending (${latestEntry.adx!.toFixed(1)})`;
  }

  const entryPrice = latestClosed.close;
  const atr = latestEntry.atr!;
  const stopDist = params.atrStopMultiplier * atr;
  const stopLoss = direction === "LONG" ? entryPrice - stopDist : entryPrice + stopDist;
  const takeProfit = direction === "LONG" ? entryPrice + stopDist * params.riskRewardRatio : entryPrice - stopDist * params.riskRewardRatio;

  reasons.entryPrice = parseFloat(entryPrice.toFixed(5));
  reasons.stopLoss = parseFloat(stopLoss.toFixed(5));
  reasons.takeProfit = parseFloat(takeProfit.toFixed(5));
  reasons.atr = parseFloat(atr.toFixed(5));
  reasons.stopDistance = parseFloat(stopDist.toFixed(5));
  reasons.riskRewardRatio = `1:${params.riskRewardRatio}`;
  reasons.ema21Zone = parseFloat(ema21Val.toFixed(5));
  reasons.ema55Zone = parseFloat(ema55Val.toFixed(5));

  if (score < params.scoreThreshold) {
    return reject(STRAT, "score_below_threshold", { score, threshold: params.scoreThreshold, partialReasons: reasons });
  }

  return { strategy: STRAT, direction, score: Math.min(score, 100), reasonJson: reasons };
}

function evaluateRangeBreakout(
  input: StrategyInput,
  params: StrategyParamsConfig["rangeBreakout"],
): StrategyResult | StrategyRejection {
  const { entryCandles, entryIndicators } = input;
  const STRAT = "RANGE_BREAKOUT";
  const lookback = params.rangeLookbackBars;

  if (entryCandles.length < lookback + 4 || entryIndicators.length < 50) {
    return reject(STRAT, "insufficient_data", { entryCandles: entryCandles.length, entryIndicators: entryIndicators.length });
  }

  const latestClosed = entryCandles[0];
  const prevClosed = entryCandles[1];
  const latestInd = indicatorForCandle(entryIndicators, latestClosed);
  if (!latestInd || !hasRequiredIndicators(latestInd)) {
    return reject(STRAT, "incomplete_entry_indicators");
  }

  if (latestInd.adx! > params.adxCeiling) {
    return reject(STRAT, "adx_above_ceiling", { adx: latestInd.adx, ceiling: params.adxCeiling });
  }

  const bbWidths = entryIndicators.slice(0, 50).map((i) => i.bbWidth).filter((w): w is number => w != null);
  if (bbWidths.length < 10) {
    return reject(STRAT, "insufficient_bbwidth_history");
  }
  const sorted = [...bbWidths].sort((a, b) => a - b);
  const pctIdx = Math.min(sorted.length - 1, Math.floor(sorted.length * (params.bbWidthPercentile / 100)));
  const threshold = sorted[pctIdx];
  if (latestInd.bbWidth! >= threshold) {
    return reject(STRAT, "bbwidth_not_compressed", { current: latestInd.bbWidth, threshold, percentile: params.bbWidthPercentile });
  }

  const baseRange = entryCandles.slice(2, 2 + lookback);
  const rangeHigh = Math.max(...baseRange.map((c) => c.high));
  const rangeLow = Math.min(...baseRange.map((c) => c.low));

  const atr = latestInd.atr!;
  const stopDist = params.atrStopMultiplier * atr;

  const reasons: Record<string, any> = {
    adx: parseFloat(latestInd.adx!.toFixed(1)),
    bbWidth: parseFloat(latestInd.bbWidth!.toFixed(5)),
    medianBBWidth: parseFloat(threshold.toFixed(5)),
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

  if (!direction) {
    return reject(STRAT, "no_breakout_followthrough", {
      latestClose: latestClosed.close,
      prevClose: prevClosed.close,
      rangeHigh,
      rangeLow,
    });
  }

  const entryPrice = latestClosed.close;
  const stopLoss = direction === "LONG" ? entryPrice - stopDist : entryPrice + stopDist;
  const takeProfit = direction === "LONG" ? entryPrice + stopDist * params.riskRewardRatio : entryPrice - stopDist * params.riskRewardRatio;

  reasons.entryPrice = parseFloat(entryPrice.toFixed(5));
  reasons.stopLoss = parseFloat(stopLoss.toFixed(5));
  reasons.takeProfit = parseFloat(takeProfit.toFixed(5));
  reasons.riskRewardRatio = `1:${params.riskRewardRatio}`;

  return { strategy: STRAT, direction, score: Math.min(score, 100), reasonJson: reasons };
}

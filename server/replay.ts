import Decimal from "decimal.js";
import { storage } from "./storage";
import { evaluateStrategies } from "./strategies";
import { log } from "./logger";
import type { Candle, Indicator, StrategyParamsConfig, Instrument } from "@shared/schema";

/**
 * Historical replay (what-if) simulator.
 *
 * Walks stored candles+indicators bar-by-bar for the given parameter set, evaluates
 * strategies on each closed 15m bar, and resolves outcomes by scanning forward in
 * the same stored 15m candles for TP/SL hits within `evalWindowHours`.
 *
 * Pure read-only — never writes signals or hits the data vendor.
 */

export interface ReplayParams {
  paramSetId: number;
  paramSetVersion: number;
  paramsConfig: StrategyParamsConfig;
  startDate: Date;
  endDate: Date;
  /** Symbols to replay (canonical). Empty = all enabled instruments. */
  symbols?: string[];
  /** TP/SL forward window. Defaults to 4h to mirror the live scanner. */
  evalWindowHours?: number;
  /** Cap per-symbol bars for very long ranges (safety). */
  maxBarsPerSymbol?: number;
}

export interface ReplayPerSymbol {
  symbol: string;
  total: number;
  wins: number;
  losses: number;
  missed: number;
}

export interface ReplayResult {
  paramSetId: number;
  paramSetVersion: number;
  startDate: string;
  endDate: string;
  totalSignals: number;
  wins: number;
  losses: number;
  missed: number;
  winRate: number | null;
  /** Sum of realized R across all decided signals (WIN=+RR, LOSS=-1). */
  expectancyR: number | null;
  durationMs: number;
  bySymbol: ReplayPerSymbol[];
  byStrategy: Record<string, { total: number; wins: number; losses: number; missed: number }>;
  /** Wins/losses bucketed by trading session (UTC hour bands). */
  bySession: Record<"asia" | "london" | "ny" | "off", { total: number; wins: number; losses: number; missed: number }>;
  /** R-multiple distribution: histogram bins from -1R to +Nmax R in 0.5 increments. */
  rMultiples: { values: number[]; mean: number | null; histogram: Array<{ bin: string; count: number }> };
  /** Sample of synthetic signals (first 50) for inspection in the UI. */
  sampleSignals: Array<{
    symbol: string;
    strategy: string;
    direction: "LONG" | "SHORT";
    score: number;
    candleDatetimeUtc: string;
    outcome: "WIN" | "LOSS" | "MISSED";
    rMultiple: number | null;
  }>;
}

function sessionForHour(h: number): "asia" | "london" | "ny" | "off" {
  if (h >= 0 && h < 8) return "asia";
  if (h >= 8 && h < 13) return "london";
  if (h >= 13 && h < 21) return "ny";
  return "off";
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

const ENTRY_WINDOW = 100; // matches live scanner's slice depth
const BIAS_WINDOW = 20;
const HTF_WINDOW = 20;

// Warmups large enough to cover EMA200 + breakout lookbacks before the replay start date.
const ENTRY_WARMUP_MS = 200 * FIFTEEN_MIN_MS;
const BIAS_WARMUP_MS = 200 * ONE_HOUR_MS;
const HTF_WARMUP_MS = 200 * FOUR_HOUR_MS;

export async function runReplay(input: ReplayParams): Promise<ReplayResult> {
  const t0 = Date.now();
  const evalWindowMs = (input.evalWindowHours ?? 4) * ONE_HOUR_MS;
  const needsHtf = !!input.paramsConfig.confluence?.requireHtfAlignment;

  const allInstruments = await storage.getEnabledInstruments();
  const targets: Instrument[] = input.symbols?.length
    ? allInstruments.filter((i) => input.symbols!.includes(i.canonicalSymbol))
    : allInstruments;

  const result: ReplayResult = {
    paramSetId: input.paramSetId,
    paramSetVersion: input.paramSetVersion,
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
    totalSignals: 0,
    wins: 0,
    losses: 0,
    missed: 0,
    winRate: null,
    expectancyR: null,
    durationMs: 0,
    bySymbol: [],
    byStrategy: {},
    bySession: {
      asia: { total: 0, wins: 0, losses: 0, missed: 0 },
      london: { total: 0, wins: 0, losses: 0, missed: 0 },
      ny: { total: 0, wins: 0, losses: 0, missed: 0 },
      off: { total: 0, wins: 0, losses: 0, missed: 0 },
    },
    rMultiples: { values: [], mean: null, histogram: [] },
    sampleSignals: [],
  };

  for (const inst of targets) {
    const sym: ReplayPerSymbol = { symbol: inst.canonicalSymbol, total: 0, wins: 0, losses: 0, missed: 0 };

    const entryFrom = new Date(input.startDate.getTime() - ENTRY_WARMUP_MS);
    const biasFrom = new Date(input.startDate.getTime() - BIAS_WARMUP_MS);
    const htfFrom = new Date(input.startDate.getTime() - HTF_WARMUP_MS);
    const to = input.endDate;

    const [entry15m, ind15m, bias1h, ind1h, htf4h, indHtf] = await Promise.all([
      storage.getCandlesInRange(inst.id, "15m", entryFrom, to),
      storage.getIndicatorsInRange(inst.id, "15m", entryFrom, to),
      storage.getCandlesInRange(inst.id, "1h", biasFrom, to),
      storage.getIndicatorsInRange(inst.id, "1h", biasFrom, to),
      needsHtf ? storage.getCandlesInRange(inst.id, "4h", htfFrom, to) : Promise.resolve([] as Candle[]),
      needsHtf ? storage.getIndicatorsInRange(inst.id, "4h", htfFrom, to) : Promise.resolve([] as Indicator[]),
    ]);

    if (entry15m.length < ENTRY_WINDOW || bias1h.length < BIAS_WINDOW) {
      result.bySymbol.push(sym);
      continue;
    }

    const indByTime15 = indexByTime(ind15m);
    const indByTime1h = indexByTime(ind1h);
    const indByTime4h = indexByTime(indHtf);

    let biasIdx = -1;
    let htfIdx = -1;
    let evalCount = 0;

    for (let i = ENTRY_WINDOW; i < entry15m.length; i++) {
      if (input.maxBarsPerSymbol && evalCount >= input.maxBarsPerSymbol) break;
      const cur = entry15m[i];
      if (cur.datetimeUtc < input.startDate || cur.datetimeUtc > input.endDate) continue;
      evalCount++;

      // Advance bias/htf indices to the most recent bar at or before cur.
      while (biasIdx + 1 < bias1h.length && bias1h[biasIdx + 1].datetimeUtc <= cur.datetimeUtc) biasIdx++;
      if (biasIdx < BIAS_WINDOW) continue;
      const biasSliceAsc = bias1h.slice(Math.max(0, biasIdx - BIAS_WINDOW + 1), biasIdx + 1);

      let htfSlice: Candle[] = [];
      let htfIndSlice: Indicator[] = [];
      if (needsHtf && htf4h.length) {
        // HTF bars are bar-OPEN times; only consider bars whose CLOSE time
        // (datetimeUtc + 4h) is at or before the current 15m bar's close.
        // This mirrors the live scanner and prevents lookahead.
        const htfCutoff = cur.datetimeUtc.getTime() + FIFTEEN_MIN_MS;
        while (htfIdx + 1 < htf4h.length && htf4h[htfIdx + 1].datetimeUtc.getTime() + FOUR_HOUR_MS <= htfCutoff) htfIdx++;
        if (htfIdx < HTF_WINDOW) continue;
        const htfAsc = htf4h.slice(Math.max(0, htfIdx - HTF_WINDOW + 1), htfIdx + 1);
        htfSlice = [...htfAsc].reverse();
        htfIndSlice = htfAsc
          .map((c) => indByTime4h.get(c.datetimeUtc.getTime()))
          .filter((x): x is Indicator => !!x)
          .reverse();
      }

      const entryAsc = entry15m.slice(i - ENTRY_WINDOW + 1, i + 1);
      const entrySlice = [...entryAsc].reverse(); // evaluator expects DESC (latest at [0])
      const indSlice = entryAsc
        .map((c) => indByTime15.get(c.datetimeUtc.getTime()))
        .filter((x): x is Indicator => !!x)
        .reverse();
      const biasIndSlice = biasSliceAsc
        .map((c) => indByTime1h.get(c.datetimeUtc.getTime()))
        .filter((x): x is Indicator => !!x)
        .reverse();
      const biasSlice = [...biasSliceAsc].reverse();

      const evalRes = evaluateStrategies({
        instrumentId: inst.id,
        entryCandles: entrySlice,
        entryIndicators: indSlice,
        biasCandles: biasSlice,
        biasIndicators: biasIndSlice,
        htfCandles: htfSlice.length ? htfSlice : undefined,
        htfIndicators: htfIndSlice.length ? htfIndSlice : undefined,
        entryTimeframe: "15m",
        params: input.paramsConfig,
      });

      for (const accepted of evalRes.accepted) {
        const reason = accepted.reasonJson;
        const tp = reason.takeProfit;
        const sl = reason.stopLoss;
        if (tp == null || sl == null) continue;

        // Walk forward in 15m candles from i+1 within evalWindowMs.
        const cutoff = cur.datetimeUtc.getTime() + evalWindowMs;
        let outcome: "WIN" | "LOSS" | "MISSED" = "MISSED";
        const tpD = new Decimal(tp);
        const slD = new Decimal(sl);

        for (let j = i + 1; j < entry15m.length; j++) {
          const fb = entry15m[j];
          if (fb.datetimeUtc.getTime() > cutoff) break;
          const high = new Decimal(fb.high);
          const low = new Decimal(fb.low);
          if (accepted.direction === "LONG") {
            if (low.lte(slD)) { outcome = "LOSS"; break; }
            if (high.gte(tpD)) { outcome = "WIN"; break; }
          } else {
            if (high.gte(slD)) { outcome = "LOSS"; break; }
            if (low.lte(tpD)) { outcome = "WIN"; break; }
          }
        }

        sym.total++;
        result.totalSignals++;
        if (outcome === "WIN") { sym.wins++; result.wins++; }
        else if (outcome === "LOSS") { sym.losses++; result.losses++; }
        else { sym.missed++; result.missed++; }

        const stratBucket = (result.byStrategy[accepted.strategy] ??= { total: 0, wins: 0, losses: 0, missed: 0 });
        stratBucket.total++;
        if (outcome === "WIN") stratBucket.wins++;
        else if (outcome === "LOSS") stratBucket.losses++;
        else stratBucket.missed++;

        const session = sessionForHour(cur.datetimeUtc.getUTCHours());
        const sessBucket = result.bySession[session];
        sessBucket.total++;
        if (outcome === "WIN") sessBucket.wins++;
        else if (outcome === "LOSS") sessBucket.losses++;
        else sessBucket.missed++;

        // Realized R-multiple: derive R from entry/TP/SL prices since reason.riskRewardRatio
        // is stored as a display string ("1:2"). WIN=+computedR, LOSS=-1, MISSED excluded.
        let rMultiple: number | null = null;
        const entryPrice = reason.entryPrice;
        if (outcome === "WIN" && entryPrice != null && tp != null && sl != null) {
          const risk = Math.abs(entryPrice - sl);
          const reward = Math.abs(tp - entryPrice);
          if (risk > 0 && Number.isFinite(reward / risk)) {
            rMultiple = reward / risk;
            result.rMultiples.values.push(rMultiple);
          }
        } else if (outcome === "LOSS") {
          rMultiple = -1;
          result.rMultiples.values.push(rMultiple);
        }

        if (result.sampleSignals.length < 50) {
          result.sampleSignals.push({
            symbol: inst.canonicalSymbol,
            strategy: accepted.strategy,
            direction: accepted.direction,
            score: accepted.score,
            candleDatetimeUtc: cur.datetimeUtc.toISOString(),
            outcome,
            rMultiple,
          });
        }
      }
    }

    result.bySymbol.push(sym);
  }

  const decided = result.wins + result.losses;
  result.winRate = decided > 0 ? (result.wins / decided) * 100 : null;

  if (result.rMultiples.values.length) {
    const sum = result.rMultiples.values.reduce((a, b) => a + b, 0);
    result.expectancyR = sum / result.rMultiples.values.length;
    result.rMultiples.mean = result.expectancyR;
    const bins = new Map<string, number>();
    for (const v of result.rMultiples.values) {
      const bucket = Math.floor(v * 2) / 2;
      const key = bucket.toFixed(1);
      bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    result.rMultiples.histogram = Array.from(bins.entries())
      .map(([bin, count]) => ({ bin, count }))
      .sort((a, b) => parseFloat(a.bin) - parseFloat(b.bin));
  }

  result.durationMs = Date.now() - t0;

  log(`Replay: paramSet#${input.paramSetId} v${input.paramSetVersion} produced ${result.totalSignals} signals in ${result.durationMs}ms`, "replay");

  return result;
}

function indexByTime(rows: Indicator[]): Map<number, Indicator> {
  const map = new Map<number, Indicator>();
  for (const r of rows) map.set(r.datetimeUtc.getTime(), r);
  return map;
}

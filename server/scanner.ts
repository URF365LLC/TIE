import Decimal from "decimal.js";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { fetchAllIndicatorsForSymbolMulti, getRateLimitState } from "./twelvedata";
import { evaluateStrategies, hasRequiredIndicators, type StrategyRejection } from "./strategies";
import { sendSignalAlert } from "./alerter";
import { evaluatePromotionsAndNotify } from "./promotion";
import { log } from "./logger";
import { summarizeSignal } from "./summary";
import type { Instrument, InsertCandle, InsertIndicator, Candle, Indicator, Signal, StrategyParamsConfig } from "@shared/schema";

let scannerTimeout: NodeJS.Timeout | null = null;
let isScanning = false;

function parseUtc(datetime: string): Date {
  if (/Z$/.test(datetime) || /[+-]\d\d:\d\d$/.test(datetime)) {
    return new Date(datetime);
  }
  return new Date(`${datetime.replace(" ", "T")}Z`);
}

export function getLatestClosedCandle(candles: Candle[], timeframe: "15m" | "1h", now = new Date()): Candle | null {
  if (!candles.length) return null;
  const tfMs = timeframe === "15m" ? 15 * 60 * 1000 : 60 * 60 * 1000;
  const nowMs = now.getTime();
  return candles.find((c) => c.datetimeUtc.getTime() + tfMs <= nowMs) ?? null;
}

function expectedLatestClosedBoundary(timeframe: "15m" | "1h", now = Date.now()): number {
  const tfMs = timeframe === "15m" ? 15 * 60 * 1000 : 60 * 60 * 1000;
  return Math.floor(now / tfMs) * tfMs - tfMs;
}

function indicatorsCompleteForCandle(candle: Candle, indicators: Indicator[]): boolean {
  const ind = indicators.find((i) => i.datetimeUtc.getTime() === candle.datetimeUtc.getTime());
  return hasRequiredIndicators(ind);
}

export function msUntilNext15mBoundary(nowMs = Date.now()): number {
  const intervalMs = 15 * 60 * 1000;
  const remainder = nowMs % intervalMs;
  if (remainder === 0) return intervalMs;
  return intervalMs - remainder;
}

export async function startScanner(): Promise<void> {
  if (scannerTimeout) return;

  const lock = await db.execute(sql`select pg_try_advisory_lock(424242) as acquired`);
  const acquired = (lock.rows[0] as any)?.acquired === true;
  if (!acquired) {
    log("Scanner advisory lock not acquired; another worker is active", "scanner");
    return;
  }

  try {
    const reconciled = await storage.reconcileZombieScanRuns();
    if (reconciled > 0) {
      log(`Reconciled ${reconciled} zombie scan_run(s) from previous process`, "scanner");
    }
  } catch (err: any) {
    log(`Zombie scan reconciliation failed: ${err.message}`, "scanner");
  }

  log("Scanner started - anchored to 15-minute wall-clock boundaries", "scanner");
  scheduleNextTick();
}

function scheduleNextTick(): void {
  const delayMs = msUntilNext15mBoundary() + 2000;
  log(`Next scan tick in ${Math.round(delayMs / 1000)}s`, "scanner");
  scannerTimeout = setTimeout(async () => {
    try {
      await tick();
    } catch (err: any) {
      log(`Scanner tick error: ${err.message}`, "scanner");
    }
    if (scannerTimeout !== null) {
      scheduleNextTick();
    }
  }, delayMs);
}

async function tick(): Promise<void> {
  const settings = await storage.getSettings();

  // Run the scan FIRST so that resolution checks the freshest possible candles.
  if (settings.scanEnabled && !isScanning) {
    await runScanCycle("15m", settings.maxSymbolsPerBurst, settings.burstSleepMs);
  }

  // Per-tick candle cache shared by resolveActiveSignals and expireOldSignals to avoid N+1 reads.
  // Built AFTER the scan so newly-fetched candles are visible.
  const candleCache = new Map<string, Candle[]>();

  try {
    const resolvedCount = await resolveActiveSignals(candleCache);
    if (resolvedCount > 0) {
      log(`Real-time resolved ${resolvedCount} signal(s) (TP/SL hit)`, "scanner");
    }
  } catch (err: any) {
    log(`Error resolving active signals: ${err.message}`, "scanner");
  }

  try {
    const evalWindowMs = (settings.signalEvalWindowHours ?? 4) * 60 * 60 * 1000;
    const expiredCount = await expireOldSignals(evalWindowMs, candleCache);
    if (expiredCount > 0) {
      log(`Expired ${expiredCount} stalled signal(s) past ${settings.signalEvalWindowHours ?? 4}h window as MISSED`, "scanner");
    }
  } catch (err: any) {
    log(`Error expiring signals: ${err.message}`, "scanner");
  }

  // Proactive auto-promotion alerting: each tick, check whether any shadow set
  // has crossed the significance threshold and surface a notification (email +
  // dashboard banner) if we haven't already done so for that paramSetId.
  try {
    const result = await evaluatePromotionsAndNotify(settings);
    if (result.created > 0 || result.reminded > 0) {
      log(`Promotion notifications created: ${result.created} (emailed: ${result.emailed}, reminded: ${result.reminded})`, "scanner");
    }
  } catch (err: any) {
    log(`Error evaluating promotion notifications: ${err.message}`, "scanner");
  }
}

export function stopScanner(): void {
  if (scannerTimeout) {
    clearTimeout(scannerTimeout);
    scannerTimeout = null;
    log("Scanner stopped", "scanner");
  }
}

export async function runScanCycle(timeframe: string, maxPerBurst: number = 4, burstSleepMs: number = 1000): Promise<void> {
  if (isScanning) {
    log("Scan already in progress, skipping", "scanner");
    return;
  }

  isScanning = true;
  const scanRun = await storage.createScanRun({
    timeframe,
    status: "running",
    startedAt: new Date(),
  });

  log(`Scan started: ${timeframe} (run #${scanRun.id})`, "scanner");

  try {
    const allActive = await storage.getActiveAndShadowStrategyParameters();
    const activeParams = allActive.find((p) => p.isActive) ?? (await storage.getActiveStrategyParameters());
    const shadowParams = allActive.filter((p) => !p.isActive);
    const paramsConfig = activeParams.params;
    // Pull 4h whenever ANY active or shadow set requires HTF confluence.
    const needsHtf = [activeParams, ...shadowParams].some((p) => p.params.confluence?.requireHtfAlignment);
    const instruments = await storage.getEnabledInstruments();
    let processedCount = 0;
    let signalCount = 0;
    let skippedFresh = 0;
    const failures: Array<{ symbol: string; error: string }> = [];
    const rejectionTotals: Record<string, number> = {};

    for (let i = 0; i < instruments.length; i += maxPerBurst) {
      const burst = instruments.slice(i, i + maxPerBurst);

      const results = await Promise.allSettled(burst.map((inst) => processInstrument(inst, activeParams, shadowParams, needsHtf)));
      results.forEach((res, idx) => {
        const inst = burst[idx];
        if (res.status === "fulfilled") {
          const r = res.value;
          signalCount += r.signalCount;
          if (r.skippedFresh) skippedFresh++;
          for (const rej of r.rejections) {
            const key = `${rej.strategy}:${rej.reason}`;
            rejectionTotals[key] = (rejectionTotals[key] ?? 0) + 1;
          }
          processedCount++;
        } else {
          const err: any = res.reason;
          failures.push({ symbol: inst.canonicalSymbol, error: err?.message ?? String(err) });
          log(`Error processing ${inst.canonicalSymbol}: ${err?.message ?? err}`, "scanner");
        }
      });

      if (i + maxPerBurst < instruments.length) {
        await sleep(burstSleepMs);
      }
    }

    const rl = getRateLimitState();
    await storage.updateScanRun(scanRun.id, {
      finishedAt: new Date(),
      status: failures.length ? "completed_with_errors" : "completed",
      creditsUsedEst: rl.creditsUsed,
      notes: JSON.stringify({
        processedCount,
        total: instruments.length,
        signalCount,
        skippedFresh,
        rejections: rejectionTotals,
        failures,
        retryCount: rl.retryCount,
        paramSetVersion: activeParams.version,
        paramSetName: activeParams.name,
      }),
    });

    log(`Scan completed: ${processedCount} instruments, ${signalCount} signals, ${skippedFresh} skipped fresh`, "scanner");
  } catch (err: any) {
    await storage.updateScanRun(scanRun.id, {
      finishedAt: new Date(),
      status: "error",
      notes: err.message,
    });
    log(`Scan error: ${err.message}`, "scanner");
  } finally {
    isScanning = false;
  }
}

interface PackData {
  candles: any[];
  ema9: any[];
  ema21: any[];
  ema55: any[];
  ema200: any[];
  bbands: any[];
  macd: any[];
  atr: any[];
  adx: any[];
}

async function persistPack(inst: Instrument, timeframe: string, data: PackData): Promise<boolean> {
  if (!data.candles.length) {
    log(`No candle data for ${inst.canonicalSymbol} (${timeframe})`, "scanner");
    return false;
  }

  const candleRows: InsertCandle[] = data.candles.map((c: any) => ({
    instrumentId: inst.id,
    timeframe,
    datetimeUtc: parseUtc(c.datetime),
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: c.volume ? parseFloat(c.volume) : null,
  }));

  await storage.upsertCandles(candleRows);

  const indicatorMap = new Map<string, Partial<InsertIndicator>>();
  const getOrCreate = (datetime: string): Partial<InsertIndicator> => {
    if (!indicatorMap.has(datetime)) {
      indicatorMap.set(datetime, {
        instrumentId: inst.id,
        timeframe,
        datetimeUtc: parseUtc(datetime),
      });
    }
    return indicatorMap.get(datetime)!;
  };

  for (const v of data.ema9) getOrCreate(v.datetime).ema9 = parseFloat(v.ema);
  for (const v of data.ema21) getOrCreate(v.datetime).ema21 = parseFloat(v.ema);
  for (const v of data.ema55) getOrCreate(v.datetime).ema55 = parseFloat(v.ema);
  for (const v of data.ema200) getOrCreate(v.datetime).ema200 = parseFloat(v.ema);
  for (const v of data.bbands) {
    const row = getOrCreate(v.datetime);
    row.bbUpper = parseFloat(v.upper_band);
    row.bbMiddle = parseFloat(v.middle_band);
    row.bbLower = parseFloat(v.lower_band);
    if (row.bbUpper != null && row.bbLower != null && row.bbMiddle != null) {
      row.bbWidth = (row.bbUpper - row.bbLower) / row.bbMiddle;
    }
  }
  for (const v of data.macd) {
    const row = getOrCreate(v.datetime);
    row.macd = parseFloat(v.macd);
    row.macdSignal = parseFloat(v.macd_signal);
    row.macdHist = parseFloat(v.macd_histogram);
  }
  for (const v of data.atr) getOrCreate(v.datetime).atr = parseFloat(v.atr);
  for (const v of data.adx) getOrCreate(v.datetime).adx = parseFloat(v.adx);

  const indRows = Array.from(indicatorMap.values()).filter(
    (r) => r.instrumentId && r.timeframe && r.datetimeUtc
  ) as InsertIndicator[];
  await storage.upsertIndicators(indRows);
  return true;
}

interface ProcessResult {
  signalCount: number;
  skippedFresh: boolean;
  rejections: StrategyRejection[];
}

async function processInstrument(
  inst: Instrument,
  activeParams: { id: number; version: number; params: StrategyParamsConfig },
  shadowParams: Array<{ id: number; version: number; params: StrategyParamsConfig }>,
  needsHtf: boolean,
): Promise<ProcessResult> {
  // Freshness gate: if scan_progress already covers the latest expected closed 15m bar, skip the API entirely.
  const expectedEntryBoundary = expectedLatestClosedBoundary("15m");
  const progress = await storage.getScanProgress(inst.id, "15m");
  if (progress && progress.lastProcessedBarUtc.getTime() >= expectedEntryBoundary) {
    return { signalCount: 0, skippedFresh: true, rejections: [] };
  }

  // Combined batch fetch for required timeframes (15m + 1h, plus 4h if any param set
  // requires HTF confluence).
  const intervals = needsHtf ? ["15min", "1h", "4h"] : ["15min", "1h"];
  const multi = await fetchAllIndicatorsForSymbolMulti(inst.vendorSymbol, intervals, 100);
  await persistPack(inst, "15m", multi["15min"]);
  await persistPack(inst, "1h", multi["1h"]);
  if (needsHtf && multi["4h"]) {
    await persistPack(inst, "4h", multi["4h"]);
  }

  const entryCandles = await storage.getCandles(inst.id, "15m", 100);
  const entryIndicators = await storage.getIndicators(inst.id, "15m", 100);
  const biasCandles = await storage.getCandles(inst.id, "1h", 20);
  const biasIndicators = await storage.getIndicators(inst.id, "1h", 20);
  const htfCandles = needsHtf ? await storage.getCandles(inst.id, "4h", 20) : [];
  const htfIndicators = needsHtf ? await storage.getIndicators(inst.id, "4h", 20) : [];

  const now = new Date();
  const latestClosedEntry = getLatestClosedCandle(entryCandles, "15m", now);
  const latestClosedBias = getLatestClosedCandle(biasCandles, "1h", now);

  if (!latestClosedEntry || !latestClosedBias) {
    return { signalCount: 0, skippedFresh: false, rejections: [{ strategy: "ALL", reason: "no_closed_candle" }] };
  }

  if (progress && progress.lastProcessedBarUtc.getTime() >= latestClosedEntry.datetimeUtc.getTime()) {
    return { signalCount: 0, skippedFresh: true, rejections: [] };
  }

  const entryForEval = entryCandles.filter((c) => c.datetimeUtc.getTime() <= latestClosedEntry.datetimeUtc.getTime());
  const biasForEval = biasCandles.filter((c) => c.datetimeUtc.getTime() <= latestClosedBias.datetimeUtc.getTime());
  // HTF bar timestamps are bar-OPEN times, so a bar is only "closed" once
  // datetimeUtc + 4h has passed. The cutoff is the latest closed 15m bar's CLOSE time
  // (latestClosedEntry.datetimeUtc + 15m). Filter both candles AND indicators by this
  // boundary so the confluence gate can never read an unclosed 4h bar.
  const FOUR_H_MS = 4 * 60 * 60 * 1000;
  const FIFTEEN_M_MS = 15 * 60 * 1000;
  const cutoffMs = latestClosedEntry.datetimeUtc.getTime() + FIFTEEN_M_MS;
  const htfForEval = htfCandles.filter((c) => c.datetimeUtc.getTime() + FOUR_H_MS <= cutoffMs);
  const htfIndicatorsForEval = htfIndicators.filter((i) => i.datetimeUtc.getTime() + FOUR_H_MS <= cutoffMs);

  if (!entryForEval.length || !biasForEval.length) {
    return { signalCount: 0, skippedFresh: false, rejections: [{ strategy: "ALL", reason: "no_eval_candles" }] };
  }

  if (!indicatorsCompleteForCandle(latestClosedEntry, entryIndicators)) {
    log(
      JSON.stringify({ event: "data_quality_gate", symbol: inst.canonicalSymbol, timeframe: "15m", candle: latestClosedEntry.datetimeUtc.toISOString(), reason: "missing_indicators" }),
      "scanner"
    );
    return { signalCount: 0, skippedFresh: false, rejections: [{ strategy: "ALL", reason: "missing_indicators" }] };
  }

  // === Live evaluation against the active parameter set ===
  const stratResults = evaluateStrategies({
    instrumentId: inst.id,
    entryCandles: entryForEval,
    entryIndicators,
    biasCandles: biasForEval,
    biasIndicators,
    htfCandles: htfForEval.length ? htfForEval : undefined,
    htfIndicators: htfIndicatorsForEval.length ? htfIndicatorsForEval : undefined,
    entryTimeframe: "15m",
    params: activeParams.params,
  });

  let signalCount = 0;
  const settings = await storage.getSettings();
  for (const result of stratResults.accepted) {
    // Dedupe LIVE signals only — must scope by mode='live' and the active paramSetId so
    // unresolved shadow signals (also persisted as NEW) cannot suppress live signal creation.
    const existing = await storage.findActiveSignal(inst.id, "15m", result.strategy, result.direction, {
      mode: "live",
      paramSetId: activeParams.id,
    });
    if (existing) continue;

    const summaryText = summarizeSignal(result.strategy, result.direction, result.reasonJson);
    const signal = await storage.upsertSignal({
      instrumentId: inst.id,
      timeframe: "15m",
      strategy: result.strategy,
      direction: result.direction,
      candleDatetimeUtc: latestClosedEntry.datetimeUtc,
      score: result.score,
      reasonJson: result.reasonJson,
      status: "NEW",
      paramSetVersion: activeParams.version,
      paramSetId: activeParams.id,
      mode: "live",
      summaryText,
    });

    signalCount++;

    if (settings.emailEnabled && signal.status === "NEW" && result.score >= settings.minScoreToAlert) {
      await sendSignalAlert(signal, inst, result.reasonJson, settings);
    }
  }

  // === Shadow evaluation: every shadow set scored on the same bar, persisted with mode='shadow'.
  // No alerts, no dedupe across the shadow set (uniqueness comes from paramSetId+mode in the index).
  // Outcomes will be filled in by resolveActiveSignals/expireOldSignals like live signals.
  for (const shadow of shadowParams) {
    const shadowEval = evaluateStrategies({
      instrumentId: inst.id,
      entryCandles: entryForEval,
      entryIndicators,
      biasCandles: biasForEval,
      biasIndicators,
      htfCandles: htfForEval.length ? htfForEval : undefined,
      htfIndicators: htfIndicatorsForEval.length ? htfIndicatorsForEval : undefined,
      entryTimeframe: "15m",
      params: shadow.params,
    });
    for (const result of shadowEval.accepted) {
      const summaryText = summarizeSignal(result.strategy, result.direction, result.reasonJson);
      await storage.upsertSignal({
        instrumentId: inst.id,
        timeframe: "15m",
        strategy: result.strategy,
        direction: result.direction,
        candleDatetimeUtc: latestClosedEntry.datetimeUtc,
        score: result.score,
        reasonJson: result.reasonJson,
        status: "NEW",
        paramSetVersion: shadow.version,
        paramSetId: shadow.id,
        mode: "shadow",
        summaryText,
      });
    }
  }

  await storage.upsertScanProgress({ instrumentId: inst.id, timeframe: "15m", lastProcessedBarUtc: latestClosedEntry.datetimeUtc });

  return { signalCount, skippedFresh: false, rejections: stratResults.rejections };
}

async function getCachedCandles(
  cache: Map<string, Candle[]> | undefined,
  instrumentId: number,
  timeframe: string
): Promise<Candle[]> {
  const key = `${instrumentId}:${timeframe}`;
  if (cache?.has(key)) return cache.get(key)!;
  const rows = await storage.getCandles(instrumentId, timeframe, 300);
  cache?.set(key, rows);
  return rows;
}

// Called when the user clicks Taken / Not Taken. Records the user's decision (status)
// and, if TP/SL has already been hit by the time of the click, also captures the outcome.
// Otherwise the signal stays in the "unresolved" pool so future scanner ticks can still
// detect a real WIN/LOSS — this is what makes "Your Win Rate" accurate.
export async function resolveSignalOutcome(signalId: number, newStatus: string): Promise<void> {
  const sig = await storage.getSignalById(signalId);
  if (!sig) return;

  const reason = (sig.reasonJson ?? {}) as Record<string, any>;
  const outcome = await determineOutcomeFromCandles(sig, reason);
  if (outcome.result === "WIN" || outcome.result === "LOSS") {
    await storage.resolveSignal(signalId, newStatus, outcome.result, outcome.price);
  } else {
    // Not yet resolved by price — only record the user's decision, leave outcome NULL
    // so resolveActiveSignals can finalize it on a future tick.
    await storage.markSignalAction(signalId, newStatus);
  }
}

export async function resolveActiveSignals(candleCache?: Map<string, Candle[]>): Promise<number> {
  // Includes NEW/ALERTED plus any TAKEN/NOT_TAKEN that haven't yet seen a TP/SL hit.
  const activeSignals = await storage.getUnresolvedSignals(0);
  let resolved = 0;
  for (const sig of activeSignals) {
    const reason = (sig.reasonJson ?? {}) as Record<string, any>;
    const outcome = await determineOutcomeFromCandles(sig, reason, candleCache);
    if (outcome.result === "WIN" || outcome.result === "LOSS") {
      // Preserve the user's decision (TAKEN/NOT_TAKEN); only auto-promote NEW/ALERTED → EXPIRED.
      const newStatus = sig.status === "NEW" || sig.status === "ALERTED" ? "EXPIRED" : sig.status;
      await storage.resolveSignal(sig.id, newStatus, outcome.result, outcome.price);
      resolved++;
    }
  }
  return resolved;
}

export async function expireOldSignals(evalWindowMs?: number, candleCache?: Map<string, Candle[]>): Promise<number> {
  const windowMs = evalWindowMs ?? 4 * 60 * 60 * 1000;
  const expired = await storage.getUnresolvedSignals(windowMs);
  let count = 0;
  for (const sig of expired) {
    const reason = (sig.reasonJson ?? {}) as Record<string, any>;
    const outcome = await determineOutcomeFromCandles(sig, reason, candleCache);
    const finalOutcome = outcome.result === "WIN" || outcome.result === "LOSS" ? outcome.result : "MISSED";
    const newStatus = sig.status === "NEW" || sig.status === "ALERTED" ? "EXPIRED" : sig.status;
    await storage.resolveSignal(sig.id, newStatus, finalOutcome, outcome.price);
    count++;
  }
  return count;
}

async function determineOutcomeFromCandles(
  sig: { instrumentId: number; direction: string; detectedAt: Date | string; timeframe: string },
  reason: Record<string, any>,
  candleCache?: Map<string, Candle[]>
): Promise<{ result: string; price: number | null }> {
  const tpRaw = reason.takeProfit;
  const slRaw = reason.stopLoss;
  const entryRaw = reason.entryPrice;
  if (tpRaw == null || slRaw == null || entryRaw == null) return { result: "MISSED", price: null };

  const tp = new Decimal(tpRaw);
  const sl = new Decimal(slRaw);

  const detectedMs = new Date(sig.detectedAt).getTime();
  const candlesAfter = await getCachedCandles(candleCache, sig.instrumentId, sig.timeframe);
  const relevant = candlesAfter
    .filter((c) => c.datetimeUtc.getTime() > detectedMs)
    .sort((a, b) => a.datetimeUtc.getTime() - b.datetimeUtc.getTime());

  for (const c of relevant) {
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    if (sig.direction === "LONG") {
      if (low.lte(sl)) return { result: "LOSS", price: sl.toNumber() };
      if (high.gte(tp)) return { result: "WIN", price: tp.toNumber() };
    } else {
      if (high.gte(sl)) return { result: "LOSS", price: sl.toNumber() };
      if (low.lte(tp)) return { result: "WIN", price: tp.toNumber() };
    }
  }

  return { result: "MISSED", price: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { fetchAllIndicatorsForSymbol, getRateLimitState } from "./twelvedata";
import { evaluateStrategies, hasRequiredIndicators } from "./strategies";
import { sendSignalAlert } from "./alerter";
import { log } from "./logger";
import type { Instrument, InsertCandle, InsertIndicator, Candle, Indicator } from "@shared/schema";

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
  if (!settings.scanEnabled) return;

  if (!isScanning) {
    await runScanCycle("15m", settings.maxSymbolsPerBurst, settings.burstSleepMs);
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
    const instruments = await storage.getEnabledInstruments();
    let processedCount = 0;
    let signalCount = 0;
    const failures: Array<{ symbol: string; error: string }> = [];

    for (let i = 0; i < instruments.length; i += maxPerBurst) {
      const burst = instruments.slice(i, i + maxPerBurst);

      for (const inst of burst) {
        try {
          const count = await processInstrument(inst);
          signalCount += count;
          processedCount++;
        } catch (err: any) {
          failures.push({ symbol: inst.canonicalSymbol, error: err.message });
          log(`Error processing ${inst.canonicalSymbol}: ${err.message}`, "scanner");
        }
      }

      if (i + maxPerBurst < instruments.length) {
        await sleep(burstSleepMs);
      }
    }

    const rl = getRateLimitState();
    await storage.updateScanRun(scanRun.id, {
      finishedAt: new Date(),
      status: failures.length ? "completed_with_errors" : "completed",
      creditsUsedEst: rl.creditsUsed,
      notes: JSON.stringify({ processedCount, total: instruments.length, signalCount, failures, retryCount: rl.retryCount }),
    });

    log(`Scan completed: ${processedCount} instruments, ${signalCount} signals`, "scanner");
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

async function ingestData(inst: Instrument, timeframe: string, interval: string): Promise<void> {
  const data = await fetchAllIndicatorsForSymbol(inst.vendorSymbol, interval, 100);

  if (!data.candles.length) {
    log(`No candle data for ${inst.canonicalSymbol} (${timeframe})`, "scanner");
    return;
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

  const indRows = Array.from(indicatorMap.values()).filter((r) => r.instrumentId && r.timeframe && r.datetimeUtc) as InsertIndicator[];

  await storage.upsertIndicators(indRows);
}

async function processInstrument(inst: Instrument): Promise<number> {
  await ingestData(inst, "15m", "15min");
  await ingestData(inst, "1h", "1h");

  const entryCandles = await storage.getCandles(inst.id, "15m", 100);
  const entryIndicators = await storage.getIndicators(inst.id, "15m", 100);
  const biasCandles = await storage.getCandles(inst.id, "1h", 20);
  const biasIndicators = await storage.getIndicators(inst.id, "1h", 20);

  const now = new Date();
  const latestClosedEntry = getLatestClosedCandle(entryCandles, "15m", now);
  const latestClosedBias = getLatestClosedCandle(biasCandles, "1h", now);

  if (!latestClosedEntry || !latestClosedBias) return 0;

  const progress = await storage.getScanProgress(inst.id, "15m");
  if (progress && progress.lastProcessedBarUtc.getTime() >= latestClosedEntry.datetimeUtc.getTime()) {
    return 0;
  }

  const entryForEval = entryCandles.filter((c) => c.datetimeUtc.getTime() <= latestClosedEntry.datetimeUtc.getTime());
  const biasForEval = biasCandles.filter((c) => c.datetimeUtc.getTime() <= latestClosedBias.datetimeUtc.getTime());

  if (!entryForEval.length || !biasForEval.length) return 0;

  if (!indicatorsCompleteForCandle(latestClosedEntry, entryIndicators)) {
    log(
      JSON.stringify({ event: "data_quality_gate", symbol: inst.canonicalSymbol, timeframe: "15m", candle: latestClosedEntry.datetimeUtc.toISOString(), reason: "missing_indicators" }),
      "scanner"
    );
    return 0;
  }

  const stratResults = evaluateStrategies({
    instrumentId: inst.id,
    entryCandles: entryForEval,
    entryIndicators,
    biasCandles: biasForEval,
    biasIndicators,
    entryTimeframe: "15m",
  });

  let signalCount = 0;
  for (const result of stratResults) {
    const existing = await storage.findActiveSignal(inst.id, "15m", result.strategy, result.direction);
    if (existing) {
      continue;
    }

    const signal = await storage.upsertSignal({
      instrumentId: inst.id,
      timeframe: "15m",
      strategy: result.strategy,
      direction: result.direction,
      candleDatetimeUtc: latestClosedEntry.datetimeUtc,
      score: result.score,
      reasonJson: result.reasonJson,
      status: "NEW",
    });

    signalCount++;

    const settings = await storage.getSettings();
    if (settings.emailEnabled && signal.status === "NEW" && result.score >= settings.minScoreToAlert) {
      await sendSignalAlert(signal, inst, result.reasonJson, settings);
    }
  }

  await storage.upsertScanProgress({ instrumentId: inst.id, timeframe: "15m", lastProcessedBarUtc: latestClosedEntry.datetimeUtc });

  return signalCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

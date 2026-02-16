import { storage } from "./storage";
import { fetchAllIndicatorsForSymbol } from "./twelvedata";
import { evaluateStrategies } from "./strategies";
import { sendSignalAlert } from "./alerter";
import { log } from "./index";
import type { Instrument, InsertCandle, InsertIndicator } from "@shared/schema";

let scannerInterval: NodeJS.Timeout | null = null;
let isScanning = false;

export function startScanner(): void {
  if (scannerInterval) return;

  log("Scanner started - checking every 60s for alignment", "scanner");

  scannerInterval = setInterval(async () => {
    try {
      const settings = await storage.getSettings();
      if (!settings.scanEnabled) return;

      const now = new Date();
      const minutes = now.getMinutes();

      if (minutes % 15 === 0 || minutes % 15 === 1) {
        if (!isScanning) {
          await runScanCycle("15m", settings.maxSymbolsPerBurst, settings.burstSleepMs);
        }
      }
    } catch (err: any) {
      log(`Scanner tick error: ${err.message}`, "scanner");
    }
  }, 60000);
}

export function stopScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
    log("Scanner stopped", "scanner");
  }
}

export async function runScanCycle(
  timeframe: string,
  maxPerBurst: number = 4,
  burstSleepMs: number = 1000
): Promise<void> {
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

    for (let i = 0; i < instruments.length; i += maxPerBurst) {
      const burst = instruments.slice(i, i + maxPerBurst);

      for (const inst of burst) {
        try {
          const count = await processInstrument(inst);
          signalCount += count;
          processedCount++;
        } catch (err: any) {
          log(`Error processing ${inst.canonicalSymbol}: ${err.message}`, "scanner");
        }
      }

      if (i + maxPerBurst < instruments.length) {
        await sleep(burstSleepMs);
      }
    }

    await storage.updateScanRun(scanRun.id, {
      finishedAt: new Date(),
      status: "completed",
      notes: `Processed ${processedCount}/${instruments.length} instruments, ${signalCount} signals`,
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
    datetimeUtc: new Date(c.datetime),
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
        datetimeUtc: new Date(datetime),
      });
    }
    return indicatorMap.get(datetime)!;
  };

  for (const v of data.ema9) { getOrCreate(v.datetime).ema9 = parseFloat(v.ema); }
  for (const v of data.ema21) { getOrCreate(v.datetime).ema21 = parseFloat(v.ema); }
  for (const v of data.ema55) { getOrCreate(v.datetime).ema55 = parseFloat(v.ema); }
  for (const v of data.ema200) { getOrCreate(v.datetime).ema200 = parseFloat(v.ema); }
  for (const v of data.bbands) {
    const row = getOrCreate(v.datetime);
    row.bbUpper = parseFloat(v.upper_band);
    row.bbMiddle = parseFloat(v.middle_band);
    row.bbLower = parseFloat(v.lower_band);
    if (row.bbUpper && row.bbLower && row.bbMiddle) {
      row.bbWidth = (row.bbUpper - row.bbLower) / row.bbMiddle;
    }
  }
  for (const v of data.macd) {
    const row = getOrCreate(v.datetime);
    row.macd = parseFloat(v.macd);
    row.macdSignal = parseFloat(v.macd_signal);
    row.macdHist = parseFloat(v.macd_histogram);
  }
  for (const v of data.atr) { getOrCreate(v.datetime).atr = parseFloat(v.atr); }
  for (const v of data.adx) { getOrCreate(v.datetime).adx = parseFloat(v.adx); }

  const indRows = Array.from(indicatorMap.values()).filter(
    (r) => r.instrumentId && r.timeframe && r.datetimeUtc
  ) as InsertIndicator[];

  await storage.upsertIndicators(indRows);
}

async function processInstrument(inst: Instrument): Promise<number> {
  await ingestData(inst, "15m", "15min");
  await ingestData(inst, "1h", "1h");

  const entryCandles = await storage.getCandles(inst.id, "15m", 100);
  const entryIndicators = await storage.getIndicators(inst.id, "15m", 100);
  const biasCandles = await storage.getCandles(inst.id, "1h", 20);
  const biasIndicators = await storage.getIndicators(inst.id, "1h", 20);

  if (!entryCandles.length) return 0;

  const stratResults = evaluateStrategies({
    instrumentId: inst.id,
    entryCandles,
    entryIndicators,
    biasCandles,
    biasIndicators,
    entryTimeframe: "15m",
  });

  let signalCount = 0;
  for (const result of stratResults) {
    const closedCandle = entryCandles[1] || entryCandles[0];
    const signal = await storage.upsertSignal({
      instrumentId: inst.id,
      timeframe: "15m",
      strategy: result.strategy,
      direction: result.direction,
      candleDatetimeUtc: closedCandle.datetimeUtc,
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

  return signalCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

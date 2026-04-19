import { storage } from "./storage";
import { fetchAllIndicatorsForSymbolRange, getRateLimitState } from "./twelvedata";
import { log } from "./logger";
import type { Instrument, InsertCandle, InsertIndicator } from "@shared/schema";

export type BackfillTimeframe = "15m" | "1h" | "4h";

const TF_TO_INTERVAL: Record<BackfillTimeframe, string> = {
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
};

const TF_MS: Record<BackfillTimeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

const PACK_REQUESTS_PER_WINDOW = 9;
const MAX_OUTPUTSIZE = 5000;

function barsPerDay(tf: BackfillTimeframe, assetClass: string): number {
  const tradingHoursPerDay = assetClass === "CRYPTO" ? 24 : 24;
  const barsPerHour = tf === "15m" ? 4 : tf === "1h" ? 1 : 0.25;
  return tradingHoursPerDay * barsPerHour;
}

interface Window {
  startDate: string;
  endDate: string;
}

function fmtDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:00`;
}

export function computeWindows(
  tf: BackfillTimeframe,
  days: number,
  assetClass: string,
  now = new Date(),
): Window[] {
  const windows: Window[] = [];
  const totalMs = days * 24 * 60 * 60 * 1000;
  const start = new Date(now.getTime() - totalMs);
  const bpd = barsPerDay(tf, assetClass);
  const barsTotal = Math.ceil(days * bpd);
  if (barsTotal <= MAX_OUTPUTSIZE) {
    return [{ startDate: fmtDate(start), endDate: fmtDate(now) }];
  }
  // Chunk by day-spans that yield ≤ MAX_OUTPUTSIZE bars.
  const daysPerChunk = Math.max(1, Math.floor(MAX_OUTPUTSIZE / bpd));
  let cursorEnd = new Date(now.getTime());
  while (cursorEnd.getTime() > start.getTime()) {
    const chunkStart = new Date(Math.max(start.getTime(), cursorEnd.getTime() - daysPerChunk * 24 * 60 * 60 * 1000));
    windows.push({ startDate: fmtDate(chunkStart), endDate: fmtDate(cursorEnd) });
    cursorEnd = new Date(chunkStart.getTime() - TF_MS[tf]);
  }
  return windows;
}

export interface BackfillEstimate {
  instrumentCount: number;
  perInstrument: Array<{
    canonicalSymbol: string;
    assetClass: string;
    perTimeframe: Record<BackfillTimeframe, { windows: number; credits: number }>;
    totalCredits: number;
  }>;
  totalRequests: number;
  totalCredits: number;
  estimatedSeconds: number;
}

export async function estimateBackfill(opts: {
  days: number;
  timeframes: BackfillTimeframe[];
  symbols?: string[];
}): Promise<BackfillEstimate> {
  const insts = await resolveInstruments(opts.symbols);
  const perInstrument: BackfillEstimate["perInstrument"] = [];
  let totalRequests = 0;

  for (const inst of insts) {
    const perTimeframe = {} as Record<BackfillTimeframe, { windows: number; credits: number }>;
    let instCredits = 0;
    for (const tf of opts.timeframes) {
      const windows = computeWindows(tf, opts.days, inst.assetClass);
      const credits = windows.length * PACK_REQUESTS_PER_WINDOW;
      perTimeframe[tf] = { windows: windows.length, credits };
      instCredits += credits;
      totalRequests += windows.length * PACK_REQUESTS_PER_WINDOW;
    }
    perInstrument.push({
      canonicalSymbol: inst.canonicalSymbol,
      assetClass: inst.assetClass,
      perTimeframe,
      totalCredits: instCredits,
    });
  }

  const rl = getRateLimitState();
  const target = rl.targetPerMin || 340;
  const estimatedSeconds = Math.ceil((totalRequests / target) * 60);

  return {
    instrumentCount: insts.length,
    perInstrument,
    totalRequests,
    totalCredits: totalRequests,
    estimatedSeconds,
  };
}

async function resolveInstruments(symbols?: string[]): Promise<Instrument[]> {
  if (!symbols || symbols.length === 0) {
    return storage.getEnabledInstruments();
  }
  const out: Instrument[] = [];
  for (const sym of symbols) {
    const inst = await storage.getInstrumentBySymbol(sym);
    if (inst) out.push(inst);
  }
  return out;
}

function parseUtc(datetime: string): Date {
  if (/Z$/.test(datetime) || /[+-]\d\d:\d\d$/.test(datetime)) return new Date(datetime);
  return new Date(`${datetime.replace(" ", "T")}Z`);
}

interface CandleRow {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface ScalarIndicatorRow {
  datetime: string;
  ema?: string;
  atr?: string;
  adx?: string;
}

interface BBandsRow {
  datetime: string;
  upper_band: string;
  middle_band: string;
  lower_band: string;
}

interface MacdRow {
  datetime: string;
  macd: string;
  macd_signal: string;
  macd_histogram: string;
}

type SymbolPack = Awaited<ReturnType<typeof fetchAllIndicatorsForSymbolRange>>;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

async function persistPack(
  inst: Instrument,
  tf: BackfillTimeframe,
  data: SymbolPack,
): Promise<{ candles: number; indicators: number }> {
  if (!data.candles.length) return { candles: 0, indicators: 0 };

  const candleRows: InsertCandle[] = (data.candles as CandleRow[]).map((c) => ({
    instrumentId: inst.id,
    timeframe: tf,
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
      indicatorMap.set(datetime, { instrumentId: inst.id, timeframe: tf, datetimeUtc: parseUtc(datetime) });
    }
    return indicatorMap.get(datetime)!;
  };
  for (const v of data.ema9 as ScalarIndicatorRow[]) if (v.ema != null) getOrCreate(v.datetime).ema9 = parseFloat(v.ema);
  for (const v of data.ema21 as ScalarIndicatorRow[]) if (v.ema != null) getOrCreate(v.datetime).ema21 = parseFloat(v.ema);
  for (const v of data.ema55 as ScalarIndicatorRow[]) if (v.ema != null) getOrCreate(v.datetime).ema55 = parseFloat(v.ema);
  for (const v of data.ema200 as ScalarIndicatorRow[]) if (v.ema != null) getOrCreate(v.datetime).ema200 = parseFloat(v.ema);
  for (const v of data.bbands as BBandsRow[]) {
    const row = getOrCreate(v.datetime);
    row.bbUpper = parseFloat(v.upper_band);
    row.bbMiddle = parseFloat(v.middle_band);
    row.bbLower = parseFloat(v.lower_band);
    if (row.bbUpper != null && row.bbLower != null && row.bbMiddle != null) {
      row.bbWidth = (row.bbUpper - row.bbLower) / row.bbMiddle;
    }
  }
  for (const v of data.macd as MacdRow[]) {
    const row = getOrCreate(v.datetime);
    row.macd = parseFloat(v.macd);
    row.macdSignal = parseFloat(v.macd_signal);
    row.macdHist = parseFloat(v.macd_histogram);
  }
  for (const v of data.atr as ScalarIndicatorRow[]) if (v.atr != null) getOrCreate(v.datetime).atr = parseFloat(v.atr);
  for (const v of data.adx as ScalarIndicatorRow[]) if (v.adx != null) getOrCreate(v.datetime).adx = parseFloat(v.adx);

  const indRows = Array.from(indicatorMap.values()).filter(
    (r) => r.instrumentId && r.timeframe && r.datetimeUtc,
  ) as InsertIndicator[];
  await storage.upsertIndicators(indRows);
  return { candles: candleRows.length, indicators: indRows.length };
}

export interface BackfillJob {
  id: string;
  status: "pending" | "running" | "completed" | "error";
  startedAt: number;
  finishedAt: number | null;
  estimate: BackfillEstimate;
  progress: {
    completedRequests: number;
    totalRequests: number;
    instrumentsDone: number;
    instrumentsTotal: number;
    currentSymbol: string | null;
    currentTimeframe: BackfillTimeframe | null;
  };
  results: Array<{
    canonicalSymbol: string;
    timeframe: BackfillTimeframe;
    windows: number;
    candlesUpserted: number;
    indicatorsUpserted: number;
    error?: string;
  }>;
  // Credit accounting derived from completed windows (each window = 9 batched
  // credits). The rate-limiter's per-minute counter resets every 60s so it
  // cannot be used as a job-lifetime total.
  creditsConsumed: number;
  error: string | null;
}

const jobs = new Map<string, BackfillJob>();

function newJobId(): string {
  return `bf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getBackfillJob(id: string): BackfillJob | undefined {
  return jobs.get(id);
}

export function listBackfillJobs(): BackfillJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export async function runBackfill(opts: {
  days: number;
  timeframes: BackfillTimeframe[];
  symbols?: string[];
}): Promise<BackfillJob> {
  const estimate = await estimateBackfill(opts);
  const insts = await resolveInstruments(opts.symbols);
  const job: BackfillJob = {
    id: newJobId(),
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    estimate,
    progress: {
      completedRequests: 0,
      totalRequests: estimate.totalRequests,
      instrumentsDone: 0,
      instrumentsTotal: insts.length,
      currentSymbol: null,
      currentTimeframe: null,
    },
    results: [],
    creditsConsumed: 0,
    error: null,
  };
  jobs.set(job.id, job);

  // Run in background — don't block the HTTP response.
  void executeJob(job, insts, opts);

  return job;
}

async function executeJob(
  job: BackfillJob,
  insts: Instrument[],
  opts: { days: number; timeframes: BackfillTimeframe[] },
): Promise<void> {
  try {
    for (const inst of insts) {
      job.progress.currentSymbol = inst.canonicalSymbol;
      for (const tf of opts.timeframes) {
        job.progress.currentTimeframe = tf;
        const windows = computeWindows(tf, opts.days, inst.assetClass);
        let totalCandles = 0;
        let totalIndicators = 0;
        let lastError: string | undefined;
        for (const w of windows) {
          try {
            const pack = await fetchAllIndicatorsForSymbolRange(
              inst.vendorSymbol,
              TF_TO_INTERVAL[tf],
              w.startDate,
              w.endDate,
              MAX_OUTPUTSIZE,
            );
            const counts = await persistPack(inst, tf, pack);
            totalCandles += counts.candles;
            totalIndicators += counts.indicators;
          } catch (err: unknown) {
            lastError = errMessage(err);
            log(`Backfill ${inst.canonicalSymbol} ${tf} ${w.startDate}→${w.endDate} failed: ${lastError}`, "backfill");
          }
          job.progress.completedRequests += PACK_REQUESTS_PER_WINDOW;
          job.creditsConsumed += PACK_REQUESTS_PER_WINDOW;
        }
        job.results.push({
          canonicalSymbol: inst.canonicalSymbol,
          timeframe: tf,
          windows: windows.length,
          candlesUpserted: totalCandles,
          indicatorsUpserted: totalIndicators,
          error: lastError,
        });
      }
      job.progress.instrumentsDone += 1;
    }
    job.status = "completed";
  } catch (err: unknown) {
    job.status = "error";
    job.error = errMessage(err);
    log(`Backfill job ${job.id} crashed: ${job.error}`, "backfill");
  } finally {
    job.finishedAt = Date.now();
    job.progress.currentSymbol = null;
    job.progress.currentTimeframe = null;
  }
}

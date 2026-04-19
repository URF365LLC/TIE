import { log } from "./logger";
import { storage } from "./storage";

const BASE_URL = "https://api.twelvedata.com";
const DEFAULT_LIMIT_PER_MIN = 377;
const DEFAULT_TARGET_PER_MIN = 340;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const SETTINGS_REFRESH_MS = 30_000;

interface RateLimitState {
  creditsUsed: number;
  creditsLeft: number;
  lastReset: number;
  paused: boolean;
  pauseUntil: number;
  retryCount: number;
  limitPerMin: number;
  targetPerMin: number;
  maxConcurrency: number;
}

const rateLimit: RateLimitState = {
  creditsUsed: 0,
  creditsLeft: DEFAULT_LIMIT_PER_MIN,
  lastReset: Date.now(),
  paused: false,
  pauseUntil: 0,
  retryCount: 0,
  limitPerMin: DEFAULT_LIMIT_PER_MIN,
  targetPerMin: DEFAULT_TARGET_PER_MIN,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
};

let activeRequests = 0;
const waitQueue: Array<() => void> = [];
let settingsLoadedAt = 0;
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getApiKey(): string {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY not set");
  return key;
}

async function refreshSettingsIfStale(): Promise<void> {
  if (Date.now() - settingsLoadedAt < SETTINGS_REFRESH_MS) return;
  try {
    const s = await storage.getSettings();
    rateLimit.limitPerMin = s.tdCreditLimitPerMin ?? DEFAULT_LIMIT_PER_MIN;
    rateLimit.targetPerMin = s.tdCreditTargetPerMin ?? DEFAULT_TARGET_PER_MIN;
    rateLimit.maxConcurrency = s.tdMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    settingsLoadedAt = Date.now();
  } catch {
    // settings unavailable; keep defaults
  }
}

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetWindowIfNeeded(): void {
  if (Date.now() - rateLimit.lastReset > 60000) {
    rateLimit.lastReset = Date.now();
    rateLimit.creditsUsed = 0;
    rateLimit.creditsLeft = rateLimit.limitPerMin;
    rateLimit.paused = false;
    rateLimit.pauseUntil = 0;
    rateLimit.retryCount = 0;
  }
}

export function msUntilNextMinuteBoundary(nowMs = Date.now()): number {
  const nextMinute = Math.ceil(nowMs / 60000) * 60000;
  return Math.max(nextMinute - nowMs, 0);
}

function jitterMs(): number {
  return Math.floor(Math.random() * 500);
}

async function waitForBudget(creditCost = 1): Promise<void> {
  resetWindowIfNeeded();

  const now = Date.now();
  if (rateLimit.paused && now < rateLimit.pauseUntil) {
    await sleepFn(rateLimit.pauseUntil - now);
    resetWindowIfNeeded();
  }

  const projected = rateLimit.creditsUsed + creditCost;
  if (projected > rateLimit.targetPerMin || rateLimit.creditsLeft <= creditCost) {
    const waitMs = msUntilNextMinuteBoundary() + 25;
    log(`Credit budget reached (${rateLimit.creditsUsed}/${rateLimit.targetPerMin}), deferring ${waitMs}ms`, "twelvedata");
    await sleepFn(waitMs);
    resetWindowIfNeeded();
  }
}

function updateRateLimit(headers: Headers): void {
  const used = parseHeaderInt(headers.get("api-credits-used"));
  const left = parseHeaderInt(headers.get("api-credits-left"));
  if (used !== null) rateLimit.creditsUsed = used;
  if (left !== null) rateLimit.creditsLeft = left;
}

async function acquireSlot(): Promise<void> {
  if (activeRequests < rateLimit.maxConcurrency) {
    activeRequests++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  activeRequests++;
}

function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waitQueue.shift();
  if (next) next();
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await work();
  } finally {
    releaseSlot();
  }
}

function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

async function backoffMs(attempt: number): Promise<void> {
  const base = Math.min(1000 * Math.pow(2, attempt), 8000);
  await sleepFn(base + jitterMs());
}

async function requestWithRetry(endpoint: string, params: Record<string, string | number>, creditCost = 1): Promise<any[]> {
  await refreshSettingsIfStale();
  return withSlot(async () => {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await waitForBudget(creditCost);

      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
      qs.set("apikey", getApiKey());
      const url = `${BASE_URL}/${endpoint}?${qs.toString()}`;

      let res: Response;
      try {
        res = await fetch(url);
      } catch (err: any) {
        lastErr = new Error(`Network error for ${endpoint}: ${err.message}`);
        log(`Network error ${endpoint}, attempt ${attempt + 1}/${MAX_RETRIES}: ${err.message}`, "twelvedata");
        await backoffMs(attempt);
        continue;
      }
      updateRateLimit(res.headers);

      if (res.status === 429) {
        rateLimit.retryCount += 1;
        const waitMs = msUntilNextMinuteBoundary() + jitterMs();
        rateLimit.paused = true;
        rateLimit.pauseUntil = Date.now() + waitMs;
        log(`429 ${endpoint}, retry ${attempt + 1}/${MAX_RETRIES}, waiting ${waitMs}ms`, "twelvedata");
        await sleepFn(waitMs);
        continue;
      }

      if (isTransientStatus(res.status)) {
        rateLimit.retryCount += 1;
        lastErr = new Error(`HTTP ${res.status} for ${endpoint}`);
        log(`Transient ${res.status} ${endpoint}, retry ${attempt + 1}/${MAX_RETRIES}`, "twelvedata");
        await backoffMs(attempt);
        continue;
      }

      if (!res.ok) {
        const message = `HTTP ${res.status} for ${endpoint}`;
        lastErr = new Error(message);
        break;
      }

      const data = await res.json();
      if (data.status === "error") {
        lastErr = new Error(`${endpoint} error: ${data.message}`);
        break;
      }

      // If headers didn't report credit usage, fall back to local accounting.
      if (parseHeaderInt(res.headers.get("api-credits-used")) === null) {
        rateLimit.creditsUsed += creditCost;
      }
      if (parseHeaderInt(res.headers.get("api-credits-left")) === null) {
        rateLimit.creditsLeft = Math.max(rateLimit.creditsLeft - creditCost, 0);
      }

      return data.values || [];
    }

    throw lastErr ?? new Error(`TwelveData request failed after retries for ${endpoint}`);
  });
}

export async function fetchTimeSeries(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("time_series", { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" });
}

export async function fetchTimeSeriesRange(
  vendorSymbol: string,
  interval: string,
  startDate: string,
  endDate: string,
  outputsize?: number,
): Promise<any[]> {
  const params: Record<string, string | number> = { symbol: vendorSymbol, interval, start_date: startDate, end_date: endDate, timezone: "UTC" };
  if (outputsize !== undefined) params.outputsize = outputsize;
  return requestWithRetry("time_series", params);
}

export async function fetchEMA(vendorSymbol: string, interval: string, timePeriod: number, outputsize = 300): Promise<any[]> {
  return requestWithRetry("ema", { symbol: vendorSymbol, interval, time_period: timePeriod, outputsize, timezone: "UTC" });
}

export async function fetchBBands(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("bbands", { symbol: vendorSymbol, interval, time_period: 20, sd: 2, outputsize, timezone: "UTC" });
}

export async function fetchMACD(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("macd", { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" });
}

export async function fetchATR(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("atr", { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" });
}

export async function fetchADX(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("adx", { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" });
}

interface SymbolPackResult {
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

function buildSymbolPackRequests(vendorSymbol: string, interval: string, outputsize: number) {
  return [
    { endpoint: "time_series", params: { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" } },
    { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 9, outputsize, timezone: "UTC" } },
    { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 21, outputsize, timezone: "UTC" } },
    { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 55, outputsize, timezone: "UTC" } },
    { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 200, outputsize, timezone: "UTC" } },
    { endpoint: "bbands", params: { symbol: vendorSymbol, interval, time_period: 20, sd: 2, outputsize, timezone: "UTC" } },
    { endpoint: "macd", params: { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" } },
    { endpoint: "atr", params: { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" } },
    { endpoint: "adx", params: { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" } },
  ];
}

function buildSymbolPackRangeRequests(
  vendorSymbol: string,
  interval: string,
  startDate: string,
  endDate: string,
  outputsize: number,
) {
  const common = { symbol: vendorSymbol, interval, start_date: startDate, end_date: endDate, outputsize, timezone: "UTC" };
  return [
    { endpoint: "time_series", params: { ...common } },
    { endpoint: "ema", params: { ...common, time_period: 9 } },
    { endpoint: "ema", params: { ...common, time_period: 21 } },
    { endpoint: "ema", params: { ...common, time_period: 55 } },
    { endpoint: "ema", params: { ...common, time_period: 200 } },
    { endpoint: "bbands", params: { ...common, time_period: 20, sd: 2 } },
    { endpoint: "macd", params: { ...common } },
    { endpoint: "atr", params: { ...common, time_period: 14 } },
    { endpoint: "adx", params: { ...common, time_period: 14 } },
  ];
}

function unpackSymbolPack(rows: any[]): SymbolPackResult {
  return {
    candles: rows[0]?.values || [],
    ema9: rows[1]?.values || [],
    ema21: rows[2]?.values || [],
    ema55: rows[3]?.values || [],
    ema200: rows[4]?.values || [],
    bbands: rows[5]?.values || [],
    macd: rows[6]?.values || [],
    atr: rows[7]?.values || [],
    adx: rows[8]?.values || [],
  };
}

async function executeBatch(requests: Array<{ endpoint: string; params: Record<string, any> }>): Promise<any[] | null> {
  await refreshSettingsIfStale();
  return withSlot(async () => {
    const creditCost = requests.length;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await waitForBudget(creditCost);

      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/batch?apikey=${getApiKey()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: requests }),
        });
      } catch (err: any) {
        log(`Batch network error attempt ${attempt + 1}/${MAX_RETRIES}: ${err.message}`, "twelvedata");
        await backoffMs(attempt);
        continue;
      }

      updateRateLimit(res.headers);

      if (res.status === 429) {
        const waitMs = msUntilNextMinuteBoundary() + jitterMs();
        rateLimit.paused = true;
        rateLimit.pauseUntil = Date.now() + waitMs;
        rateLimit.retryCount += 1;
        log(`Batch 429, retry ${attempt + 1}/${MAX_RETRIES}, waiting ${waitMs}ms`, "twelvedata");
        await sleepFn(waitMs);
        continue;
      }

      if (isTransientStatus(res.status)) {
        rateLimit.retryCount += 1;
        log(`Batch transient ${res.status}, retry ${attempt + 1}/${MAX_RETRIES}`, "twelvedata");
        await backoffMs(attempt);
        continue;
      }

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      if (parseHeaderInt(res.headers.get("api-credits-used")) === null) {
        rateLimit.creditsUsed += creditCost;
      }
      if (parseHeaderInt(res.headers.get("api-credits-left")) === null) {
        rateLimit.creditsLeft = Math.max(rateLimit.creditsLeft - creditCost, 0);
      }
      if (data && Array.isArray(data.data)) return data.data;
      return null;
    }
    return null;
  });
}

export async function fetchAllIndicatorsForSymbol(
  vendorSymbol: string,
  interval: string,
  outputsize = 100
): Promise<SymbolPackResult> {
  const requests = buildSymbolPackRequests(vendorSymbol, interval, outputsize);
  const rows = await executeBatch(requests);
  if (rows && rows.length >= 9) {
    return unpackSymbolPack(rows);
  }

  // Sequential fallback (each call counts against the budget on its own).
  const candles = await fetchTimeSeries(vendorSymbol, interval, outputsize);
  const ema9 = await fetchEMA(vendorSymbol, interval, 9, outputsize);
  const ema21 = await fetchEMA(vendorSymbol, interval, 21, outputsize);
  const ema55 = await fetchEMA(vendorSymbol, interval, 55, outputsize);
  const ema200 = await fetchEMA(vendorSymbol, interval, 200, outputsize);
  const bbands = await fetchBBands(vendorSymbol, interval, outputsize);
  const macd = await fetchMACD(vendorSymbol, interval, outputsize);
  const atr = await fetchATR(vendorSymbol, interval, outputsize);
  const adx = await fetchADX(vendorSymbol, interval, outputsize);

  return { candles, ema9, ema21, ema55, ema200, bbands, macd, atr, adx };
}

export async function fetchAllIndicatorsForSymbolRange(
  vendorSymbol: string,
  interval: string,
  startDate: string,
  endDate: string,
  outputsize = 5000,
): Promise<SymbolPackResult> {
  const requests = buildSymbolPackRangeRequests(vendorSymbol, interval, startDate, endDate, outputsize);
  const rows = await executeBatch(requests);
  if (rows && rows.length >= 9) {
    return unpackSymbolPack(rows);
  }

  // Sequential fallback
  const candles = await fetchTimeSeriesRange(vendorSymbol, interval, startDate, endDate, outputsize);
  const rangeReq = (endpoint: string, extra: Record<string, string | number>) =>
    requestWithRetry(endpoint, { symbol: vendorSymbol, interval, start_date: startDate, end_date: endDate, outputsize, timezone: "UTC", ...extra });
  const ema9 = await rangeReq("ema", { time_period: 9 });
  const ema21 = await rangeReq("ema", { time_period: 21 });
  const ema55 = await rangeReq("ema", { time_period: 55 });
  const ema200 = await rangeReq("ema", { time_period: 200 });
  const bbands = await rangeReq("bbands", { time_period: 20, sd: 2 });
  const macd = await rangeReq("macd", {});
  const atr = await rangeReq("atr", { time_period: 14 });
  const adx = await rangeReq("adx", { time_period: 14 });
  return { candles, ema9, ema21, ema55, ema200, bbands, macd, atr, adx };
}

export async function fetchAllIndicatorsForSymbolMulti(
  vendorSymbol: string,
  intervals: string[],
  outputsize = 100
): Promise<Record<string, SymbolPackResult>> {
  const allRequests: Array<{ endpoint: string; params: Record<string, any> }> = [];
  for (const interval of intervals) {
    allRequests.push(...buildSymbolPackRequests(vendorSymbol, interval, outputsize));
  }

  const result: Record<string, SymbolPackResult> = {};
  const rows = await executeBatch(allRequests);

  if (rows && rows.length >= allRequests.length) {
    for (let i = 0; i < intervals.length; i++) {
      const slice = rows.slice(i * 9, i * 9 + 9);
      result[intervals[i]] = unpackSymbolPack(slice);
    }
    return result;
  }

  for (const interval of intervals) {
    result[interval] = await fetchAllIndicatorsForSymbol(vendorSymbol, interval, outputsize);
  }
  return result;
}

export function getRateLimitState() {
  return { ...rateLimit };
}

export const __testHooks = {
  setSleep(fn: (ms: number) => Promise<void>) {
    sleepFn = fn;
  },
  resetState() {
    rateLimit.creditsUsed = 0;
    rateLimit.creditsLeft = rateLimit.limitPerMin;
    rateLimit.lastReset = Date.now();
    rateLimit.paused = false;
    rateLimit.pauseUntil = 0;
    rateLimit.retryCount = 0;
    activeRequests = 0;
    waitQueue.length = 0;
    settingsLoadedAt = 0;
  },
};

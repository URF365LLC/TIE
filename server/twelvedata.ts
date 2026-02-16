import { log } from "./logger";

const BASE_URL = "https://api.twelvedata.com";
const PLAN_LIMIT_PER_MIN = 610;
const TARGET_CREDITS_PER_MIN = 520;
const MAX_RETRIES = 3;

interface RateLimitState {
  creditsUsed: number;
  creditsLeft: number;
  lastReset: number;
  paused: boolean;
  pauseUntil: number;
  retryCount: number;
}

const rateLimit: RateLimitState = {
  creditsUsed: 0,
  creditsLeft: PLAN_LIMIT_PER_MIN,
  lastReset: Date.now(),
  paused: false,
  pauseUntil: 0,
  retryCount: 0,
};

let requestQueue: Promise<void> = Promise.resolve();
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getApiKey(): string {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY not set");
  return key;
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
    rateLimit.creditsLeft = PLAN_LIMIT_PER_MIN;
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

async function waitForBudget(): Promise<void> {
  resetWindowIfNeeded();

  const now = Date.now();
  if (rateLimit.paused && now < rateLimit.pauseUntil) {
    await sleepFn(rateLimit.pauseUntil - now);
    resetWindowIfNeeded();
  }

  if (rateLimit.creditsUsed >= TARGET_CREDITS_PER_MIN || rateLimit.creditsLeft <= PLAN_LIMIT_PER_MIN - TARGET_CREDITS_PER_MIN) {
    const waitMs = msUntilNextMinuteBoundary() + 25;
    log(`Credit budget reached, deferring ${waitMs}ms`, "twelvedata");
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

async function enqueueRequest<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = requestQueue;
  requestQueue = prior.then(() => gate).catch(() => gate);
  await prior;

  try {
    return await work();
  } finally {
    release();
  }
}

async function requestWithRetry(endpoint: string, params: Record<string, string | number>): Promise<any[]> {
  return enqueueRequest(async () => {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await waitForBudget();

      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
      qs.set("apikey", getApiKey());
      const url = `${BASE_URL}/${endpoint}?${qs.toString()}`;

      const res = await fetch(url);
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

      if (parseHeaderInt(res.headers.get("api-credits-used")) === null) {
        rateLimit.creditsUsed += 1;
      }
      if (parseHeaderInt(res.headers.get("api-credits-left")) === null) {
        rateLimit.creditsLeft = Math.max(rateLimit.creditsLeft - 1, 0);
      }

      return data.values || [];
    }

    throw lastErr ?? new Error(`TwelveData request failed after retries for ${endpoint}`);
  });
}

export async function fetchTimeSeries(vendorSymbol: string, interval: string, outputsize = 300): Promise<any[]> {
  return requestWithRetry("time_series", { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" });
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



async function fetchIndicatorPackBatch(vendorSymbol: string, interval: string, outputsize: number): Promise<any | null> {
  try {
    const body = {
      data: [
        { endpoint: "time_series", params: { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" } },
        { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 9, outputsize, timezone: "UTC" } },
        { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 21, outputsize, timezone: "UTC" } },
        { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 55, outputsize, timezone: "UTC" } },
        { endpoint: "ema", params: { symbol: vendorSymbol, interval, time_period: 200, outputsize, timezone: "UTC" } },
        { endpoint: "bbands", params: { symbol: vendorSymbol, interval, time_period: 20, sd: 2, outputsize, timezone: "UTC" } },
        { endpoint: "macd", params: { symbol: vendorSymbol, interval, outputsize, timezone: "UTC" } },
        { endpoint: "atr", params: { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" } },
        { endpoint: "adx", params: { symbol: vendorSymbol, interval, time_period: 14, outputsize, timezone: "UTC" } },
      ],
    };

    const res = await fetch(`${BASE_URL}/batch?apikey=${getApiKey()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;
    updateRateLimit(res.headers);
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
}

export async function fetchAllIndicatorsForSymbol(
  vendorSymbol: string,
  interval: string,
  outputsize = 100
): Promise<{
  candles: any[];
  ema9: any[];
  ema21: any[];
  ema55: any[];
  ema200: any[];
  bbands: any[];
  macd: any[];
  atr: any[];
  adx: any[];
}> {
  const batch = await fetchIndicatorPackBatch(vendorSymbol, interval, outputsize);
  if (batch && Array.isArray(batch.data) && batch.data.length >= 9) {
    const rows = batch.data;
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

  // Sequential fallback keeps credit accounting deterministic under a single global governor.
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

export function getRateLimitState() {
  return { ...rateLimit };
}

export const __testHooks = {
  setSleep(fn: (ms: number) => Promise<void>) {
    sleepFn = fn;
  },
  resetState() {
    rateLimit.creditsUsed = 0;
    rateLimit.creditsLeft = PLAN_LIMIT_PER_MIN;
    rateLimit.lastReset = Date.now();
    rateLimit.paused = false;
    rateLimit.pauseUntil = 0;
    rateLimit.retryCount = 0;
    requestQueue = Promise.resolve();
  },
};

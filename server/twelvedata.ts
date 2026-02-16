import { log } from "./index";

const BASE_URL = "https://api.twelvedata.com";

interface RateLimitState {
  creditsUsed: number;
  creditsLeft: number;
  lastReset: number;
  paused: boolean;
  pauseUntil: number;
}

const rateLimit: RateLimitState = {
  creditsUsed: 0,
  creditsLeft: 610,
  lastReset: Date.now(),
  paused: false,
  pauseUntil: 0,
};

const MAX_CREDITS_PER_MIN = 520;

function getApiKey(): string {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY not set");
  return key;
}

async function waitForRateLimit(): Promise<void> {
  if (rateLimit.paused && Date.now() < rateLimit.pauseUntil) {
    const waitMs = rateLimit.pauseUntil - Date.now();
    log(`Rate limit: pausing ${waitMs}ms`, "twelvedata");
    await sleep(waitMs);
    rateLimit.paused = false;
    rateLimit.creditsUsed = 0;
  }

  if (Date.now() - rateLimit.lastReset > 60000) {
    rateLimit.creditsUsed = 0;
    rateLimit.lastReset = Date.now();
  }

  if (rateLimit.creditsUsed >= MAX_CREDITS_PER_MIN) {
    const waitMs = 60000 - (Date.now() - rateLimit.lastReset) + 1000;
    log(`Credits exhausted, waiting ${waitMs}ms`, "twelvedata");
    await sleep(Math.max(waitMs, 1000));
    rateLimit.creditsUsed = 0;
    rateLimit.lastReset = Date.now();
  }
}

function updateRateLimit(headers: Headers): void {
  const used = headers.get("api-credits-used");
  const left = headers.get("api-credits-left");
  if (used) rateLimit.creditsUsed = parseInt(used);
  if (left) rateLimit.creditsLeft = parseInt(left);
}

export async function fetchTimeSeries(
  vendorSymbol: string,
  interval: string,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`time_series error for ${vendorSymbol}: ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
}

export async function fetchEMA(
  vendorSymbol: string,
  interval: string,
  timePeriod: number,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/ema?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&time_period=${timePeriod}&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`EMA error for ${vendorSymbol} (${timePeriod}): ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
}

export async function fetchBBands(
  vendorSymbol: string,
  interval: string,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/bbands?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&time_period=20&sd=2&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`BBANDS error for ${vendorSymbol}: ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
}

export async function fetchMACD(
  vendorSymbol: string,
  interval: string,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/macd?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`MACD error for ${vendorSymbol}: ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
}

export async function fetchATR(
  vendorSymbol: string,
  interval: string,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/atr?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&time_period=14&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`ATR error for ${vendorSymbol}: ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
}

export async function fetchADX(
  vendorSymbol: string,
  interval: string,
  outputsize = 300
): Promise<any[]> {
  await waitForRateLimit();
  const url = `${BASE_URL}/adx?symbol=${encodeURIComponent(vendorSymbol)}&interval=${interval}&time_period=14&outputsize=${outputsize}&apikey=${getApiKey()}`;

  const res = await fetch(url);
  updateRateLimit(res.headers);

  if (res.status === 429) {
    handleRateLimitError();
    return [];
  }

  const data = await res.json();
  if (data.status === "error") {
    log(`ADX error for ${vendorSymbol}: ${data.message}`, "twelvedata");
    return [];
  }

  rateLimit.creditsUsed += 1;
  return data.values || [];
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
  const [candleData, ema9, ema21, ema55, ema200, bbands, macd, atr, adx] = await Promise.all([
    fetchTimeSeries(vendorSymbol, interval, outputsize),
    fetchEMA(vendorSymbol, interval, 9, outputsize),
    fetchEMA(vendorSymbol, interval, 21, outputsize),
    fetchEMA(vendorSymbol, interval, 55, outputsize),
    fetchEMA(vendorSymbol, interval, 200, outputsize),
    fetchBBands(vendorSymbol, interval, outputsize),
    fetchMACD(vendorSymbol, interval, outputsize),
    fetchATR(vendorSymbol, interval, outputsize),
    fetchADX(vendorSymbol, interval, outputsize),
  ]);

  return { candles: candleData, ema9, ema21, ema55, ema200, bbands, macd, atr, adx };
}

function handleRateLimitError(): void {
  const now = Date.now();
  const nextMinute = Math.ceil(now / 60000) * 60000 + 2000;
  rateLimit.paused = true;
  rateLimit.pauseUntil = nextMinute;
  log(`429 received, pausing until ${new Date(nextMinute).toISOString()}`, "twelvedata");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRateLimitState() {
  return { ...rateLimit };
}

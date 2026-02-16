import test from "node:test";
import assert from "node:assert/strict";

import { safeString, formatAlertEmail } from "../server/alerter";
import { canonicalToVendor, type Candle, type Indicator } from "../shared/schema";
import { getLatestClosedCandle } from "../server/scanner";
import { evaluateStrategies } from "../server/strategies";
import { msUntilNextMinuteBoundary } from "../server/twelvedata";

test("safeString strips CR/LF and caps length", () => {
  const raw = "abc\r\ndef\n" + "x".repeat(500);
  const got = safeString(raw, 10);
  assert.equal(got.includes("\n"), false);
  assert.equal(got.includes("\r"), false);
  assert.equal(got.length, 10);
});

test("formatAlertEmail produces sanitized subject/body", () => {
  const signal: any = {
    id: 1,
    instrumentId: 1,
    timeframe: "15m",
    strategy: "TREND_CONTINUATION",
    direction: "LONG",
    detectedAt: new Date("2024-01-01T00:00:00Z"),
    candleDatetimeUtc: new Date("2024-01-01T00:00:00Z"),
    score: 77,
    reasonJson: {},
    status: "NEW",
  };
  const inst: any = {
    id: 1,
    canonicalSymbol: "EURUSD\r\n",
    vendorSymbol: "EUR/USD:KuCoin",
    assetClass: "FOREX",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { subject, body } = formatAlertEmail(signal, inst, { note: "ok\nline" });
  assert.equal(subject.includes("\n"), false);
  assert.equal(body.includes("\r"), false);
});

test("crypto mapping uses KuCoin", () => {
  assert.equal(canonicalToVendor("BTCUSD", "CRYPTO"), "BTC/USD:KuCoin");
});

test("getLatestClosedCandle selects only closed bar", () => {
  const candles: Candle[] = [
    { id: 1, instrumentId: 1, timeframe: "15m", datetimeUtc: new Date("2024-01-01T10:00:00Z"), open: 1, high: 1, low: 1, close: 1, volume: null, source: "twelvedata" },
    { id: 2, instrumentId: 1, timeframe: "15m", datetimeUtc: new Date("2024-01-01T09:45:00Z"), open: 1, high: 1, low: 1, close: 1, volume: null, source: "twelvedata" },
  ];
  const now = new Date("2024-01-01T10:10:00Z");
  const closed = getLatestClosedCandle(candles, "15m", now);
  assert.equal(closed?.datetimeUtc.toISOString(), "2024-01-01T09:45:00.000Z");
});

test("range breakout requires 2-candle follow-through", () => {
  const baseTs = Date.UTC(2024, 0, 1, 12, 0, 0);
  const mk = (idx: number, close: number, high = close + 0.05, low = close - 0.05): Candle => ({
    id: idx,
    instrumentId: 1,
    timeframe: "15m",
    datetimeUtc: new Date(baseTs - idx * 15 * 60 * 1000),
    open: close,
    high,
    low,
    close,
    volume: null,
    source: "twelvedata",
  });

  const breakout0 = mk(0, 101.6, 101.7, 101.4);
  const breakout1 = mk(1, 101.3, 101.35, 101.1);
  const range = Array.from({ length: 55 }, (_, i) => mk(i + 2, 100.0 + (i % 2) * 0.02, 100.2, 99.8));
  const candles = [breakout0, breakout1, ...range];

  const indicators: Indicator[] = candles.map((c, i) => ({
    id: i + 1,
    instrumentId: 1,
    timeframe: "15m",
    datetimeUtc: c.datetimeUtc,
    ema9: 100,
    ema21: 100,
    ema55: 100,
    ema200: 100,
    bbUpper: 101,
    bbMiddle: 100,
    bbLower: 99,
    bbWidth: i === 0 ? 0.005 : 0.02,
    macd: 0,
    macdSignal: 0,
    macdHist: 0.1,
    atr: 0.5,
    adx: 10,
  }));

  const results = evaluateStrategies({
    instrumentId: 1,
    entryCandles: candles,
    entryIndicators: indicators,
    biasCandles: candles,
    biasIndicators: indicators,
    entryTimeframe: "15m",
  });

  assert.equal(results.some((r) => r.strategy === "RANGE_BREAKOUT"), true);
});

test("minute boundary helper", () => {
  const t = Date.UTC(2024, 0, 1, 0, 0, 30, 0);
  assert.equal(msUntilNextMinuteBoundary(t), 30000);
});

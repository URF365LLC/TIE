import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  evaluateStrategies,
  type StrategyEvaluation,
} from "../server/strategies";
import {
  DEFAULT_STRATEGY_PARAMS,
  type Candle,
  type Indicator,
  type StrategyParamsConfig,
  type Instrument,
  type SignalWithInstrument,
} from "../shared/schema";
import { runReplay } from "../server/replay";
import { storage } from "../server/storage";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { generateOptimizerCandidate } from "../server/advisor";

// ─── Helpers ────────────────────────────────────────────────────────────────

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

function mkCandle(
  instrumentId: number,
  timeframe: "15m" | "1h" | "4h",
  datetimeUtc: Date,
  close: number,
  highOff = 0.05,
  lowOff = 0.05,
): Candle {
  return {
    id: 0,
    instrumentId,
    timeframe,
    datetimeUtc,
    open: close,
    high: close + highOff,
    low: close - lowOff,
    close,
    volume: null,
    source: "twelvedata",
  };
}

function mkIndicator(
  instrumentId: number,
  timeframe: "15m" | "1h" | "4h",
  datetimeUtc: Date,
  overrides: Partial<Indicator> = {},
): Indicator {
  return {
    id: 0,
    instrumentId,
    timeframe,
    datetimeUtc,
    ema9: 100,
    ema21: 100,
    ema55: 100,
    ema200: 100,
    bbUpper: 101,
    bbMiddle: 100,
    bbLower: 99,
    bbWidth: 0.02,
    macd: 0,
    macdSignal: 0,
    macdHist: 0.1,
    atr: 0.5,
    adx: 20,
    ...overrides,
  };
}

/**
 * Build a fully-aligned LONG TREND_CONTINUATION setup. Caller may flip
 * `htfDirection` to misalign HTF and confirm the confluence gate kicks in.
 */
function buildTrendSetup(opts: { htfDirection: "up" | "down" | "none" }): {
  entryCandles: Candle[];
  entryIndicators: Indicator[];
  biasCandles: Candle[];
  biasIndicators: Indicator[];
  htfCandles?: Candle[];
  htfIndicators?: Indicator[];
} {
  const baseTs = Date.UTC(2024, 0, 1, 12, 0, 0);

  // 1h bias: close > ema200 + slope-up (latest ema200 > 3-bars-ago ema200).
  const bias1h: Candle[] = [];
  const biasInd1h: Indicator[] = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(baseTs - i * ONE_HOUR_MS);
    bias1h.push(mkCandle(1, "1h", t, 105));
    biasInd1h.push(
      mkIndicator(1, "1h", t, {
        // i=0 is latest. Force a strict up-slope so latest.ema200 > bias[3].ema200.
        ema200: 100 - i * 0.5,
      }),
    );
  }

  // 15m entry: aligned EMA stack ascending, MACD positive, ADX strong.
  const entry: Candle[] = [];
  const entryInd: Indicator[] = [];
  for (let i = 0; i < 60; i++) {
    const t = new Date(baseTs - i * FIFTEEN_MIN_MS);
    entry.push(mkCandle(1, "15m", t, 105));
    entryInd.push(
      mkIndicator(1, "15m", t, {
        ema9: 104.9,
        ema21: 104.5,
        ema55: 104.0,
        ema200: 100,
        macdHist: 0.2,
        adx: 25,
        atr: 0.4,
      }),
    );
  }
  // The first entry candle is "latest"; force a pullback wick on prev that
  // touched ema21, then close back above for the pullback condition to fire.
  entry[1] = {
    ...entry[1],
    low: 104.5 * 0.999, // just below ema21
  };

  let htfCandles: Candle[] | undefined;
  let htfIndicators: Indicator[] | undefined;
  if (opts.htfDirection !== "none") {
    htfCandles = [];
    htfIndicators = [];
    for (let i = 0; i < 30; i++) {
      const t = new Date(baseTs - i * FOUR_HOUR_MS);
      // i=0 is latest. For UP: latest.ema200 must exceed older AND close > ema200.
      // For DOWN: latest.ema200 below older AND close < ema200 (so the LONG entry conflicts).
      const close = opts.htfDirection === "up" ? 120 : 80;
      const ema200 =
        opts.htfDirection === "up"
          ? 100 - i * 0.5 // latest highest → slope up
          : 100 + i * 0.5; // latest lowest → slope down
      htfCandles.push(mkCandle(1, "4h", t, close));
      htfIndicators.push(mkIndicator(1, "4h", t, { ema200 }));
    }
  }

  return {
    entryCandles: entry,
    entryIndicators: entryInd,
    biasCandles: bias1h,
    biasIndicators: biasInd1h,
    htfCandles,
    htfIndicators,
  };
}

// ─── 4h confluence gate: rejection vs pass ──────────────────────────────────

test("4h confluence: PASSES setup when HTF EMA200 slope is aligned with direction", () => {
  const setup = buildTrendSetup({ htfDirection: "up" });
  const params: StrategyParamsConfig = {
    ...DEFAULT_STRATEGY_PARAMS,
    confluence: {
      requireHtfAlignment: true,
      htfTimeframe: "4h",
      htfEma200SlopeBars: 4,
      appliesTo: ["TREND_CONTINUATION"],
    },
  };
  const res: StrategyEvaluation = evaluateStrategies({
    instrumentId: 1,
    entryTimeframe: "15m",
    params,
    ...setup,
  });
  const tc = res.accepted.find((s) => s.strategy === "TREND_CONTINUATION");
  assert.ok(tc, "TREND_CONTINUATION should be accepted with HTF aligned UP");
  assert.equal(tc!.direction, "LONG");
  assert.equal(tc!.reasonJson.htfConfluence, "4h aligned LONG");
});

test("4h confluence: REJECTS setup when HTF EMA200 slope conflicts with direction", () => {
  const setup = buildTrendSetup({ htfDirection: "down" });
  const params: StrategyParamsConfig = {
    ...DEFAULT_STRATEGY_PARAMS,
    confluence: {
      requireHtfAlignment: true,
      htfTimeframe: "4h",
      htfEma200SlopeBars: 4,
      appliesTo: ["TREND_CONTINUATION"],
    },
  };
  const res = evaluateStrategies({
    instrumentId: 1,
    entryTimeframe: "15m",
    params,
    ...setup,
  });
  assert.equal(
    res.accepted.find((s) => s.strategy === "TREND_CONTINUATION"),
    undefined,
    "TREND_CONTINUATION must be rejected when HTF conflicts",
  );
  const rej = res.rejections.find((r) => r.strategy === "TREND_CONTINUATION");
  assert.ok(rej);
  assert.equal(rej!.reason, "htf_confluence_conflict");
});

test("4h confluence: appliesTo gate skips strategies not in the list", () => {
  const setup = buildTrendSetup({ htfDirection: "down" });
  // Confluence only applies to RANGE_BREAKOUT, so TREND_CONTINUATION should
  // ignore the conflicting HTF and still be accepted.
  const params: StrategyParamsConfig = {
    ...DEFAULT_STRATEGY_PARAMS,
    confluence: {
      requireHtfAlignment: true,
      htfTimeframe: "4h",
      htfEma200SlopeBars: 4,
      appliesTo: ["RANGE_BREAKOUT"],
    },
  };
  const res = evaluateStrategies({
    instrumentId: 1,
    entryTimeframe: "15m",
    params,
    ...setup,
  });
  assert.ok(
    res.accepted.find((s) => s.strategy === "TREND_CONTINUATION"),
    "TREND_CONTINUATION should not be HTF-gated when appliesTo excludes it",
  );
});

// ─── Replay determinism ─────────────────────────────────────────────────────

test("Replay is deterministic: identical inputs produce identical outputs", async (t) => {
  const startDate = new Date("2024-01-15T00:00:00Z");
  const endDate = new Date("2024-01-15T06:00:00Z");

  // Build a long, smooth uptrend in 15m candles + matching indicators that
  // satisfy the TREND_CONTINUATION rules. Warmup period must extend behind
  // startDate by 200 * 15min for the entry slice.
  const warmupStart = new Date(startDate.getTime() - 250 * FIFTEEN_MIN_MS);
  const totalBars =
    Math.ceil((endDate.getTime() - warmupStart.getTime()) / FIFTEEN_MIN_MS) + 5;

  const candles15: Candle[] = [];
  const ind15: Indicator[] = [];
  for (let i = 0; i < totalBars; i++) {
    const t = new Date(warmupStart.getTime() + i * FIFTEEN_MIN_MS);
    const px = 110 + i * 0.01;
    candles15.push(mkCandle(1, "15m", t, px, 0.05, 0.05));
    ind15.push(
      mkIndicator(1, "15m", t, {
        ema9: px,
        ema21: px - 0.05,
        ema55: px - 0.1,
        ema200: px - 0.5,
        macdHist: 0.1,
        adx: 25,
        atr: 0.3,
      }),
    );
  }

  // 1h bias: enough bars for slope; close >> ema200, gentle slope up so that
  // every entry-bar's close (~110-113) sits well above the bias EMA200.
  const biasStart = new Date(startDate.getTime() - 250 * ONE_HOUR_MS);
  const biasBars =
    Math.ceil((endDate.getTime() - biasStart.getTime()) / ONE_HOUR_MS) + 5;
  const candles1h: Candle[] = [];
  const ind1h: Indicator[] = [];
  for (let i = 0; i < biasBars; i++) {
    const t = new Date(biasStart.getTime() + i * ONE_HOUR_MS);
    candles1h.push(mkCandle(1, "1h", t, 110));
    ind1h.push(mkIndicator(1, "1h", t, { ema200: 99 + i * 0.001 }));
  }

  const fakeInstrument: Instrument = {
    id: 1,
    canonicalSymbol: "EURUSD",
    assetClass: "FOREX",
    vendorSymbol: "EUR/USD",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  t.mock.method(storage, "getEnabledInstruments", async () => [fakeInstrument]);
  t.mock.method(
    storage,
    "getCandlesInRange",
    async (_id: number, tf: string, from: Date, to: Date) => {
      const src = tf === "15m" ? candles15 : tf === "1h" ? candles1h : [];
      return src.filter(
        (c) => c.datetimeUtc >= from && c.datetimeUtc <= to,
      );
    },
  );
  t.mock.method(
    storage,
    "getIndicatorsInRange",
    async (_id: number, tf: string, from: Date, to: Date) => {
      const src = tf === "15m" ? ind15 : tf === "1h" ? ind1h : [];
      return src.filter(
        (i) => i.datetimeUtc >= from && i.datetimeUtc <= to,
      );
    },
  );

  const params: StrategyParamsConfig = DEFAULT_STRATEGY_PARAMS;

  const r1 = await runReplay({
    paramSetId: 1,
    paramSetVersion: 1,
    paramsConfig: params,
    startDate,
    endDate,
  });
  const r2 = await runReplay({
    paramSetId: 1,
    paramSetVersion: 1,
    paramsConfig: params,
    startDate,
    endDate,
  });

  // Strip non-deterministic durationMs before comparing.
  const norm = (r: typeof r1) => ({ ...r, durationMs: 0 });
  assert.deepEqual(norm(r1), norm(r2));
  assert.equal(r1.totalSignals, r2.totalSignals);
  assert.equal(r1.bySymbol.length, r2.bySymbol.length);
  // Determinism is only meaningful if the engine actually emits signals on
  // valid setups — verify the fixture produced at least one accepted signal.
  assert.ok(
    r1.totalSignals > 0,
    `replay should emit ≥1 signal under the engineered uptrend; got ${r1.totalSignals}`,
  );
});

// ─── Optimizer produces a valid candidate ──────────────────────────────────

test("Optimizer: produces a JSON candidate matching the schema when conditions warrant a change", async (t) => {
  // Mock baseline params + archived signals biased to trigger changes.
  const baseline = {
    id: 42,
    version: 7,
    name: "v7 baseline",
    description: null,
    isActive: true,
    status: "active" as const,
    rationale: null,
    parentId: null,
    activatedAt: new Date(),
    archivedAt: null,
    params: JSON.parse(JSON.stringify(DEFAULT_STRATEGY_PARAMS)),
    createdAt: new Date(),
  };

  // Stats: low overall win rate to trigger the HTF-confluence proposal.
  t.mock.method(storage, "getActiveStrategyParameters", async () => baseline);
  t.mock.method(storage, "getBacktestStats", async () => ({
    total: 60,
    resolvedTotal: 50,
    wins: 18,
    losses: 32,
    missed: 10,
    unresolved: 0,
    byStrategy: {},
    byDirection: {},
    takenWins: 0,
    takenTotal: 0,
    takenResolved: 0,
  }));

  // 12 archived signals: TC low-ADX losses dominate, low-score losses dominate.
  const fakeInstrument: Instrument = {
    id: 1,
    canonicalSymbol: "EURUSD",
    assetClass: "FOREX",
    vendorSymbol: "EUR/USD",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const mkArchived = (
    id: number,
    strategy: string,
    outcome: "WIN" | "LOSS",
    score: number,
    adx: number,
  ): SignalWithInstrument => ({
    id,
    instrumentId: 1,
    timeframe: "15m",
    strategy,
    direction: "LONG",
    detectedAt: new Date(),
    candleDatetimeUtc: new Date(),
    score,
    reasonJson: { adx },
    status: "ARCHIVED",
    outcome,
    outcomePrice: null,
    resolvedAt: new Date(),
    paramSetVersion: 7,
    paramSetId: 42,
    mode: "live",
    summaryText: null,
    notes: null,
    confidence: null,
    tags: [],
    instrument: fakeInstrument,
  });
  const archived: SignalWithInstrument[] = [
    ...Array.from({ length: 6 }, (_, i) =>
      mkArchived(100 + i, "TREND_CONTINUATION", "LOSS", 30, 15),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      mkArchived(200 + i, "TREND_CONTINUATION", "WIN", 70, 25),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      mkArchived(300 + i, "RANGE_BREAKOUT", "LOSS", 70, 17),
    ),
  ];
  t.mock.method(storage, "getArchivedSignals", async () => archived);

  const candidate = await generateOptimizerCandidate();
  assert.ok(candidate, "optimizer should return a candidate when data is biased");
  assert.equal(candidate!.baseline.version, 7);

  // Must be valid JSON-serializable.
  const json = JSON.stringify(candidate!.proposedParams);
  const reparsed = JSON.parse(json);
  assert.deepEqual(reparsed, candidate!.proposedParams);

  // Schema sanity checks (mirror routes.ts strategyParamsConfigSchema).
  const p = candidate!.proposedParams;
  assert.ok(p.trendContinuation && p.rangeBreakout);
  assert.ok(typeof p.trendContinuation.adxThreshold === "number");
  assert.ok(p.trendContinuation.adxThreshold >= 0 && p.trendContinuation.adxThreshold <= 100);
  assert.ok(p.trendContinuation.scoreThreshold >= 0 && p.trendContinuation.scoreThreshold <= 100);
  assert.ok(p.rangeBreakout.adxCeiling >= 0 && p.rangeBreakout.adxCeiling <= 100);
  assert.ok(Array.isArray(candidate!.rationale.changes));
  assert.ok(candidate!.rationale.changes.length > 0, "rationale must explain at least one change");
  for (const c of candidate!.rationale.changes) {
    assert.ok(typeof c.path === "string" && c.path.length > 0);
    assert.ok(typeof c.reason === "string" && c.reason.length > 0);
  }
});

test("Optimizer: returns null when there is not enough resolved data", async (t) => {
  t.mock.method(storage, "getActiveStrategyParameters", async () => ({
    id: 1,
    version: 1,
    name: "v1",
    description: null,
    isActive: true,
    status: "active" as const,
    rationale: null,
    parentId: null,
    activatedAt: new Date(),
    archivedAt: null,
    params: JSON.parse(JSON.stringify(DEFAULT_STRATEGY_PARAMS)),
    createdAt: new Date(),
  }));
  t.mock.method(storage, "getBacktestStats", async () => ({
    total: 0,
    resolvedTotal: 0,
    wins: 0,
    losses: 0,
    missed: 0,
    unresolved: 0,
    byStrategy: {},
    byDirection: {},
    takenWins: 0,
    takenTotal: 0,
    takenResolved: 0,
  }));
  t.mock.method(
    storage,
    "getArchivedSignals",
    async (): Promise<SignalWithInstrument[]> => [],
  );

  const candidate = await generateOptimizerCandidate();
  assert.equal(candidate, null);
});

// ─── Promotion archives previous active set ─────────────────────────────────

async function dbAvailable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

test("Promotion: setActiveStrategyParameters demotes previous active to 'shadow'", async (t) => {
  // Integration test: requires a reachable Postgres. Skip cleanly when the
  // dev DB isn't up so this suite stays runnable in any environment.
  if (!(await dbAvailable())) {
    t.skip("DATABASE_URL not reachable; skipping promotion integration test");
    return;
  }
  // Real DB-backed test. Cleans up after itself.
  const list = await storage.listStrategyParameters();
  const baseVersion = list.length === 0 ? 0 : Math.max(...list.map((p) => p.version));

  // Ensure there is exactly one current active set (seed if none).
  const initialActive = await storage.getActiveStrategyParameters();

  const draft = await storage.createStrategyParameters({
    version: baseVersion + 1000, // far beyond anything else to avoid collisions
    name: `__test_promotion_${Date.now()}`,
    description: "test row from self-improvement-loop.test.ts",
    isActive: false,
    status: "draft",
    params: DEFAULT_STRATEGY_PARAMS,
  });

  try {
    const promoted = await storage.setActiveStrategyParameters(draft.id);
    assert.equal(promoted.isActive, true);
    assert.equal(promoted.status, "active");

    // The previously-active row must now be demoted to shadow, NOT deleted.
    const after = await storage.listStrategyParameters();
    const prev = after.find((p) => p.id === initialActive.id);
    assert.ok(prev, "previously-active row must still exist (archived, not deleted)");
    assert.equal(prev!.isActive, false);
    assert.equal(prev!.status, "shadow");

    // Exactly one row should be active now.
    const actives = after.filter((p) => p.isActive);
    assert.equal(actives.length, 1);
    assert.equal(actives[0].id, draft.id);
  } finally {
    // Restore the original active set so the dev DB is left as we found it.
    await storage.setActiveStrategyParameters(initialActive.id);
  }
});

test("Promotion: setStrategyParameterStatus('archived') stamps archivedAt and sets status='archived'", async (t) => {
  // Covers the literal "archive" path of the promotion workflow:
  // demoted/shadow sets that are no longer wanted get fully archived via
  // setStrategyParameterStatus(id, 'archived'), which must set
  // status='archived' AND a non-null archivedAt timestamp.
  if (!(await dbAvailable())) {
    t.skip("DATABASE_URL not reachable; skipping archive integration test");
    return;
  }
  const list = await storage.listStrategyParameters();
  const baseVersion = list.length === 0 ? 0 : Math.max(...list.map((p) => p.version));
  const draft = await storage.createStrategyParameters({
    version: baseVersion + 2000,
    name: `__test_archive_${Date.now()}`,
    description: "test row from self-improvement-loop.test.ts",
    isActive: false,
    status: "shadow",
    params: DEFAULT_STRATEGY_PARAMS,
  });
  try {
    const before = Date.now();
    const archived = await storage.setStrategyParameterStatus(draft.id, "archived");
    assert.equal(archived.status, "archived");
    assert.equal(archived.isActive, false);
    assert.ok(archived.archivedAt, "archivedAt must be set when status flips to 'archived'");
    assert.ok(
      archived.archivedAt!.getTime() >= before - 1000,
      "archivedAt timestamp must reflect the archive operation",
    );
    // Round-trip: re-read from DB and confirm persistence.
    const reread = (await storage.listStrategyParameters()).find((p) => p.id === draft.id);
    assert.equal(reread?.status, "archived");
    assert.ok(reread?.archivedAt, "archivedAt must persist to the DB");
  } finally {
    // Test row is left archived and inactive — does not affect active set.
  }
});

// ─── Shadow signals never alert ─────────────────────────────────────────────

test("Scanner: alert call lives only inside the live-eval loop, never the shadow loop", () => {
  // Structural guarantee: there must be exactly one sendSignalAlert(...) call
  // in scanner.ts and it must appear before the shadow-evaluation loop. Any
  // refactor that drops a sendSignalAlert call into the shadow loop will trip
  // this test.
  const src = readFileSync(resolve("server/scanner.ts"), "utf8");
  const calls = src.match(/sendSignalAlert\s*\(/g) ?? [];
  assert.equal(calls.length, 1, "expected exactly one sendSignalAlert call site in scanner.ts");

  const callIdx = src.indexOf("sendSignalAlert(");
  const shadowLoopIdx = src.indexOf("for (const shadow of shadowParams)");
  assert.ok(callIdx > 0 && shadowLoopIdx > 0, "expected to find both alert call and shadow loop in scanner.ts");
  assert.ok(
    callIdx < shadowLoopIdx,
    "sendSignalAlert must be invoked in the live-eval loop, BEFORE the shadow-eval loop",
  );

  // Extract the shadow-loop body (matched braces, depth-aware) and assert
  // that no sendSignalAlert call appears anywhere inside it.
  const openBraceIdx = src.indexOf("{", shadowLoopIdx);
  assert.ok(openBraceIdx > 0, "expected an opening brace for the shadow loop body");
  let depth = 1;
  let cursor = openBraceIdx + 1;
  while (cursor < src.length && depth > 0) {
    const ch = src[cursor];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    cursor++;
  }
  assert.equal(depth, 0, "expected the shadow loop body to have balanced braces");
  const shadowLoopBody = src.slice(openBraceIdx, cursor);
  assert.ok(
    !/sendSignalAlert\s*\(/.test(shadowLoopBody),
    "sendSignalAlert must NEVER appear inside the shadow-evaluation loop body",
  );

  // And the shadow upsert must tag the signal with mode: 'shadow'.
  assert.ok(
    /mode:\s*["']shadow["']/.test(shadowLoopBody),
    "shadow signals must be persisted with mode: 'shadow'",
  );
});

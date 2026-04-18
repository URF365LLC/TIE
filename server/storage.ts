import { db } from "./db";
import { eq, and, desc, sql, lt, inArray, or, isNull, type SQL } from "drizzle-orm";
import {
  instruments,
  candles,
  indicators,
  scanRuns,
  scanProgress,
  signals,
  alertEvents,
  settings,
  tradeAnalyses,
  strategyParameters,
  DEFAULT_STRATEGY_PARAMS,
  type Instrument,
  type InsertInstrument,
  type Candle,
  type InsertCandle,
  type Indicator,
  type InsertIndicator,
  type ScanRun,
  type InsertScanRun,
  type ScanProgress,
  type InsertScanProgress,
  type Signal,
  type InsertSignal,
  type AlertEvent,
  type InsertAlertEvent,
  type Settings,
  type InsertSettings,
  type TradeAnalysis,
  type InsertTradeAnalysis,
  type StrategyParameters,
  type InsertStrategyParameters,
  type StrategyParamsConfig,
  type SignalWithInstrument,
} from "@shared/schema";

export interface IStorage {
  getInstruments(): Promise<Instrument[]>;
  getInstrumentBySymbol(canonical: string): Promise<Instrument | undefined>;
  getEnabledInstruments(): Promise<Instrument[]>;
  upsertInstrument(data: InsertInstrument): Promise<Instrument>;
  bulkUpsertInstruments(data: InsertInstrument[]): Promise<number>;

  getCandles(instrumentId: number, timeframe: string, limit?: number): Promise<Candle[]>;
  upsertCandles(data: InsertCandle[]): Promise<void>;

  getIndicators(instrumentId: number, timeframe: string, limit?: number): Promise<Indicator[]>;
  upsertIndicators(data: InsertIndicator[]): Promise<void>;

  getScanRuns(limit?: number): Promise<ScanRun[]>;
  createScanRun(data: InsertScanRun): Promise<ScanRun>;
  updateScanRun(id: number, data: Partial<ScanRun>): Promise<void>;
  reconcileZombieScanRuns(): Promise<number>;

  getScanProgress(instrumentId: number, timeframe: string): Promise<ScanProgress | undefined>;
  upsertScanProgress(data: InsertScanProgress): Promise<void>;

  getSignalById(id: number): Promise<SignalWithInstrument | undefined>;
  getSignals(filters?: { strategy?: string; direction?: string; status?: string; activeOnly?: boolean; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]>;
  getArchivedSignals(filters?: { strategy?: string; direction?: string; outcome?: string; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]>;
  findActiveSignal(instrumentId: number, timeframe: string, strategy: string, direction: string): Promise<Signal | undefined>;
  getActiveSignalsOlderThan(maxAgeMs: number): Promise<Signal[]>;
  getUnresolvedSignals(maxAgeMs: number): Promise<Signal[]>;
  upsertSignal(data: InsertSignal): Promise<Signal>;
  updateSignalStatus(id: number, status: string): Promise<void>;
  markSignalAction(id: number, status: string): Promise<void>;
  resolveSignal(id: number, status: string, outcome: string, outcomePrice: number | null): Promise<void>;
  updateSignalJournal(id: number, data: { notes?: string | null; confidence?: number | null; tags?: string[] | null }): Promise<Signal | undefined>;
  updateSignalSummary(id: number, summaryText: string): Promise<void>;

  // Strategy parameters (versioned)
  getActiveStrategyParameters(): Promise<StrategyParameters>;
  listStrategyParameters(): Promise<StrategyParameters[]>;
  createStrategyParameters(data: InsertStrategyParameters): Promise<StrategyParameters>;
  setActiveStrategyParameters(id: number): Promise<StrategyParameters>;
  ensureDefaultStrategyParameters(): Promise<StrategyParameters>;

  // Performance analytics aggregates and rejection telemetry
  getPerformanceAggregates(groupBy: "pair" | "strategy" | "direction" | "asset" | "session" | "hour"): Promise<Array<{ key: string; total: number; wins: number; losses: number; missed: number }>>;
  getScanRunById(id: number): Promise<ScanRun | undefined>;
  getBacktestStats(): Promise<{ total: number; resolvedTotal: number; wins: number; losses: number; missed: number; unresolved: number; byStrategy: Record<string, { total: number; wins: number; losses: number }>; byDirection: Record<string, { total: number; wins: number; losses: number }>; takenWins: number; takenTotal: number; takenResolved: number }>;

  createAlertEvent(data: InsertAlertEvent): Promise<AlertEvent>;

  getTradeAnalysis(signalId: number): Promise<TradeAnalysis | undefined>;
  getTradeAnalyses(signalIds?: number[]): Promise<TradeAnalysis[]>;
  getAnalyzedSignalIds(): Promise<number[]>;
  upsertTradeAnalysis(data: InsertTradeAnalysis): Promise<TradeAnalysis>;

  getSettings(): Promise<Settings>;
  upsertSettings(data: Partial<InsertSettings>): Promise<Settings>;

  getDashboardStats(): Promise<{
    totalInstruments: number;
    enabledInstruments: number;
    totalSignals: number;
    newSignals: number;
    lastScan: ScanRun | null;
    scanEnabled: boolean;
  }>;
}

export class DatabaseStorage implements IStorage {
  async getInstruments(): Promise<Instrument[]> {
    return db.select().from(instruments).orderBy(instruments.assetClass, instruments.canonicalSymbol);
  }

  async getInstrumentBySymbol(canonical: string): Promise<Instrument | undefined> {
    const [row] = await db.select().from(instruments).where(eq(instruments.canonicalSymbol, canonical)).limit(1);
    return row;
  }

  async getEnabledInstruments(): Promise<Instrument[]> {
    return db.select().from(instruments).where(eq(instruments.enabled, true)).orderBy(instruments.canonicalSymbol);
  }

  async upsertInstrument(data: InsertInstrument): Promise<Instrument> {
    const [row] = await db
      .insert(instruments)
      .values(data)
      .onConflictDoUpdate({
        target: instruments.canonicalSymbol,
        set: { vendorSymbol: data.vendorSymbol, assetClass: data.assetClass, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async bulkUpsertInstruments(data: InsertInstrument[]): Promise<number> {
    if (!data.length) return 0;
    let total = 0;
    for (const batch of chunk(data, 200)) {
      const result = await db
        .insert(instruments)
        .values(batch)
        .onConflictDoUpdate({
          target: instruments.canonicalSymbol,
          set: {
            vendorSymbol: sql`EXCLUDED.vendor_symbol`,
            assetClass: sql`EXCLUDED.asset_class`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: instruments.id });
      total += result.length;
    }
    return total;
  }

  async getCandles(instrumentId: number, timeframe: string, limit = 300): Promise<Candle[]> {
    return db
      .select()
      .from(candles)
      .where(and(eq(candles.instrumentId, instrumentId), eq(candles.timeframe, timeframe)))
      .orderBy(desc(candles.datetimeUtc))
      .limit(limit);
  }

  async upsertCandles(data: InsertCandle[]): Promise<void> {
    if (!data.length) return;
    for (const batch of chunk(data, 100)) {
      await db
        .insert(candles)
        .values(batch)
        .onConflictDoUpdate({
          target: [candles.instrumentId, candles.timeframe, candles.datetimeUtc],
          set: {
            open: sql`EXCLUDED.open`,
            high: sql`EXCLUDED.high`,
            low: sql`EXCLUDED.low`,
            close: sql`EXCLUDED.close`,
            volume: sql`EXCLUDED.volume`,
          },
        });
    }
  }

  async getIndicators(instrumentId: number, timeframe: string, limit = 300): Promise<Indicator[]> {
    return db
      .select()
      .from(indicators)
      .where(and(eq(indicators.instrumentId, instrumentId), eq(indicators.timeframe, timeframe)))
      .orderBy(desc(indicators.datetimeUtc))
      .limit(limit);
  }

  async upsertIndicators(data: InsertIndicator[]): Promise<void> {
    if (!data.length) return;
    for (const batch of chunk(data, 100)) {
      await db
        .insert(indicators)
        .values(batch)
        .onConflictDoUpdate({
          target: [indicators.instrumentId, indicators.timeframe, indicators.datetimeUtc],
          set: {
            ema9: sql`EXCLUDED.ema9`,
            ema21: sql`EXCLUDED.ema21`,
            ema55: sql`EXCLUDED.ema55`,
            ema200: sql`EXCLUDED.ema200`,
            bbUpper: sql`EXCLUDED.bb_upper`,
            bbMiddle: sql`EXCLUDED.bb_middle`,
            bbLower: sql`EXCLUDED.bb_lower`,
            bbWidth: sql`EXCLUDED.bb_width`,
            macd: sql`EXCLUDED.macd`,
            macdSignal: sql`EXCLUDED.macd_signal`,
            macdHist: sql`EXCLUDED.macd_hist`,
            atr: sql`EXCLUDED.atr`,
            adx: sql`EXCLUDED.adx`,
          },
        });
    }
  }

  async getScanRuns(limit = 20): Promise<ScanRun[]> {
    return db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(limit);
  }

  async createScanRun(data: InsertScanRun): Promise<ScanRun> {
    const [row] = await db.insert(scanRuns).values(data).returning();
    return row;
  }

  async updateScanRun(id: number, data: Partial<ScanRun>): Promise<void> {
    await db.update(scanRuns).set(data).where(eq(scanRuns.id, id));
  }

  async reconcileZombieScanRuns(): Promise<number> {
    const result = await db
      .update(scanRuns)
      .set({
        status: "aborted",
        finishedAt: new Date(),
        notes: sql`coalesce(${scanRuns.notes}, '') || ' [reconciled at startup]'`,
      })
      .where(eq(scanRuns.status, "running"))
      .returning({ id: scanRuns.id });
    return result.length;
  }

  async getScanProgress(instrumentId: number, timeframe: string): Promise<ScanProgress | undefined> {
    const [row] = await db
      .select()
      .from(scanProgress)
      .where(and(eq(scanProgress.instrumentId, instrumentId), eq(scanProgress.timeframe, timeframe)))
      .limit(1);
    return row;
  }

  async upsertScanProgress(data: InsertScanProgress): Promise<void> {
    await db
      .insert(scanProgress)
      .values(data)
      .onConflictDoUpdate({
        target: [scanProgress.instrumentId, scanProgress.timeframe],
        set: {
          lastProcessedBarUtc: data.lastProcessedBarUtc,
          updatedAt: new Date(),
        },
      });
  }

  async getSignalById(id: number): Promise<SignalWithInstrument | undefined> {
    const rows = await db
      .select()
      .from(signals)
      .innerJoin(instruments, eq(signals.instrumentId, instruments.id))
      .where(eq(signals.id, id))
      .limit(1);
    if (!rows.length) return undefined;
    return { ...rows[0].signals, instrument: rows[0].instruments };
  }

  async getSignals(filters?: { strategy?: string; direction?: string; status?: string; activeOnly?: boolean; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]> {
    const conditions = [];
    if (filters?.strategy) conditions.push(eq(signals.strategy, filters.strategy));
    if (filters?.direction) conditions.push(eq(signals.direction, filters.direction));
    if (filters?.activeOnly) {
      conditions.push(inArray(signals.status, ["NEW", "ALERTED"]));
    } else if (filters?.status) {
      conditions.push(eq(signals.status, filters.status));
    }
    if (filters?.symbol) {
      const inst = await this.getInstrumentBySymbol(filters.symbol);
      if (inst) conditions.push(eq(signals.instrumentId, inst.id));
      else return [];
    }

    const rows = await db
      .select()
      .from(signals)
      .innerJoin(instruments, eq(signals.instrumentId, instruments.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(signals.detectedAt))
      .limit(filters?.limit ?? 100);

    return rows.map((r) => ({ ...r.signals, instrument: r.instruments }));
  }

  async findActiveSignal(instrumentId: number, timeframe: string, strategy: string, direction: string): Promise<Signal | undefined> {
    const [row] = await db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.instrumentId, instrumentId),
          eq(signals.timeframe, timeframe),
          eq(signals.strategy, strategy),
          eq(signals.direction, direction),
          inArray(signals.status, ["NEW", "ALERTED"]),
        )
      )
      .limit(1);
    return row;
  }

  async upsertSignal(data: InsertSignal): Promise<Signal> {
    const [row] = await db
      .insert(signals)
      .values(data)
      .onConflictDoUpdate({
        target: [signals.instrumentId, signals.timeframe, signals.strategy, signals.direction, signals.candleDatetimeUtc],
        set: {
          score: data.score,
          reasonJson: data.reasonJson,
          detectedAt: new Date(),
          paramSetVersion: data.paramSetVersion,
          summaryText: data.summaryText,
        },
      })
      .returning();
    return row;
  }

  async updateSignalStatus(id: number, status: string): Promise<void> {
    await db.update(signals).set({ status }).where(eq(signals.id, id));
  }

  // Records a user's TAKEN/NOT_TAKEN decision without finalizing the outcome.
  // Leaves outcome/resolvedAt untouched so the scanner can still resolve TP/SL hits later.
  async markSignalAction(id: number, status: string): Promise<void> {
    await db.update(signals).set({ status }).where(eq(signals.id, id));
  }

  // Concurrency-safe: if the row's current status is already TAKEN/NOT_TAKEN
  // (i.e. the user clicked between when the scanner read the row and when it
  // writes back), preserve that user decision. Done in SQL so we don't lose to
  // a stale in-memory read.
  async resolveSignal(id: number, status: string, outcome: string, outcomePrice: number | null): Promise<void> {
    await db
      .update(signals)
      .set({
        status: sql`case when ${signals.status} in ('TAKEN','NOT_TAKEN') then ${signals.status} else ${status} end`,
        outcome,
        outcomePrice,
        resolvedAt: new Date(),
      })
      .where(eq(signals.id, id));
  }

  async updateSignalJournal(
    id: number,
    data: { notes?: string | null; confidence?: number | null; tags?: string[] | null },
  ): Promise<Signal | undefined> {
    const patch: Partial<typeof signals.$inferInsert> = {};
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.confidence !== undefined) patch.confidence = data.confidence;
    if (data.tags !== undefined) patch.tags = data.tags ?? [];
    if (Object.keys(patch).length === 0) {
      const [row] = await db.select().from(signals).where(eq(signals.id, id)).limit(1);
      return row;
    }
    const [row] = await db.update(signals).set(patch).where(eq(signals.id, id)).returning();
    return row;
  }

  async updateSignalSummary(id: number, summaryText: string): Promise<void> {
    await db.update(signals).set({ summaryText }).where(eq(signals.id, id));
  }

  async getActiveStrategyParameters(): Promise<StrategyParameters> {
    const [active] = await db
      .select()
      .from(strategyParameters)
      .where(eq(strategyParameters.isActive, true))
      .orderBy(desc(strategyParameters.version))
      .limit(1);
    if (active) return active;
    return this.ensureDefaultStrategyParameters();
  }

  async listStrategyParameters(): Promise<StrategyParameters[]> {
    return db.select().from(strategyParameters).orderBy(desc(strategyParameters.version));
  }

  async createStrategyParameters(data: InsertStrategyParameters): Promise<StrategyParameters> {
    const [row] = await db.insert(strategyParameters).values(data).returning();
    return row;
  }

  async setActiveStrategyParameters(id: number): Promise<StrategyParameters> {
    return await db.transaction(async (tx) => {
      await tx.update(strategyParameters).set({ isActive: false });
      const [row] = await tx
        .update(strategyParameters)
        .set({ isActive: true })
        .where(eq(strategyParameters.id, id))
        .returning();
      if (!row) throw new Error(`strategy_parameters id ${id} not found`);
      return row;
    });
  }

  async ensureDefaultStrategyParameters(): Promise<StrategyParameters> {
    const existing = await db.select().from(strategyParameters).limit(1);
    if (existing.length > 0) {
      const active = existing.find((r) => r.isActive);
      if (active) return active;
      const [promoted] = await db
        .update(strategyParameters)
        .set({ isActive: true })
        .where(eq(strategyParameters.id, existing[0].id))
        .returning();
      return promoted;
    }
    const [row] = await db
      .insert(strategyParameters)
      .values({
        version: 1,
        name: "v1 (initial defaults)",
        description: "Initial strategy parameter set seeded from hardcoded constants.",
        isActive: true,
        params: DEFAULT_STRATEGY_PARAMS,
      })
      .returning();
    return row;
  }

  async getScanRunById(id: number): Promise<ScanRun | undefined> {
    const [row] = await db.select().from(scanRuns).where(eq(scanRuns.id, id)).limit(1);
    return row;
  }

  // Performance aggregates: per-pair / per-strategy / per-direction / per-asset / per-session / per-hour.
  // session derived from extract(hour from detected_at) ranges in UTC:
  //   Asia 0-7, London 7-13, NY-overlap 13-17, NY 17-22, Off 22-24
  async getPerformanceAggregates(
    groupBy: "pair" | "strategy" | "direction" | "asset" | "session" | "hour",
  ): Promise<Array<{ key: string; total: number; wins: number; losses: number; missed: number }>> {
    const archivedStatuses = ["EXPIRED", "TAKEN", "NOT_TAKEN"];
    const baseWhere = inArray(signals.status, archivedStatuses);

    let keyExpr: SQL<string>;
    switch (groupBy) {
      case "pair":
        keyExpr = sql<string>`${instruments.canonicalSymbol}`;
        break;
      case "strategy":
        keyExpr = sql<string>`${signals.strategy}`;
        break;
      case "direction":
        keyExpr = sql<string>`${signals.direction}`;
        break;
      case "asset":
        keyExpr = sql<string>`${instruments.assetClass}`;
        break;
      case "session":
        keyExpr = sql<string>`case
          when extract(hour from ${signals.detectedAt} at time zone 'UTC') < 7 then 'Asia'
          when extract(hour from ${signals.detectedAt} at time zone 'UTC') < 13 then 'London'
          when extract(hour from ${signals.detectedAt} at time zone 'UTC') < 17 then 'NY-Overlap'
          when extract(hour from ${signals.detectedAt} at time zone 'UTC') < 22 then 'NY'
          else 'Off'
        end`;
        break;
      case "hour":
        keyExpr = sql<string>`lpad(extract(hour from ${signals.detectedAt} at time zone 'UTC')::text, 2, '0') || ':00 UTC'`;
        break;
    }

    const needsJoin = groupBy === "pair" || groupBy === "asset";
    const baseQuery = needsJoin
      ? db
          .select({
            key: keyExpr,
            total: sql<number>`count(*)::int`,
            wins: sql<number>`count(*) filter (where ${signals.outcome} = 'WIN')::int`,
            losses: sql<number>`count(*) filter (where ${signals.outcome} = 'LOSS')::int`,
            missed: sql<number>`count(*) filter (where ${signals.outcome} = 'MISSED')::int`,
          })
          .from(signals)
          .innerJoin(instruments, eq(signals.instrumentId, instruments.id))
          .where(baseWhere)
          .groupBy(keyExpr)
      : db
          .select({
            key: keyExpr,
            total: sql<number>`count(*)::int`,
            wins: sql<number>`count(*) filter (where ${signals.outcome} = 'WIN')::int`,
            losses: sql<number>`count(*) filter (where ${signals.outcome} = 'LOSS')::int`,
            missed: sql<number>`count(*) filter (where ${signals.outcome} = 'MISSED')::int`,
          })
          .from(signals)
          .where(baseWhere)
          .groupBy(keyExpr);

    const rows = await baseQuery;
    return rows
      .map((r) => ({ key: String(r.key ?? ""), total: r.total, wins: r.wins, losses: r.losses, missed: r.missed }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async getActiveSignalsOlderThan(maxAgeMs: number): Promise<Signal[]> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return db
      .select()
      .from(signals)
      .where(and(inArray(signals.status, ["NEW", "ALERTED"]), lt(signals.detectedAt, cutoff)));
  }

  // Returns every signal that has not yet had its outcome decided by price.
  // This is the union of (a) NEW/ALERTED awaiting resolution and (b) TAKEN/NOT_TAKEN
  // signals the user has acted on but where TP/SL has not yet been hit. Both groups
  // continue to be monitored each tick so "Your Win Rate" can pick up later resolutions.
  async getUnresolvedSignals(maxAgeMs: number): Promise<Signal[]> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return db
      .select()
      .from(signals)
      .where(
        and(
          lt(signals.detectedAt, cutoff),
          or(
            inArray(signals.status, ["NEW", "ALERTED"]),
            and(inArray(signals.status, ["TAKEN", "NOT_TAKEN"]), isNull(signals.outcome)),
          ),
        ),
      );
  }

  async getArchivedSignals(filters?: { strategy?: string; direction?: string; outcome?: string; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]> {
    const archivedStatuses = ["EXPIRED", "TAKEN", "NOT_TAKEN"];
    const conditions = [inArray(signals.status, archivedStatuses)];
    if (filters?.strategy) conditions.push(eq(signals.strategy, filters.strategy));
    if (filters?.direction) conditions.push(eq(signals.direction, filters.direction));
    if (filters?.outcome) {
      // "PENDING" is the UI label for archived signals whose outcome hasn't been
      // decided by price yet (TAKEN/NOT_TAKEN with NULL outcome). Map it to IS NULL.
      if (filters.outcome === "PENDING") {
        conditions.push(isNull(signals.outcome));
      } else {
        conditions.push(eq(signals.outcome!, filters.outcome));
      }
    }
    if (filters?.symbol) {
      const inst = await this.getInstrumentBySymbol(filters.symbol);
      if (inst) conditions.push(eq(signals.instrumentId, inst.id));
      else return [];
    }

    const rows = await db
      .select()
      .from(signals)
      .innerJoin(instruments, eq(signals.instrumentId, instruments.id))
      .where(and(...conditions))
      .orderBy(sql`${signals.resolvedAt} desc nulls last`, desc(signals.detectedAt))
      .limit(filters?.limit ?? 200);

    return rows.map((r) => ({ ...r.signals, instrument: r.instruments }));
  }

  async getBacktestStats() {
    const archivedStatuses = ["EXPIRED", "TAKEN", "NOT_TAKEN"];

    const [overall] = await db
      .select({
        total: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${signals.outcome} = 'WIN')::int`,
        losses: sql<number>`count(*) filter (where ${signals.outcome} = 'LOSS')::int`,
        // MISSED = scanner gave up after the eval window (outcome explicitly set to MISSED)
        // UNRESOLVED = TAKEN/NOT_TAKEN that the scanner is still monitoring (outcome NULL)
        missed: sql<number>`count(*) filter (where ${signals.outcome} = 'MISSED')::int`,
        unresolved: sql<number>`count(*) filter (where ${signals.outcome} is null)::int`,
        // takenTotal/takenResolved: only count TAKEN signals that have actually resolved
        // to WIN or LOSS so the displayed "Your Win Rate" isn't diluted by unresolved trades.
        takenTotal: sql<number>`count(*) filter (where ${signals.status} = 'TAKEN')::int`,
        takenResolved: sql<number>`count(*) filter (where ${signals.status} = 'TAKEN' and ${signals.outcome} in ('WIN','LOSS'))::int`,
        takenWins: sql<number>`count(*) filter (where ${signals.status} = 'TAKEN' and ${signals.outcome} = 'WIN')::int`,
      })
      .from(signals)
      .where(inArray(signals.status, archivedStatuses));

    const stratRows = await db
      .select({
        strategy: signals.strategy,
        total: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${signals.outcome} = 'WIN')::int`,
        losses: sql<number>`count(*) filter (where ${signals.outcome} = 'LOSS')::int`,
      })
      .from(signals)
      .where(inArray(signals.status, archivedStatuses))
      .groupBy(signals.strategy);

    const dirRows = await db
      .select({
        direction: signals.direction,
        total: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${signals.outcome} = 'WIN')::int`,
        losses: sql<number>`count(*) filter (where ${signals.outcome} = 'LOSS')::int`,
      })
      .from(signals)
      .where(inArray(signals.status, archivedStatuses))
      .groupBy(signals.direction);

    const byStrategy: Record<string, { total: number; wins: number; losses: number }> = {};
    for (const r of stratRows) byStrategy[r.strategy] = { total: r.total, wins: r.wins, losses: r.losses };

    const byDirection: Record<string, { total: number; wins: number; losses: number }> = {};
    for (const r of dirRows) byDirection[r.direction] = { total: r.total, wins: r.wins, losses: r.losses };

    return {
      total: overall?.total ?? 0,
      // resolvedTotal = wins+losses; the meaningful denominator for "win rate when the trade resolves"
      resolvedTotal: (overall?.wins ?? 0) + (overall?.losses ?? 0),
      wins: overall?.wins ?? 0,
      losses: overall?.losses ?? 0,
      missed: overall?.missed ?? 0,
      unresolved: overall?.unresolved ?? 0,
      takenWins: overall?.takenWins ?? 0,
      takenTotal: overall?.takenTotal ?? 0,
      takenResolved: overall?.takenResolved ?? 0,
      byStrategy,
      byDirection,
    };
  }

  async createAlertEvent(data: InsertAlertEvent): Promise<AlertEvent> {
    const [row] = await db.insert(alertEvents).values(data).returning();
    return row;
  }

  async getTradeAnalysis(signalId: number): Promise<TradeAnalysis | undefined> {
    const [row] = await db.select().from(tradeAnalyses).where(eq(tradeAnalyses.signalId, signalId)).limit(1);
    return row;
  }

  async getTradeAnalyses(signalIds?: number[]): Promise<TradeAnalysis[]> {
    if (signalIds && signalIds.length > 0) {
      return db.select().from(tradeAnalyses).where(inArray(tradeAnalyses.signalId, signalIds)).orderBy(desc(tradeAnalyses.analyzedAt));
    }
    return db.select().from(tradeAnalyses).orderBy(desc(tradeAnalyses.analyzedAt));
  }

  async getAnalyzedSignalIds(): Promise<number[]> {
    const rows = await db.select({ signalId: tradeAnalyses.signalId }).from(tradeAnalyses);
    return rows.map((r) => r.signalId);
  }

  async upsertTradeAnalysis(data: InsertTradeAnalysis): Promise<TradeAnalysis> {
    const [row] = await db
      .insert(tradeAnalyses)
      .values(data)
      .onConflictDoUpdate({
        target: tradeAnalyses.signalId,
        set: {
          analysis: data.analysis,
          keyFindings: data.keyFindings,
          winLossFactors: data.winLossFactors,
          priceActionPatterns: data.priceActionPatterns,
          marketPsychology: data.marketPsychology,
          entryQuality: data.entryQuality,
          chartPatterns: data.chartPatterns,
          lessonsLearned: data.lessonsLearned,
          analyzedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getSettings(): Promise<Settings> {
    const rows = await db.select().from(settings).limit(1);
    if (rows.length === 0) {
      const [row] = await db.insert(settings).values({}).returning();
      return row;
    }
    return rows[0];
  }

  async upsertSettings(data: Partial<InsertSettings>): Promise<Settings> {
    const existing = await this.getSettings();
    const [row] = await db
      .update(settings)
      .set(data)
      .where(eq(settings.id, existing.id))
      .returning();
    return row;
  }

  async getDashboardStats() {
    const [counts] = await db
      .select({
        totalInstruments: sql<number>`count(*)::int`,
        enabledInstruments: sql<number>`count(*) filter (where ${instruments.enabled})::int`,
      })
      .from(instruments);

    const [sigCounts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        newCount: sql<number>`count(*) filter (where ${signals.status} = 'NEW')::int`,
      })
      .from(signals);

    const lastScans = await db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(1);
    const s = await this.getSettings();

    return {
      totalInstruments: counts?.totalInstruments ?? 0,
      enabledInstruments: counts?.enabledInstruments ?? 0,
      totalSignals: sigCounts?.total ?? 0,
      newSignals: sigCounts?.newCount ?? 0,
      lastScan: lastScans[0] ?? null,
      scanEnabled: s.scanEnabled,
    };
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export const storage = new DatabaseStorage();

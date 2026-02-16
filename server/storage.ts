import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  instruments,
  candles,
  indicators,
  scanRuns,
  scanProgress,
  signals,
  alertEvents,
  settings,
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

  getScanProgress(instrumentId: number, timeframe: string): Promise<ScanProgress | undefined>;
  upsertScanProgress(data: InsertScanProgress): Promise<void>;

  getSignals(filters?: { strategy?: string; direction?: string; status?: string; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]>;
  findActiveSignal(instrumentId: number, timeframe: string, strategy: string, direction: string): Promise<Signal | undefined>;
  upsertSignal(data: InsertSignal): Promise<Signal>;
  updateSignalStatus(id: number, status: string): Promise<void>;

  createAlertEvent(data: InsertAlertEvent): Promise<AlertEvent>;

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
    let count = 0;
    for (const item of data) {
      await this.upsertInstrument(item);
      count++;
    }
    return count;
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

  async getSignals(filters?: { strategy?: string; direction?: string; status?: string; symbol?: string; limit?: number }): Promise<SignalWithInstrument[]> {
    const conditions = [];
    if (filters?.strategy) conditions.push(eq(signals.strategy, filters.strategy));
    if (filters?.direction) conditions.push(eq(signals.direction, filters.direction));
    if (filters?.status) conditions.push(eq(signals.status, filters.status));
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
          eq(signals.status, "NEW"),
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
        set: { score: data.score, reasonJson: data.reasonJson, detectedAt: new Date() },
      })
      .returning();
    return row;
  }

  async updateSignalStatus(id: number, status: string): Promise<void> {
    await db.update(signals).set({ status }).where(eq(signals.id, id));
  }

  async createAlertEvent(data: InsertAlertEvent): Promise<AlertEvent> {
    const [row] = await db.insert(alertEvents).values(data).returning();
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
    const allInst = await db.select().from(instruments);
    const enabledInst = allInst.filter((i) => i.enabled);

    const [sigCount] = await db.select({ count: sql<number>`count(*)::int` }).from(signals);
    const [newSigCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(signals)
      .where(eq(signals.status, "NEW"));

    const lastScans = await db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(1);
    const s = await this.getSettings();

    return {
      totalInstruments: allInst.length,
      enabledInstruments: enabledInst.length,
      totalSignals: sigCount.count,
      newSignals: newSigCount.count,
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

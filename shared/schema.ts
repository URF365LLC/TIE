import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  real,
  timestamp,
  uniqueIndex,
  serial,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

const tz = { withTimezone: true } as const;

export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  canonicalSymbol: varchar("canonical_symbol", { length: 20 }).notNull().unique(),
  assetClass: varchar("asset_class", { length: 10 }).notNull(),
  vendorSymbol: varchar("vendor_symbol", { length: 40 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

export const candles = pgTable(
  "candles",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    datetimeUtc: timestamp("datetime_utc", tz).notNull(),
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    volume: real("volume"),
    source: varchar("source", { length: 20 }).notNull().default("twelvedata"),
  },
  (table) => [
    uniqueIndex("candles_unique_idx").on(table.instrumentId, table.timeframe, table.datetimeUtc),
  ]
);

export const indicators = pgTable(
  "indicators",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    datetimeUtc: timestamp("datetime_utc", tz).notNull(),
    ema9: real("ema9"),
    ema21: real("ema21"),
    ema55: real("ema55"),
    ema200: real("ema200"),
    bbUpper: real("bb_upper"),
    bbMiddle: real("bb_middle"),
    bbLower: real("bb_lower"),
    bbWidth: real("bb_width"),
    macd: real("macd"),
    macdSignal: real("macd_signal"),
    macdHist: real("macd_hist"),
    atr: real("atr"),
    adx: real("adx"),
  },
  (table) => [
    uniqueIndex("indicators_unique_idx").on(table.instrumentId, table.timeframe, table.datetimeUtc),
  ]
);

export const scanRuns = pgTable("scan_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", tz).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", tz),
  timeframe: varchar("timeframe", { length: 5 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("running"),
  creditsUsedEst: integer("credits_used_est"),
  notes: text("notes"),
});

export const scanProgress = pgTable(
  "scan_progress",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    lastProcessedBarUtc: timestamp("last_processed_bar_utc", tz).notNull(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("scan_progress_unique_idx").on(table.instrumentId, table.timeframe)]
);

export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    strategy: varchar("strategy", { length: 30 }).notNull(),
    direction: varchar("direction", { length: 5 }).notNull(),
    detectedAt: timestamp("detected_at", tz).notNull().defaultNow(),
    candleDatetimeUtc: timestamp("candle_datetime_utc", tz).notNull(),
    score: integer("score").notNull(),
    reasonJson: jsonb("reason_json"),
    status: varchar("status", { length: 10 }).notNull().default("NEW"),
  },
  (table) => [
    uniqueIndex("signals_unique_idx").on(
      table.instrumentId,
      table.timeframe,
      table.strategy,
      table.direction,
      table.candleDatetimeUtc
    ),
  ]
);

export const alertEvents = pgTable("alert_events", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id").notNull().references(() => signals.id),
  sentAt: timestamp("sent_at", tz).notNull().defaultNow(),
  channel: varchar("channel", { length: 10 }).notNull().default("EMAIL"),
  to: varchar("to", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  error: text("error"),
});

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  scanEnabled: boolean("scan_enabled").notNull().default(false),
  emailEnabled: boolean("email_enabled").notNull().default(false),
  alertToEmail: varchar("alert_to_email", { length: 255 }),
  smtpFrom: varchar("smtp_from", { length: 255 }),
  minScoreToAlert: integer("min_score_to_alert").notNull().default(60),
  quietHoursJson: jsonb("quiet_hours_json"),
  maxSymbolsPerBurst: integer("max_symbols_per_burst").notNull().default(4),
  burstSleepMs: integer("burst_sleep_ms").notNull().default(1000),
  alertCooldownMinutes: integer("alert_cooldown_minutes").notNull().default(60),
});

export const insertInstrumentSchema = createInsertSchema(instruments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCandleSchema = createInsertSchema(candles).omit({ id: true });
export const insertIndicatorSchema = createInsertSchema(indicators).omit({ id: true });
export const insertScanRunSchema = createInsertSchema(scanRuns).omit({ id: true });
export const insertScanProgressSchema = createInsertSchema(scanProgress).omit({ id: true, updatedAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true });
export const insertAlertEventSchema = createInsertSchema(alertEvents).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });

export type Instrument = typeof instruments.$inferSelect;
export type InsertInstrument = z.infer<typeof insertInstrumentSchema>;
export type Candle = typeof candles.$inferSelect;
export type InsertCandle = z.infer<typeof insertCandleSchema>;
export type Indicator = typeof indicators.$inferSelect;
export type InsertIndicator = z.infer<typeof insertIndicatorSchema>;
export type ScanRun = typeof scanRuns.$inferSelect;
export type InsertScanRun = z.infer<typeof insertScanRunSchema>;
export type ScanProgress = typeof scanProgress.$inferSelect;
export type InsertScanProgress = z.infer<typeof insertScanProgressSchema>;
export type Signal = typeof signals.$inferSelect;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type AlertEvent = typeof alertEvents.$inferSelect;
export type InsertAlertEvent = z.infer<typeof insertAlertEventSchema>;
export type Settings = typeof settings.$inferSelect;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;

export const WHITELIST = {
  FOREX: [
    "AUDCAD","AUDCHF","AUDJPY","AUDNZD","AUDUSD",
    "CADCHF","CADJPY","CHFJPY",
    "EURAUD","EURCAD","EURCHF","EURGBP","EURJPY","EURNZD","EURUSD",
    "GBPAUD","GBPCAD","GBPCHF","GBPJPY","GBPNZD","GBPUSD",
    "NZDCAD","NZDCHF","NZDJPY","NZDUSD",
    "USDCAD","USDCHF","USDJPY",
  ],
  METAL: ["XAUUSD", "XAGUSD"],
  CRYPTO: ["BTCUSD","ETHUSD","SOLUSD","XRPUSD","ADAUSD","BCHUSD","BNBUSD","LTCUSD"],
} as const;

export function canonicalToVendor(canonical: string, assetClass: string): string {
  const base = canonical.slice(0, 3);
  const quote = canonical.slice(3);
  const pair = `${base}/${quote}`;
  if (assetClass === "CRYPTO") return `${pair}:KuCoin`;
  return pair;
}

export type SignalWithInstrument = Signal & { instrument: Instrument };

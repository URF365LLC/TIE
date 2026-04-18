import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  uniqueIndex,
  index,
  serial,
  jsonb,
  customType,
} from "drizzle-orm/pg-core";

const priceNumeric = customType<{ data: number; driverData: string }>({
  dataType() {
    return "numeric(20,8)";
  },
  fromDriver(value: string): number {
    return Number(value);
  },
  toDriver(value: number): string {
    return String(value);
  },
});
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
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    datetimeUtc: timestamp("datetime_utc", tz).notNull(),
    open: priceNumeric("open").notNull(),
    high: priceNumeric("high").notNull(),
    low: priceNumeric("low").notNull(),
    close: priceNumeric("close").notNull(),
    volume: doublePrecision("volume"),
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
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    datetimeUtc: timestamp("datetime_utc", tz).notNull(),
    ema9: doublePrecision("ema9"),
    ema21: doublePrecision("ema21"),
    ema55: doublePrecision("ema55"),
    ema200: doublePrecision("ema200"),
    bbUpper: doublePrecision("bb_upper"),
    bbMiddle: doublePrecision("bb_middle"),
    bbLower: doublePrecision("bb_lower"),
    bbWidth: doublePrecision("bb_width"),
    macd: doublePrecision("macd"),
    macdSignal: doublePrecision("macd_signal"),
    macdHist: doublePrecision("macd_hist"),
    atr: doublePrecision("atr"),
    adx: doublePrecision("adx"),
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
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
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
    instrumentId: integer("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
    timeframe: varchar("timeframe", { length: 5 }).notNull(),
    strategy: varchar("strategy", { length: 30 }).notNull(),
    direction: varchar("direction", { length: 5 }).notNull(),
    detectedAt: timestamp("detected_at", tz).notNull().defaultNow(),
    candleDatetimeUtc: timestamp("candle_datetime_utc", tz).notNull(),
    score: integer("score").notNull(),
    reasonJson: jsonb("reason_json"),
    status: varchar("status", { length: 20 }).notNull().default("NEW"),
    outcome: varchar("outcome", { length: 10 }),
    outcomePrice: priceNumeric("outcome_price"),
    resolvedAt: timestamp("resolved_at", tz),
  },
  (table) => [
    uniqueIndex("signals_unique_idx").on(
      table.instrumentId,
      table.timeframe,
      table.strategy,
      table.direction,
      table.candleDatetimeUtc
    ),
    index("signals_status_idx").on(table.status),
    index("signals_detected_at_idx").on(table.detectedAt),
    index("signals_status_detected_idx").on(table.status, table.detectedAt),
  ]
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull().references(() => signals.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", tz).notNull().defaultNow(),
    channel: varchar("channel", { length: 10 }).notNull().default("EMAIL"),
    to: varchar("to", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    error: text("error"),
  },
  (table) => [index("alert_events_signal_id_idx").on(table.signalId)]
);

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
  accountBalance: integer("account_balance").notNull().default(50000),
  riskPercent: doublePrecision("risk_percent").notNull().default(1.0),
  signalEvalWindowHours: integer("signal_eval_window_hours").notNull().default(4),
  tdCreditLimitPerMin: integer("td_credit_limit_per_min").notNull().default(377),
  tdCreditTargetPerMin: integer("td_credit_target_per_min").notNull().default(340),
  tdMaxConcurrency: integer("td_max_concurrency").notNull().default(3),
});

export const tradeAnalyses = pgTable("trade_analyses", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id").notNull().references(() => signals.id, { onDelete: "cascade" }).unique(),
  analysis: text("analysis").notNull(),
  keyFindings: text("key_findings"),
  winLossFactors: text("win_loss_factors"),
  priceActionPatterns: text("price_action_patterns"),
  marketPsychology: text("market_psychology"),
  entryQuality: varchar("entry_quality", { length: 20 }),
  chartPatterns: text("chart_patterns"),
  lessonsLearned: text("lessons_learned"),
  analyzedAt: timestamp("analyzed_at", tz).notNull().defaultNow(),
});

export const insertInstrumentSchema = createInsertSchema(instruments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCandleSchema = createInsertSchema(candles).omit({ id: true });
export const insertIndicatorSchema = createInsertSchema(indicators).omit({ id: true });
export const insertScanRunSchema = createInsertSchema(scanRuns).omit({ id: true });
export const insertScanProgressSchema = createInsertSchema(scanProgress).omit({ id: true, updatedAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true });
export const insertAlertEventSchema = createInsertSchema(alertEvents).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export const insertTradeAnalysisSchema = createInsertSchema(tradeAnalyses).omit({ id: true, analyzedAt: true });

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
export type TradeAnalysis = typeof tradeAnalyses.$inferSelect;
export type InsertTradeAnalysis = z.infer<typeof insertTradeAnalysisSchema>;

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

export function canonicalToVendor(canonical: string, _assetClass: string): string {
  const base = canonical.slice(0, 3);
  const quote = canonical.slice(3);
  return `${base}/${quote}`;
}

export type SignalWithInstrument = Signal & { instrument: Instrument };

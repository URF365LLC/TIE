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
    paramSetVersion: integer("param_set_version"),
    paramSetId: integer("param_set_id"),
    mode: varchar("mode", { length: 10 }).notNull().default("live"),
    summaryText: text("summary_text"),
    notes: text("notes"),
    confidence: integer("confidence"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // Market regime snapshot taken at signal detection. Used to stratify
    // performance ("strategy X wins 78% in TRENDING, 41% in CHOPPY").
    regimeTag: varchar("regime_tag", { length: 20 }),
    regimeContext: jsonb("regime_context"),
    // Excursion metrics populated at resolution. mfe/mae are in price units,
    // mfeR/maeR are in R-multiples (relative to the signal's risk = |entry - stop|).
    // MFE answers "how far did price move in our favor before this ended?"
    // MAE answers "how close did we come to being stopped?"
    mfe: doublePrecision("mfe"),
    mae: doublePrecision("mae"),
    mfeR: doublePrecision("mfe_r"),
    maeR: doublePrecision("mae_r"),
    timeToResolutionMs: integer("time_to_resolution_ms"),
  },
  (table) => [
    // Unique per (instrument, tf, strategy, direction, candle, mode, paramSetId) so that the same
    // bar can produce one live + several shadow signals (one per candidate set) without colliding.
    uniqueIndex("signals_unique_idx").on(
      table.instrumentId,
      table.timeframe,
      table.strategy,
      table.direction,
      table.candleDatetimeUtc,
      table.mode,
      table.paramSetId,
    ),
    index("signals_status_idx").on(table.status),
    index("signals_detected_at_idx").on(table.detectedAt),
    index("signals_status_detected_idx").on(table.status, table.detectedAt),
    index("signals_regime_tag_idx").on(table.regimeTag),
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
  promotionMinSamples: integer("promotion_min_samples").notNull().default(20),
  promotionMinDeltaPp: doublePrecision("promotion_min_delta_pp").notNull().default(5),
  promotionMaxPValue: doublePrecision("promotion_max_p_value").notNull().default(0.05),
  promotionReminderDays: integer("promotion_reminder_days").notNull().default(3),
  promotionMaxReminders: integer("promotion_max_reminders").notNull().default(3),
});

export interface StrategyParamsConfig {
  trendContinuation: {
    adxThreshold: number;
    atrStopMultiplier: number;
    riskRewardRatio: number;
    scoreThreshold: number;
    pullbackTolerance: number;
  };
  rangeBreakout: {
    adxCeiling: number;
    bbWidthPercentile: number;
    rangeLookbackBars: number;
    atrStopMultiplier: number;
    riskRewardRatio: number;
  };
  confluence?: {
    /** 4h trend (EMA200 slope + price-side) gate. */
    requireHtfAlignment: boolean;
    htfTimeframe: "4h";
    htfEma200SlopeBars: number;
    /** Optional key-level gate: entry must be within proximityPct of prior-24h high/low (computed from 1h bias candles). */
    requireKeyLevels?: boolean;
    keyLevelProximityPct?: number;
    /** Per-strategy opt-in. Empty/undefined = applies to all supported strategies. */
    appliesTo?: Array<"TREND_CONTINUATION" | "RANGE_BREAKOUT">;
  };
}

// Status values for strategy parameter sets:
//  - draft: created (e.g. by optimizer) but not yet running anywhere
//  - active: drives live scanning. Exactly one row should have this status.
//  - shadow: evaluated alongside active on every tick; signals tagged mode='shadow' and never alerted
//  - archived: previously active or shadow, now retained only for history
export const strategyParameters = pgTable("strategy_parameters", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  // Legacy column kept so older rows continue to work; new code reads `status`.
  isActive: boolean("is_active").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  rationale: jsonb("rationale"),
  parentId: integer("parent_id"),
  activatedAt: timestamp("activated_at", tz),
  archivedAt: timestamp("archived_at", tz),
  params: jsonb("params").$type<StrategyParamsConfig>().notNull(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

// One row per shadow parameter set that has crossed the auto-promotion
// significance threshold. Acts as a throttle: while the row exists for a given
// paramSetId, the scanner will not re-send the email or create a duplicate
// banner. The user clearing the banner sets dismissedAt; promoting the set
// makes its status='active' so it falls out of the "still shadow" filter.
export const promotionNotifications = pgTable(
  "promotion_notifications",
  {
    id: serial("id").primaryKey(),
    paramSetId: integer("param_set_id").notNull().references(() => strategyParameters.id, { onDelete: "cascade" }).unique(),
    paramSetVersion: integer("param_set_version").notNull(),
    summary: text("summary").notNull(),
    comparisonJson: jsonb("comparison_json").notNull(),
    emailStatus: varchar("email_status", { length: 20 }).notNull(),
    emailError: text("email_error"),
    emailedAt: timestamp("emailed_at", tz),
    dismissedAt: timestamp("dismissed_at", tz),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at", tz),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (table) => [index("promotion_notifications_dismissed_idx").on(table.dismissedAt)],
);

export const replayRuns = pgTable("replay_runs", {
  id: serial("id").primaryKey(),
  paramSetId: integer("param_set_id").notNull().references(() => strategyParameters.id, { onDelete: "cascade" }),
  baselineParamSetId: integer("baseline_param_set_id").references(() => strategyParameters.id, { onDelete: "set null" }),
  startDate: timestamp("start_date", tz).notNull(),
  endDate: timestamp("end_date", tz).notNull(),
  totalSignals: integer("total_signals").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  missed: integer("missed").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  resultJson: jsonb("result_json"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
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

export const backfillJobs = pgTable(
  "backfill_jobs",
  {
    id: varchar("id", { length: 40 }).primaryKey(),
    status: varchar("status", { length: 20 }).notNull(),
    startedAt: timestamp("started_at", tz).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", tz),
    requestJson: jsonb("request_json").notNull(),
    estimateJson: jsonb("estimate_json").notNull(),
    progressJson: jsonb("progress_json").notNull(),
    resultsJson: jsonb("results_json").notNull().default(sql`'[]'::jsonb`),
    creditsConsumed: integer("credits_consumed").notNull().default(0),
    error: text("error"),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (table) => [index("backfill_jobs_started_at_idx").on(table.startedAt)],
);

export const insertInstrumentSchema = createInsertSchema(instruments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCandleSchema = createInsertSchema(candles).omit({ id: true });
export const insertIndicatorSchema = createInsertSchema(indicators).omit({ id: true });
export const insertScanRunSchema = createInsertSchema(scanRuns).omit({ id: true });
export const insertScanProgressSchema = createInsertSchema(scanProgress).omit({ id: true, updatedAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true });
export const insertAlertEventSchema = createInsertSchema(alertEvents).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export const insertStrategyParametersSchema = createInsertSchema(strategyParameters).omit({ id: true, createdAt: true });
export const insertTradeAnalysisSchema = createInsertSchema(tradeAnalyses).omit({ id: true, analyzedAt: true });
export const insertReplayRunSchema = createInsertSchema(replayRuns).omit({ id: true, createdAt: true });
export const insertPromotionNotificationSchema = createInsertSchema(promotionNotifications).omit({ id: true, createdAt: true });

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
export type StrategyParameters = typeof strategyParameters.$inferSelect;
export type InsertStrategyParameters = z.infer<typeof insertStrategyParametersSchema>;
export type TradeAnalysis = typeof tradeAnalyses.$inferSelect;
export type InsertTradeAnalysis = z.infer<typeof insertTradeAnalysisSchema>;
export type ReplayRun = typeof replayRuns.$inferSelect;
export type InsertReplayRun = z.infer<typeof insertReplayRunSchema>;
export type PromotionNotification = typeof promotionNotifications.$inferSelect;
export type InsertPromotionNotification = z.infer<typeof insertPromotionNotificationSchema>;
export type BackfillJobRow = typeof backfillJobs.$inferSelect;
export type InsertBackfillJobRow = typeof backfillJobs.$inferInsert;

export const DEFAULT_STRATEGY_PARAMS: StrategyParamsConfig = {
  trendContinuation: {
    adxThreshold: 18,
    atrStopMultiplier: 1.2,
    riskRewardRatio: 2,
    scoreThreshold: 40,
    pullbackTolerance: 0.002,
  },
  rangeBreakout: {
    adxCeiling: 18,
    bbWidthPercentile: 50,
    rangeLookbackBars: 20,
    atrStopMultiplier: 1.2,
    riskRewardRatio: 2,
  },
  confluence: {
    requireHtfAlignment: false,
    htfTimeframe: "4h",
    htfEma200SlopeBars: 4,
  },
};

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

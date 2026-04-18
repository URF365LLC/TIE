import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { runScanCycle } from "./scanner";
import { WHITELIST, canonicalToVendor } from "@shared/schema";
import { log } from "./logger";
import { z } from "zod";
import { analyzePortfolio, analyzeTradeDeep, batchAnalyzeTrades, generateStrategyGuide, generateStrategyOptimizer } from "./advisor";
import { insertStrategyParametersSchema } from "@shared/schema";
import { summarizeSignal } from "./summary";

const journalSchema = z.object({
  notes: z.string().max(5000).nullable().optional(),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).nullable().optional(),
});

const strategyParamsConfigSchema = z.object({
  trendContinuation: z.object({
    adxThreshold: z.number().min(0).max(100),
    atrStopMultiplier: z.number().min(0.1).max(10),
    riskRewardRatio: z.number().min(0.5).max(10),
    scoreThreshold: z.number().int().min(0).max(100),
    pullbackTolerance: z.number().min(0).max(0.1),
  }),
  rangeBreakout: z.object({
    adxCeiling: z.number().min(0).max(100),
    bbWidthPercentile: z.number().min(1).max(99),
    rangeLookbackBars: z.number().int().min(5).max(200),
    atrStopMultiplier: z.number().min(0.1).max(10),
    riskRewardRatio: z.number().min(0.5).max(10),
  }),
});

const settingsUpdateSchema = z.object({
  scanEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  alertToEmail: z.string().email().optional().or(z.literal("")),
  smtpFrom: z.string().email().optional().or(z.literal("")),
  minScoreToAlert: z.number().int().min(0).max(100).optional(),
  maxSymbolsPerBurst: z.number().int().min(1).max(10).optional(),
  burstSleepMs: z.number().int().min(500).max(5000).optional(),
  alertCooldownMinutes: z.number().int().min(1).max(1440).optional(),
  accountBalance: z.number().int().min(10000).max(500000).optional(),
  riskPercent: z.number().min(0.25).max(2).optional(),
  signalEvalWindowHours: z.number().int().min(1).max(48).optional(),
  tdCreditLimitPerMin: z.number().int().min(8).max(5000).optional(),
  tdCreditTargetPerMin: z.number().int().min(8).max(5000).optional(),
  tdMaxConcurrency: z.number().int().min(1).max(16).optional(),
}).refine(
  (data) =>
    data.tdCreditTargetPerMin == null ||
    data.tdCreditLimitPerMin == null ||
    data.tdCreditTargetPerMin <= data.tdCreditLimitPerMin,
  {
    message: "tdCreditTargetPerMin must be less than or equal to tdCreditLimitPerMin",
    path: ["tdCreditTargetPerMin"],
  },
);

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/instruments", async (_req, res) => {
    const instruments = await storage.getInstruments();
    res.json(instruments);
  });

  app.get("/api/instruments/:symbol", async (req, res) => {
    const inst = await storage.getInstrumentBySymbol(req.params.symbol);
    if (!inst) return res.status(404).json({ message: "Instrument not found" });
    res.json(inst);
  });

  app.post("/api/instruments/seed", async (_req, res) => {
    const items: { canonicalSymbol: string; assetClass: string; vendorSymbol: string }[] = [];

    for (const sym of WHITELIST.FOREX) {
      items.push({ canonicalSymbol: sym, assetClass: "FOREX", vendorSymbol: canonicalToVendor(sym, "FOREX") });
    }
    for (const sym of WHITELIST.METAL) {
      items.push({ canonicalSymbol: sym, assetClass: "METAL", vendorSymbol: canonicalToVendor(sym, "METAL") });
    }
    for (const sym of WHITELIST.CRYPTO) {
      items.push({ canonicalSymbol: sym, assetClass: "CRYPTO", vendorSymbol: canonicalToVendor(sym, "CRYPTO") });
    }

    const count = await storage.bulkUpsertInstruments(items);
    res.json({ count });
  });

  app.get("/api/candles", async (req, res) => {
    const symbol = req.query.symbol as string;
    const tf = (req.query.tf as string) || "15m";
    if (!symbol) return res.status(400).json({ message: "symbol required" });

    const inst = await storage.getInstrumentBySymbol(symbol);
    if (!inst) return res.status(404).json({ message: "Instrument not found" });

    const candles = await storage.getCandles(inst.id, tf);
    res.json(candles);
  });

  app.get("/api/indicators", async (req, res) => {
    const symbol = req.query.symbol as string;
    const tf = (req.query.tf as string) || "15m";
    if (!symbol) return res.status(400).json({ message: "symbol required" });

    const inst = await storage.getInstrumentBySymbol(symbol);
    if (!inst) return res.status(404).json({ message: "Instrument not found" });

    const indicators = await storage.getIndicators(inst.id, tf);
    res.json(indicators);
  });

  app.get("/api/signals", async (req, res) => {
    const filters: any = {};
    if (req.query.strategy) filters.strategy = req.query.strategy;
    if (req.query.direction) filters.direction = req.query.direction;
    if (req.query.status) {
      if (req.query.status === "active") {
        filters.activeOnly = true;
      } else {
        filters.status = req.query.status;
      }
    }
    if (req.query.symbol) filters.symbol = req.query.symbol;
    if (req.query.limit) filters.limit = parseInt(req.query.limit as string);

    const signals = await storage.getSignals(filters);
    res.json(signals);
  });

  app.post("/api/scan/run", async (_req, res) => {
    try {
      runScanCycle("15m").catch((err) => log(`Manual scan error: ${err.message}`, "scanner"));
      res.json({ message: "Scan triggered" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/scan/status", async (_req, res) => {
    const settings = await storage.getSettings();
    const scans = await storage.getScanRuns(1);
    res.json({
      scanEnabled: settings.scanEnabled,
      lastScanTime: scans[0]?.finishedAt || null,
    });
  });

  app.get("/api/scan/runs", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const runs = await storage.getScanRuns(limit);
    res.json(runs);
  });

  app.get("/api/settings", async (_req, res) => {
    const settings = await storage.getSettings();
    res.json(settings);
  });

  app.post("/api/settings", async (req, res) => {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid settings", errors: parsed.error.flatten() });
    }
    const settings = await storage.upsertSettings(parsed.data);
    res.json(settings);
  });

  app.post("/api/signals/:id/action", async (req, res) => {
    const id = parseInt(req.params.id);
    const { action } = req.body;
    if (!["TAKEN", "NOT_TAKEN"].includes(action)) {
      return res.status(400).json({ message: "action must be TAKEN or NOT_TAKEN" });
    }
    try {
      const { resolveSignalOutcome } = await import("./scanner");
      await resolveSignalOutcome(id, action);
      res.json({ message: "Signal updated" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/backtest/signals", async (req, res) => {
    const filters: any = {};
    if (req.query.strategy) filters.strategy = req.query.strategy;
    if (req.query.direction) filters.direction = req.query.direction;
    if (req.query.outcome) {
      const o = String(req.query.outcome);
      if (["WIN", "LOSS", "MISSED", "PENDING"].includes(o)) filters.outcome = o;
    }
    if (req.query.symbol) filters.symbol = req.query.symbol;
    if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
    const signals = await storage.getArchivedSignals(filters);
    res.json(signals);
  });

  app.get("/api/backtest/stats", async (_req, res) => {
    const stats = await storage.getBacktestStats();
    res.json(stats);
  });

  app.get("/api/dashboard/stats", async (_req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  });

  app.post("/api/advisor/portfolio-analysis", async (_req, res) => {
    try {
      const analysis = await analyzePortfolio();
      res.json({ analysis });
    } catch (err: any) {
      log(`Portfolio analysis error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/advisor/trade-analysis", async (req, res) => {
    try {
      const { signalId } = req.body;
      if (!signalId) return res.status(400).json({ message: "signalId required" });
      const analysis = await analyzeTradeDeep(signalId);
      res.json({ analysis });
    } catch (err: any) {
      log(`Trade analysis error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/advisor/strategy-guide", async (req, res) => {
    try {
      const { strategy } = req.body;
      if (!strategy || !["TREND_CONTINUATION", "RANGE_BREAKOUT"].includes(strategy)) {
        return res.status(400).json({ message: "strategy must be TREND_CONTINUATION or RANGE_BREAKOUT" });
      }
      const analysis = await generateStrategyGuide(strategy);
      res.json({ analysis });
    } catch (err: any) {
      log(`Strategy guide error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/advisor/batch-analyze", async (req, res) => {
    try {
      const { signalIds } = req.body;
      if (!signalIds || !Array.isArray(signalIds) || signalIds.length === 0) {
        return res.status(400).json({ message: "signalIds array required" });
      }
      if (signalIds.length > 30) {
        return res.status(400).json({ message: "Maximum 30 signals per batch" });
      }
      const result = await batchAnalyzeTrades(signalIds);
      res.json(result);
    } catch (err: any) {
      log(`Batch analysis error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/advisor/analyzed-signals", async (_req, res) => {
    try {
      const ids = await storage.getAnalyzedSignalIds();
      res.json({ analyzedIds: ids });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/advisor/trade-analysis/:signalId", async (req, res) => {
    try {
      const signalId = parseInt(req.params.signalId);
      const analysis = await storage.getTradeAnalysis(signalId);
      if (!analysis) return res.status(404).json({ message: "No analysis found for this signal" });
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Learning Infrastructure: signal journaling ───────────────────────────
  app.patch("/api/signals/:id/journal", async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "invalid id" });
    const parsed = journalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid journal payload", errors: parsed.error.flatten() });
    }
    try {
      const updated = await storage.updateSignalJournal(id, parsed.data);
      if (!updated) return res.status(404).json({ message: "signal not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Learning Infrastructure: versioned strategy parameters ───────────────
  app.get("/api/strategy-parameters", async (_req, res) => {
    const rows = await storage.listStrategyParameters();
    const active = await storage.getActiveStrategyParameters();
    res.json({ activeId: active.id, activeVersion: active.version, parameters: rows });
  });

  app.post("/api/strategy-parameters", async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      params: strategyParamsConfigSchema,
      activate: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    }
    try {
      const all = await storage.listStrategyParameters();
      const nextVersion = all.length === 0 ? 1 : Math.max(...all.map((r) => r.version)) + 1;
      const row = await storage.createStrategyParameters({
        version: nextVersion,
        name: parsed.data.name,
        description: parsed.data.description,
        isActive: false,
        params: parsed.data.params,
      });
      const final = parsed.data.activate ? await storage.setActiveStrategyParameters(row.id) : row;
      res.status(201).json(final);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/strategy-parameters/:id/activate", async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "invalid id" });
    try {
      const row = await storage.setActiveStrategyParameters(id);
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Learning Infrastructure: performance analytics ───────────────────────
  app.get("/api/analytics/performance", async (req, res) => {
    const allowed = ["pair", "strategy", "direction", "asset", "session", "hour"] as const;
    type GroupBy = (typeof allowed)[number];
    const isGroupBy = (v: string): v is GroupBy => (allowed as readonly string[]).includes(v);
    const raw = typeof req.query.groupBy === "string" ? req.query.groupBy : "pair";
    if (!isGroupBy(raw)) {
      return res.status(400).json({ message: `groupBy must be one of: ${allowed.join(", ")}` });
    }
    try {
      const rows = await storage.getPerformanceAggregates(raw);
      res.json({ groupBy: raw, rows });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Learning Infrastructure: scan-rejection telemetry per scan ───────────
  app.get("/api/scan/runs/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "invalid id" });
    const run = await storage.getScanRunById(id);
    if (!run) return res.status(404).json({ message: "scan run not found" });
    type ParsedNotes = { rejections?: Record<string, number>; raw?: string | null } & Record<string, unknown>;
    let parsedNotes: ParsedNotes | null = null;
    try {
      parsedNotes = run.notes ? (JSON.parse(run.notes) as ParsedNotes) : null;
    } catch {
      parsedNotes = { raw: run.notes };
    }
    const rejectionsRaw: Record<string, number> = parsedNotes?.rejections ?? {};
    const rejections = Object.entries(rejectionsRaw)
      .map(([key, count]) => {
        const [strategy, ...rest] = key.split(":");
        return { strategy, reason: rest.join(":") || "unknown", count };
      })
      .sort((a, b) => b.count - a.count);
    res.json({ ...run, parsedNotes, rejections });
  });

  // ─── Learning Infrastructure: backfill summaries for legacy signals ───────
  app.post("/api/signals/backfill-summaries", async (_req, res) => {
    try {
      const all = await storage.getSignals({ limit: 1000 });
      let count = 0;
      for (const sig of all) {
        if (sig.summaryText) continue;
        const text = summarizeSignal(sig.strategy, sig.direction as "LONG" | "SHORT", sig.reasonJson as Record<string, any>);
        await storage.updateSignalSummary(sig.id, text);
        count++;
      }
      res.json({ updated: count });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/advisor/strategy-optimizer", async (_req, res) => {
    try {
      const analysis = await generateStrategyOptimizer();
      res.json({ analysis });
    } catch (err: any) {
      log(`Strategy optimizer error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}

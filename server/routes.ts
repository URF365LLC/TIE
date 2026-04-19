import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { runScanCycle } from "./scanner";
import { WHITELIST, canonicalToVendor } from "@shared/schema";
import { log } from "./logger";
import { z } from "zod";
import { analyzePortfolio, analyzeTradeDeep, batchAnalyzeTrades, generateStrategyGuide, generateStrategyOptimizer, generateOptimizerCandidate } from "./advisor";
import { insertStrategyParametersSchema } from "@shared/schema";
import { summarizeSignal } from "./summary";
import { runReplay } from "./replay";
import { estimateBackfill, runBackfill, getBackfillJob, listBackfillJobs, type BackfillTimeframe } from "./backfill";
import { computePromotionRecommendations } from "./promotion";

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
  confluence: z
    .object({
      requireHtfAlignment: z.boolean(),
      htfTimeframe: z.literal("4h"),
      htfEma200SlopeBars: z.number().int().min(2).max(20),
      requireKeyLevels: z.boolean().optional(),
      keyLevelProximityPct: z.number().min(0).max(10).optional(),
      appliesTo: z.array(z.enum(["TREND_CONTINUATION", "RANGE_BREAKOUT"])).optional(),
    })
    .optional(),
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
  promotionMinSamples: z.number().int().min(5).max(1000).optional(),
  promotionMinDeltaPp: z.number().min(0).max(50).optional(),
  promotionMaxPValue: z.number().min(0.0001).max(0.5).optional(),
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
    const rationaleSchema = z.object({ rationale: z.unknown().optional() }).strict();
    const parsed = rationaleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    }
    try {
      const row = await storage.setActiveStrategyParameters(id, parsed.data.rationale);
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

  // ─── Self-improvement loop ────────────────────────────────────────────────

  // Optimizer write-back: returns a CONCRETE candidate parameter set + rationale
  // OR optionally persists it as a draft (saveAsDraft=true) for the user to review.
  app.post("/api/advisor/optimizer-candidate", async (req, res) => {
    try {
      const candidate = await generateOptimizerCandidate();
      if (!candidate) {
        return res.status(200).json({ candidate: null, message: "Not enough resolved signals or no high-confidence change suggested." });
      }
      const saveAsDraft = req.body?.saveAsDraft === true;
      let saved = null;
      if (saveAsDraft) {
        const all = await storage.listStrategyParameters();
        const nextVersion = all.length === 0 ? 1 : Math.max(...all.map((r) => r.version)) + 1;
        saved = await storage.createStrategyParameters({
          version: nextVersion,
          name: `v${nextVersion} (optimizer candidate)`,
          description: `Auto-generated from active v${candidate.baseline.version} based on ${candidate.rationale.sampleSize} archived signals.`,
          isActive: false,
          status: "draft",
          parentId: candidate.baseline.id,
          rationale: candidate.rationale,
          params: candidate.proposedParams,
        });
      }
      res.json({ candidate, saved });
    } catch (err: any) {
      log(`Optimizer candidate error: ${err.message}`, "advisor");
      res.status(500).json({ message: err.message });
    }
  });

  // Replay (what-if) — runs synchronously over stored data; large ranges may take seconds.
  // When `compareParamSetId` or `compareParams` is provided, runs BOTH and returns a
  // baseline-vs-proposed comparison over the SAME window so deltas are like-for-like.
  app.post("/api/replay", async (req, res) => {
    const schema = z.object({
      paramSetId: z.number().int().positive().optional(),
      params: strategyParamsConfigSchema.optional(),
      compareParamSetId: z.number().int().positive().optional(),
      compareParams: strategyParamsConfigSchema.optional(),
      startDate: z.string(),
      endDate: z.string(),
      symbols: z.array(z.string()).optional(),
      evalWindowHours: z.number().int().min(1).max(48).optional(),
      persist: z.boolean().optional(),
    }).refine((d) => d.paramSetId || d.params, { message: "either paramSetId or params is required" });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });

    try {
      const all = await storage.listStrategyParameters();
      async function resolve(id?: number, params?: any): Promise<{ id: number; version: number; cfg: any } | null> {
        if (id) {
          const set = all.find((p) => p.id === id);
          if (!set) return null;
          return { id: set.id, version: set.version, cfg: set.params };
        }
        if (params) return { id: 0, version: 0, cfg: params };
        return null;
      }
      const baseline = await resolve(parsed.data.paramSetId, parsed.data.params);
      if (!baseline) return res.status(404).json({ message: "baseline param set not found" });
      const proposed = await resolve(parsed.data.compareParamSetId, parsed.data.compareParams);

      const startDate = new Date(parsed.data.startDate);
      const endDate = new Date(parsed.data.endDate);

      const baselineResult = await runReplay({
        paramSetId: baseline.id,
        paramSetVersion: baseline.version,
        paramsConfig: baseline.cfg,
        startDate,
        endDate,
        symbols: parsed.data.symbols,
        evalWindowHours: parsed.data.evalWindowHours,
      });

      let proposedResult = null;
      let comparison = null;
      if (proposed) {
        proposedResult = await runReplay({
          paramSetId: proposed.id,
          paramSetVersion: proposed.version,
          paramsConfig: proposed.cfg,
          startDate,
          endDate,
          symbols: parsed.data.symbols,
          evalWindowHours: parsed.data.evalWindowHours,
        });
        comparison = {
          deltaSignals: proposedResult.totalSignals - baselineResult.totalSignals,
          deltaWinRate: (proposedResult.winRate ?? 0) - (baselineResult.winRate ?? 0),
          deltaExpectancyR: (proposedResult.expectancyR ?? 0) - (baselineResult.expectancyR ?? 0),
        };
      }

      if (parsed.data.persist && baseline.id) {
        await storage.createReplayRun({
          paramSetId: baseline.id,
          startDate,
          endDate,
          totalSignals: baselineResult.totalSignals,
          wins: baselineResult.wins,
          losses: baselineResult.losses,
          missed: baselineResult.missed,
          durationMs: baselineResult.durationMs,
          resultJson: { baseline: baselineResult, proposed: proposedResult, comparison },
        });
      }

      // Single-run callers see the original shape; comparison callers get an extra block.
      res.json(proposedResult ? { ...baselineResult, proposed: proposedResult, comparison } : baselineResult);
    } catch (err: any) {
      log(`Replay error: ${err.message}`, "replay");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/replay/runs", async (req, res) => {
    const paramSetId = req.query.paramSetId ? parseInt(String(req.query.paramSetId)) : undefined;
    const rows = await storage.listReplayRuns(paramSetId);
    res.json(rows);
  });

  // Promote a draft → shadow (run alongside live) or shadow → archived.
  // Promotion to ACTIVE goes through the existing /:id/activate endpoint and always
  // requires explicit user action (this route is the gate).
  app.post("/api/strategy-parameters/:id/status", async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "invalid id" });
    const schema = z.object({ status: z.enum(["draft", "shadow", "archived"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    try {
      const row = await storage.setStrategyParameterStatus(id, parsed.data.status);
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Version history: every parameter set + lifetime stats.
  app.get("/api/strategy-parameters/history", async (_req, res) => {
    const all = await storage.listStrategyParameters();
    const enriched = await Promise.all(
      all.map(async (p) => ({
        ...p,
        lifetimeStats: await storage.getParamSetLifetimeStats(p.id),
      })),
    );
    res.json(enriched);
  });

  // Self-improvement dashboard: rolling N-day win rate per parameter set version.
  app.get("/api/strategy-parameters/rolling-winrate", async (req, res) => {
    const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? "30")) || 30));
    const rows = await storage.getRollingWinRateByParamSet(days);
    res.json({ windowDays: days, rows });
  });

  // Auto-promotion recommendations: for each shadow set with a statistically
  // meaningful win-rate edge over the active set in the rolling window, return
  // a structured recommendation the user can promote with one click.
  app.get("/api/strategy-parameters/promotion-recommendations", async (req, res) => {
    const settings = await storage.getSettings();
    const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? "30")) || 30));
    const parsedSamples = parseInt(String(req.query.minSamples ?? settings.promotionMinSamples));
    const minSampleSize = Math.max(5, Number.isFinite(parsedSamples) ? parsedSamples : settings.promotionMinSamples);
    const parsedDelta = parseFloat(String(req.query.minDeltaPp ?? settings.promotionMinDeltaPp));
    const minDeltaPp = Math.max(0, Number.isFinite(parsedDelta) ? parsedDelta : settings.promotionMinDeltaPp);
    const parsedP = parseFloat(String(req.query.maxP ?? settings.promotionMaxPValue));
    const maxPValue = Math.max(0.0001, Math.min(0.5, Number.isFinite(parsedP) ? parsedP : settings.promotionMaxPValue));

    try {
      const result = await computePromotionRecommendations({ windowDays: days, minSampleSize, minDeltaPp, maxPValue });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Active (undismissed) auto-promotion notifications surfaced as a dashboard
  // banner. Filtered server-side to sets that are still 'shadow' so the banner
  // disappears automatically once the user promotes the set.
  app.get("/api/strategy-parameters/promotion-notifications", async (_req, res) => {
    try {
      const rows = await storage.listActivePromotionNotifications();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/strategy-parameters/promotion-notifications/:id/dismiss", async (req, res) => {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "invalid id" });
    try {
      const row = await storage.dismissPromotionNotification(id);
      if (!row) return res.status(404).json({ message: "not found" });
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Backfill: historical candles + indicators per active instrument ─────
  const backfillSchema = z.object({
    days: z.number().int().min(1).max(365),
    timeframes: z.array(z.enum(["15m", "1h", "4h"])).min(1).optional(),
    symbols: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
  });

  // Lightweight guard for admin endpoints. If ADMIN_TOKEN is set in the
  // environment, callers must present it as `x-admin-token` (or
  // `Authorization: Bearer <token>`). If unset, the routes remain open
  // (matching the rest of this dev-oriented API) but a startup warning is
  // logged so operators know to lock them down before deploying.
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    log("ADMIN_TOKEN not set; /api/admin/backfill endpoints are unauthenticated. Set ADMIN_TOKEN in production.", "backfill");
  }
  const requireAdmin = (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    if (!adminToken) return next();
    const headerToken = req.header("x-admin-token");
    const auth = req.header("authorization");
    const bearer = auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
    if (headerToken === adminToken || bearer === adminToken) return next();
    return res.status(401).json({ message: "admin token required" });
  };

  app.post("/api/admin/backfill", requireAdmin, async (req, res) => {
    const parsed = backfillSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    }
    const timeframes = (parsed.data.timeframes ?? ["15m", "1h", "4h"]) as BackfillTimeframe[];
    try {
      if (parsed.data.dryRun) {
        const estimate = await estimateBackfill({ days: parsed.data.days, timeframes, symbols: parsed.data.symbols });
        return res.json({ dryRun: true, estimate });
      }
      const job = await runBackfill({ days: parsed.data.days, timeframes, symbols: parsed.data.symbols });
      res.status(202).json({ jobId: job.id, status: job.status, estimate: job.estimate, progress: job.progress });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Backfill error: ${message}`, "backfill");
      res.status(500).json({ message });
    }
  });

  app.get("/api/admin/backfill", requireAdmin, (_req, res) => {
    res.json({ jobs: listBackfillJobs() });
  });

  app.get("/api/admin/backfill/:id", requireAdmin, (req, res) => {
    const job = getBackfillJob(String(req.params.id));
    if (!job) return res.status(404).json({ message: "job not found" });
    res.json(job);
  });

  return httpServer;
}


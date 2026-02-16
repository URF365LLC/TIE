import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { runScanCycle } from "./scanner";
import { WHITELIST, canonicalToVendor } from "@shared/schema";
import { log } from "./logger";
import { z } from "zod";

const settingsUpdateSchema = z.object({
  scanEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  alertToEmail: z.string().email().optional().or(z.literal("")),
  smtpFrom: z.string().email().optional().or(z.literal("")),
  minScoreToAlert: z.number().int().min(0).max(100).optional(),
  maxSymbolsPerBurst: z.number().int().min(1).max(10).optional(),
  burstSleepMs: z.number().int().min(500).max(5000).optional(),
  alertCooldownMinutes: z.number().int().min(1).max(1440).optional(),
});

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
    if (req.query.status) filters.status = req.query.status;
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

  app.get("/api/dashboard/stats", async (_req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  });

  return httpServer;
}

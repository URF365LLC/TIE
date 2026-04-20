/**
 * Backfill MFE/MAE/time-to-resolution/regime for resolved signals that predate
 * these fields. Idempotent: only touches rows where the target fields are NULL.
 *
 * Run:   tsx scripts/backfill-excursion-regime.ts
 *        tsx scripts/backfill-excursion-regime.ts --dry-run
 *        tsx scripts/backfill-excursion-regime.ts --limit 500
 *        tsx scripts/backfill-excursion-regime.ts --window-hours 72
 *
 * --window-hours caps how far forward we scan candles when computing MFE/MAE
 * for MISSED rows (default 72). Already-WIN/LOSS rows stop at the resolving
 * candle regardless.
 */

import Decimal from "decimal.js";
import { db, pool } from "../server/db";
import { sql, and, eq, or, isNull, inArray, gte, lte } from "drizzle-orm";
import { signals, candles, indicators } from "../shared/schema";
import { computeRegime } from "../server/regime";

interface Args {
  dryRun: boolean;
  limit: number | null;
  windowHours: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: null, windowHours: 72 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--window-hours") out.windowHours = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windowMs = args.windowHours * 60 * 60 * 1000;

  // Candidates: resolved signals missing excursion metrics OR regime tag.
  // Limit the candidate set so a huge backfill can be chunked across runs.
  const rows = await db
    .select()
    .from(signals)
    .where(
      and(
        inArray(signals.outcome, ["WIN", "LOSS", "MISSED"]),
        or(
          isNull(signals.mfe),
          isNull(signals.mae),
          isNull(signals.regimeTag),
        ),
      ),
    )
    .orderBy(signals.id)
    .limit(args.limit ?? 100000);

  console.log(`[backfill] ${rows.length} candidate signal(s) (window=${args.windowHours}h, dryRun=${args.dryRun})`);

  let updated = 0;
  let skippedNoLevels = 0;
  let skippedNoCandles = 0;
  let regimeWritten = 0;
  let excursionWritten = 0;

  for (const sig of rows) {
    const reason = (sig.reasonJson ?? {}) as Record<string, any>;
    const entryRaw = reason.entryPrice;
    const tpRaw = reason.takeProfit;
    const slRaw = reason.stopLoss;

    const patch: Record<string, unknown> = {};

    // --- Regime (from stored indicators at detection time) ---
    if (sig.regimeTag == null) {
      // Find the indicator row for this signal's entry bar + the 50 preceding rows.
      const detectedMs = sig.detectedAt.getTime();
      const historyStart = new Date(detectedMs - 50 * 60 * 60 * 1000); // ~50 hours back on 15m = plenty of samples
      const recent = await db
        .select()
        .from(indicators)
        .where(
          and(
            eq(indicators.instrumentId, sig.instrumentId),
            eq(indicators.timeframe, sig.timeframe),
            gte(indicators.datetimeUtc, historyStart),
            lte(indicators.datetimeUtc, new Date(detectedMs)),
          ),
        )
        .orderBy(indicators.datetimeUtc);
      const latest = recent.length ? recent[recent.length - 1] : undefined;
      const regime = computeRegime(latest, recent);
      if (regime) {
        patch.regimeTag = regime.tag;
        patch.regimeContext = regime.context;
        regimeWritten++;
      }
    }

    // --- Excursion (MFE / MAE / time-to-resolution) ---
    if ((sig.mfe == null || sig.mae == null) && entryRaw != null && tpRaw != null && slRaw != null) {
      const tp = new Decimal(tpRaw);
      const sl = new Decimal(slRaw);
      const entry = Number(entryRaw);
      const risk = Math.abs(entry - Number(slRaw));

      const detectedMs = sig.detectedAt.getTime();
      const endMs = sig.outcome === "MISSED" || !sig.resolvedAt
        ? detectedMs + windowMs
        : sig.resolvedAt.getTime();

      const walkCandles = await db
        .select()
        .from(candles)
        .where(
          and(
            eq(candles.instrumentId, sig.instrumentId),
            eq(candles.timeframe, sig.timeframe),
            gte(candles.datetimeUtc, new Date(detectedMs)),
            lte(candles.datetimeUtc, new Date(endMs)),
          ),
        )
        .orderBy(candles.datetimeUtc);

      const relevant = walkCandles.filter((c) => c.datetimeUtc.getTime() > detectedMs);
      if (!relevant.length) {
        skippedNoCandles++;
      } else {
        let mfePrice: number | null = null;
        let maePrice: number | null = null;
        let resolvedAtMs: number | null = null;
        for (const c of relevant) {
          const highN = Number(c.high);
          const lowN = Number(c.low);
          if (sig.direction === "LONG") {
            mfePrice = mfePrice == null ? highN : Math.max(mfePrice, highN);
            maePrice = maePrice == null ? lowN : Math.min(maePrice, lowN);
          } else {
            mfePrice = mfePrice == null ? lowN : Math.min(mfePrice, lowN);
            maePrice = maePrice == null ? highN : Math.max(maePrice, highN);
          }
          const high = new Decimal(c.high);
          const low = new Decimal(c.low);
          if (sig.direction === "LONG") {
            if (low.lte(sl) || high.gte(tp)) { resolvedAtMs = c.datetimeUtc.getTime(); break; }
          } else {
            if (high.gte(sl) || low.lte(tp)) { resolvedAtMs = c.datetimeUtc.getTime(); break; }
          }
        }
        let mfe: number | null = null;
        let mae: number | null = null;
        if (mfePrice != null && maePrice != null) {
          if (sig.direction === "LONG") {
            mfe = mfePrice - entry;
            mae = maePrice - entry;
          } else {
            mfe = entry - maePrice;
            mae = entry - mfePrice;
          }
        }
        const mfeR = mfe != null && risk > 0 ? mfe / risk : null;
        const maeR = mae != null && risk > 0 ? mae / risk : null;
        if (mfe != null) patch.mfe = round6(mfe);
        if (mae != null) patch.mae = round6(mae);
        if (mfeR != null) patch.mfeR = round4(mfeR);
        if (maeR != null) patch.maeR = round4(maeR);
        if (resolvedAtMs != null) patch.timeToResolutionMs = resolvedAtMs - detectedMs;
        else if (sig.resolvedAt) patch.timeToResolutionMs = sig.resolvedAt.getTime() - detectedMs;
        if (mfe != null || mae != null) excursionWritten++;
      }
    } else if (entryRaw == null || tpRaw == null || slRaw == null) {
      skippedNoLevels++;
    }

    if (Object.keys(patch).length === 0) continue;

    if (args.dryRun) {
      console.log(`[dry] signal ${sig.id} ${sig.direction} ${sig.outcome}`, patch);
    } else {
      await db.update(signals).set(patch).where(eq(signals.id, sig.id));
    }
    updated++;
  }

  console.log(JSON.stringify({ updated, regimeWritten, excursionWritten, skippedNoLevels, skippedNoCandles, dryRun: args.dryRun }, null, 2));
  await pool.end();
}

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }
function round4(n: number): number { return Math.round(n * 1e4) / 1e4; }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

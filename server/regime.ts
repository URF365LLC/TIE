import type { Indicator } from "@shared/schema";

export type RegimeTag = "TRENDING" | "CHOPPY" | "HIGH_VOL" | "MIXED";

export interface RegimeContext {
  adx: number;
  bbWidthPct: number | null;
  atr: number | null;
}

export interface RegimeSnapshot {
  tag: RegimeTag;
  context: RegimeContext;
}

const TRENDING_ADX = 22;
const CHOPPY_ADX = 18;
const HIGH_VOL_BB_PCT = 80;
const LOW_VOL_BB_PCT = 30;
const MIN_BB_HISTORY = 10;

// Classifies the market regime at signal detection from a single entry-timeframe
// indicator row plus its recent history (used for a BB-width percentile).
// Returns null if the minimum inputs are missing — caller should leave the
// regime fields unset in that case rather than writing a misleading tag.
export function computeRegime(latest: Indicator | undefined, history: Indicator[]): RegimeSnapshot | null {
  if (!latest || latest.adx == null) return null;
  const adx = latest.adx;

  const widths = history
    .map((i) => i.bbWidth)
    .filter((w): w is number => w != null);
  const bbWidthPct = widths.length >= MIN_BB_HISTORY && latest.bbWidth != null
    ? percentile(widths, latest.bbWidth)
    : null;

  let tag: RegimeTag;
  if (bbWidthPct != null && bbWidthPct >= HIGH_VOL_BB_PCT) {
    tag = "HIGH_VOL";
  } else if (adx >= TRENDING_ADX) {
    tag = "TRENDING";
  } else if (adx < CHOPPY_ADX && (bbWidthPct == null || bbWidthPct <= LOW_VOL_BB_PCT)) {
    tag = "CHOPPY";
  } else {
    tag = "MIXED";
  }

  return {
    tag,
    context: {
      adx: round(adx, 2),
      bbWidthPct: bbWidthPct != null ? round(bbWidthPct, 1) : null,
      atr: latest.atr != null ? round(latest.atr, 6) : null,
    },
  };
}

function percentile(values: number[], target: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  let below = 0;
  for (const v of sorted) {
    if (v < target) below++;
    else break;
  }
  return (below / sorted.length) * 100;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

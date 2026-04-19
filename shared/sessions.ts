/**
 * Canonical session-of-day bucketing. Used by both the live analytics SQL
 * (storage.ts) and the replay engine (replay.ts) so a signal is always
 * attributed to the same session regardless of code path.
 *
 * Hours are UTC. Thresholds follow major FX session overlaps:
 *   Asia       00:00–06:59
 *   London     07:00–12:59
 *   NY-Overlap 13:00–16:59   (London/NY overlap, highest volume)
 *   NY         17:00–21:59
 *   Off        22:00–23:59
 */
export type SessionKey = "Asia" | "London" | "NY-Overlap" | "NY" | "Off";

export const SESSION_KEYS: readonly SessionKey[] = ["Asia", "London", "NY-Overlap", "NY", "Off"];

export function sessionForHour(hourUtc: number): SessionKey {
  if (hourUtc < 7) return "Asia";
  if (hourUtc < 13) return "London";
  if (hourUtc < 17) return "NY-Overlap";
  if (hourUtc < 22) return "NY";
  return "Off";
}

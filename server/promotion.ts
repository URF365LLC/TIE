import nodemailer from "nodemailer";
import { storage } from "./storage";
import { log } from "./logger";
import type { Settings } from "@shared/schema";

export interface PromotionRecommendation {
  paramSetId: number;
  version: number;
  name: string;
  comparison: {
    windowDays: number;
    activeVersion: number | null;
    activeName: string | null;
    activeWins: number;
    activeLosses: number;
    activeTotal: number;
    activeWinRate: number | null;
    shadowWins: number;
    shadowLosses: number;
    shadowTotal: number;
    shadowWinRate: number;
    deltaPp: number;
    zScore: number;
    pValue: number;
    minSampleSize: number;
    minDeltaPp: number;
    maxPValue: number;
  };
  summary: string;
}

export interface PromotionRecommendationsResult {
  windowDays: number;
  thresholds: { minSampleSize: number; minDeltaPp: number; maxPValue: number };
  active: { paramSetId: number; version: number; name: string; total: number; winRate: number | null } | null;
  recommendations: PromotionRecommendation[];
}

export const DEFAULT_PROMOTION_THRESHOLDS = {
  windowDays: 30,
  minSampleSize: 20,
  minDeltaPp: 5,
  maxPValue: 0.05,
};

export async function computePromotionRecommendations(opts: {
  windowDays?: number;
  minSampleSize?: number;
  minDeltaPp?: number;
  maxPValue?: number;
} = {}): Promise<PromotionRecommendationsResult> {
  const windowDays = opts.windowDays ?? DEFAULT_PROMOTION_THRESHOLDS.windowDays;
  const minSampleSize = opts.minSampleSize ?? DEFAULT_PROMOTION_THRESHOLDS.minSampleSize;
  const minDeltaPp = opts.minDeltaPp ?? DEFAULT_PROMOTION_THRESHOLDS.minDeltaPp;
  const maxPValue = opts.maxPValue ?? DEFAULT_PROMOTION_THRESHOLDS.maxPValue;

  const rows = await storage.getRollingWinRateByParamSet(windowDays);
  const active = rows.find((r) => r.status === "active");
  const recommendations: PromotionRecommendation[] = [];

  if (active && active.total >= minSampleSize) {
    for (const r of rows) {
      if (r.paramSetId === active.paramSetId) continue;
      if (r.status !== "shadow") continue;
      if (r.total < minSampleSize) continue;
      if (r.winRate == null || active.winRate == null) continue;
      const deltaPp = r.winRate - active.winRate;
      if (deltaPp < minDeltaPp) continue;
      const z = twoProportionZ(r.wins, r.total, active.wins, active.total);
      if (!Number.isFinite(z) || z <= 0) continue;
      const pValue = 1 - normCdf(z);
      if (pValue > maxPValue) continue;
      const summary = `v${r.version} (${r.name}) shadow win rate ${r.winRate.toFixed(1)}% beats active v${active.version} ${active.winRate.toFixed(1)}% by ${deltaPp.toFixed(1)}pp over ${r.total} resolved signals (vs ${active.total}) in the last ${windowDays}d (p=${pValue.toFixed(3)}).`;
      recommendations.push({
        paramSetId: r.paramSetId,
        version: r.version,
        name: r.name,
        comparison: {
          windowDays,
          activeVersion: active.version,
          activeName: active.name,
          activeWins: active.wins,
          activeLosses: active.losses,
          activeTotal: active.total,
          activeWinRate: active.winRate,
          shadowWins: r.wins,
          shadowLosses: r.losses,
          shadowTotal: r.total,
          shadowWinRate: r.winRate,
          deltaPp,
          zScore: z,
          pValue,
          minSampleSize,
          minDeltaPp,
          maxPValue,
        },
        summary,
      });
    }
    recommendations.sort((a, b) => b.comparison.deltaPp - a.comparison.deltaPp);
  }

  return {
    windowDays,
    thresholds: { minSampleSize, minDeltaPp, maxPValue },
    active: active
      ? { paramSetId: active.paramSetId, version: active.version, name: active.name, total: active.total, winRate: active.winRate }
      : null,
    recommendations,
  };
}

// Evaluate the latest recommendations and, for any that have no existing
// notification row yet, create one and (best-effort) send an email. The unique
// constraint on promotion_notifications.paramSetId is what enforces throttling
// across scanner ticks and process restarts.
export async function evaluatePromotionsAndNotify(settings: Settings): Promise<{ created: number; emailed: number; reminded: number }> {
  let result;
  try {
    result = await computePromotionRecommendations({
      minSampleSize: settings.promotionMinSamples,
      minDeltaPp: settings.promotionMinDeltaPp,
      maxPValue: settings.promotionMaxPValue,
    });
  } catch (err: any) {
    log(`Promotion evaluation failed: ${err.message}`, "promotion");
    return { created: 0, emailed: 0, reminded: 0 };
  }

  const reminderDays = Math.max(1, settings.promotionReminderDays ?? 3);
  const maxReminders = Math.max(0, settings.promotionMaxReminders ?? 3);
  const reminderIntervalMs = reminderDays * 24 * 60 * 60 * 1000;

  let created = 0;
  let emailed = 0;
  let reminded = 0;
  for (const rec of result.recommendations) {
    const existing = await storage.getPromotionNotificationByParamSetId(rec.paramSetId);
    if (existing) {
      // The recommendation still applies (we are iterating over current
      // recommendations) and the row has not been dismissed → consider sending
      // a reminder. We only send reminders when the original email actually
      // went out, when SMTP is currently configured, and when the configured
      // cadence + max-reminder cap allow it.
      if (existing.dismissedAt) continue;
      if (!settings.emailEnabled) continue;
      if (maxReminders <= 0) continue;
      if (existing.reminderCount >= maxReminders) continue;
      const lastSentAt = existing.lastReminderAt ?? existing.emailedAt;
      if (!lastSentAt) continue; // never successfully emailed → nothing to remind
      const elapsed = Date.now() - new Date(lastSentAt).getTime();
      if (elapsed < reminderIntervalMs) continue;

      const reminderNumber = existing.reminderCount + 1;
      try {
        const sent = await sendPromotionEmail(rec, settings, {
          reminderNumber,
          maxReminders,
        });
        if (sent.sent) {
          await storage.recordPromotionNotificationReminder(existing.id, {
            emailStatus: "sent",
            emailError: null,
            lastReminderAt: new Date(),
          });
          reminded++;
          emailed++;
          log(
            `Promotion reminder ${reminderNumber}/${maxReminders} sent for v${rec.version} (${rec.name})`,
            "promotion",
          );
        } else {
          log(
            `Promotion reminder skipped for v${rec.version}: ${sent.reason ?? "unknown"}`,
            "promotion",
          );
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Intentionally do NOT advance reminderCount/lastReminderAt on
        // failure — otherwise transient SMTP errors would consume the
        // user's max-reminder budget and delay the next attempt by a full
        // cadence. The next scanner tick will retry.
        log(`Promotion reminder failed for v${rec.version}: ${msg}`, "promotion");
      }
      continue;
    }

    let emailStatus: "sent" | "skipped" | "error" = "skipped";
    let emailError: string | null = null;
    let emailedAt: Date | null = null;

    if (settings.emailEnabled) {
      try {
        const sent = await sendPromotionEmail(rec, settings);
        if (sent.sent) {
          emailStatus = "sent";
          emailedAt = new Date();
          emailed++;
        } else {
          emailStatus = "skipped";
          emailError = sent.reason ?? null;
        }
      } catch (err: any) {
        emailStatus = "error";
        emailError = err?.message ?? String(err);
        log(`Promotion email failed for v${rec.version}: ${emailError}`, "promotion");
      }
    }

    try {
      await storage.createPromotionNotification({
        paramSetId: rec.paramSetId,
        paramSetVersion: rec.version,
        summary: rec.summary,
        comparisonJson: rec.comparison as unknown as Record<string, unknown>,
        emailStatus,
        emailError,
        emailedAt,
        dismissedAt: null,
      });
      created++;
      log(`Promotion notification created for v${rec.version} (${rec.name}) emailStatus=${emailStatus}`, "promotion");
    } catch (err: any) {
      // Most likely a unique-constraint race; safe to ignore.
      log(`Promotion notification insert race for paramSetId=${rec.paramSetId}: ${err.message}`, "promotion");
    }
  }

  return { created, emailed, reminded };
}

let promotionTransporter: nodemailer.Transporter | null = null;
function getPromotionTransporter(): nodemailer.Transporter | null {
  if (promotionTransporter) return promotionTransporter;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) return null;
  promotionTransporter = nodemailer.createTransport({
    host,
    port: parseInt(port),
    secure: parseInt(port) === 465,
    auth: { user, pass },
  });
  return promotionTransporter;
}

async function sendPromotionEmail(
  rec: PromotionRecommendation,
  settings: Settings,
  reminder?: { reminderNumber: number; maxReminders: number },
): Promise<{ sent: boolean; reason?: string }> {
  const mailer = getPromotionTransporter();
  const toEmail = settings.alertToEmail || process.env.ALERT_TO_EMAIL;
  const fromEmail = settings.smtpFrom || process.env.SMTP_FROM_EMAIL;
  if (!mailer || !toEmail || !fromEmail) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const c = rec.comparison;
  const reminderTag = reminder
    ? `[Reminder ${reminder.reminderNumber}/${reminder.maxReminders}] `
    : "";
  const subject = `${reminderTag}[Promotion Recommended] v${rec.version} ${rec.name} - +${c.deltaPp.toFixed(1)}pp win rate`;
  const reminderPreamble = reminder
    ? `This is reminder ${reminder.reminderNumber} of ${reminder.maxReminders}: an earlier promotion recommendation is still pending review.\n\n`
    : "";
  const body = `
${reminderPreamble}A shadow parameter set has crossed the auto-promotion threshold.

Recommended: v${rec.version} (${rec.name})
  Win rate: ${c.shadowWinRate.toFixed(1)}% (${c.shadowWins}W / ${c.shadowLosses}L of ${c.shadowTotal})

Active baseline: v${c.activeVersion ?? "?"} ${c.activeName ?? ""}
  Win rate: ${c.activeWinRate != null ? c.activeWinRate.toFixed(1) + "%" : "n/a"} (${c.activeWins}W / ${c.activeLosses}L of ${c.activeTotal})

Edge: +${c.deltaPp.toFixed(1)}pp over the last ${c.windowDays} days
Significance: z=${c.zScore.toFixed(2)}, p=${c.pValue.toFixed(3)} (threshold p<${c.maxPValue})

${rec.summary}

Open the parameter history page to promote with one click:
/parameters

---
Trading Intelligence Engine
  `.trim();

  await mailer.sendMail({ from: fromEmail, to: toEmail, subject, text: body });
  return { sent: true };
}

// One-sided two-proportion z-test (pooled variance) comparing shadow vs active.
function twoProportionZ(winsA: number, totalA: number, winsB: number, totalB: number): number {
  if (totalA <= 0 || totalB <= 0) return NaN;
  const pA = winsA / totalA;
  const pB = winsB / totalB;
  const pPool = (winsA + winsB) / (totalA + totalB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / totalA + 1 / totalB));
  if (se === 0) return NaN;
  return (pA - pB) / se;
}

function normCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = d * poly;
  return 0.5 + sign * (0.5 - tail);
}

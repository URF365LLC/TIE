import nodemailer from "nodemailer";
import { storage } from "./storage";
import { log } from "./logger";
import type { Signal, Instrument, Settings } from "@shared/schema";

let transporter: nodemailer.Transporter | null = null;

export function safeString(value: unknown, max = 300): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}

export function formatAlertEmail(
  signal: Signal,
  instrument: Instrument,
  reasonJson: Record<string, any>
): { subject: string; body: string } {
  const subject = safeString(
    `[Signal] ${signal.direction} ${instrument.canonicalSymbol} - ${signal.strategy} (Score: ${signal.score})`,
    500
  );

  const reasons = Object.entries(reasonJson)
    .map(([k, v]) => `  - ${safeString(k, 60)}: ${safeString(v, 300)}`)
    .join("\n");

  const body = `
Trading Signal Detected
=======================

Symbol: ${safeString(instrument.canonicalSymbol, 40)} (${safeString(instrument.vendorSymbol, 60)})
Direction: ${safeString(signal.direction, 10)}
Strategy: ${safeString(signal.strategy, 60)}
Timeframe: ${safeString(signal.timeframe, 10)}
Score: ${signal.score}/100
Detected: ${new Date(signal.detectedAt).toUTCString()}

Reasoning:
${reasons}

---
Trading Intelligence Engine
  `.trim();

  return { subject, body };
}

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(port),
    secure: parseInt(port) === 465,
    auth: { user, pass },
  });

  return transporter;
}

export async function sendSignalAlert(
  signal: Signal,
  instrument: Instrument,
  reasonJson: Record<string, any>,
  settings: Settings
): Promise<void> {
  const mailer = getTransporter();
  const toEmail = settings.alertToEmail || process.env.ALERT_TO_EMAIL;
  const fromEmail = settings.smtpFrom || process.env.SMTP_FROM_EMAIL;

  if (!mailer || !toEmail || !fromEmail) {
    log(`Email alert skipped for ${instrument.canonicalSymbol} - SMTP not configured`, "alerter");
    return;
  }

  const { subject, body } = formatAlertEmail(signal, instrument, reasonJson);

  try {
    await mailer.sendMail({
      from: fromEmail,
      to: toEmail,
      subject,
      text: body,
    });

    await storage.createAlertEvent({
      signalId: signal.id,
      channel: "EMAIL",
      to: toEmail,
      subject,
      status: "sent",
    });

    await storage.updateSignalStatus(signal.id, "ALERTED");
    log(`Alert sent for ${instrument.canonicalSymbol} ${signal.direction}`, "alerter");
  } catch (err: any) {
    await storage.createAlertEvent({
      signalId: signal.id,
      channel: "EMAIL",
      to: toEmail,
      subject,
      status: "error",
      error: err.message,
    });
    log(`Alert send failed: ${err.message}`, "alerter");
  }
}

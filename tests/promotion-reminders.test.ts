import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";

// Stub SMTP env + nodemailer transporter BEFORE importing promotion.ts so that
// getPromotionTransporter() picks up our fake on first call.
process.env.SMTP_HOST = "localhost";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "u";
process.env.SMTP_PASS = "p";

let sendMailImpl: (opts: any) => Promise<any> = async () => ({ messageId: "ok" });
let sendMailCalls: any[] = [];
const fakeTransporter: any = {
  sendMail: async (opts: any) => {
    sendMailCalls.push(opts);
    return sendMailImpl(opts);
  },
};
(nodemailer as any).createTransport = () => fakeTransporter;

import { storage } from "../server/storage";
import { evaluatePromotionsAndNotify } from "../server/promotion";
import type { Settings, PromotionNotification } from "@shared/schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    scanEnabled: true,
    emailEnabled: true,
    alertToEmail: "to@example.com",
    smtpFrom: "from@example.com",
    minScoreToAlert: 60,
    quietHoursJson: null,
    maxSymbolsPerBurst: 4,
    burstSleepMs: 1000,
    alertCooldownMinutes: 60,
    accountBalance: 50000,
    riskPercent: 1.0,
    signalEvalWindowHours: 4,
    tdCreditLimitPerMin: 377,
    tdCreditTargetPerMin: 340,
    tdMaxConcurrency: 3,
    promotionMinSamples: 20,
    promotionMinDeltaPp: 5,
    promotionMaxPValue: 0.05,
    promotionReminderDays: 3,
    promotionMaxReminders: 3,
    ...overrides,
  } as Settings;
}

function makeNotification(overrides: Partial<PromotionNotification> = {}): PromotionNotification {
  return {
    id: 42,
    paramSetId: 7,
    paramSetVersion: 2,
    summary: "summary",
    comparisonJson: {},
    emailStatus: "sent",
    emailError: null,
    emailedAt: new Date("2024-01-01T00:00:00Z"),
    dismissedAt: null,
    reminderCount: 0,
    lastReminderAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  } as PromotionNotification;
}

// Stub the rolling win-rate query so computePromotionRecommendations always
// produces exactly one recommendation for paramSetId=7.
function stubWinRateRows() {
  return [
    {
      paramSetId: 1,
      version: 1,
      name: "active-set",
      status: "active",
      total: 100,
      wins: 50,
      losses: 50,
      winRate: 50,
    },
    {
      paramSetId: 7,
      version: 2,
      name: "shadow-set",
      status: "shadow",
      total: 100,
      wins: 70,
      losses: 30,
      winRate: 70,
    },
  ];
}

interface Stubs {
  getNotification: (paramSetId: number) => Promise<PromotionNotification | undefined>;
  recordReminder?: (id: number, data: any) => Promise<PromotionNotification | undefined>;
  createNotification?: (data: any) => Promise<PromotionNotification>;
}

function installStubs(stubs: Stubs) {
  const orig = {
    getRollingWinRateByParamSet: storage.getRollingWinRateByParamSet,
    getPromotionNotificationByParamSetId: storage.getPromotionNotificationByParamSetId,
    createPromotionNotification: storage.createPromotionNotification,
    recordPromotionNotificationReminder: storage.recordPromotionNotificationReminder,
  };
  (storage as any).getRollingWinRateByParamSet = async () => stubWinRateRows();
  (storage as any).getPromotionNotificationByParamSetId = stubs.getNotification;
  (storage as any).createPromotionNotification =
    stubs.createNotification ?? (async (data: any) => ({ id: 1, ...data, createdAt: new Date() }));
  (storage as any).recordPromotionNotificationReminder =
    stubs.recordReminder ?? (async (_id: number, _data: any) => undefined);
  return () => {
    Object.assign(storage, orig);
  };
}

function resetSendMail() {
  sendMailCalls = [];
  sendMailImpl = async () => ({ messageId: "ok" });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("reminder is skipped when cadence has not yet elapsed", async () => {
  resetSendMail();
  const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({ emailedAt: recent, lastReminderAt: recent, reminderCount: 1 }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(
      makeSettings({ promotionReminderDays: 3 }),
    );
    assert.equal(res.reminded, 0);
    assert.equal(res.emailed, 0);
    assert.equal(res.created, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 0);
  } finally {
    restore();
  }
});

test("reminder is skipped once max-reminder cap is reached", async () => {
  resetSendMail();
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({ emailedAt: long_ago, lastReminderAt: long_ago, reminderCount: 3 }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(
      makeSettings({ promotionMaxReminders: 3 }),
    );
    assert.equal(res.reminded, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 0);
  } finally {
    restore();
  }
});

test("dismissal halts further reminders", async () => {
  resetSendMail();
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({
        emailedAt: long_ago,
        lastReminderAt: long_ago,
        reminderCount: 0,
        dismissedAt: new Date(),
      }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(makeSettings());
    assert.equal(res.reminded, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 0);
  } finally {
    restore();
  }
});

test("emailEnabled=false suppresses reminders", async () => {
  resetSendMail();
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({ emailedAt: long_ago, lastReminderAt: long_ago, reminderCount: 0 }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(makeSettings({ emailEnabled: false }));
    assert.equal(res.reminded, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 0);
  } finally {
    restore();
  }
});

test("never-emailed notifications are skipped (no reminder when emailedAt and lastReminderAt are null)", async () => {
  resetSendMail();
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({
        emailedAt: null,
        lastReminderAt: null,
        emailStatus: "skipped",
        reminderCount: 0,
      }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(makeSettings());
    assert.equal(res.reminded, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 0);
  } finally {
    restore();
  }
});

test("eligible notification advances reminderCount and lastReminderAt", async () => {
  resetSendMail();
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recordArgs: Array<{ id: number; data: any }> = [];
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({
        id: 99,
        emailedAt: long_ago,
        lastReminderAt: null,
        reminderCount: 0,
      }),
    recordReminder: async (id, data) => {
      recordArgs.push({ id, data });
      return undefined;
    },
  });
  try {
    const before = Date.now();
    const res = await evaluatePromotionsAndNotify(
      makeSettings({ promotionReminderDays: 3, promotionMaxReminders: 3 }),
    );
    const after = Date.now();
    assert.equal(res.reminded, 1);
    assert.equal(res.emailed, 1);
    assert.equal(res.created, 0);
    assert.equal(recordArgs.length, 1);
    assert.equal(recordArgs[0].id, 99);
    assert.equal(recordArgs[0].data.emailStatus, "sent");
    assert.equal(recordArgs[0].data.emailError, null);
    const ts = recordArgs[0].data.lastReminderAt as Date;
    assert.ok(ts instanceof Date);
    assert.ok(ts.getTime() >= before && ts.getTime() <= after);
    assert.equal(sendMailCalls.length, 1);
    assert.match(sendMailCalls[0].subject, /Reminder 1\/3/);
  } finally {
    restore();
  }
});

test("transient SMTP failure does NOT consume reminder budget", async () => {
  resetSendMail();
  sendMailImpl = async () => {
    throw new Error("smtp down");
  };
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let recordCalled = false;
  const restore = installStubs({
    getNotification: async () =>
      makeNotification({
        emailedAt: long_ago,
        lastReminderAt: long_ago,
        reminderCount: 1,
      }),
    recordReminder: async () => {
      recordCalled = true;
      return undefined;
    },
  });
  try {
    const res = await evaluatePromotionsAndNotify(makeSettings());
    assert.equal(res.reminded, 0);
    assert.equal(res.emailed, 0);
    assert.equal(recordCalled, false);
    assert.equal(sendMailCalls.length, 1);
  } finally {
    restore();
    resetSendMail();
  }
});

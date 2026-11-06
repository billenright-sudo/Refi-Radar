"use strict";
// /api/billing: what the client asks about billing (spec §6.2, §6.5). This router is NOT behind the access gate: a locked brokerage
// still reads its status, adds a card and takes its clients out (H11). The Stripe webhook is its own router (billingWebhook.js).
//   GET  /public      (no sign-in) -> { enabled }
//   GET  /status      (signed in)  -> { success, access, role, billing }: `billing` is null for a loan officer (they never see a price
//                                    or a Stripe detail), { enabled: false } for a broker while billing is off, else the brokerage's
//                                    plan (see brokerView). Before answering it repairs a state that may be stale (H4): a Checkout
//                                    still pending is read back from Stripe (the broker is back before the webhook), a subscription
//                                    not synced for 24 hours (or never) is read again, then the user count is put back if it differs
//                                    (H2) and a recorded second subscription is retried (H1). None of that can fail the request,
//                                    and a Stripe that doesn't answer holds it up for 8 seconds at most.
//   POST /card        (broker)     -> { url }: a live subscription -> Stripe's portal, straight to its card form (also for a tester's
//                                    card-less month: a Checkout would make a second subscription); a still-open pending Checkout ->
//                                    the same page again (H1); else a new Checkout for the user count, remembered as pending.
//                                    409 { success: false, error: "This account has no charge." } for an exempt brokerage (I1).
//   POST /portal      (broker)     -> { url }: Stripe's customer portal (card, invoices, cancel); 409 before there is a customer.
//                                    Open to an exempt brokerage too (invoices from before, a card to take off).
//   GET  /export.csv  (broker)     -> every client of the brokerage as CSV; open with billing off and while locked (H11).
// Billing off: 404 on /card and /portal; /public says so and /status lets everyone in. A loan officer: 403 on /card, /portal and
// /export.csv. Stripe unreachable: 502 { success: false, error: "Couldn't reach the payment service. Please try again." }.
// Logs carry our organization id and an error's message only: never a Stripe object, an address or a key.
const express = require("express");
const db = require("../db");
const email = require("../email");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { orgBilling, accessFor, bannerFor } = require("../lib/billing/access");
const { checkoutPlan } = require("../lib/billing/plan");
const { seatCount, syncSeats } = require("../lib/billing/seats");
const { storeSubscription } = require("../lib/billing/events");
const { runFollowUps, retryPendingDuplicate } = require("../lib/billing/followUps");
const { BASE_CENTS, ADDITIONAL_CENTS, STALE_MS, monthlyTotalCents } = require("../lib/billing/config");
const { termsCurrent } = require("../lib/terms");

const router = express.Router();

const LIVE = new Set(["trialing", "active", "past_due"]);
// How long the status call waits for its repair before answering from what is stored (the repair carries on and lands for the next
// call). The client asks for the status before it shows the app, and one Stripe call can take a minute with the SDK's retries.
// app.set("billingRepairWaitMs", n) overrides it (tests).
const REPAIR_WAIT_MS = 8_000;
const NOT_FOUND = Object.freeze({ success: false, error: "Not found" });
const UNREACHABLE = Object.freeze({ success: false, error: "Couldn't reach the payment service. Please try again." });
const NO_CUSTOMER = Object.freeze({ success: false, error: "There's no billing account to manage yet." });
const NO_CHARGE = Object.freeze({ success: false, error: "This account has no charge." });
const returnUrl = (outcome) => `${email.APP_URL}/?billing=${outcome}`;

// Billing is on when start-up switched it on and put the gateway on the app (index.js), the webhook's rule too.
function billingOf(req) {
  const config = req.app.get("billingConfig");
  const gateway = req.app.get("billingGateway");
  const send = req.app.get("sendBillingConfirmation") || email.sendBillingConfirmation;
  return { config, gateway, send, on: Boolean(config && config.enabled && gateway) };
}
const billingOn = (req, res, next) => (billingOf(req).on ? next() : res.status(404).json(NOT_FOUND));

// A subscription read from Stripe counts as of its whole second: Stripe's event times are whole seconds, and an event from the same
// second as the read must still apply (only a strictly older one is ignored).
const readAt = (nowMs) => Math.floor(nowMs / 1000) * 1000;
const isLive = (org) => Boolean(org.stripe_subscription_id && LIVE.has(org.billing_status));

// Concurrent calls for one organization share one piece of work (two tabs: one Checkout, one re-read). One instance runs.
function sharedPerOrg() {
  const running = new Map();
  return (orgId, work) => {
    if (running.has(orgId)) return running.get(orgId);
    const p = Promise.resolve().then(work).finally(() => running.delete(orgId));
    running.set(orgId, p);
    return p;
  };
}
const cardOnce = sharedPerOrg();
const repairOnce = sharedPerOrg();

// Stripe has no such object: its SDK says resource_missing (HTTP 404).
const missingAtStripe = (err) => err?.code === "resource_missing" || err?.statusCode === 404 || err?.status === 404;

// The organization's pending Checkout, read back from Stripe. A finished one stores its subscription (the same rules as the webhook)
// and is forgotten; an expired one is forgotten; an open one is kept, to be shown again. One Stripe doesn't have at all (a test-mode
// Checkout once live keys are in, say) can never finish, so it is forgotten too (status "missing"), and the broker gets a new one
// rather than an error for ever. -> { session, followUps }. Any other failure throws, leaving the pending Checkout in place to be
// read next time (and no second Checkout is made meanwhile).
async function settleCheckout(gateway, org, nowMs) {
  const id = org.billing_pending_checkout;
  const forget = () => db.prepare("UPDATE organizations SET billing_pending_checkout = NULL WHERE id = ? AND billing_pending_checkout = ?").run(org.id, id);
  let session;
  try {
    session = await gateway.retrieveCheckout(id);
  } catch (err) {
    if (!missingAtStripe(err)) throw err;
    forget();
    console.warn(`[billing] the pending Checkout for org ${org.id} doesn't exist at Stripe: forgotten`);
    return { session: { status: "missing" }, followUps: [] };
  }
  let followUps = [];
  if (session.status === "complete" && session.subscriptionId) {
    const subscription = await gateway.retrieveSubscription(session.subscriptionId);
    followUps = storeSubscription(db, org.id, subscription, readAt(nowMs), nowMs);
  }
  if (session.status === "complete" || session.status === "expired") forget();
  return { session, followUps };
}

// The stale-state repair (H4) behind the status call. Never throws: each step's failure is logged and the rest still run.
async function repair({ config, gateway, send }, orgId, nowMs) {
  let org = orgBilling(db, orgId);
  if (!org) return;
  const followUps = [];
  if (org.billing_pending_checkout) {
    try {
      followUps.push(...(await settleCheckout(gateway, org, nowMs)).followUps);
    } catch (err) {
      console.error(`[billing] checkout sync failed for org ${orgId}:`, err?.message);
    }
    org = orgBilling(db, orgId);
  }
  if (org.stripe_subscription_id && (org.billing_synced_at == null || nowMs - org.billing_synced_at > STALE_MS)) {
    try {
      const subscription = await gateway.retrieveSubscription(org.stripe_subscription_id);
      followUps.push(...storeSubscription(db, orgId, subscription, readAt(nowMs), nowMs));
    } catch (err) {
      console.error(`[billing] subscription sync failed for org ${orgId}:`, err?.message);
    }
  }
  // The confirmation email a missed webhook still owes (H6) and any second subscription just found (H1); the user count below.
  await runFollowUps({ db, gateway, send, config }, followUps.filter((f) => f.type !== "sync_seats"));
  try {
    await syncSeats(db, gateway, orgId);
  } catch (err) {
    console.error(`[billing] sync_seats failed for org ${orgId}:`, err?.message);
  }
  if (!followUps.some((f) => f.type === "cancel_duplicate")) {
    try {
      await retryPendingDuplicate(db, gateway, orgId);   // its first read is outside its own try
    } catch (err) {
      console.error(`[billing] cancel_duplicate failed for org ${orgId}:`, err?.message);
    }
  }
}

// The Billing page's facts, for the broker only. Times are epoch ms (or null).
function brokerView(org, nowMs) {
  const users = seatCount(db, org.id);
  return {
    enabled: true,
    status: org.billing_status ?? "none",
    users,
    baseCents: BASE_CENTS,
    additionalCents: ADDITIONAL_CENTS,
    monthlyTotalCents: monthlyTotalCents(Math.max(1, users)),
    trialEnd: org.billing_trial_end ?? null,
    testerUntil: org.billing_tester_until ?? null,
    periodEnd: org.billing_period_end ?? null,
    cancelAtPeriodEnd: Boolean(org.billing_cancel_at_period_end),
    exempt: Boolean(org.billing_exempt),
    hasCustomer: Boolean(org.stripe_customer_id),
    banner: bannerFor(org, nowMs),
  };
}

router.get("/public", (req, res) => {
  res.json({ enabled: billingOf(req).on });
});

router.get("/status", requireAuth, async (req, res) => {
  const billing = billingOf(req);
  const role = req.user.role;
  if (!billing.on) return res.json({ success: true, access: { ok: true }, role, billing: role === "broker" ? { enabled: false } : null });
  const orgId = req.user.org_id;
  let timer;
  await Promise.race([
    repairOnce(orgId, () => repair(billing, orgId, Date.now()))
      .catch((err) => console.error(`[billing] status sync failed for org ${orgId}:`, err?.message)),
    new Promise((resolve) => { timer = setTimeout(resolve, req.app.get("billingRepairWaitMs") ?? REPAIR_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  try {
    const nowMs = Date.now();
    const org = orgBilling(db, req.user.org_id);
    const access = org
      ? accessFor({ config: billing.config, org, termsOk: termsCurrent(db, req.user.id), nowMs })
      : { ok: false, reason: "needs_card" };
    res.json({ success: true, access, role, billing: role === "broker" && org ? brokerView(org, nowMs) : null });
  } catch (err) {
    console.error("GET /api/billing/status:", err?.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// Where "Add card" / "Update card" / "Restart subscription" goes. See the header for the three cases.
async function cardUrl({ config, gateway, send }, user, nowMs) {
  let org = orgBilling(db, user.org_id);
  if (!isLive(org) && org.billing_pending_checkout) {
    const { session, followUps } = await settleCheckout(gateway, org, nowMs);
    if (session.status === "open" && session.url) return session.url;
    await runFollowUps({ db, gateway, send, config }, followUps);
    org = orgBilling(db, user.org_id);
  }
  if (isLive(org)) {
    if (!org.stripe_customer_id) throw new Error("a live subscription with no customer on file");
    return (await gateway.createPortal({ customerId: org.stripe_customer_id, returnUrl: returnUrl("done"), updateCard: true })).url;
  }
  const session = await gateway.createCheckout({
    customerId: org.stripe_customer_id || null,
    email: user.email,
    orgId: org.id,
    priceId: config.priceId,
    quantity: Math.max(1, seatCount(db, org.id)),
    plan: checkoutPlan(org, nowMs),
    successUrl: returnUrl("done"),
    cancelUrl: returnUrl("cancelled"),
  });
  db.prepare("UPDATE organizations SET billing_pending_checkout = ? WHERE id = ?").run(session.id, org.id);
  return session.url;
}

router.post("/card", requireAuth, billingOn, requireBroker, async (req, res) => {
  const orgId = req.user.org_id;
  try {
    // An exempt brokerage is never charged, so it is never sent to a card page (I1).
    if (orgBilling(db, orgId)?.billing_exempt) return res.status(409).json(NO_CHARGE);
    const url = await cardOnce(orgId, () => cardUrl(billingOf(req), req.user, Date.now()));
    res.json({ url });
  } catch (err) {
    console.error(`[billing] card failed for org ${orgId}:`, err?.message);
    res.status(502).json(UNREACHABLE);
  }
});

router.post("/portal", requireAuth, billingOn, requireBroker, async (req, res) => {
  const orgId = req.user.org_id;
  try {
    const org = orgBilling(db, orgId);
    if (!org?.stripe_customer_id) return res.status(409).json(NO_CUSTOMER);
    const { url } = await billingOf(req).gateway.createPortal({ customerId: org.stripe_customer_id, returnUrl: returnUrl("done"), updateCard: false });
    res.json({ url });
  } catch (err) {
    console.error(`[billing] portal failed for org ${orgId}:`, err?.message);
    res.status(502).json(UNREACHABLE);
  }
});

// ── The client export (H11): the client list's fields, plus who each client belongs to, for the whole brokerage.
const LOAN_LABELS = { "30yr_fixed": "30-Yr Fixed", "15yr_fixed": "15-Yr Fixed", "5_1_arm": "5/1 ARM" };   // as the app shows them
const COLUMNS = [
  ["Name", (r) => r.name],
  ["Email", (r) => r.email],
  ["Phone", (r) => r.phone],
  ["Loan type", (r) => LOAN_LABELS[r.loan_type] ?? r.loan_type],
  ["Current rate", (r) => r.current_rate],
  ["Loan balance", (r) => r.loan_balance],
  ["Property value", (r) => r.property_value],
  ["Close date", (r) => r.close_date],
  ["Credit score", (r) => r.credit_score],
  ["Last contact", (r) => r.last_contact],
  ["Notes", (r) => r.notes],
  ["Loan number", (r) => r.loan_number],
  ["Loan officer", (r) => [r.lo_first_name, r.lo_last_name].filter(Boolean).join(" ")],
  ["Loan officer email", (r) => r.lo_email],
  ["Added", (r) => r.created_at],
  ["Updated", (r) => r.updated_at],
];
// A spreadsheet runs a cell that starts with one of these as a formula, so such a cell gets a leading ' (shown as plain text). Tab
// and carriage return are on the list for the same reason.
const FORMULA_START = /^[=+\-@\t\r]/;
function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

router.get("/export.csv", requireAuth, requireBroker, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.*, u.first_name AS lo_first_name, u.last_name AS lo_last_name, u.email AS lo_email
      FROM clients c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.org_id = ?
      ORDER BY c.name COLLATE NOCASE ASC, c.id ASC
    `).all(req.user.org_id);
    const lines = [COLUMNS.map(([heading]) => csvCell(heading)).join(",")];
    for (const row of rows) lines.push(COLUMNS.map(([, value]) => csvCell(value(row))).join(","));
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="broker-radar-clients.csv"',
      "Cache-Control": "no-store",
    });
    // The byte-order mark makes spreadsheet programs read the file as UTF-8 (names with accents come out right).
    res.send(`﻿${lines.join("\r\n")}\r\n`);
  } catch (err) {
    console.error("GET /api/billing/export.csv:", err?.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

module.exports = router;

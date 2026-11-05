"use strict";
// The billing gate (spec §6.2): mounted right after requireAuth on every gated router. With billing off (no config on the app, or
// config.enabled false) it lets everything through, so the app behaves exactly as it did before billing. With billing on, a
// brokerage that needs a card, has ended, or a user who hasn't accepted the current terms gets
//   402 { success: false, error: "Broker Radar needs attention before you can continue.", reason: "terms" | "needs_card" | "ended" }
// and nothing else: no price, no Stripe detail (a loan officer gets the same answer as their broker). It reads only our database,
// never Stripe; the billing status call (routes/billing.js) is what repairs a stale state (H4).
const db = require("../db");
const { orgBilling, accessFor } = require("../lib/billing/access");
const { termsCurrent } = require("../lib/terms");

const NEEDS_ATTENTION = "Broker Radar needs attention before you can continue.";

function requireAccess(req, res, next) {
  const config = req.app.get("billingConfig");
  if (!config || !config.enabled) return next();
  let access;
  try {
    const org = orgBilling(db, req.user.org_id);
    access = org
      ? accessFor({ config, org, termsOk: termsCurrent(db, req.user.id), nowMs: Date.now() })
      : { ok: false, reason: "needs_card" };
  } catch (err) {
    console.error("[billing] access check failed:", err?.message);
    return res.status(500).json({ success: false, error: "Database error" });
  }
  if (access.ok) return next();
  res.status(402).json({ success: false, error: NEEDS_ATTENTION, reason: access.reason });
}

module.exports = { requireAccess, NEEDS_ATTENTION };

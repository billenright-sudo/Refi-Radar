"use strict";
// Who may use the app, and which billing banner (if any) to show. Pure functions over an organization row.
const { TESTER_WARN_DAYS } = require("./config");

const orgBilling = (db, orgId) => db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);

const LIVE = new Set(["trialing", "active", "past_due"]);        // past_due keeps working: Stripe is still retrying the card
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

// Order matters: with billing off nothing changes; the terms come before everything else (so even an exempt
// account accepts them); then exemption, the free tester month, and last the subscription's own status.
function accessFor({ config, org, termsOk, nowMs }) {
  if (!config.enabled) return { ok: true };
  if (!termsOk) return { ok: false, reason: "terms" };
  if (org.billing_exempt) return { ok: true };
  if (org.billing_tester_until > nowMs) return { ok: true };
  if (LIVE.has(org.billing_status)) return { ok: true };
  if (ENDED.has(org.billing_status)) return { ok: false, reason: "ended" };
  return { ok: false, reason: "needs_card" };
}

// A tester who has already added a card is not nagged: the card will be charged when the month ends. An exempt brokerage is never
// charged, so it never gets a banner asking for a card or a payment.
function bannerFor(org, nowMs) {
  if (org.billing_exempt) return null;
  if (org.billing_status === "past_due") return "past_due";
  const left = org.billing_tester_until - nowMs;
  if (org.billing_tester_until && left > 0 && left <= TESTER_WARN_DAYS * 24 * 3600_000 && !org.billing_has_card) return "tester_ending";
  return null;
}

module.exports = { orgBilling, accessFor, bannerFor };

"use strict";
// Billing settings and price rules. Pure: reads only the env object it is given.
// `enabled` is not produced here: the app sets config.enabled = stripeConfigured && priceOk at start-up, once the
// Stripe price has been checked, so a half-configured deployment behaves exactly as it did before billing.

const BASE_CENTS = 9900;          // the brokerage, including the broker
const ADDITIONAL_CENTS = 4900;    // each additional user
const TRIAL_DAYS = 14;
const TESTER_DAYS = 30;
const TESTER_WARN_DAYS = 7;
const STALE_MS = 24 * 3600_000;
const TERMS_VERSION = "2026-11-05";
const PRIVACY_VERSION = "2026-11-05";

const monthlyTotalCents = (users) => BASE_CENTS + ADDITIONAL_CENTS * (users - 1);

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function billingConfig(env = {}) {
  const secretKey = trimmed(env.STRIPE_SECRET_KEY);
  const webhookSecret = trimmed(env.STRIPE_WEBHOOK_SECRET);
  const priceId = trimmed(env.STRIPE_PRICE_ID);

  // A bad number falls back to the default rather than silently allowing unlimited (or zero) tester sign-ups.
  const maxRaw = trimmed(env.BILLING_TESTER_MAX_USES);
  const testerMaxUses = maxRaw && /^\d+$/.test(maxRaw) ? parseInt(maxRaw, 10) : 25;

  // The expiry day counts through its last millisecond (UTC), so "2026-12-31" still works on the 31st.
  const expRaw = trimmed(env.BILLING_TESTER_EXPIRES);
  let testerExpiresMs = null;
  const m = expRaw && /^(\d{4})-(\d{2})-(\d{2})$/.exec(expRaw);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
    if (Number.isFinite(ms)) testerExpiresMs = ms;
  }

  return {
    stripeConfigured: !!(secretKey && webhookSecret && priceId),
    secretKey,
    webhookSecret,
    priceId,
    testerCode: trimmed(env.BILLING_TESTER_CODE)?.toLowerCase() ?? null,
    testerMaxUses,
    testerExpiresMs,
    // commas, semicolons or whitespace between addresses (an address has none of them), so no gcloud delimiter trick is needed
    exemptEmails: String(env.BILLING_EXEMPT_EMAILS || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    feedbackTo: trimmed(env.FEEDBACK_TO),
  };
}

// The inbox Send feedback goes to, or null: the app's billing config when it carries the setting (its own null included), else the
// environment (index.js's fallback config after a failed start-up has no feedbackTo, and tests may set no config at all).
const feedbackAddress = (config, env = process.env) => (config?.feedbackTo !== undefined ? config.feedbackTo : billingConfig(env).feedbackTo) || null;

module.exports = {
  billingConfig, monthlyTotalCents, feedbackAddress,
  BASE_CENTS, ADDITIONAL_CENTS, TRIAL_DAYS, TESTER_DAYS, TESTER_WARN_DAYS, STALE_MS, TERMS_VERSION, PRIVACY_VERSION,
};

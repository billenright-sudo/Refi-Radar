"use strict";
// How a new Stripe Checkout should treat the trial. Pure.
const { TRIAL_DAYS } = require("./config");

// Stripe refuses a trial end less than 48 hours away, so a tester month about to finish gets 49 hours instead
// (an hour of margin for clock drift). Once an organization has had any subscription it never gets a trial again.
function checkoutPlan(org, nowMs) {
  if (org.billing_tester_until > nowMs) return { trial: "until", endMs: Math.max(org.billing_tester_until, nowMs + 49 * 3600_000) };
  if (!org.billing_ever_subscribed) return { trial: "days", days: TRIAL_DAYS };
  return { trial: "none" };
}

module.exports = { checkoutPlan };

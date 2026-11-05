"use strict";
// POST /api/billing/webhook: Stripe telling us something (spec §6.4). Mounted in index.js BEFORE the app-wide JSON parser: the
// signature covers the exact bytes Stripe sent, so this route reads the raw body itself (1 MB at most).
//   404 { success: false }   billing is off: no config or gateway on the app yet, or config.enabled false
//   400 { success: false }   no Stripe-Signature, a bad one, or a body that isn't the signed JSON
//   413 { success: false }   a body over 1 MB
//   500 { success: false }   the event couldn't be stored (Stripe sends it again)
//   200 { received: true }   applied, a replay, or an event we don't use. The follow-ups (cancel a second subscription, put the user
//                            count back, the confirmation email) run after the answer, so Stripe never waits on them.
// Nothing from the body is ever logged: only the event type, the outcome and an error's message.
const express = require("express");
const db = require("../db");
const email = require("../email");
const { applyStripeEvent } = require("../lib/billing/events");
const { runFollowUps } = require("../lib/billing/followUps");

const router = express.Router();
const REFUSED = Object.freeze({ success: false });

// Billing is switched on at start-up, which puts the config and the gateway on the app; until then this route isn't there.
function billingOn(req, res, next) {
  const config = req.app.get("billingConfig");
  if (!config || !config.enabled || !req.app.get("billingGateway")) return res.status(404).json(REFUSED);
  next();
}

router.post("/", billingOn, express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const config = req.app.get("billingConfig");
  const gateway = req.app.get("billingGateway");
  const signature = req.get("stripe-signature");
  let event;
  try {
    if (!signature || !Buffer.isBuffer(req.body)) throw new Error("unsigned");
    event = gateway.constructEvent(req.body, signature, config.webhookSecret);
  } catch {
    // the error holds the header and the payload, so not even its message is logged
    console.warn("[billing] webhook refused: missing or bad signature");
    return res.status(400).json(REFUSED);
  }

  const type = typeof event?.type === "string" ? event.type : "unknown";
  let result;
  try {
    result = applyStripeEvent(db, event);
  } catch (err) {
    console.error(`[billing] webhook ${type} not stored:`, err?.message);
    return res.status(500).json(REFUSED);
  }
  console.log(`[billing] webhook ${type}: ${result.outcome}`);
  res.json({ received: true });

  if (!result.followUps.length) return;
  const send = req.app.get("sendBillingConfirmation") || email.sendBillingConfirmation;
  setImmediate(() => {
    runFollowUps({ db, gateway, send, config }, result.followUps)
      .catch((err) => console.error("[billing] follow-ups failed:", err?.message));
  });
});

// express.raw's own refusals (too big, a bad encoding) answer like the rest of this route, without Express's HTML error page.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err?.type === "entity.too.large" ? 413 : 400).json(REFUSED);
});

module.exports = router;

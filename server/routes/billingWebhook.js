"use strict";
// POST /api/billing/webhook: Stripe telling us something (spec §6.4). Mounted in index.js BEFORE the app-wide JSON parser: the
// signature covers the exact bytes Stripe sent, so this route reads the raw body itself (1 MB at most).
//   404 { success: false }   billing is off: no config or gateway on the app yet, or config.enabled false
//   400 { success: false }   no Stripe-Signature, a bad one, or a body that isn't the signed JSON
//   413 { success: false }   a body over 1 MB
//   500 { success: false }   the event couldn't be stored (Stripe sends it again)
//   200 { received: true }   applied, a replay, or an event we don't use, once the follow-ups have run: cancel and refund a second
//                            subscription (H1), put the user count back (H2), the confirmation email (H6), and a retry of any
//                            second subscription still recorded for the event's organization. They run BEFORE the answer because
//                            Cloud Run throttles the CPU once a response has gone (ruling 9). A failed follow-up still answers 200:
//                            the event is recorded, and what failed is kept to be tried again on the organization's next event.
// Nothing from the body is ever logged: only the event type, the outcome and an error's message.
const express = require("express");
const db = require("../db");
const email = require("../email");
const { applyStripeEvent } = require("../lib/billing/events");
const { runFollowUps, retryPendingDuplicate } = require("../lib/billing/followUps");

const router = express.Router();
const REFUSED = Object.freeze({ success: false });

// Billing is switched on at start-up, which puts the config and the gateway on the app; until then this route isn't there.
function billingOn(req, res, next) {
  const config = req.app.get("billingConfig");
  if (!config || !config.enabled || !req.app.get("billingGateway")) return res.status(404).json(REFUSED);
  next();
}

router.post("/", billingOn, express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
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
  const { orgId } = result;
  console.log(`[billing] webhook ${type}${orgId != null ? ` for org ${orgId}` : ""}: ${result.outcome}`);

  const send = req.app.get("sendBillingConfirmation") || email.sendBillingConfirmation;
  try {
    await runFollowUps({ db, gateway, send, config }, result.followUps);
    // Any event for the organization retries a second subscription still recorded for it, unless this event's own follow-ups just did.
    const handled = result.followUps.some((f) => f.type === "cancel_duplicate" && f.orgId === orgId);
    if (orgId != null && !handled) await retryPendingDuplicate(db, gateway, orgId, send);
  } catch (err) {
    console.error(`[billing] follow-ups failed for org ${orgId}:`, err?.message);
  }
  res.json({ received: true });
});

// express.raw's own refusals (too big, a bad encoding) answer like the rest of this route, without Express's HTML error page.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err?.type === "entity.too.large" ? 413 : 400).json(REFUSED);
});

module.exports = router;

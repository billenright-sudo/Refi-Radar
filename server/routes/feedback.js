"use strict";
// /api/feedback: a note from inside the app (spec §9). POST { message, page } -> { success: true }.
// Signed in only. NOT behind the access gate: a user whose brokerage is locked must still be able to write to us.
// Order: check, store the row, then (when FEEDBACK_TO is set) email it to that inbox from the app's mailbox, waiting at most 8 seconds
// before answering because Cloud Run throttles work left running after the response. A failed or slow send still answers 200 and logs
// only the error message. Limited to 10 an hour per user.
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const email = require("../email");
const { requireAuth } = require("../middleware/auth");
const { billingConfig } = require("../lib/billing/config");

const router = express.Router();

const MAX_MESSAGE = 2000;
const MAX_PAGE = 100;
const SEND_WAIT_MS = 8_000;

// Per signed-in user (this runs after requireAuth), not per address. A refused request counts too.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: "Too many messages — please try again in an hour" },
});

const feedbackToOf = (req) => {
  const config = req.app.get("billingConfig");
  return (config ? config.feedbackTo : billingConfig(process.env).feedbackTo) || null;
};

router.post("/", requireAuth, feedbackLimiter, async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ success: false, error: "Please write a message." });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ success: false, error: "Please keep it under 2,000 characters." });
  const page = (typeof req.body?.page === "string" ? req.body.page.trim().slice(0, MAX_PAGE).trim() : "") || "unknown";

  const { id: userId, org_id: orgId, role, first_name: firstName, last_name: lastName } = req.user;
  try {
    db.prepare("INSERT INTO feedback (user_id, org_id, page, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, orgId, page, message, Date.now());
  } catch (err) {
    console.error("[feedback] store failed:", err.message);
    return res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
  }

  const to = feedbackToOf(req);
  if (to) {
    try {
      const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(orgId);
      const send = req.app.get("sendFeedback") || email.sendFeedback;
      const waitMs = req.app.get("feedbackWaitMs") ?? SEND_WAIT_MS;
      let timer;
      const sending = Promise.resolve().then(() => send({ to, brokerage: org?.name || "", name: `${firstName} ${lastName}`.trim(), role, page, message }));
      await Promise.race([sending.catch((err) => console.error("[feedback] send failed:", err?.message)), new Promise((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    } catch (err) {
      console.error("[feedback] send failed:", err?.message);
    }
  }
  res.json({ success: true });
});

module.exports = router;

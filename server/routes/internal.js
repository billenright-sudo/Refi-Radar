"use strict";
// Doors for machines, not people. Today one: POST /internal/rate-check, which Cloud Scheduler calls every half hour to run the rate-drop
// check (lib/pings/rateCheck.js). No cookie, no session: the secret in the X-Rate-Check-Secret header is the credential.
//   RATE_CHECK_SECRET unset or shorter than 32 characters -> 404 { success: false, error: "not available" } (the door does not exist)
//   wrong or missing header                               -> 403 { success: false }
//   a run already in flight                               -> 409 { success: false, busy: true }
//   otherwise                                             -> 200 { success: true, fetched, observation, recorded, drop, sent, held, skipped, failed }
// The answer is counts and market dates only. Limited to 10 a minute. Test seams: app.get("rateCheckEnv") (settings, default process.env),
// app.get("rateCheckDeps") ({ fetchImpl, push, mail, now }, set once at start-up by index.js) and app.get("rateCheckLimit").
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { runRateCheck } = require("../lib/pings/rateCheck");
const { rateCheckSecret, SECRET_MIN } = require("../lib/pings/channels");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60_000,
  limit: (req) => req.app.get("rateCheckLimit") || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests" },
});

// Equal strings in time that does not depend on where they differ: compare SHA-256 digests, which are always the same length.
const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();
const sameSecret = (given, expected) => crypto.timingSafeEqual(sha(given), sha(expected));

// One run at a time: a second call while one is in flight is told so (the claims in rate_alerts_sent would make it harmless, but there
// is no reason to fetch FRED twice).
let running = false;

router.post("/rate-check", limiter, async (req, res) => {
  const env = req.app.get("rateCheckEnv") || process.env;
  const secret = rateCheckSecret(env);
  if (secret.length < SECRET_MIN) return res.status(404).json({ success: false, error: "not available" });
  const given = req.get("x-rate-check-secret");
  if (typeof given !== "string" || !sameSecret(given, secret)) return res.status(403).json({ success: false });
  if (running) return res.status(409).json({ success: false, busy: true });
  running = true;
  try {
    const deps = req.app.get("rateCheckDeps") || {};
    const summary = await runRateCheck({
      db, env, nowMs: deps.now ? deps.now() : Date.now(), fetchImpl: deps.fetchImpl,
      push: deps.push || null, mail: deps.mail || null, billingConfig: req.app.get("billingConfig"),
    });
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error(`[pings] rate check failed: ${(err && err.name) || "Error"}`);
    res.status(500).json({ success: false });
  } finally {
    running = false;
  }
});

router.limiter = limiter;
module.exports = router;

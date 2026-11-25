"use strict";
// The signed-in user's rate-drop notification settings and devices, mounted at /api/profile/alerts (the Profile page's Notifications card).
// Behind requireAuth only, not the billing gate, like the rest of Profile. Every route acts on req.user, never on an id from the request.
//   GET    /api/profile/alerts          -> { settings, available: { push, email }, vapidPublicKey, devices }
//   PUT    /api/profile/alerts  { enabled, threshold, quietStart, quietEnd, weekdaysOnly, channels, timeZone } -> the same shape as GET
//            400 { success: false, error } with the settings' own message; turning ON a channel that is not available is a 400 too:
//            "Phone notifications aren't available yet. Choose email." / "Email notifications aren't available yet."
//   POST   /api/profile/alerts/devices { endpoint, keys: { p256dh, auth } } -> { devices }   400 "That device can't get notifications."
//            unless the endpoint is a push service's and the keys are a P-256 point (65 octets) and a 16-octet secret, base64url.
//            An endpoint already stored moves to this user; at most 10 devices per user (the oldest goes).
//   DELETE /api/profile/alerts/devices { endpoint } -> { devices }   (only the caller's own)
//   POST   /api/profile/alerts/test -> { sent }   a fixed test notification to the caller's own devices and/or email, per their channel;
//            3 an hour per user; 503 "Notifications aren't available yet." when neither channel is available at all.
// Which channels exist comes from app.get("rateCheckDeps") ({ push, mail }, set once at start-up by index.js; lib/pings/channels.js).
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { parseSettings, getSettings, saveSettings } = require("../lib/pings/settings");
const { isPushEndpoint } = require("../lib/pings/push");
const { TEST_TEXT } = require("../lib/pings/text");

const router = express.Router();
router.use(requireAuth);

const MAX_DEVICES = 10;
const TEST_TTL_SECONDS = 300;
const TEST_LIMIT = 3;   // test notifications per signed-in user per hour; app.set("pingTestLimit", n) overrides it (tests)
const BAD_DEVICE = "That device can't get notifications.";
const BAD_REQUEST = "Something in this request isn't valid.";
const NO_PUSH = "Phone notifications aren't available yet. Choose email.";
const NO_EMAIL = "Email notifications aren't available yet.";
const NONE = "Notifications aren't available yet.";
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const errName = (err) => (err && typeof err.name === "string" && err.name) || "Error";
const bad = (res, error) => res.status(400).json({ success: false, error });

// A test notification is a real send to a real device or inbox, so it is limited per signed-in user (an office shares one IP address).
const testLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => req.app.get("pingTestLimit") || TEST_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: "Too many test notifications. Please try again in an hour." },
});

const channelsOf = (app) => {
  const deps = app.get("rateCheckDeps") || {};
  return { push: deps.push && deps.push.enabled ? deps.push : null, mail: deps.mail && deps.mail.enabled ? deps.mail : null };
};
const deviceCount = (userId) => db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(userId).n;

function view(req) {
  const { push, mail } = channelsOf(req.app);
  return {
    settings: getSettings(db, req.user.id),
    available: { push: Boolean(push), email: Boolean(mail) },
    vapidPublicKey: push ? push.publicKey || null : null,
    devices: deviceCount(req.user.id),
  };
}

router.get("/", (req, res) => {
  try {
    res.json(view(req));
  } catch (err) {
    console.error(`[pings] reading alert settings failed: ${errName(err)}`);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

router.put("/", (req, res) => {
  const parsed = parseSettings(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const { push, mail } = channelsOf(req.app);
  const v = parsed.value;
  if (v.enabled) {
    if (v.channels !== "email" && !push) return bad(res, NO_PUSH);
    if (v.channels !== "push" && !mail) return bad(res, NO_EMAIL);
  }
  try {
    saveSettings(db, req.user.id, v);
    res.json(view(req));
  } catch (err) {
    console.error(`[pings] saving alert settings failed: ${errName(err)}`);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// A browser's push keys: p256dh is an uncompressed P-256 point (65 octets, 0x04...) that really is on the curve, auth is 16 octets.
function validKeys(keys) {
  if (!keys || typeof keys !== "object") return false;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !B64URL_RE.test(p256dh) || !B64URL_RE.test(auth)) return false;
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 0x04 || Buffer.from(auth, "base64url").length !== 16) return false;
  try {
    const probe = crypto.createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);   // throws for a point that is not on the curve
    return true;
  } catch (_err) {
    return false;
  }
}

router.post("/devices", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !isPushEndpoint(body.endpoint) || !validKeys(body.keys)) return bad(res, BAD_DEVICE);
  try {
    db.transaction(() => {
      // the newest add is the newest device, even for an endpoint that was already stored (it may have been another user's)
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(body.endpoint);
      db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)")
        .run(req.user.id, body.endpoint, body.keys.p256dh, body.keys.auth);
      db.prepare(
        "DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)"
      ).run(req.user.id, req.user.id, MAX_DEVICES);
    })();
    res.json({ devices: deviceCount(req.user.id) });
  } catch (err) {
    console.error(`[pings] saving a device failed: ${errName(err)}`);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

router.delete("/devices", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== "string" || !endpoint) return bad(res, BAD_REQUEST);
  try {
    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(req.user.id, endpoint);
    res.json({ devices: deviceCount(req.user.id) });
  } catch (err) {
    console.error(`[pings] removing a device failed: ${errName(err)}`);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// Nothing to test when neither channel exists at all: answered before the limiter, so it uses none of the user's three.
const someChannel = (req, res, next) => {
  const { push, mail } = channelsOf(req.app);
  if (!push && !mail) return res.status(503).json({ success: false, error: NONE });
  next();
};

router.post("/test", someChannel, testLimiter, async (req, res) => {
  const { push, mail } = channelsOf(req.app);
  let sent = false;
  try {
    const settings = getSettings(db, req.user.id);
    if (settings.channels !== "email" && push) {
      const subs = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY id").all(req.user.id);
      for (const sub of subs) {
        let result;
        try { result = await push.send(sub, TEST_TEXT, { ttlSeconds: TEST_TTL_SECONDS }); } catch (err) {
          console.error(`[pings] test send failed: ${errName(err)}`);
          result = { ok: false };
        }
        if (result && result.ok) sent = true;
        else if (result && result.gone) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
      }
    }
    if (settings.channels !== "push" && mail) {
      try { if (await mail.sendTestPing({ to: req.user.email })) sent = true; } catch (err) { console.error(`[pings] test email failed: ${errName(err)}`); }
    }
    res.json({ sent });
  } catch (err) {
    console.error(`[pings] test notification failed: ${errName(err)}`);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

router.limiter = testLimiter;
module.exports = router;

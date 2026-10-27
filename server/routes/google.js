"use strict";
// The signed-in user's own Google connection (lib/google/oauth.js), for Charli's calendar.
//   POST /api/google/connect     -> { url }   the Google consent URL to send the browser to
//   GET  /api/google/callback    Google's redirect back; answers 302 to /?google=connected | denied | scope | error
//                                (scope: signed in, but the calendar permission box was left unticked)
//   GET  /api/google/status      -> { configured, connected, status, googleEmail }   (status: 'connected' | 'reconnect' | null)
//   POST /api/google/disconnect  -> { success: true }   revokes at Google and forgets the tokens
//
// Everything but the callback needs a signed-in user. The callback cannot have one: the auth cookie is
// sameSite=strict, so the browser does not send it on a redirect from Google. The single-use `state` row made by
// /connect names the user instead, and a short-lived "flow cookie" ties that state to the browser that asked for it:
// /connect sets it (value = the state), the callback must bring it back and it must match the state in the query. Without
// that, a user could send their own Google URL to someone else and have the other person's calendar attached to
// their account (RFC 6749 section 10.12). The flow cookie is sameSite=lax, which IS sent on Google's top-level GET
// redirect, is scoped to the callback path, and is cleared by every callback response. No response ever carries a
// token. Outbound calls go through `app.get("googleFetch") || fetch`, so tests inject a stub.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const oauth = require("../lib/google/oauth");

const NOT_CONFIGURED = "Google isn't set up on this server";
const MAX_CODE_CHARS = 2048;
const MAX_STATE_CHARS = 200;
const FLOW_COOKIE = "rr_google_flow";
const flowCookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  path: "/api/google/callback",
  secure: process.env.NODE_ENV === "production",   // as the rr_token cookie in routes/auth.js
});

// Two strings that are equal, compared in constant time (the lengths are not secret: 43 characters of base64url).
function sameValue(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a === "") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// What gets logged for a failure: the error's name only (a message can quote a response from Google).
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");

// A query value that is a single, reasonably short, non-empty string (Express turns `a[]=1` into an array).
const param = (value, max) => (typeof value === "string" && value !== "" && value.length <= max ? value : null);

// createGoogleRouter({ limiter }) builds a router with its own rate-limit counter; `limiter` overrides the
// express-rate-limit options (tests use a bigger `max`). The default export is the one index.js mounts.
function createGoogleRouter({ limiter = {} } = {}) {
  const router = express.Router();
  // 20 requests a minute, counted per signed-in user (an office shares one IP address); the callback has no user, so
  // it is counted by IP address.
  const limit = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`),
    message: { success: false, error: "Too many requests — please try again in a minute" },
    ...limiter,
  });

  router.get("/callback", limit, async (req, res) => {
    res.set("Cache-Control", "no-store");   // the URL carries the one-time code
    res.clearCookie(FLOW_COOKIE, flowCookieOptions());   // it has done its job whatever happens next
    const done = (outcome) => res.redirect(302, `/?google=${outcome}`);
    try {
      if (req.query.error !== undefined) return done(req.query.error === "access_denied" ? "denied" : "error");
      const code = param(req.query.code, MAX_CODE_CHARS);
      const state = param(req.query.state, MAX_STATE_CHARS);
      if (!state) return done("error");
      // Only the browser that started this sign-in has the cookie. Any other arrival (a link sent to someone else, a
      // forged redirect) is refused before Google is called, and the state is spent so it cannot be tried again.
      if (!code || !sameValue(req.cookies && req.cookies[FLOW_COOKIE], state)) {
        oauth.cancelAuth(db, state);
        return done("error");
      }
      const send = req.app.get("googleFetch") || globalThis.fetch;
      const result = await oauth.finishAuth(db, { code, state }, send);
      // (Ruling 56: Google's consent screen has a box per scope; a broker who unticks the calendar one is told to tick it)
      if (result.error) return done(result.error === oauth.MSG_NEEDS_CALENDAR ? "scope" : "error");
      return done("connected");
    } catch (err) {
      console.error("GET /api/google/callback:", errName(err));
      return done("error");
    }
  });

  router.use(requireAuth);
  router.use(limit);

  router.post("/connect", (req, res) => {
    try {
      if (!oauth.googleConfig()) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
      const { url } = oauth.startAuth(db, req.user.id);
      res.cookie(FLOW_COOKIE, new URL(url).searchParams.get("state"), { ...flowCookieOptions(), maxAge: oauth.STATE_TTL_MS });
      res.json({ url });
    } catch (err) {
      console.error("POST /api/google/connect:", errName(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  router.get("/status", (req, res) => {
    try {
      const connection = oauth.getConnection(db, req.user.id);
      res.json({
        configured: oauth.googleConfig() !== null,
        connected: connection !== null,
        status: connection ? connection.status : null,
        googleEmail: connection ? connection.googleEmail : null,
      });
    } catch (err) {
      console.error("GET /api/google/status:", errName(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  router.post("/disconnect", async (req, res) => {
    try {
      await oauth.disconnect(db, req.user.id, req.app.get("googleFetch") || globalThis.fetch);
      res.json({ success: true });
    } catch (err) {
      console.error("POST /api/google/disconnect:", errName(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  return router;
}

module.exports = Object.assign(createGoogleRouter(), { createGoogleRouter });

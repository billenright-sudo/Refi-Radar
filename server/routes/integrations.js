"use strict";
// The ARIVE feed. A Zap ("Webhooks by Zapier", POST) sends each funded loan here as it closes; the loan lands in the key owner's
// book through the same ingest() the file import uses (lib/intake/ingest.js), so a loan is never made twice. Importing never
// contacts anyone (A1): nothing here sends mail, and the only message is the in-app note ingest() leaves when a client moves.
//   GET    /api/integrations/key    signed in (any role) -> { success, connected, createdAt, lastUsedAt, webhookUrl }
//   POST   /api/integrations/key    signed in            -> { success, key, webhookUrl, createdAt }   a NEW key, replacing any old one
//   DELETE /api/integrations/key    signed in            -> { success: true, connected: false }
//   POST   /api/integrations/loans  Authorization: Bearer <key>  JSON body, up to 32 KB   -> 200 { result } (below)
//
// The key is "br_" and 64 hex characters. It is shown once, when it is made; only its SHA-256 is stored, so it can be checked but
// never read back. The key routes carry a cookie (they are the Settings page's), so they are no-store; /loans reads no cookie.
//
// /loans answers, in this order (every error is { error }, and no answer ever echoes a value from the body):
//   401  no Bearer header, or a key that is malformed, unknown or revoked ({ error: "Unauthorized" }); then the key's last use is
//        stamped, and a key gets 60 calls a minute (429)
//   413  body over 32 KB    400  not a JSON object
//   400  loan_id missing or over 64 characters
//   200  { result: "ignored", reason }  a dead status (denied, withdrawn, cancelled, adverse, archived)
//   200  { result: "ignored", reason }  no closing date, or a closing date in the future (R7)
//   400  a closing date that is not a date (R7)
//   400  a missing name, note rate, balance or property value
//   200  { result: "created" | "updated" | "unchanged" | "ambiguous" }, plus moved_from (the old loan officer's name) when an
//        update moved the client to the loan officer the loan names (A6a)
//   500  { error: "Server error" }
// A key's owner decides the book: a loan officer's key always fills their own, a broker's routes by loan_officer_email. Only the
// keys in BODY_FIELDS are read (A2), so an SSN or a date of birth in the body goes nowhere. The payload is never logged (a failure
// logs only the error's name).
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { APP_URL } = require("../email");   // the one constant: nothing in this file sends mail
const { toRecord } = require("../lib/intake/record");
const { ingest } = require("../lib/intake/ingest");
// A status that means the loan will never fund, so the Zap has nothing to import (the file import never ticks one as funded).
const { isDeadStatus, parseDate } = require("../lib/intake/normalize");

const MAX_BODY = "32kb";
const MAX_LOAN_ID = 64;
const PER_MINUTE = 60;
const KEY_RE = /^br_[0-9a-f]{64}$/;
const BEARER_RE = /^Bearer +(\S+)$/i;

const MSG = Object.freeze({
  unauthorized: "Unauthorized",
  tooMany: `Too many requests: at most ${PER_MINUTE} a minute`,
  tooBig: "The body is over 32 KB",
  notObject: "The body must be a JSON object",
  noLoanId: "loan_id is required",
  longLoanId: "loan_id is too long",
  failed: "Server error",
});

// toRecord()'s codes that are the Zap's mistake (400) and the two that only mean "not funded yet" (200 ignored). The /loans route
// checks the closing date itself before toRecord() runs, with these same words.
const BAD_FIELD = Object.freeze({
  no_name: "borrower_name (or borrower_first_name and borrower_last_name) is required",
  bad_rate: "note_rate is missing or not between 0 and 20",
  no_balance: "current_balance or loan_amount is required",
  no_value: "property_value, appraised_value or purchase_price is required",
  bad_closing_date: "closing_date is not a date",
});
const NOT_FUNDED = Object.freeze({
  no_closing_date: "no closing date",
  future_closing_date: "closing date is in the future",
});

// The whitelist (A2): a body key -> the FIELDS id (lib/intake/fields.js) it fills. closing_date / funding_date is read separately.
const BODY_FIELDS = Object.freeze({
  loan_id: "loanNumber",
  borrower_name: "borrowerName",
  borrower_first_name: "firstName",
  borrower_last_name: "lastName",
  email: "email",
  phone: "phone",
  note_rate: "noteRate",
  current_balance: "currentBalance",
  loan_amount: "loanAmount",
  term_months: "term",
  amortization_type: "amortization",
  first_payment_date: "firstPaymentDate",
  property_value: "propertyValue",
  appraised_value: "appraisedValue",
  purchase_price: "purchasePrice",
  credit_score: "creditScore",
  loan_officer_email: "loanOfficer",
  loan_purpose: "purpose",
});

// What gets logged for a failure: the error's name only (a message can quote the payload).
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// "today" is the UTC date and "nowUtc" is SQLite's UTC text, both read from one instant so a whole request agrees (A4).
function clock() {
  const iso = new Date().toISOString();
  return { today: iso.slice(0, 10), nowUtc: `${iso.slice(0, 10)} ${iso.slice(11, 19)}` };
}

// A body value that counts: a string with something in it, or a finite number (a Zap sends numbers either way). A "", null, a
// boolean, a list or an object is the same as not sent.
function given(v) {
  if (typeof v === "string") return v.trim() === "" ? undefined : v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

// The body as FIELDS values. Only the keys in BODY_FIELDS are read; closing_date wins over funding_date when both are there.
function fieldsOf(body) {
  const fields = {};
  for (const [key, id] of Object.entries(BODY_FIELDS)) {
    const v = given(body[key]);
    if (v !== undefined) fields[id] = v;
  }
  const closing = given(body.closing_date) ?? given(body.funding_date);
  if (closing !== undefined) fields.closingDate = closing;
  return fields;
}

// createIntegrationsRouter({ limiter }) builds a router with its own rate-limit counter; `limiter` overrides the express-rate-limit
// options (tests use a smaller or bigger `max`). The default export is the one index.js mounts.
function createIntegrationsRouter({ limiter = {} } = {}) {
  const router = express.Router();

  const keyFailed = (label, res, err) => {
    console.error(label, errName(err));
    res.status(500).json({ success: false, error: "Database error" });
  };
  const loansFailed = (res, err) => {
    console.error("POST /api/integrations/loans:", errName(err));
    res.status(500).json({ error: MSG.failed });
  };

  // ── the key (a signed-in user's own) ──────────────────────────────────────────────────────────────────────────────────
  // index.js mounts this router above its cookie parser (R9), so the key routes bring their own.
  const signedIn = [(req, res, next) => { res.set("Cache-Control", "no-store"); next(); }, cookieParser(), requireAuth];
  const webhookUrl = `${APP_URL}/api/integrations/loans`;

  router.get("/key", signedIn, (req, res) => {
    try {
      const row = db.prepare("SELECT created_at, last_used_at FROM integration_keys WHERE user_id = ?").get(req.user.id);
      res.json({
        success: true,
        connected: Boolean(row),
        createdAt: row ? row.created_at : null,
        lastUsedAt: row ? row.last_used_at : null,
        webhookUrl,
      });
    } catch (err) {
      keyFailed("GET /api/integrations/key:", res, err);
    }
  });

  router.post("/key", signedIn, (req, res) => {
    try {
      const key = `br_${crypto.randomBytes(32).toString("hex")}`;
      const { nowUtc } = clock();
      // One row per user: a new key takes the old one's place, and it has not been used yet.
      db.prepare(`
        INSERT INTO integration_keys (user_id, key_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = NULL
      `).run(req.user.id, sha256(key), nowUtc);
      res.json({ success: true, key, webhookUrl, createdAt: nowUtc });
    } catch (err) {
      keyFailed("POST /api/integrations/key:", res, err);
    }
  });

  router.delete("/key", signedIn, (req, res) => {
    try {
      db.prepare("DELETE FROM integration_keys WHERE user_id = ?").run(req.user.id);
      res.json({ success: true, connected: false });
    } catch (err) {
      keyFailed("DELETE /api/integrations/key:", res, err);
    }
  });

  // ── the webhook (a Zap, signed with the key) ──────────────────────────────────────────────────────────────────────────
  // The key's owner, by the hash of the key. Looking a row up by the hash of a 256-bit secret gives a timing probe nothing to
  // work with, so no constant-time compare is needed.
  function authenticate(req, res, next) {
    const sent = BEARER_RE.exec(req.get("authorization") || "");
    const key = sent ? sent[1] : "";
    if (!KEY_RE.test(key)) return res.status(401).json({ error: MSG.unauthorized });
    try {
      const user = db.prepare(`
        SELECT u.id, u.org_id, u.role, u.first_name, u.last_name, u.email
        FROM integration_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ?
      `).get(sha256(key));
      if (!user) return res.status(401).json({ error: MSG.unauthorized });
      req.keyUser = user;
      req.now = clock();
      db.prepare("UPDATE integration_keys SET last_used_at = ? WHERE user_id = ?").run(req.now.nowUtc, user.id);
      next();
    } catch (err) {
      loansFailed(res, err);
    }
  }

  // 60 calls a minute, counted per key (an office may share one IP address, and a key is one person's feed).
  const limit = rateLimit({
    windowMs: 60 * 1000,
    max: PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `key:${req.keyUser.id}`,
    message: { error: MSG.tooMany },
    ...limiter,
  });

  // The body is read only for a caller who passed authenticate(), and only up to 32 KB.
  const parseJson = express.json({ limit: MAX_BODY });
  function readBody(req, res, next) {
    parseJson(req, res, (err) => {
      if (!err) return next();
      if (err.type === "entity.too.large") return res.status(413).json({ error: MSG.tooBig });
      if (err.status >= 400 && err.status < 500) return res.status(400).json({ error: MSG.notObject });
      return loansFailed(res, err);
    });
  }

  router.post("/loans", authenticate, limit, readBody, (req, res) => {
    try {
      const body = req.body;
      // (a body of another content type is never parsed, so it is not a JSON object either)
      if (!req.is("application/json") || body === null || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: MSG.notObject });
      }
      const fields = fieldsOf(body);

      if (fields.loanNumber === undefined) return res.status(400).json({ error: MSG.noLoanId });
      if (String(fields.loanNumber).trim().length > MAX_LOAN_ID) return res.status(400).json({ error: MSG.longLoanId });

      const status = given(body.status);
      if (status !== undefined && isDeadStatus(status)) {
        return res.json({ result: "ignored", reason: "status is not funded" });
      }

      // The closing date before the loan's other fields (R7): a Zap that fires on a loan still in the pipeline usually lacks a
      // field or two as well, and that loan is "not funded yet", not a mistake. toRecord() reads the date the same way.
      const { today, nowUtc } = req.now;
      if (fields.closingDate === undefined) return res.json({ result: "ignored", reason: NOT_FUNDED.no_closing_date });
      const closeDate = parseDate(fields.closingDate);
      if (closeDate === null) return res.status(400).json({ error: BAD_FIELD.bad_closing_date });
      if (closeDate > today) return res.json({ result: "ignored", reason: NOT_FUNDED.future_closing_date });

      const read = toRecord(fields, { today, requireClosingDate: true });
      if (!read.ok) {
        if (NOT_FUNDED[read.code]) return res.json({ result: "ignored", reason: NOT_FUNDED[read.code] });
        return res.status(400).json({ error: BAD_FIELD[read.code] || MSG.failed });
      }

      const { results } = ingest(db, {
        actor: req.keyUser, source: "arive", items: [{ row: 1, fields }], today, nowUtc, requireClosingDate: true, dryRun: false,
      });
      const { outcome, movedFrom, reason } = results[0];
      if (movedFrom) return res.json({ result: outcome, moved_from: movedFrom });
      // The only row ingest skips here is another loan officer's client sent with a loan officer's own key (Bill, 2026-11-03).
      res.json(outcome === "skipped" ? { result: outcome, reason } : { result: outcome });
    } catch (err) {
      loansFailed(res, err);
    }
  });

  return router;
}

module.exports = Object.assign(createIntegrationsRouter(), { createIntegrationsRouter });

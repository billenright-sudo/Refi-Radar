"use strict";
// The email-verified sign-up store: a request is kept as a hash until its 24-hour link is used, and only then do the
// organization and the broker exist. Plain functions over a `db` handle, like lib/passwordReset.js; nothing in here sends mail.
const crypto = require("crypto");
const { hashToken } = require("./passwordReset");

const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

// Stores the request and returns its token (to be mailed, never logged). One row per address: asking again replaces the row,
// so the older link stops working at once. The email is lower-cased and the names trimmed.
function issueSignup(db, { email, firstName, lastName, orgName, passwordHash }, nowMs) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO signup_requests (email, token_hash, first_name, last_name, org_name, password_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash, first_name = excluded.first_name,
      last_name = excluded.last_name, org_name = excluded.org_name, password_hash = excluded.password_hash,
      expires_at = excluded.expires_at
  `).run(email.trim().toLowerCase(), hashToken(token), firstName.trim(), lastName.trim(), orgName.trim(), passwordHash, nowMs + SIGNUP_TTL_MS);
  return token;
}

// The request a token belongs to, or null. Reading it does not use it up (mail scanners open links). Malformed, unknown,
// expired (at the 24th hour exactly, not after) and "the address now has a user" (an unused invite included) all look the same.
function signupFor(db, token, nowMs) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return db.prepare(`
    SELECT r.* FROM signup_requests r
    WHERE r.token_hash = ? AND r.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM users WHERE email = r.email)
  `).get(hashToken(token), nowMs) || null;
}

// Uses the link up: the organization (14-day trial from now) and the broker, then the request deleted, in one transaction so a
// failure part-way leaves nothing behind. Returns the new users row, or null if the token isn't valid.
function completeSignup(db, token, nowMs) {
  return db.transaction(() => {
    const req = signupFor(db, token, nowMs);
    if (!req) return null;
    const orgId = Number(db.prepare("INSERT INTO organizations (name, plan, trial_ends) VALUES (?, 'trial', ?)")
      .run(req.org_name, new Date(nowMs + TRIAL_MS).toISOString()).lastInsertRowid);
    const userId = Number(db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted)
      VALUES (?, 'broker', ?, ?, ?, ?, 1)
    `).run(orgId, req.first_name, req.last_name, req.email, req.password_hash).lastInsertRowid);
    db.prepare("DELETE FROM signup_requests WHERE email = ?").run(req.email);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  })();
}

// Housekeeping: drops requests whose link has run out.
function purgeExpiredSignups(db, nowMs) {
  db.prepare("DELETE FROM signup_requests WHERE expires_at <= ?").run(nowMs);
}

module.exports = { SIGNUP_TTL_MS, TRIAL_MS, issueSignup, signupFor, completeSignup, purgeExpiredSignups };

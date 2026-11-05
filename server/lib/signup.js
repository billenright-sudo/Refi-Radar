"use strict";
// The email-verified sign-up store: a request is kept as a hash until its 24-hour link is used, and only then do the
// organization and the broker exist. Plain functions over a `db` handle, like lib/passwordReset.js; nothing in here sends mail.
const crypto = require("crypto");
const { hashToken } = require("./passwordReset");
const { TESTER_DAYS } = require("./billing/config");

const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

// Stores the request and returns its token (to be mailed, never logged). One row per address: asking again replaces the row,
// so the older link stops working at once. The email is lower-cased and the names trimmed. With billing on, the request also
// carries the Terms and Privacy versions the person agreed to and whether they gave a usable tester code (spec §6.1); with billing
// off these stay at "none" (0 and NULL).
function issueSignup(db, { email, firstName, lastName, orgName, passwordHash, tester = false, termsVersion = null, privacyVersion = null }, nowMs) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO signup_requests (email, token_hash, first_name, last_name, org_name, password_hash, expires_at, tester, terms_version, privacy_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash, first_name = excluded.first_name,
      last_name = excluded.last_name, org_name = excluded.org_name, password_hash = excluded.password_hash,
      expires_at = excluded.expires_at, tester = excluded.tester, terms_version = excluded.terms_version,
      privacy_version = excluded.privacy_version
  `).run(email.trim().toLowerCase(), hashToken(token), firstName.trim(), lastName.trim(), orgName.trim(), passwordHash, nowMs + SIGNUP_TTL_MS,
    tester ? 1 : 0, termsVersion, privacyVersion);
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

// Whether the tester code still has a place for one more organization right now: still switched on, not past its expiry day, and
// fewer organizations than its limit already came in on it. Asked again when the link is used, because several people can ask
// with the code while only one place is left (spec §6.1.4, H10).
function testerPlaceLeft(db, config, nowMs) {
  if (!config || !config.testerCode) return false;
  if (config.testerExpiresMs != null && nowMs > config.testerExpiresMs) return false;
  const used = db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE billing_via_tester_code = 1").get().n;
  return used < config.testerMaxUses;
}

// Uses the link up: the organization (14-day trial from now) and the broker, then the request deleted, in one transaction so a
// failure part-way leaves nothing behind. Returns the new users row, or null if the token isn't valid.
// With billing on (`billingOn`, and the billing `config` for the tester code's limits) the organization starts with billing_status
// 'none' (no card yet). A tester request also gets the free test month and is counted against the code, but only if the code still
// has a place (checked inside this transaction); otherwise it is a normal sign-up and is asked for a card. With billing off the
// billing columns are left as they were before billing (billing_status NULL).
function completeSignup(db, token, nowMs, { billingOn = false, config = null } = {}) {
  return db.transaction(() => {
    const req = signupFor(db, token, nowMs);
    if (!req) return null;
    const orgId = Number(db.prepare("INSERT INTO organizations (name, plan, trial_ends) VALUES (?, 'trial', ?)")
      .run(req.org_name, new Date(nowMs + TRIAL_MS).toISOString()).lastInsertRowid);
    if (billingOn) {
      const tester = req.tester === 1 && testerPlaceLeft(db, config, nowMs);
      db.prepare("UPDATE organizations SET billing_status = 'none', billing_tester_until = ?, billing_via_tester_code = ? WHERE id = ?")
        .run(tester ? nowMs + TESTER_DAYS * DAY_MS : null, tester ? 1 : 0, orgId);
    }
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

"use strict";
// The forgotten-password store: one-time, 60-minute reset links kept as a hash, and the in-memory count that limits how many
// reset emails one account gets. Plain functions over a `db` handle (the routes pass the real one), so the rules are testable
// without a server and nothing in here sends mail or touches the cookie.
const crypto = require("crypto");

const RESET_TTL_MS = 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

// What is stored in password_resets. The token itself exists only in the emailed link, so a copy of the database holds nothing
// that can be opened. SHA-256 is enough (no bcrypt): the token is 32 random bytes, so there is nothing to guess.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Makes a new link for this user and returns its token (to be mailed, never logged). One row per user: asking again replaces
// the row, so the older link stops working at once.
function issueReset(db, userId, nowMs) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at
  `).run(userId, hashToken(token), nowMs + RESET_TTL_MS);
  return token;
}

// The user a token belongs to, or null. Reading it does not use it up: mail scanners open links before the person does. A token
// that is malformed, unknown, expired (at the 60th minute exactly, not after) or belongs to someone who never accepted their
// invite all look the same to the caller.
function userForReset(db, token, nowMs) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return db.prepare(`
    SELECT u.* FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.expires_at > ? AND u.invite_accepted = 1
  `).get(hashToken(token), nowMs) || null;
}

// Uses the link up: new password, every older session ended (session_version + 1, which requireAuth compares), the link
// deleted, and any login-email change still waiting for its confirmation cancelled (it may have been started by whoever was
// signed in before, and the new password is meant to shut them out). All in one transaction so a failure part-way leaves the
// old password, the live link and the pending change as they were. Returns the users row as it is AFTER the update, because the
// caller signs the new session from it; null if the token isn't valid.
function completeReset(db, token, passwordHash, nowMs) {
  return db.transaction(() => {
    const user = userForReset(db, token, nowMs);
    if (!user) return null;
    db.prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(passwordHash, user.id);
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM email_changes WHERE user_id = ?").run(user.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  })();
}

// How many reset emails one account (the key) may be sent: `max` per rolling `windowMs`. Kept in memory because the service runs
// one instance and a restart that forgets the count is harmless. A refused take is not counted, so being over the limit
// doesn't extend itself.
function createSendCounter({ max = 3, windowMs = 60 * 60 * 1000 } = {}) {
  const takes = new Map();   // key -> times of the takes still inside the window
  return {
    take(key, nowMs) {
      const recent = (takes.get(key) || []).filter((t) => t > nowMs - windowMs);
      if (recent.length >= max) {
        takes.set(key, recent);
        return false;
      }
      recent.push(nowMs);
      takes.set(key, recent);
      return true;
    },
  };
}

module.exports = { RESET_TTL_MS, hashToken, issueReset, userForReset, completeReset, createSendCounter };

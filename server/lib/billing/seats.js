"use strict";
// Seats (what the subscription's quantity follows) and the tester-code limits.

// A seat is an accepted, not-removed user: a pending invite costs nothing until it is accepted.
const seatCount = (db, orgId) => db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND invite_accepted = 1 AND removed_at IS NULL"
).get(orgId).n;

// The code is a shared secret, so it is capped two ways: an expiry day and a number of organizations that may use it.
function testerCodeUsable(db, config, code, nowMs) {
  if (!config.testerCode || typeof code !== "string") return false;
  if (code.trim().toLowerCase() !== config.testerCode) return false;
  if (config.testerExpiresMs != null && nowMs > config.testerExpiresMs) return false;
  const used = db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE billing_via_tester_code = 1").get().n;
  return used < config.testerMaxUses;
}

module.exports = { seatCount, testerCodeUsable };

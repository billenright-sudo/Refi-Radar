"use strict";
// Seats (what the subscription's quantity follows) and the tester-code limits.

// A seat is an accepted, not-removed user: a pending invite costs nothing until it is accepted.
const seatCount = (db, orgId) => db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND invite_accepted = 1 AND removed_at IS NULL"
).get(orgId).n;

// The code is a shared secret, so it is capped two ways: an expiry day and a number of organizations that may use it. Whether it
// has a place for one more organization right now: switched on, not past its expiry day, and fewer organizations than its limit
// already came in on it. The one home of that rule: asked when a code is typed (testerCodeUsable) and again when the sign-up link
// is used (lib/signup.js), because several people can ask with the code while only one place is left.
function testerSlotOpen(db, config, nowMs) {
  if (!config || !config.testerCode) return false;
  if (config.testerExpiresMs != null && nowMs > config.testerExpiresMs) return false;
  const used = db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE billing_via_tester_code = 1").get().n;
  return used < config.testerMaxUses;
}

// The typed code is the right one (trimmed, any case) and the code has a place left.
function testerCodeUsable(db, config, code, nowMs) {
  if (!config.testerCode || typeof code !== "string") return false;
  if (code.trim().toLowerCase() !== config.testerCode) return false;
  return testerSlotOpen(db, config, nowMs);
}

// Puts the subscription's quantity back to the user count (H2): after a loan officer joins or is removed, and whenever Stripe reports
// a different quantity. Nothing without a subscription item, or for one that has ended (Stripe refuses to change those). The new
// count is stored only once Stripe has taken it, so a failed push (which throws, for the caller to log) is tried again next time.
async function syncSeats(db, gateway, orgId) {
  const org = db.prepare(
    "SELECT stripe_subscription_id, stripe_item_id, billing_status, billing_quantity FROM organizations WHERE id = ?"
  ).get(orgId);
  if (!org || !org.stripe_subscription_id || !org.stripe_item_id) return;
  if (org.billing_status === "canceled" || org.billing_status === "incomplete_expired") return;
  const quantity = seatCount(db, orgId);
  if (quantity < 1 || quantity === org.billing_quantity) return;
  await gateway.setQuantity({ subscriptionId: org.stripe_subscription_id, itemId: org.stripe_item_id, quantity });
  db.prepare("UPDATE organizations SET billing_quantity = ? WHERE id = ? AND stripe_item_id = ?").run(quantity, orgId, org.stripe_item_id);
}

module.exports = { seatCount, testerSlotOpen, testerCodeUsable, syncSeats };

"use strict";
// The Terms of Service and Privacy Policy versions in force, and whether a user has accepted both (spec §6.6). The versions live in
// lib/billing/config.js with the other billing values; they are re-exported here so everything about terms has one home.
const { TERMS_VERSION, PRIVACY_VERSION } = require("./billing/config");

// Only the latest acceptance of each document counts: accepting an old version after a new one never brings the old one back.
function latestVersion(db, userId, document) {
  const row = db.prepare(
    "SELECT version FROM terms_acceptances WHERE user_id = ? AND document = ? ORDER BY accepted_at DESC, id DESC LIMIT 1"
  ).get(userId, document);
  return row ? row.version : null;
}

const termsCurrent = (db, userId) =>
  latestVersion(db, userId, "terms") === TERMS_VERSION && latestVersion(db, userId, "privacy") === PRIVACY_VERSION;

module.exports = { TERMS_VERSION, PRIVACY_VERSION, termsCurrent };

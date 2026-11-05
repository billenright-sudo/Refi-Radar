"use strict";
// Test-only: a broker who can sign in, made straight in the database the way /register/complete leaves one (their own
// organization on a 14-day trial, invite_accepted 1), for tests whose subject isn't sign-up itself. Sign-up now needs an emailed
// link, so tests make the account here and sign in with POST /api/auth/login.
// This file lives outside server/test/ because `node --test` runs every .js file under a test/ directory. It takes the test's
// own `db` and never requires ../db itself: each test file points DATA_DIR at its own throwaway directory before db.js opens it.
const bcrypt = require("bcryptjs");
const { TRIAL_MS } = require("../lib/signup");

// The bcrypt cost is 4 (not the app's 12) only to keep the tests quick. Returns the new users row.
function addBroker(db, { email, firstName = "Ann", lastName = "Broker", orgName = "Alpha Mortgage", password = "password123" } = {}) {
  const orgId = Number(db.prepare("INSERT INTO organizations (name, plan, trial_ends) VALUES (?, 'trial', ?)")
    .run(orgName, new Date(Date.now() + TRIAL_MS).toISOString()).lastInsertRowid);
  const userId = Number(db.prepare(`
    INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted)
    VALUES (?, 'broker', ?, ?, ?, ?, 1)
  `).run(orgId, firstName, lastName, email.trim().toLowerCase(), bcrypt.hashSync(password, 4)).lastInsertRowid);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

module.exports = { addBroker };

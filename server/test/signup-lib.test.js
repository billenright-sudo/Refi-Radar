"use strict";
// lib/signup.js: the email-verified sign-up request store. Throwaway DB; nothing here sends mail.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-signup-lib-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { hashToken } = require("../lib/passwordReset");
const { SIGNUP_TTL_MS, TRIAL_MS, issueSignup, signupFor, completeSignup, purgeExpiredSignups } = require("../lib/signup");

const NOW = 1_800_000_000_000;
const REQ = { email: "new@x.test", firstName: " Nia ", lastName: " New ", orgName: " Nia Mortgage ", passwordHash: "bcrypt-hash" };
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const reset = () => {
  db.prepare("DELETE FROM signup_requests").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("DELETE FROM organizations").run();
};

test("issueSignup stores only a hash and the trimmed names; a second request for the address replaces the first", () => {
  reset();
  const t1 = issueSignup(db, REQ, NOW);
  assert.match(t1, /^[0-9a-f]{64}$/);
  const row = db.prepare("SELECT * FROM signup_requests WHERE email = ?").get("new@x.test");
  assert.strictEqual(row.token_hash, hashToken(t1));
  assert.ok(!Object.values(row).includes(t1));
  assert.deepStrictEqual([row.first_name, row.last_name, row.org_name, row.password_hash, row.expires_at],
    ["Nia", "New", "Nia Mortgage", "bcrypt-hash", NOW + SIGNUP_TTL_MS]);
  const t2 = issueSignup(db, REQ, NOW + 5);
  assert.notStrictEqual(t2, t1);
  assert.strictEqual(count("signup_requests"), 1);
  assert.strictEqual(signupFor(db, t1, NOW + 5), null);
  assert.strictEqual(signupFor(db, t2, NOW + 5).email, "new@x.test");
});

test("issueSignup lower-cases and trims the email", () => {
  reset();
  const t = issueSignup(db, { ...REQ, email: "  New@X.Test " }, NOW);
  assert.strictEqual(signupFor(db, t, NOW).email, "new@x.test");
});

test("signupFor: null when expired (at exactly 24 hours), malformed, unknown, or the address already has a user (an unused invite too)", () => {
  reset();
  const t = issueSignup(db, REQ, NOW);
  assert.strictEqual(signupFor(db, t, NOW + SIGNUP_TTL_MS), null);
  assert.strictEqual(signupFor(db, t, NOW + SIGNUP_TTL_MS - 1).email, "new@x.test");
  for (const bad of ["abc", "A".repeat(64), "AB".repeat(32), undefined, 42]) assert.strictEqual(signupFor(db, bad, NOW), null);
  assert.strictEqual(signupFor(db, "cd".repeat(32), NOW), null);

  const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Other')").run().lastInsertRowid);
  const addUser = (accepted) => db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'A', 'B', 'new@x.test', 'h', ?)"
  ).run(orgId, accepted);
  addUser(1);
  assert.strictEqual(signupFor(db, t, NOW), null);
  db.prepare("DELETE FROM users WHERE email = 'new@x.test'").run();
  assert.strictEqual(signupFor(db, t, NOW).email, "new@x.test");
  addUser(0);
  assert.strictEqual(signupFor(db, t, NOW), null);
});

test("completeSignup creates the organization (14-day trial from now) and the broker, deletes the request, and works once", () => {
  reset();
  const t = issueSignup(db, REQ, NOW);
  const user = completeSignup(db, t, NOW);
  assert.strictEqual(user.role, "broker");
  assert.strictEqual(user.invite_accepted, 1);
  assert.strictEqual(user.password_hash, "bcrypt-hash");
  assert.deepStrictEqual([user.first_name, user.last_name, user.email, user.session_version], ["Nia", "New", "new@x.test", 0]);
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(user.org_id);
  assert.deepStrictEqual([org.name, org.plan, org.trial_ends], ["Nia Mortgage", "trial", new Date(NOW + TRIAL_MS).toISOString()]);
  assert.strictEqual(count("signup_requests"), 0);
  assert.strictEqual(count("organizations"), 1);
  assert.strictEqual(count("users"), 1);
  assert.strictEqual(completeSignup(db, t, NOW), null);
  assert.strictEqual(count("organizations"), 1);
  assert.strictEqual(count("users"), 1);
});

test("completeSignup creates nothing when the address got a user another way, or the link expired", () => {
  reset();
  const t = issueSignup(db, REQ, NOW);
  const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Other')").run().lastInsertRowid);
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, 'lo', 'A', 'B', 'new@x.test', 0)").run(orgId);
  assert.strictEqual(completeSignup(db, t, NOW), null);
  assert.strictEqual(count("organizations"), 1);
  assert.strictEqual(count("users"), 1);

  reset();
  const t2 = issueSignup(db, REQ, NOW);
  assert.strictEqual(completeSignup(db, t2, NOW + SIGNUP_TTL_MS), null);
  assert.strictEqual(count("organizations"), 0);
  assert.strictEqual(count("users"), 0);
});

test("purgeExpiredSignups deletes only expired requests", () => {
  reset();
  issueSignup(db, REQ, NOW);
  issueSignup(db, { ...REQ, email: "later@x.test" }, NOW + 10);
  purgeExpiredSignups(db, NOW + SIGNUP_TTL_MS);
  const left = db.prepare("SELECT email FROM signup_requests").all().map((r) => r.email);
  assert.deepStrictEqual(left, ["later@x.test"]);
});

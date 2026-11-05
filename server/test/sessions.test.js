"use strict";
// Sessions that can be ended: every login token carries the account's session version, and requireAuth refuses a token
// whose version is behind the account's. Raising the version (a password reset will do this) therefore ends every older
// session at once, with no list of tokens to keep. Same throwaway-DB setup as auth.test.js.
// Isolate the DB + secret BEFORE requiring db.js (it opens the DB at load).
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-sessions-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { addBroker } = require("../test-support/accounts");
const authRoutes = require("../routes/auth");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  return app;
}

// Plain fetch that returns the raw rr_token cookie value too, so a test can decode it or replay an old one.
async function call(base, method, p, { body, token } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { cookie: `rr_token=${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const sc = res.headers.get("set-cookie");
  const m = sc && /rr_token=([^;]+)/.exec(sc);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, token: m ? m[1] : null };
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("a token signed before this change (no sv) still works while the version is 0", async () => {
  await withServer(async (base) => {
    const user = addBroker(db, { email: "old@sessions.test", firstName: "Old", lastName: "Token", orgName: "Old Token Co" });

    // The shape every token had before the session version existed: just the user id.
    const legacy = signToken({ userId: user.id });
    assert.equal(jwt.decode(legacy).sv, undefined);

    const me = await call(base, "GET", "/api/auth/me", { token: legacy });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, "old@sessions.test");
  });
});

test("login and accept-invite tokens carry the account's current version", async () => {
  await withServer(async (base) => {
    // (a brand-new account's first session, from finishing sign-up, is checked at version 0 in signup-api.test.js)
    const vera = addBroker(db, { email: "vera@sessions.test", firstName: "Vera", lastName: "Version", orgName: "Version Co" });

    // login -> picks up whatever the account's version is by then
    db.prepare("UPDATE users SET session_version = 2 WHERE id = ?").run(vera.id);
    const login = await call(base, "POST", "/api/auth/login", { body: { email: "vera@sessions.test", password: "password123" } });
    assert.equal(login.status, 200);
    assert.equal(jwt.decode(login.token).sv, 2);

    // accept-invite -> a new LO's first session is at version 0
    const invite = "ab".repeat(32);
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted)
      VALUES (?, 'lo', 'Ivy', 'Invitee', 'ivy@sessions.test', ?, ?, 0)
    `).run(vera.org_id, require("../lib/passwordReset").hashToken(invite), expires);
    const accepted = await call(base, "POST", "/api/auth/accept-invite", { body: { token: invite, password: "password123" } });
    assert.equal(accepted.status, 200);
    assert.equal(jwt.decode(accepted.token).sv, 0);
  });
});

test("raising the version ends every older session", async () => {
  await withServer(async (base) => {
    const sam = addBroker(db, { email: "sam@sessions.test", firstName: "Sam", lastName: "Session", orgName: "Session Co" });
    const first = await call(base, "POST", "/api/auth/login", { body: { email: "sam@sessions.test", password: "password123" } });
    assert.equal(first.status, 200);

    const a = await call(base, "POST", "/api/auth/login", { body: { email: "sam@sessions.test", password: "password123" } });
    assert.equal((await call(base, "GET", "/api/auth/me", { token: a.token })).status, 200);

    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(sam.id);

    // Session A, and the first one, are both finished; a fresh login works.
    for (const old of [a.token, first.token]) {
      const stale = await call(base, "GET", "/api/auth/me", { token: old });
      assert.equal(stale.status, 401);
      assert.deepEqual(stale.data, { success: false, error: "Invalid or expired session" });
    }
    const b = await call(base, "POST", "/api/auth/login", { body: { email: "sam@sessions.test", password: "password123" } });
    assert.equal((await call(base, "GET", "/api/auth/me", { token: b.token })).status, 200);
  });
});

test("the migration adds session_version, default 0", () => {
  const col = db.prepare("PRAGMA table_info(users)").all().find((c) => c.name === "session_version");
  assert.ok(col, "users.session_version should exist");
  assert.equal(col.dflt_value, "0");
  assert.equal(col.notnull, 1);
});

"use strict";
// Auth + permissions tests against a throwaway SQLite DB. Verifies login
// (good + bad), session via httpOnly cookie, that protected routes reject
// anonymous callers, and — the key permission property — that clients are isolated
// per organization (one broker can never see another org's book).
// Isolate the DB + secret BEFORE requiring db.js (it opens the DB at load).
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-auth-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { addBroker } = require("../test-support/accounts");
const authRoutes = require("../routes/auth");
const clientRoutes = require("../routes/clients");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/clients", clientRoutes);
  return app;
}

// A tiny fetch wrapper that carries the session cookie, like a browser would.
function session(base) {
  let cookie = "";
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  };
}

test("auth flow + per-org client isolation", async () => {
  const server = makeApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;

  try {
    const alpha = session(base);

    // A broker in org "Alpha" signs in — succeeds, returns a broker, sets the cookie. (Sign-up needs an emailed link, so the
    // account is made directly; signup-api.test.js covers sign-up itself.)
    addBroker(db, { email: "ann@test.co", firstName: "Ann", orgName: "Alpha Mortgage" });
    let r = await alpha("POST", "/api/auth/login", { email: "ann@test.co", password: "password123" });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, "broker");

    // Session cookie works.
    r = await alpha("GET", "/api/auth/me");
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, "ann@test.co");

    // Wrong password is rejected.
    const badLogin = session(base);
    r = await badLogin("POST", "/api/auth/login", { email: "ann@test.co", password: "wrongpass" });
    assert.equal(r.status, 401);

    // Anonymous caller can't reach a protected route.
    const anon = session(base);
    r = await anon("GET", "/api/clients");
    assert.equal(r.status, 401);

    // Alpha broker adds a client and sees exactly one.
    r = await alpha("POST", "/api/clients", {
      name: "Test Client", loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 400000,
    });
    assert.equal(r.status, 201);
    r = await alpha("GET", "/api/clients");
    assert.equal(r.status, 200);
    assert.equal(r.data.clients.length, 1);

    // A broker in a different org sees none of Alpha's clients.
    const beta = session(base);
    addBroker(db, { email: "bob@test.co", firstName: "Bob", orgName: "Beta Mortgage" });
    r = await beta("POST", "/api/auth/login", { email: "bob@test.co", password: "password123" });
    assert.equal(r.status, 200);
    r = await beta("GET", "/api/clients");
    assert.equal(r.status, 200);
    assert.equal(r.data.clients.length, 0, "org isolation: no cross-org client visibility");
  } finally {
    server.close();
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

"use strict";
// Integration test for POST /api/sweeps and POST /api/clients/:id/contact against a
// throwaway DB. Exercises the last_contact migration, auth, org-scoping, and the sweep.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-sweep-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const authRoutes = require("../routes/auth");
const clientRoutes = require("../routes/clients");
const sweepsRoutes = require("../routes/sweeps");

const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/auth", authRoutes);
  a.use("/api/clients", clientRoutes);
  a.use("/api/sweeps", sweepsRoutes);
  return a;
}
function session(base) {
  let cookie = "";
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  };
}

test("sweeps endpoint + log-contact", async () => {
  const server = app().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = session(base);
    await s("POST", "/api/auth/register", { firstName: "Ann", lastName: "B", email: "ann@test.co", password: "password123", orgName: "Alpha" });

    // A clear opportunity and a non-opportunity.
    await s("POST", "/api/clients", { name: "Refi Ready", loanType: "30yr_fixed", currentRate: 8.0, loanBalance: 485000, propertyValue: 650000, creditScore: 760 });
    await s("POST", "/api/clients", { name: "No Op", loanType: "30yr_fixed", currentRate: 6.0, loanBalance: 142000, propertyValue: 195000, creditScore: 790 });

    // Requires rates.
    let r = await s("POST", "/api/sweeps", {});
    assert.equal(r.status, 400);

    // Runs the sweep.
    r = await s("POST", "/api/sweeps", { rates: RATES });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true);
    assert.equal(r.data.counts.total, 2);
    assert.ok(r.data.counts.withOpportunity >= 1, "the refi-ready client is flagged");
    assert.ok((r.data.byLens.rate_term || 0) >= 1);

    // Anonymous is rejected.
    const anon = session(base);
    r = await anon("POST", "/api/sweeps", { rates: RATES });
    assert.equal(r.status, 401);

    // Log a contact → last_contact gets set.
    r = await s("GET", "/api/clients");
    const id = r.data.clients[0].id;
    r = await s("POST", `/api/clients/${id}/contact`);
    assert.equal(r.status, 200);
    assert.ok(r.data.client.lastContact, "last_contact is set after logging contact");
  } finally {
    server.close();
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
  }
});

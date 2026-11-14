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

const db = require("../db");
const { addBroker } = require("../test-support/accounts");

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
    addBroker(db, { email: "ann@test.co", firstName: "Ann", lastName: "B", orgName: "Alpha" });
    assert.equal((await s("POST", "/api/auth/login", { email: "ann@test.co", password: "password123" })).status, 200);

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

test("sweep upgrade rows carry isNew from the alert table, and a reached call clears it", async () => {
  const { recordSnapshot } = require("../lib/rateHistory");
  const server = app().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = session(base);
    addBroker(db, { email: "bo@test.co", firstName: "Bo", lastName: "B", orgName: "Bravo" });
    assert.equal((await s("POST", "/api/auth/login", { email: "bo@test.co", password: "password123" })).status, 200);
    const rates = { ...RATES, rate_30yr_fha: 6.1, rate_30yr_va: 5.8 };
    const obs = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    recordSnapshot({ ...rates, date: obs, source: `Optimal Blue lock data (${obs})` }, obs, "fred");
    const made = await s("POST", "/api/clients", {
      name: "Vee Sample", loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 400000, creditScore: 720,
      loanProgram: "va", closeDate: "2025-06-15", originalAmount: 300000, originalValue: 400000, propertyZip: "85016", occupancy: "primary",
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.client.id;
    db.prepare("UPDATE clients SET balance_as_of = '2025-06-15' WHERE id = ?").run(id);

    let r = await s("POST", "/api/sweeps", { rates });
    assert.equal(r.status, 200);
    const row = r.data.upgrades.find((u) => u.clientId === id);
    assert.ok(row, JSON.stringify(r.data.upgrades));
    assert.deepStrictEqual(row.upgrades.map((l) => [l.lens, l.isNew]), [["va_irrrl", true]]);
    assert.equal(row.bestUpgrade.isNew, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM client_upgrades WHERE client_id = ?").get(id).n, 1);

    assert.equal((await s("POST", `/api/clients/${id}/contact`)).status, 200);
    r = await s("POST", "/api/sweeps", { rates });
    const after = r.data.upgrades.find((u) => u.clientId === id);
    assert.equal(after.bestUpgrade.isNew, false);
    assert.equal(after.upgrades[0].isNew, false);
  } finally {
    server.close();
  }
});

test("a failing isNew marking never fails the sweep: the rows go out unmarked, the rest unchanged", async () => {
  const upgradeAlerts = require("../lib/upgradeAlerts");
  const server = app().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;
  const real = upgradeAlerts.newAlertRows;
  const logged = [];
  const savedErr = console.error;
  try {
    const s = session(base);
    addBroker(db, { email: "cy@test.co", firstName: "Cy", lastName: "B", orgName: "Charlie Org" });
    assert.equal((await s("POST", "/api/auth/login", { email: "cy@test.co", password: "password123" })).status, 200);
    const rates = { ...RATES, rate_30yr_fha: 6.1, rate_30yr_va: 5.8 };
    const made = await s("POST", "/api/clients", {
      name: "Wes Sample", loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 400000, creditScore: 720,
      loanProgram: "va", closeDate: "2025-06-15", originalAmount: 300000, originalValue: 400000, propertyZip: "85016", occupancy: "primary",
    });
    db.prepare("UPDATE clients SET balance_as_of = '2025-06-15' WHERE id = ?").run(made.data.client.id);
    upgradeAlerts.newAlertRows = () => { throw new TypeError("secret client name"); };
    console.error = (...a) => logged.push(a.join(" "));
    const r = await s("POST", "/api/sweeps", { rates });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true);
    assert.equal(r.data.counts.total, 1);
    const row = r.data.upgrades.find((u) => u.clientId === made.data.client.id);
    assert.ok(row && row.bestUpgrade && row.upgrades.length === 1, "the upgrade row is still there");
    assert.equal("isNew" in row.bestUpgrade, false);
    assert.deepStrictEqual(logged, ["upgrade marks skipped: TypeError"]);
  } finally {
    upgradeAlerts.newAlertRows = real;
    console.error = savedErr;
    server.close();
  }
});

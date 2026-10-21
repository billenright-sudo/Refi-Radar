"use strict";
// Daily rate snapshot + movement against a throwaway DB. Exercises the rate_snapshots
// migration, the same-day upsert, and the "no prior day yet" vs "has history" movement.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-ratehist-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { recordSnapshot, getMovement } = require("../lib/rateHistory");

const PRIOR_DAY = "2000-01-01"; // always earlier than "today"
const countRows = () => db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n;

test.beforeEach(() => {
  db.prepare("DELETE FROM rate_snapshots").run();
});

test("recordSnapshot writes one row, and a second call the same day upserts (still one row)", () => {
  recordSnapshot({ rate_30yr_fixed: 7.4, rate_15yr_fixed: 6.6 });
  assert.equal(countRows(), 1);

  recordSnapshot({ rate_30yr_fixed: 7.35, rate_15yr_fixed: 6.55 });
  assert.equal(countRows(), 1, "same-day call must upsert, not insert");

  const row = db.prepare("SELECT day, rates, captured_at FROM rate_snapshots").get();
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(JSON.parse(row.rates).rate_30yr_fixed, 7.35, "latest write wins");
  assert.ok(row.captured_at, "captured_at is set");
});

test("getMovement reports no history and null deltas when only today's snapshot exists", () => {
  const today = { rate_30yr_fixed: 7.4 };
  recordSnapshot(today);

  const m = getMovement(today);
  assert.equal(m.hasHistory, false);
  assert.equal(m.deltas, null);
  assert.equal(m.previous, null);
  assert.deepEqual(m.current, today);
});

test("getMovement computes deltas against the most recent prior-day snapshot", () => {
  recordSnapshot({ rate_30yr_fixed: 7.5, rate_15yr_fixed: 6.7 }, PRIOR_DAY);
  const today = { rate_30yr_fixed: 7.4, rate_15yr_fixed: 6.7 };
  recordSnapshot(today);

  const m = getMovement(today);
  assert.equal(m.hasHistory, true);
  assert.ok(Math.abs(m.deltas.rate_30yr_fixed - -0.1) < 1e-9, `30yr delta was ${m.deltas.rate_30yr_fixed}`);
  assert.ok(Math.abs(m.deltas.rate_15yr_fixed) < 1e-9, "unchanged rate has a zero delta");
  assert.equal(m.previous.rate_30yr_fixed, 7.5);
  assert.equal(m.current.rate_30yr_fixed, 7.4);
});

test("getMovement uses the most recent prior day, not an older one", () => {
  recordSnapshot({ rate_30yr_fixed: 8.0 }, "1999-12-30");
  recordSnapshot({ rate_30yr_fixed: 7.5 }, PRIOR_DAY);

  const m = getMovement({ rate_30yr_fixed: 7.4 });
  assert.ok(Math.abs(m.deltas.rate_30yr_fixed - -0.1) < 1e-9);
});

// ── Capture-on-fetch wiring in POST /api/rates ──────────────────────────────
async function postRates() {
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/rates"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/rates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return await res.json();
  } finally {
    server.close();
  }
}

test("the hardcoded 'Estimated' last-resort rates are NOT snapshotted", async () => {
  delete process.env.FRED_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const data = await postRates();
  assert.equal(data.success, false);
  assert.equal(countRows(), 0, "estimate must never pollute the movement history");
});

test("a live FRED resolve is snapshotted", async () => {
  process.env.FRED_API_KEY = "test-fred-key";
  delete process.env.ANTHROPIC_API_KEY; // ARM falls back to the estimate; FRED still resolves
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.stlouisfed.org/")) {
      return { ok: true, json: async () => ({ observations: [{ date: "2026-10-20", value: "6.50" }] }) };
    }
    return realFetch(url, opts);
  };
  try {
    const data = await postRates();
    assert.equal(data.success, true);
    assert.equal(countRows(), 1, "live resolve writes today's snapshot");
    const stored = JSON.parse(db.prepare("SELECT rates FROM rate_snapshots").get().rates);
    assert.equal(stored.rate_30yr_fixed, 6.5);
  } finally {
    global.fetch = realFetch;
    delete process.env.FRED_API_KEY;
  }
});

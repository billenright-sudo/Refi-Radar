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

test("getMovement skips non-finite values so a NaN can't produce a NaN delta", () => {
  recordSnapshot({ rate_30yr_fixed: 7.5, rate_15yr_fixed: 6.7 }, PRIOR_DAY);

  const m = getMovement({ rate_30yr_fixed: NaN, rate_15yr_fixed: 6.6 });
  assert.equal(m.hasHistory, true);
  assert.ok(!("rate_30yr_fixed" in m.deltas), "NaN current value yields no delta");
  assert.ok(Math.abs(m.deltas.rate_15yr_fixed - -0.1) < 1e-9);
  for (const v of Object.values(m.deltas)) assert.ok(Number.isFinite(v), "every delta is finite");
});

// ── Capture-on-fetch wiring in POST /api/rates ──────────────────────────────
// Each test gets a FRESH copy of the rates router so the module-level ratesCache never
// leaks between tests (results are independent of execution order).
async function startRatesApp() {
  const express = require("express");
  delete require.cache[require.resolve("../routes/rates")];
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/rates"));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  return {
    post: async () => {
      const res = await fetch(`http://localhost:${port}/api/rates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.json();
    },
    close: () => server.close(),
  };
}

// Stub FRED only (everything else, e.g. the local server, goes through the real fetch).
function stubFred(getValue) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.stlouisfed.org/")) {
      return { ok: true, json: async () => ({ observations: [{ date: "2026-10-20", value: String(getValue()) }] }) };
    }
    return realFetch(url, opts);
  };
  return () => { global.fetch = realFetch; };
}

test("the hardcoded 'Estimated' last-resort rates are NOT snapshotted", async () => {
  delete process.env.FRED_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const app = await startRatesApp();
  try {
    const data = await app.post();
    assert.equal(data.success, false);
    assert.equal(countRows(), 0, "estimate must never pollute the movement history");
  } finally {
    app.close();
  }
});

test("a live FRED resolve is snapshotted", async () => {
  process.env.FRED_API_KEY = "test-fred-key";
  delete process.env.ANTHROPIC_API_KEY; // ARM falls back to the estimate; FRED still resolves
  const restore = stubFred(() => "6.50");
  const app = await startRatesApp();
  try {
    const data = await app.post();
    assert.equal(data.success, true);
    assert.equal(countRows(), 1, "live resolve writes today's snapshot");
    const stored = JSON.parse(db.prepare("SELECT rates FROM rate_snapshots").get().rates);
    assert.equal(stored.rate_30yr_fixed, 6.5);
  } finally {
    app.close();
    restore();
    delete process.env.FRED_API_KEY;
  }
});

test("the rates cache does not outlive the UTC day, so every served response has a same-day snapshot", async (t) => {
  process.env.FRED_API_KEY = "test-fred-key";
  delete process.env.ANTHROPIC_API_KEY;
  let fred = "6.50";
  const restore = stubFred(() => fred);
  // Mock only Date: the 6h cache window opened at 20:00 UTC still covers 01:00 UTC next day.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T20:00:00Z") });
  const app = await startRatesApp();
  try {
    const first = await app.post();
    assert.equal(first.success, true);
    assert.equal(countRows(), 1);

    // Same UTC day, inside the TTL -> still a cache hit, no extra write.
    t.mock.timers.setTime(new Date("2026-10-20T23:00:00Z").getTime());
    const sameDay = await app.post();
    assert.equal(sameDay.cached, true, "same-day request is still served from cache");
    assert.equal(countRows(), 1);

    // 01:00 UTC next day: inside the 6h TTL but a new UTC day -> must refetch and snapshot.
    fred = "6.40";
    t.mock.timers.setTime(new Date("2026-10-21T01:00:00Z").getTime());
    const nextDay = await app.post();
    assert.ok(!nextDay.cached, "cache must not span UTC midnight");
    assert.equal(nextDay.rates.rate_30yr_fixed, 6.4, "fresh data, not the previous day's payload");
    const days = db.prepare("SELECT day FROM rate_snapshots ORDER BY day").all().map((r) => r.day);
    assert.deepEqual(days, ["2026-10-20", "2026-10-21"], "a snapshot exists for the new day");

    // Movement is therefore across two real observations, never a payload compared to itself.
    const m = getMovement(nextDay.rates);
    assert.equal(m.hasHistory, true);
    assert.ok(Math.abs(m.deltas.rate_30yr_fixed - -0.1) < 1e-9);
  } finally {
    app.close();
    restore();
    delete process.env.FRED_API_KEY;
  }
});

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

// ── B3 (final review I1): provenance, the 5/1 ARM, and "since when" ───────────────────────────────────────────────────────

const { providerOf, sinceLabel } = require("../lib/rateHistory");
const FRED_SOURCE = "Optimal Blue lock data (2026-10-20) · ARM via Mortgage News Daily";
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test("B3: providerOf reads the source label: FRED, the hard-coded estimate, and everything else is the web-search fallback", () => {
  assert.equal(providerOf({ source: FRED_SOURCE }), "fred");
  assert.equal(providerOf({ source: "Optimal Blue lock data (2026-10-20) · ARM estimated" }), "fred");
  assert.equal(providerOf({ source: "Estimated — live fetch unavailable" }), "estimated");
  assert.equal(providerOf({ source: "Mortgage News Daily" }), "claude");
  assert.equal(providerOf({ rate_30yr_fixed: 6.5 }), "claude");
  assert.equal(providerOf(null), "claude");
});

test("B3: a move is computed only between snapshots from the same provider", () => {
  const cases = [
    ["fred", "fred", { source: FRED_SOURCE }, { source: FRED_SOURCE }, true],
    ["claude", "claude", { source: "Mortgage News Daily" }, { source: "Freddie Mac" }, true],
    ["claude", "fred", { source: "Mortgage News Daily" }, { source: FRED_SOURCE }, false],
    ["fred", "claude", { source: FRED_SOURCE }, { source: "Mortgage News Daily" }, false],
    ["fred", "estimated", { source: FRED_SOURCE }, { source: "Estimated — live fetch unavailable" }, false],
  ];
  for (const [before, now, prevTag, curTag, moves] of cases) {
    db.prepare("DELETE FROM rate_snapshots").run();
    recordSnapshot({ rate_30yr_fixed: 7.5, rate_15yr_fixed: 6.7, ...prevTag }, daysAgo(1));
    const m = getMovement({ rate_30yr_fixed: 7.4, rate_15yr_fixed: 6.7, ...curTag });
    const label = `${before} -> ${now}`;
    assert.equal(m.hasHistory, moves, label);
    if (moves) {
      assert.ok(Math.abs(m.deltas.rate_30yr_fixed - -0.1) < 1e-9, label);
      assert.equal(m.since, "yesterday", label);
    } else {
      assert.deepStrictEqual([m.deltas, m.previous, m.since, m.sinceDate], [null, null, null, null], label);
    }
  }
  // the provider is stored with the row
  db.prepare("DELETE FROM rate_snapshots").run();
  recordSnapshot({ rate_30yr_fixed: 7.5, source: FRED_SOURCE }, daysAgo(2));
  recordSnapshot({ rate_30yr_fixed: 7.5, source: "Mortgage News Daily" }, daysAgo(1));
  assert.deepStrictEqual(db.prepare("SELECT provider FROM rate_snapshots ORDER BY day").all().map((r) => r.provider), ["fred", "claude"]);
  // ... and it is the most recent prior snapshot that counts: a web-search day between two FRED days means no move
  assert.equal(getMovement({ rate_30yr_fixed: 7.4, source: FRED_SOURCE }).hasHistory, false);
});

test("B3: a row stored before the provider column (provider '') is read by its stored source label", () => {
  db.prepare("INSERT INTO rate_snapshots (day, rates, captured_at) VALUES (?, ?, ?)")
    .run(daysAgo(1), JSON.stringify({ rate_30yr_fixed: 7.5, source: FRED_SOURCE }), new Date().toISOString());
  assert.equal(db.prepare("SELECT provider FROM rate_snapshots").get().provider, "");
  assert.equal(getMovement({ rate_30yr_fixed: 7.4, source: FRED_SOURCE }).hasHistory, true);
  assert.equal(getMovement({ rate_30yr_fixed: 7.4, source: "Mortgage News Daily" }).hasHistory, false);
});

test("B3: the provider migration is idempotent and keeps the rows a database already had", () => {
  const { execFileSync } = require("child_process");
  const Database = require("better-sqlite3");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-ratehist-migrate-"));
  try {
    const legacy = new Database(path.join(dir, "refi-radar.db"));
    legacy.exec(`CREATE TABLE rate_snapshots (day TEXT PRIMARY KEY, rates TEXT NOT NULL, captured_at TEXT NOT NULL);
      INSERT INTO rate_snapshots (day, rates, captured_at) VALUES ('2026-10-20', '{"rate_30yr_fixed":6.5}', 'then');`);
    legacy.close();
    const boot = () => execFileSync(process.execPath, ["-e", "require('./db'); require('./db');"], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, stdio: "pipe",
    });
    boot();
    boot();   // a second start finds the column and leaves it alone
    const check = new Database(path.join(dir, "refi-radar.db"));
    const cols = check.prepare("PRAGMA table_info(rate_snapshots)").all().filter((c) => c.name === "provider");
    assert.equal(cols.length, 1);
    assert.deepStrictEqual([cols[0].type, cols[0].notnull, cols[0].dflt_value], ["TEXT", 1, "''"]);
    assert.deepStrictEqual({ ...check.prepare("SELECT day, rates, provider FROM rate_snapshots").get() }, { day: "2026-10-20", rates: '{"rate_30yr_fixed":6.5}', provider: "" });
    check.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("B3: estimated rates are never snapshotted, by the route or by recordSnapshot itself", () => {
  recordSnapshot({ rate_30yr_fixed: 6.87, source: "Estimated — live fetch unavailable" });
  recordSnapshot({ rate_30yr_fixed: 6.87, source: "estimated rates" }, daysAgo(1));
  assert.equal(countRows(), 0);
});

test("B3: the 5/1 ARM has no delta; its level is still the current one", () => {
  recordSnapshot({ rate_30yr_fixed: 7.5, rate_5_1_arm: 7.4, source: FRED_SOURCE }, daysAgo(1));
  const m = getMovement({ rate_30yr_fixed: 7.4, rate_5_1_arm: 7.1, source: FRED_SOURCE });
  assert.equal(m.hasHistory, true);
  assert.equal("rate_5_1_arm" in m.deltas, false);
  assert.equal(m.current.rate_5_1_arm, 7.1);
});

test("B3: since is 'yesterday' for one day, the weekday for two to six, the date beyond (with the year when it differs)", () => {
  assert.equal(sinceLabel("2026-10-24", "2026-10-25"), "yesterday");
  assert.equal(sinceLabel("2026-10-22", "2026-10-25"), "Thursday", "3 days");
  assert.equal(sinceLabel("2026-10-23", "2026-10-25"), "Friday", "2 days");
  assert.equal(sinceLabel("2026-10-19", "2026-10-25"), "Monday", "6 days");
  assert.equal(sinceLabel("2026-10-15", "2026-10-25"), "October 15", "10 days");
  assert.equal(sinceLabel("2026-10-18", "2026-10-25"), "October 18", "7 days");
  assert.equal(sinceLabel("2025-12-30", "2026-01-02"), "Tuesday", "across a year end, within six days");
  assert.equal(sinceLabel("2025-12-20", "2026-01-02"), "December 20, 2025");
  // through getMovement, against today's real date
  for (const [n, expected] of [[1, "yesterday"], [3, sinceLabel(daysAgo(3))], [10, sinceLabel(daysAgo(10))]]) {
    db.prepare("DELETE FROM rate_snapshots").run();
    recordSnapshot({ rate_30yr_fixed: 7.5, source: FRED_SOURCE }, daysAgo(n));
    const m = getMovement({ rate_30yr_fixed: 7.4, source: FRED_SOURCE });
    assert.equal(m.since, expected, `${n} days`);
    assert.equal(m.sinceDate, daysAgo(n));
  }
  assert.match(sinceLabel(daysAgo(3)), /^(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day$/);
  assert.match(sinceLabel(daysAgo(10)), /^[A-Z][a-z]+ \d{1,2}(?:, \d{4})?$/);
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
    assert.equal(db.prepare("SELECT provider FROM rate_snapshots").get().provider, "fred", "B3: stored with its provider");
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

"use strict";
// FRED-only fetch (lib/fred.js), the rates cache (lib/ratesCache.js) and recording one FRED observation (rateHistory.recordFredObservation).
// Offline: an injected fetch answers FRED JSON per series_id and records every URL.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-fred-"));
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const F = require("../lib/fred");
const cache = require("../lib/ratesCache");
const { recordFredObservation, recordSnapshot } = require("../lib/rateHistory");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const at = (iso) => Date.parse(iso);
const NOV25_15Z = at("2026-11-25T15:00:00Z");
const NOV25_16Z = at("2026-11-25T16:00:00Z");
const NOV25_17Z = at("2026-11-25T17:00:00Z");
const NOV25_18Z = at("2026-11-25T18:00:00Z");

// A fetch that answers FRED's observations JSON per series_id. `overrides` replace what a series says; every URL is recorded.
function fakeFred(overrides = {}, { failSeries = [] } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const id = new URL(url).searchParams.get("series_id");
    if (failSeries.includes(id)) return { ok: false, status: 500, json: async () => ({}) };
    const base = {
      OBMMIC30YF: [["2026-11-24", "6.402"], ["2026-11-21", "6.555"]],
      OBMMIC15YF: [["2026-11-24", "5.700"]],
      OBMMIJUMBO30YF: [["2026-11-24", "6.600"]],
      OBMMIFHA30YF: [["2026-11-24", "6.100"]],
      OBMMIC30YFLVLE80FGE740: [["2026-11-24", "6.350"]],
      OBMMIVA30YF: [["2026-11-24", "6.050"]],
    };
    const list = overrides[id] || base[id];
    return { ok: true, status: 200, json: async () => ({ observations: list.map(([date, value]) => ({ date, value })) }) };
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}

test("fetchFredObservations reads the latest two 30-year observations, skipping '.'", async () => {
  const obs = await F.fetchFredObservations({
    fredKey: "k", fetchImpl: fakeFred({ OBMMIC30YF: [["2026-11-25", "."], ["2026-11-24", "6.402"], ["2026-11-21", "6.555"]] }),
  });
  assert.deepEqual(obs.obmmi.rate_30yr_fixed, { date: "2026-11-24", value: 6.402 });
  assert.deepEqual(obs.previous30, { date: "2026-11-21", value: 6.555 });
  assert.deepEqual(obs.va, { date: "2026-11-24", value: 6.05 });
  assert.deepEqual(Object.keys(obs.obmmi).sort(), ["rate_15yr_fixed", "rate_30yr_fha", "rate_30yr_fixed", "rate_30yr_jumbo", "rate_30yr_top_tier"]);
});

test("only api.stlouisfed.org is called, six series, limit 5", async () => {
  const f = fakeFred();
  await F.fetchFredObservations({ fredKey: "k", fetchImpl: f });
  assert.equal(f.urls.length, 6);
  for (const u of f.urls) {
    assert.ok(u.startsWith("https://api.stlouisfed.org/fred/"), u);
    assert.match(u, /limit=5/);
  }
});

test("a VA failure gives va: null; an OBMMI failure throws; no key throws", async () => {
  const realError = console.error;
  console.error = () => {};
  try {
    const obs = await F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred({}, { failSeries: ["OBMMIVA30YF"] }) });
    assert.equal(obs.va, null);
    await assert.rejects(F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred({}, { failSeries: ["OBMMIC15YF"] }) }), /HTTP 500/);
    await assert.rejects(F.fetchFredObservations({ fredKey: "", fetchImpl: fakeFred() }), /not configured/);
  } finally {
    console.error = realError;
  }
});

test("the fetch has a timeout: a hung FRED aborts", async () => {
  const realError = console.error;
  console.error = () => {};
  const hung = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
  });
  try {
    await assert.rejects(F.fetchFredObservations({ fredKey: "k", fetchImpl: hung, timeoutMs: 30 }), (err) => err.name === "AbortError");
  } finally {
    console.error = realError;
  }
});

test("fredRateSet builds the exact set /api/rates serves", async () => {
  const obs = await F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred() });
  assert.deepEqual(F.fredRateSet(obs, { arm: 6.3, armSource: "ARM estimated" }), {
    rate_30yr_fixed: 6.402, rate_15yr_fixed: 5.7, rate_5_1_arm: 6.3, rate_30yr_jumbo: 6.6, rate_30yr_fha: 6.1, rate_30yr_va: 6.05,
    rate_30yr_top_tier: 6.35, date: "2026-11-24", source: "Optimal Blue lock data (2026-11-24) · ARM estimated",
  });
  const noVa = F.fredRateSet({ ...obs, va: null }, { arm: 6.3, armSource: "ARM estimated" });
  assert.equal("rate_30yr_va" in noVa, false);
});

test("a partial publish is not one observation", async () => {
  const whole = await F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred() });
  assert.equal(F.sameObservation(whole), true);
  const partial = await F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred({ OBMMIC15YF: [["2026-11-21", "5.8"]] }) });
  assert.equal(F.sameObservation(partial), false);
});

test("the rates cache: fresh, same UTC day only, cleared", () => {
  cache.clear();
  assert.equal(cache.get(NOV25_15Z), null);
  cache.set({ success: true }, NOV25_15Z);
  assert.deepEqual(cache.get(NOV25_16Z), { success: true });
  assert.equal(cache.get(NOV25_15Z + 6 * 3600_000 + 1), null, "past the 6 hours");
  cache.set({ success: true }, at("2026-11-25T22:00:00Z"));
  assert.equal(cache.get(at("2026-11-26T00:30:00Z")), null, "not served after UTC midnight");
  cache.set({ success: true }, NOV25_15Z);
  cache.clear();
  assert.equal(cache.get(NOV25_16Z), null);
});

// ── recordFredObservation ─────────────────────────────────────────────────────

const set = (obs, v30, extra = {}) => ({
  rate_30yr_fixed: v30, rate_15yr_fixed: 5.7, rate_5_1_arm: Math.round((v30 - 0.1) * 100) / 100, rate_30yr_jumbo: 6.6, rate_30yr_fha: 6.1,
  rate_30yr_top_tier: 6.35, date: obs, source: `Optimal Blue lock data (${obs}) · ARM estimated`, ...extra,
});
const snapshotRow = (day) => db.prepare("SELECT * FROM rate_snapshots WHERE day = ?").get(day);

test("recordFredObservation: new, same, revised, older", () => {
  db.prepare("DELETE FROM rate_snapshots").run();
  assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_15Z), "new");
  const before = snapshotRow("2026-11-25");
  assert.equal(before.provider, "fred");
  assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_16Z), "same");
  assert.deepEqual(snapshotRow("2026-11-25"), before);
  assert.equal(recordFredObservation(set("2026-11-24", 6.39), NOV25_17Z), "revised");
  assert.equal(recordFredObservation(set("2026-11-21", 6.555), NOV25_18Z), "older");
  assert.equal(JSON.parse(snapshotRow("2026-11-25").rates).rate_30yr_fixed, 6.39);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n, 1);
});

test("a 'same' observation keeps a web-searched ARM the route stored", () => {
  db.prepare("DELETE FROM rate_snapshots").run();
  recordSnapshot(set("2026-11-24", 6.402, { rate_5_1_arm: 6.01, source: "Optimal Blue lock data (2026-11-24) · ARM via Sample Source" }), "2026-11-25", "fred");
  assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_16Z), "same");
  assert.equal(JSON.parse(snapshotRow("2026-11-25").rates).rate_5_1_arm, 6.01);
});

test("a newer observation is 'new' under the UTC day of the call; a set with no real date is 'older' and stores nothing", () => {
  db.prepare("DELETE FROM rate_snapshots").run();
  recordFredObservation(set("2026-11-21", 6.555), at("2026-11-22T12:00:00Z"));
  assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_15Z), "new");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n, 2);
  assert.equal(recordFredObservation(set("2026-02-30", 6.0), NOV25_16Z), "older");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n, 2);
});

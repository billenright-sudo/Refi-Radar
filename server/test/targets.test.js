"use strict";
// Target-rate alerts engine (lib/targets.js): columns, parsing, the estimate, the FRED-only snapshot, the check, the views.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-targets-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const { recordSnapshot } = require("../lib/rateHistory");
const T = require("../lib/targets");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const BASE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const live = (obs, numbers = {}) => ({ ...BASE, ...numbers, date: obs, source: `Optimal Blue lock data (${obs})` });
const RANGE = { error: "A target rate is a number from 1.000 to 15.000." };

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, email, first, last) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', ?, ?, ?)"
).run(orgId, first, last, email).lastInsertRowid);
const orgA = addOrg("Org A");
const orgB = addOrg("Org B");
const ann = addUser(orgA, "ann@targets.test", "Ann", "Broker");
const lou = addUser(orgA, "lou@targets.test", "Lou", "Officer");
const zed = addUser(orgB, "zed@targets.test", "Zed", "Other");

function addClient(orgId, userId, name, fields = {}) {
  const f = { loanType: "30yr_fixed", rate: 6.75, balance: 300000, value: 400000, score: 760, ...fields };
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, name, f.loanType, f.rate, f.balance, f.value, f.score).lastInsertRowid);
}
const get = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const setCols = (id, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
};

test.beforeEach(() => {
  for (const table of ["contact_log", "rate_snapshots", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

test("migration adds the nine target columns, nullable", () => {
  const cols = db.prepare("PRAGMA table_info(clients)").all();
  for (const name of ["target_rate", "target_set_by", "target_set_at", "target_reached_on", "target_reached_rate",
    "target_reached_at", "target_announced_on", "target_checked_on", "target_checked_rate"]) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, name);
    assert.equal(col.notnull, 0, name);
    assert.equal(col.dflt_value, null, name);
  }
  const id = addClient(orgA, ann, "Plain");
  const row = get(id);
  for (const k of Object.keys(row).filter((k) => k.startsWith("target_"))) assert.equal(row[k], null, k);
});

test("parseTarget", () => {
  assert.deepEqual(T.parseTarget(6), { rate: 6 });
  assert.deepEqual(T.parseTarget("5.875"), { rate: 5.875 });
  assert.deepEqual(T.parseTarget(5.87549), { rate: 5.875 });
  assert.deepEqual(T.parseTarget(null), { rate: null });
  assert.deepEqual(T.parseTarget(undefined), { rate: null });
  assert.deepEqual(T.parseTarget(""), { rate: null });
  for (const bad of [0.5, 15.5, "6%", "1e1", NaN]) assert.deepEqual(T.parseTarget(bad), RANGE, String(bad));
  assert.equal(T.notBelowError("Lucy Tran", 6.5), "A target has to be below Lucy Tran's current rate of 6.500%.");
});

test("estimateRate matches the client page", () => {
  const row = { loan_type: "30yr_fixed", current_rate: 7.5, loan_balance: 320000, property_value: 400000, credit_score: 760 };
  const want = T.round3(refi.analyze(refi.norm(row), BASE).effRate);
  assert.equal(T.estimateRate(row, BASE), want);

  const arm = { ...row, loan_type: "5_1_arm" };
  assert.equal(T.estimateRate(arm, BASE), want);
  assert.notEqual(T.round3(refi.analyze(refi.norm(arm), BASE).effRate), want);

  const noTop = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81 };
  const market = T.estimateRate(row, noTop);
  assert.equal(market, T.round3(refi.analyze(refi.norm(row), noTop).effRate));
  assert.notEqual(market, want);

  assert.equal(T.estimateRate({ ...row, loan_balance: 0 }, BASE), null);
  assert.equal(T.estimateRate({ ...row, property_value: 0 }, BASE), null);
  assert.equal(T.estimateRate({ ...row, current_rate: 0 }, BASE), null);
});

test("latestRealSnapshot: the greatest observation date wins over capture order", () => {
  assert.equal(T.latestRealSnapshot(db), null);
  recordSnapshot(live("2026-11-05"), "2026-11-09", "fred");   // captured late, an older observation
  recordSnapshot(live("2026-11-06"), "2026-11-07", "fred");
  const snap = T.latestRealSnapshot(db);
  assert.equal(snap.obsDate, "2026-11-06");
  assert.equal(snap.rates.date, "2026-11-06");
});

test("a claude snapshot never acts", () => {
  recordSnapshot(live("2026-11-05"), "2026-11-05", "fred");
  recordSnapshot({ ...live("2026-11-08"), source: "web search" }, "2026-11-08", "claude");
  assert.equal(T.latestRealSnapshot(db).obsDate, "2026-11-05");
  db.prepare("DELETE FROM rate_snapshots WHERE day = ?").run("2026-11-05");
  assert.equal(T.latestRealSnapshot(db), null);
});

test("nextTargetFields", () => {
  const NOW = "2026-11-09 15:00:00";
  const base = { target_rate: 6.0, current_rate: 6.75, target_reached_on: null, target_reached_rate: null,
    target_reached_at: null, target_announced_on: null, target_checked_on: null, target_checked_rate: null };
  // every check writes its day and the estimate it used (null when the client can't be priced)
  const checked = (day, est) => ({ target_checked_on: day, target_checked_rate: est });
  const cleared = { target_reached_on: null, target_reached_rate: null, target_reached_at: null, target_announced_on: null };

  const hit = T.nextTargetFields(base, 5.99, "2026-11-02", NOW);
  assert.deepEqual(hit, { ...checked("2026-11-02", 5.99), target_reached_on: "2026-11-02", target_reached_rate: 5.99,
    target_reached_at: NOW, target_announced_on: null });

  // wobble: the hit is kept while the estimate drifts
  let row = { ...base, ...hit, target_announced_on: "2026-11-03" };
  assert.deepEqual(T.nextTargetFields(row, 6.01, "2026-11-03", NOW), checked("2026-11-03", 6.01));
  row = { ...row, target_checked_on: "2026-11-03" };
  assert.deepEqual(T.nextTargetFields(row, 5.995, "2026-11-04", NOW), checked("2026-11-04", 5.995));
  row = { ...row, target_checked_on: "2026-11-04" };

  // re-arm at 0.125 above target, not below it
  assert.deepEqual(T.nextTargetFields(row, 6.124, "2026-11-05", NOW), checked("2026-11-05", 6.124));
  assert.deepEqual(T.nextTargetFields(row, 6.125, "2026-11-05", NOW), { ...checked("2026-11-05", 6.125), ...cleared });

  // a repeated observation is not a new check
  assert.equal(T.nextTargetFields({ ...base, target_checked_on: "2026-11-02" }, 5.9, "2026-11-02", NOW), null);
  assert.equal(T.nextTargetFields({ ...base, target_checked_on: "2026-11-02" }, 5.9, "2026-11-01", NOW), null);

  // current rate at or below target clears a hit, never sets one
  assert.deepEqual(T.nextTargetFields({ ...row, current_rate: 5.9 }, 5.5, "2026-11-05", NOW), { ...checked("2026-11-05", 5.5), ...cleared });
  assert.deepEqual(T.nextTargetFields({ ...base, current_rate: 6.0 }, 5.5, "2026-11-05", NOW), checked("2026-11-05", 5.5));

  // unpriceable: only the check day, with no estimate; a stored hit is kept
  assert.deepEqual(T.nextTargetFields(base, null, "2026-11-05", NOW), checked("2026-11-05", null));
  assert.deepEqual(T.nextTargetFields({ ...row, target_checked_rate: 6.01 }, null, "2026-11-05", NOW), checked("2026-11-05", null));

  // no target
  assert.equal(T.nextTargetFields({ ...base, target_rate: null }, 5.0, "2026-11-05", NOW), null);

  // already there when set
  assert.deepEqual(T.nextTargetFields({ ...base, target_rate: 5.875 }, 5.875, "2026-11-09", NOW), {
    ...checked("2026-11-09", 5.875), target_reached_on: "2026-11-09", target_reached_rate: 5.875,
    target_reached_at: NOW, target_announced_on: null });
});

test("checkTargets", () => {
  const a1 = addClient(orgA, ann, "Hits", { rate: 7.5, balance: 320000, value: 400000 });
  const a2 = addClient(orgA, lou, "Checked already", { rate: 7.5, balance: 320000, value: 400000 });
  const a3 = addClient(orgA, ann, "No target", { rate: 7.5 });
  const b1 = addClient(orgB, zed, "Other org", { rate: 7.5, balance: 320000, value: 400000 });
  const est = T.estimateRate(get(a1), live("2026-11-06"));
  const stamp = "2026-01-01 00:00:00";
  for (const id of [a1, a2, b1]) setCols(id, { target_rate: est + 0.05, updated_at: stamp });
  setCols(a2, { target_checked_on: "2026-11-06" });

  assert.equal(T.checkTargets(db, orgA, Date.UTC(2026, 10, 9, 15, 0, 0)), null);   // no snapshot: no writes
  assert.equal(get(a1).target_checked_on, null);

  recordSnapshot(live("2026-11-06"), "2026-11-09", "fred");
  const snap = T.checkTargets(db, orgA, Date.UTC(2026, 10, 9, 15, 0, 0));
  assert.equal(snap.obsDate, "2026-11-06");

  const r1 = get(a1);
  assert.equal(r1.target_checked_on, "2026-11-06");
  assert.equal(r1.target_checked_rate, est);            // the estimate the check used, kept with its day
  assert.equal(r1.target_reached_on, "2026-11-06");
  assert.equal(r1.target_reached_rate, est);
  assert.equal(r1.target_reached_at, "2026-11-09 15:00:00");
  assert.equal(r1.updated_at, stamp);
  assert.equal(get(a2).target_reached_on, null);        // already checked that observation
  assert.equal(get(a3).target_checked_on, null);        // no target
  assert.equal(get(b1).target_checked_on, null);        // another org
  assert.equal(get(a2).updated_at, stamp);
});

test("targetView states, from the stored check", () => {
  const mk = (fields = {}) => ({ ...get(addClient(orgA, ann, "V", { rate: 7.5, balance: 320000, value: 400000 })),
    target_rate: 6.0, target_set_at: "2026-11-01 10:00:00", target_checked_on: "2026-11-06", target_checked_rate: 6.2, ...fields });

  assert.equal(T.targetView(mk({ target_rate: null }), null), null);

  const w = T.targetView(mk(), null);
  assert.deepEqual(w, { rate: 6, state: "watching", estRate: 6.2, gap: 0.2, asOf: "2026-11-06",
    reachedOn: null, reachedRate: null, handledAt: null, setAt: "2026-11-01 10:00:00" });
  // the loan's figures changed after the check (an import, a feed update): the line still says what the check used
  assert.deepEqual(T.targetView(mk({ credit_score: 600, property_value: 330000 }), null), w);

  const hitFields = { target_reached_on: "2026-11-05", target_reached_rate: 5.99, target_reached_at: "2026-11-09 15:00:00" };
  const at = T.targetView(mk(hitFields), null);
  assert.equal(at.state, "at_target");
  assert.equal(at.reachedOn, "2026-11-05");
  assert.equal(at.reachedRate, 5.99);
  assert.equal(at.estRate, null);
  assert.equal(at.gap, null);
  assert.equal(at.asOf, null);

  const done = T.targetView(mk(hitFields), "2026-11-09 18:00:00");
  assert.equal(done.state, "handled");
  assert.equal(done.handledAt, "2026-11-09 18:00:00");

  assert.equal(T.targetView(mk({ current_rate: 6.0 }), null).state, "already_below");   // the loan as it is now
  assert.equal(T.targetView(mk({ target_checked_rate: null }), null).state, "unpriceable");
  assert.equal(T.targetView(mk({ target_checked_on: null, target_checked_rate: null }), null).state, "no_rates");
  // a check that stored no hit on an estimate at or under the target (the loan was at or below it then, and an import has since
  // raised it) is never watching
  assert.equal(T.targetView(mk({ target_checked_rate: 5.9 }), null).state, "unpriceable");
});

test("property: a watching view is above its target, with the figures of the last check", () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (lo, hi) => T.round3(lo + rand() * (hi - lo));
  const NOW = "2026-11-09 15:00:00";
  let watching = 0;
  for (let run = 0; run < 400; run++) {
    let row = { target_rate: pick(5, 7), current_rate: pick(4.5, 7.5), target_set_at: null, target_reached_on: null,
      target_reached_rate: null, target_reached_at: null, target_announced_on: null, target_checked_on: null, target_checked_rate: null };
    let day = 1;
    for (let step = 0; step < 12; step++) {
      const move = rand();
      if (move < 0.55) {                       // a new FRED observation, priced or not
        const obs = `2026-11-${String(day++).padStart(2, "0")}`;
        const patch = T.nextTargetFields(row, rand() < 0.1 ? null : pick(5, 7.2), obs, NOW);
        if (patch) row = { ...row, ...patch };
      } else if (move < 0.8) {                 // an import or the LOS feed moves the loan's rate: no target column changes
        row = { ...row, current_rate: pick(4.5, 7.5) };
      } else {                                 // the broker changes the target: the hit and the check are forgotten
        row = { ...row, target_rate: pick(5, 7), target_reached_on: null, target_reached_rate: null, target_reached_at: null,
          target_announced_on: null, target_checked_on: null, target_checked_rate: null };
      }
      const v = T.targetView(row, null);
      if (v.state !== "watching") continue;
      watching += 1;
      assert.ok(v.gap > 0, JSON.stringify({ row, v }));
      assert.equal(v.estRate, row.target_checked_rate);
      assert.equal(v.asOf, row.target_checked_on);
      assert.equal(v.gap, T.round3(row.target_checked_rate - row.target_rate));
    }
  }
  assert.ok(watching > 100, `watching is reached often enough to mean something (${watching})`);
});

test("a not-reached call does not handle it", () => {
  const id = addClient(orgA, ann, "Called");
  setCols(id, { target_rate: 6.0, target_reached_on: "2026-11-05", target_reached_rate: 5.99, target_reached_at: "2026-11-09 15:00:00" });
  const log = (at, outcome) => db.prepare("INSERT INTO contact_log (client_id, user_id, at, outcome) VALUES (?, ?, ?, ?)").run(id, ann, at, outcome);
  log("2026-11-09 14:00:00", "reached");       // before the hit
  log("2026-11-09 16:00:00", "not_reached");   // not a conversation
  assert.equal(T.handledAtFor(db, [get(id)]).get(id), undefined);
  log("2026-11-09 17:00:00", "reached");
  log("2026-11-09 19:00:00", "reached");
  const handled = T.handledAtFor(db, [get(id)]);
  assert.equal(handled.get(id), "2026-11-09 17:00:00");
  const v = T.viewsFor(db, [get(id)], ann).get(id);
  assert.equal(v.state, "handled");
  assert.equal(v.handledAt, "2026-11-09 17:00:00");
});

test("viewsFor names the owner on a teammate's client only", () => {
  const mine = addClient(orgA, ann, "Mine");
  const theirs = addClient(orgA, lou, "Theirs");
  const none = addClient(orgA, lou, "No target");
  setCols(mine, { target_rate: 6.0 });
  setCols(theirs, { target_rate: 6.0 });
  const rows = [mine, theirs, none].map(get);
  const views = T.viewsFor(db, rows, ann);
  assert.equal(views.size, 2);
  assert.equal("ownerName" in views.get(mine), false);
  assert.equal(views.get(theirs).ownerName, "Lou Officer");
  assert.equal(views.has(none), false);
});

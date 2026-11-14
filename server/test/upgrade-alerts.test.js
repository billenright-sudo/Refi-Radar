"use strict";
// Upgrade alerts (lib/upgradeAlerts.js): the client_upgrades table, the check on a FRED snapshot, re-arming, the views, announcing.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-upalerts-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { recordSnapshot } = require("../lib/rateHistory");
const A = require("../lib/upgradeAlerts");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const BASE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, rate_30yr_fha: 6.1, rate_30yr_va: 5.8 };
const live = (obs, numbers = {}) => ({ ...BASE, ...numbers, date: obs, source: `Optimal Blue lock data (${obs})` });
const snapshot = (obs, numbers) => recordSnapshot(live(obs, numbers), obs, "fred");
const NOW = Date.parse("2026-11-13T15:00:00Z");
const NOW_SQL = "2026-11-13 15:00:00";

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid);
const userId = Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'Ann', 'Broker', 'ann@upalerts.test')"
).run(orgId).lastInsertRowid);

// A VA client with a 7.5% loan closed in mid-2025: the IRRRL qualifies while the VA rate is 5.8 and not when it is 7.3.
function addVa(name = "Vee Sample", fields = {}) {
  const f = { rate: 7.5, program: "va", ...fields };
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, credit_score_known,
      loan_program, close_date, balance_as_of, original_amount, original_value, property_zip, occupancy)
    VALUES (?, ?, ?, '30yr_fixed', ?, 300000, 400000, 720, 1, ?, '2025-06-15', '2025-06-15', 300000, 400000, '85016', 'primary')
  `).run(orgId, userId, name, f.rate, f.program).lastInsertRowid);
}
const alerts = () => db.prepare("SELECT * FROM client_upgrades ORDER BY client_id, lens").all();
const rowsOf = (...ids) => ids.map((id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id));
const addContact = (clientId, at, outcome = "reached") =>
  db.prepare("INSERT INTO contact_log (client_id, user_id, at, outcome) VALUES (?, ?, ?, ?)").run(clientId, userId, at, outcome);

test.beforeEach(() => {
  for (const table of ["client_upgrades", "contact_log", "rate_snapshots", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

test("first check records a newly qualifying lens with the snapshot day", () => {
  const id = addVa();
  snapshot("2026-11-12");
  const check = A.checkUpgrades(db, orgId, NOW);
  assert.equal(check.obsDate, "2026-11-12");
  assert.equal(check.today, "2026-11-13");
  assert.ok(check.results.get(id).lenses.some((l) => l.lens === "va_irrrl"));
  assert.deepStrictEqual(alerts(), [{ client_id: id, lens: "va_irrrl", first_seen_on: "2026-11-12", first_seen_at: NOW_SQL, announced_on: null }]);
});

test("a second check the same day writes nothing", () => {
  addVa();
  snapshot("2026-11-12");
  A.checkUpgrades(db, orgId, NOW);
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  A.checkUpgrades(db, orgId, NOW + 3600_000);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before, "no write at all");
  assert.equal(alerts()[0].first_seen_at, NOW_SQL);
});

test("a check never touches updated_at, and skips clients with no program", () => {
  const id = addVa();
  const none = addVa("No Program", { program: "" });
  db.prepare("UPDATE clients SET updated_at = '2020-01-01 00:00:00'").run();
  snapshot("2026-11-12");
  const check = A.checkUpgrades(db, orgId, NOW);
  assert.deepStrictEqual(db.prepare("SELECT DISTINCT updated_at FROM clients").all(), [{ updated_at: "2020-01-01 00:00:00" }]);
  assert.ok(check.results.has(id));
  assert.ok(!check.results.has(none));
});

test("a lens that stops qualifying is deleted, and comes back as new", () => {
  const id = addVa();
  snapshot("2026-11-12");
  A.checkUpgrades(db, orgId, NOW);
  assert.equal(alerts().length, 1);
  snapshot("2026-11-13", { rate_30yr_va: 7.3, rate_30yr_fixed: 7.4 });   // rates rise: a 0.2-point drop is no IRRRL
  A.checkUpgrades(db, orgId, NOW + 86400_000);
  assert.deepStrictEqual(alerts(), []);
  snapshot("2026-11-14");
  const later = NOW + 2 * 86400_000;
  const check = A.checkUpgrades(db, orgId, later);
  const [row] = alerts();
  assert.equal(row.first_seen_on, "2026-11-14");
  assert.equal(row.announced_on, null);
  const view = A.upgradeViewsFor(db, rowsOf(id), check, later).get(id);
  assert.deepStrictEqual(view.newLenses, ["va_irrrl"]);
  assert.equal(view.lenses.find((l) => l.lens === "va_irrrl").isNew, true);
});

test("a reached contact after first_seen_at clears isNew; one before does not", () => {
  const id = addVa();
  snapshot("2026-11-12");
  const check = A.checkUpgrades(db, orgId, NOW);
  addContact(id, "2026-11-13 14:59:59");                  // before
  addContact(id, "2026-11-13 16:00:00", "not_reached");   // after, but not reached
  assert.deepStrictEqual(A.upgradeViewsFor(db, rowsOf(id), check, NOW).get(id).newLenses, ["va_irrrl"]);
  addContact(id, "2026-11-13 16:00:00");
  const view = A.upgradeViewsFor(db, rowsOf(id), check, NOW).get(id);
  assert.deepStrictEqual(view.newLenses, []);
  assert.equal(view.lenses.find((l) => l.lens === "va_irrrl").isNew, false);
  assert.equal(alerts().length, 1, "the alert row stays: handled is not re-armed");
});

test("no FRED snapshot: checkUpgrades is null and views still carry gaps", () => {
  const id = addVa("Vee");
  const bare = addVa("Bare", { program: "" });
  recordSnapshot({ ...BASE, date: "2026-11-12", source: "web search" }, "2026-11-12", "claude");
  assert.equal(A.checkUpgrades(db, orgId, NOW), null);
  assert.equal(A.safeCheckUpgrades(db, orgId, NOW), null);
  const views = A.upgradeViewsFor(db, rowsOf(id, bare), null, NOW);
  assert.deepStrictEqual(views.get(id).lenses, []);
  assert.equal(views.get(id).today.balance > 0, true);
  assert.deepStrictEqual(views.get(bare).gaps, ["Add the loan program to check upgrades."]);
  assert.deepStrictEqual(alerts(), []);
});

test("safeCheckUpgrades logs only the error name", () => {
  const seen = [];
  const saved = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    const broken = { prepare() { throw new TypeError("secret client name"); } };
    assert.equal(A.safeCheckUpgrades(broken, orgId, NOW), null);
  } finally { console.error = saved; }
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("secret"), seen[0]);
});

test("newlyQualified / announceUpgrades: announced once; the same day still listed; the next day not", () => {
  const id = addVa("Vee Sample");
  snapshot("2026-11-12");
  const check = A.checkUpgrades(db, orgId, NOW);
  const rows = rowsOf(id);
  const views = A.upgradeViewsFor(db, rows, check, NOW);
  const pairs = A.newlyQualified(db, rows, views, "2026-11-13");
  assert.deepStrictEqual(pairs, [{ clientId: id, name: "Vee Sample", lens: "va_irrrl" }]);
  A.announceUpgrades(db, pairs, "2026-11-13");
  A.announceUpgrades(db, pairs, "2026-11-14");   // already announced: keeps its day
  assert.equal(alerts()[0].announced_on, "2026-11-13");
  assert.deepStrictEqual(A.newlyQualified(db, rows, views, "2026-11-13"), pairs);
  assert.deepStrictEqual(A.newlyQualified(db, rows, views, "2026-11-14"), []);
});

test("newlyQualified skips a handled alert", () => {
  const id = addVa();
  snapshot("2026-11-12");
  const check = A.checkUpgrades(db, orgId, NOW);
  addContact(id, "2026-11-13 16:00:00");
  const rows = rowsOf(id);
  assert.deepStrictEqual(A.newlyQualified(db, rows, A.upgradeViewsFor(db, rows, check, NOW), "2026-11-13"), []);
});

// ── I5: one rate set for every upgrade surface, and no refi upgrade on a snapshot more than 10 days old ─────────────────────
// A conventional client whose typed PMI can be dropped (balance under 80% of the original value): Drop PMI prices nothing.
function addPmi(name = "Pam Sample") {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, credit_score_known,
      loan_program, monthly_mi, close_date, balance_as_of, original_amount, original_value, property_zip, occupancy)
    VALUES (?, ?, ?, '30yr_fixed', 6.5, 238000, 300000, 700, 0, 'conventional', 95, '2022-03-15', '2026-11-13', 285000, 300000, '', 'primary')
  `).run(orgId, userId, name).lastInsertRowid);
}

test("ratesForUpgrades: the snapshot's rates up to 10 days old, else (or without one) null", () => {
  const snap = (obsDate) => ({ rates: live(obsDate), obsDate });
  assert.deepStrictEqual(A.ratesForUpgrades(snap("2026-11-03"), "2026-11-13"), live("2026-11-03"));   // 10 days
  assert.deepStrictEqual(A.ratesForUpgrades(snap("2026-11-13"), "2026-11-13"), live("2026-11-13"));
  assert.equal(A.ratesForUpgrades(snap("2026-11-02"), "2026-11-13"), null);                           // 11 days
  assert.equal(A.ratesForUpgrades(null, "2026-11-13"), null);
  assert.equal(A.ratesForUpgrades(snap("garbage"), "2026-11-13"), null);
});

test("upgradeRates / safeUpgradeRates: the latest FRED snapshot's rates on the clock's UTC day; a failure logs its name only", () => {
  assert.equal(A.upgradeRates(db, NOW), null, "no snapshot");
  assert.equal(A.upgradeRates(db, NOW, "fallback"), "fallback", "no snapshot: the caller's fallback");
  snapshot("2026-11-02");
  assert.equal(A.upgradeRates(db, NOW, "fallback"), null, "11 days old: none, even with a fallback");
  snapshot("2026-11-03");
  assert.deepStrictEqual(A.safeUpgradeRates(db, NOW), live("2026-11-03"));
  const seen = [];
  const saved = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    assert.equal(A.safeUpgradeRates({ prepare() { throw new TypeError("secret client name"); } }, NOW), null);
  } finally { console.error = saved; }
  assert.deepStrictEqual(seen, ["upgrade rates skipped: TypeError"]);
});

test("a snapshot 11 days old: no refi upgrade is checked (its alert re-arms), Drop PMI still qualifies", () => {
  const va = addVa();
  const pmi = addPmi();
  snapshot("2026-11-03");   // 10 days: the IRRRL qualifies
  let check = A.checkUpgrades(db, orgId, NOW);
  assert.deepStrictEqual(check.results.get(va).lenses.map((l) => l.lens), ["va_irrrl"]);
  assert.deepStrictEqual(alerts().map((a) => a.lens).sort(), ["drop_pmi", "va_irrrl"]);
  check = A.checkUpgrades(db, orgId, NOW + 86400_000);   // the next day the same snapshot is 11 days old
  assert.equal(check.rates, null);
  assert.deepStrictEqual(check.results.get(va).lenses, []);
  assert.deepStrictEqual(check.results.get(pmi).lenses.map((l) => l.lens), ["drop_pmi"]);
  assert.deepStrictEqual(alerts().map((a) => a.lens), ["drop_pmi"]);
  const views = A.upgradeViewsFor(db, rowsOf(va, pmi), check, NOW + 86400_000);
  assert.deepStrictEqual(views.get(va).lenses, []);
  assert.deepStrictEqual(views.get(pmi).lenses.map((l) => l.lens), ["drop_pmi"]);
});

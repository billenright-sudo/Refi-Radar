"use strict";
// Upgrade alerts (spec 4.7): on each FRED observation, record which clients newly qualify for which upgrade lens, re-arm the ones
// that stopped qualifying, and build the per-client upgrade views the screens show. Only FRED snapshots act (targets.latestRealSnapshot).
const refi = require("./refi");
const { upgradesFor } = require("./upgrades");
const targets = require("./targets");

// first_seen_at and contact_log.at are both SQLite UTC text, so "reached at or after" is a plain string compare.
const sqliteUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Record and re-arm alert rows for every org client with a loan program, on the latest FRED snapshot.
// -> { rates, obsDate, today, results: Map<clientId, UpgradesResult> }, or null without a FRED snapshot. Writes only differences.
function checkUpgrades(db, orgId, nowMs = Date.now()) {
  const snap = targets.latestRealSnapshot(db);
  if (!snap) return null;
  const today = utcDay(nowMs);
  const rows = db.prepare("SELECT * FROM clients WHERE org_id = ? AND loan_program IS NOT NULL AND loan_program != ''").all(orgId);
  const stored = db.prepare(
    "SELECT u.client_id, u.lens FROM client_upgrades u JOIN clients c ON c.id = u.client_id WHERE c.org_id = ?"
  ).all(orgId);
  const storedKeys = new Set(stored.map((r) => `${r.client_id}:${r.lens}`));

  const results = new Map();
  const nowKeys = new Set();
  const add = [];
  for (const row of rows) {
    const result = upgradesFor(refi.norm(row), snap.rates, today);
    results.set(row.id, result);
    for (const l of result.lenses) {
      const key = `${row.id}:${l.lens}`;
      nowKeys.add(key);
      if (!storedKeys.has(key)) add.push([row.id, l.lens]);
    }
  }
  const drop = stored.filter((r) => !nowKeys.has(`${r.client_id}:${r.lens}`));   // stopped qualifying (or lost the program): re-armed
  if (add.length || drop.length) {
    const at = sqliteUtc(nowMs);
    db.transaction(() => {
      const ins = db.prepare("INSERT OR IGNORE INTO client_upgrades (client_id, lens, first_seen_on, first_seen_at) VALUES (?, ?, ?, ?)");
      const del = db.prepare("DELETE FROM client_upgrades WHERE client_id = ? AND lens = ?");
      for (const [id, lens] of add) ins.run(id, lens, snap.obsDate, at);
      for (const r of drop) del.run(r.client_id, r.lens);
    })();
  }
  return { ...snap, today, results };
}

// checkUpgrades for a read that has to answer anyway: a failure is logged by the error's name only, and the read goes on without it.
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");

function safeCheckUpgrades(db, orgId, nowMs = Date.now()) {
  try {
    return module.exports.checkUpgrades(db, orgId, nowMs);   // via exports: a test can swap it
  } catch (err) {
    console.error("upgrade check skipped:", errName(err));
    return null;
  }
}

// upgradeViewsFor for a read that has to answer anyway: a failure is logged by name and every client gets no view (an empty Map).
function safeUpgradeViewsFor(db, rows, check, nowMs = Date.now()) {
  try {
    return module.exports.upgradeViewsFor(db, rows, check, nowMs);   // via exports: a test can swap it
  } catch (err) {
    console.error("upgrade views skipped:", errName(err));
    return new Map();
  }
}

// The sweep's upgrade rows with isNew marked; a failure is logged by name and the rows go out unmarked.
function markSweepUpgrades(db, rows) {
  try {
    const fresh = module.exports.newAlertRows(db, rows.map((r) => r.clientId));
    return rows.map((r) => {
      const lenses = markNew(r.upgrades, fresh.get(r.clientId));
      return { ...r, upgrades: lenses, bestUpgrade: lenses[0] || null };
    });
  } catch (err) {
    console.error("upgrade marks skipped:", errName(err));
    return rows;
  }
}

// Alert rows of `ids` that are still new: Map<clientId, Map<lens, row>>. New = no `reached` contact at/after first_seen_at.
function newAlertRows(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const list = targets.idList(ids);
  const alerts = db.prepare("SELECT * FROM client_upgrades WHERE client_id IN (SELECT value FROM json_each(?))").all(list);
  if (!alerts.length) return out;
  const reached = new Map();   // clientId -> reached contact instants
  for (const c of db.prepare(
    "SELECT client_id, at FROM contact_log WHERE outcome = 'reached' AND client_id IN (SELECT value FROM json_each(?))"
  ).all(list)) {
    if (!reached.has(c.client_id)) reached.set(c.client_id, []);
    reached.get(c.client_id).push(c.at);
  }
  for (const a of alerts) {
    if ((reached.get(a.client_id) || []).some((at) => at >= a.first_seen_at)) continue;
    if (!out.has(a.client_id)) out.set(a.client_id, new Map());
    out.get(a.client_id).set(a.lens, a);
  }
  return out;
}

// The lenses with `isNew` set; `fresh` is newAlertRows' Map for that client (or undefined).
const markNew = (lenses, fresh) => lenses.map((l) => ({ ...l, isNew: !!(fresh && fresh.has(l.lens)) }));

// -> Map<clientId, { lenses, gaps, today, newLenses }> for `rows` (raw clients rows). A row the check has no result for is computed
// on the check's rates (null without a snapshot: only Drop PMI runs).
function upgradeViewsFor(db, rows, check, nowMs = Date.now()) {
  const fresh = newAlertRows(db, rows.map((r) => r.id));
  const day = check ? check.today : utcDay(nowMs);
  const views = new Map();
  for (const row of rows) {
    const result = (check && check.results.get(row.id)) || upgradesFor(refi.norm(row), check ? check.rates : null, day);
    const lenses = markNew(result.lenses, fresh.get(row.id));
    views.set(row.id, { lenses, gaps: result.gaps, today: result.today, newLenses: lenses.filter((l) => l.isNew).map((l) => l.lens) });
  }
  return views;
}

// Alerts to tell the broker about on `localDate`: new, and not announced on an earlier day. -> [{ clientId, name, lens }]
function newlyQualified(db, rows, views, localDate) {
  const out = [];
  if (!rows.length) return out;
  const announced = new Map();
  for (const a of db.prepare("SELECT client_id, lens, announced_on FROM client_upgrades WHERE client_id IN (SELECT value FROM json_each(?))")
    .all(targets.idList(rows.map((r) => r.id)))) announced.set(`${a.client_id}:${a.lens}`, a.announced_on);
  for (const row of rows) {
    const view = views.get(row.id);
    if (!view) continue;
    for (const lens of view.newLenses) {
      const on = announced.get(`${row.id}:${lens}`);
      if (on === undefined) continue;
      if (on === null || on === localDate) out.push({ clientId: row.id, name: row.name, lens });
    }
  }
  return out;
}

// Stamp the pairs as announced on `localDate` (a pair already announced keeps its day).
function announceUpgrades(db, pairs, localDate) {
  const upd = db.prepare("UPDATE client_upgrades SET announced_on = ? WHERE client_id = ? AND lens = ? AND announced_on IS NULL");
  db.transaction(() => { for (const p of pairs) upd.run(localDate, p.clientId, p.lens); })();
}

module.exports = { checkUpgrades, safeCheckUpgrades, safeUpgradeViewsFor, markSweepUpgrades, newAlertRows, markNew, upgradeViewsFor, newlyQualified, announceUpgrades };

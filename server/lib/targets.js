"use strict";
// Target-rate alerts: the broker records a target rate per client; once a day's FRED observation arrives, checkTargets decides
// whether the client's estimated rate has reached it. Only a FRED snapshot acts. Pure helpers plus a few small DB reads.
const refi = require("./refi");
const { observationDate, providerOf } = require("./rateHistory");

const TARGET_MIN = 1;
const TARGET_MAX = 15;
const REARM_MARGIN = 0.125;   // the estimate has to climb this far above the target before a reached target re-arms
const SCAN_ROWS = 400;        // as rateHistory.getMovement: the latest capture days read

const round3 = (x) => Math.round(x * 1000) / 1000;
const RANGE_ERROR = "A target rate is a number from 1.000 to 15.000.";
const HIT_FIELDS = ["target_reached_on", "target_reached_rate", "target_reached_at", "target_announced_on"];

// null/undefined/"" clears the target; a finite number or plain decimal string within range sets it.
function parseTarget(raw) {
  if (raw == null || raw === "") return { rate: null };
  let n = NaN;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw)) n = Number(raw);
  if (!Number.isFinite(n) || n < TARGET_MIN || n > TARGET_MAX) return { error: RANGE_ERROR };
  return { rate: round3(n) };
}

const notBelowError = (name, currentRate) => `A target has to be below ${name}'s current rate of ${Number(currentRate).toFixed(3)}%.`;

// The "Est. Client Rate" the client page shows: an ARM is priced there as a 30-year fixed.
function estimateRate(row, rates) {
  const client = refi.norm(row);
  if (!(client.currentRate > 0) || !(client.loanBalance > 0) || !(client.propertyValue > 0)) return null;
  const priced = client.loanType === "5_1_arm" ? { ...client, loanType: "30yr_fixed" } : client;
  const a = refi.analyze(priced, rates);
  return a && Number.isFinite(a.effRate) ? round3(a.effRate) : null;
}

// The stored FRED set with the greatest observation date (the later capture wins a tie); claude/estimated sets never count.
function latestRealSnapshot(db) {
  let best = null;
  const rows = db.prepare("SELECT rates, provider FROM rate_snapshots ORDER BY day DESC LIMIT ?").all(SCAN_ROWS);
  for (const row of rows) {
    let rates = null;
    try { rates = JSON.parse(row.rates); } catch (_err) { continue; }
    const provider = row.provider || providerOf(rates);
    const obsDate = observationDate(rates);
    if (provider !== "fred" || !obsDate) continue;
    if (!best || obsDate > best.obsDate) best = { rates, obsDate };
  }
  return best;
}

// The patch to write for one client on observation `obsDate`, or null when there is nothing to check (no target, or this
// observation was already checked). `est` is the rounded estimate or null. Every patch keeps the estimate it used beside its day,
// so the screens show the figures this check decided on.
function nextTargetFields(row, est, obsDate, nowUtc) {
  if (row.target_rate == null) return null;
  if (row.target_checked_on != null && obsDate <= row.target_checked_on) return null;
  const patch = { target_checked_on: obsDate, target_checked_rate: est };
  const hit = row.target_reached_on != null;
  const clear = () => { for (const f of HIT_FIELDS) patch[f] = null; };
  if (round3(row.current_rate) <= round3(row.target_rate)) {   // already at or below: never a hit, and a stored one goes
    if (hit) clear();
    return patch;
  }
  if (est == null) return patch;
  if (hit) {
    if (round3(est - row.target_rate) >= REARM_MARGIN) clear();
  } else if (est <= round3(row.target_rate)) {
    patch.target_reached_on = obsDate;
    patch.target_reached_rate = est;
    patch.target_reached_at = nowUtc;
    patch.target_announced_on = null;
  }
  return patch;
}

// Check every target in the org against the latest FRED observation; writes only the patch columns, never updated_at.
function checkTargets(db, orgId, nowMs = Date.now()) {
  const snap = latestRealSnapshot(db);
  if (!snap) return null;
  const nowUtc = new Date(nowMs).toISOString().slice(0, 19).replace("T", " ");
  const rows = db.prepare(
    "SELECT * FROM clients WHERE org_id = ? AND target_rate IS NOT NULL AND (target_checked_on IS NULL OR target_checked_on < ?)"
  ).all(orgId, snap.obsDate);
  const apply = db.transaction(() => {
    for (const row of rows) {
      const patch = nextTargetFields(row, estimateRate(row, snap.rates), snap.obsDate, nowUtc);
      if (!patch) continue;
      const cols = Object.keys(patch);
      db.prepare(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => patch[c]), row.id);
    }
  });
  apply();
  return snap;
}

// Earliest `reached` contact at or after each hit's target_reached_at, in one query: Map<clientId, atUtc>.
function handledAtFor(db, rows) {
  const hits = rows.filter((r) => r.target_reached_on != null && r.target_reached_at != null);
  const map = new Map();
  if (!hits.length) return map;
  const reachedAt = new Map(hits.map((r) => [r.id, r.target_reached_at]));
  const found = db.prepare(
    `SELECT client_id, at FROM contact_log WHERE outcome = 'reached' AND client_id IN (${hits.map(() => "?").join(",")}) ORDER BY at`
  ).all(...hits.map((r) => r.id));
  for (const c of found) {
    if (!map.has(c.client_id) && c.at >= reachedAt.get(c.client_id)) map.set(c.client_id, c.at);
  }
  return map;
}

// What the screens show for a client's target, from the stored check only (spec 4.5: the line can never contradict the state):
// watching shows the estimate and the observation day the last check used, never a fresh estimate. Whether the client's rate is
// already at or below the target is the loan as it is now. A target not checked yet (no FRED day so far) has no rates; a check
// that could not price the client, or that stored no hit on an estimate at or under the target (the loan was at or below it then
// and has since been raised by an import or the feed), shows no estimate until the next observation.
function targetView(row, handledAt) {
  if (row.target_rate == null) return null;
  const view = {
    rate: row.target_rate, state: null, estRate: null, gap: null, asOf: null,
    reachedOn: row.target_reached_on ?? null, reachedRate: row.target_reached_rate ?? null,
    handledAt: handledAt || null, setAt: row.target_set_at ?? null,
  };
  const est = row.target_checked_rate ?? null;
  if (round3(row.current_rate) <= round3(row.target_rate)) view.state = "already_below";
  else if (row.target_reached_on != null) view.state = handledAt ? "handled" : "at_target";
  else if (row.target_checked_on == null) view.state = "no_rates";
  else if (est == null || round3(est) <= round3(row.target_rate)) view.state = "unpriceable";
  else {
    view.state = "watching";
    view.estRate = est;
    view.gap = round3(est - row.target_rate);
    view.asOf = row.target_checked_on;
  }
  return view;
}

// Views for the rows that have a target: Map<clientId, View>. A teammate's client carries the owner's "First Last".
function viewsFor(db, rows, viewerId) {
  const withTarget = rows.filter((r) => r.target_rate != null);
  const handled = handledAtFor(db, withTarget);
  const ownerIds = [...new Set(withTarget.filter((r) => r.user_id !== viewerId).map((r) => r.user_id))];
  const owners = new Map();
  if (ownerIds.length) {
    const users = db.prepare(`SELECT id, first_name, last_name FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds);
    for (const u of users) owners.set(u.id, `${u.first_name} ${u.last_name}`.trim());
  }
  const out = new Map();
  for (const r of withTarget) {
    const v = targetView(r, handled.get(r.id));
    if (r.user_id !== viewerId && owners.has(r.user_id)) v.ownerName = owners.get(r.user_id);
    out.set(r.id, v);
  }
  return out;
}

module.exports = {
  TARGET_MIN, TARGET_MAX, REARM_MARGIN, round3, parseTarget, notBelowError, estimateRate, latestRealSnapshot,
  nextTargetFields, checkTargets, handledAtFor, targetView, viewsFor,
};

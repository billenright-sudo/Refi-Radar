"use strict";
// Charlie's morning call list: who to put in front of the broker, and the one-line reason for each.
//
// Pure: it takes a runSweep result (lib/refi.js) and returns the picks. The reasons are code-authored from sweep fields only,
// so every figure is grounded by construction. The briefing reads them aloud, so figures are digits, never words, and a
// reason has no contact details and no question mark (the briefing's one question is its own).
//
// Order (spec 5.2):
//   1. carried clients (the broker asked for them on "tomorrow's list"), in the order they were carried;
//   2. the sweep's ranking, alternating a refi-savings client (rate_term, arm_to_fixed) with a cash-out client. The engine ranks
//      a cash-out dollar figure against a monthly saving, so cash-out would otherwise always win. The kind whose best client
//      ranks higher overall goes first, and when one kind runs out the other fills the list;
//   3. term_swap clients, which have an opportunity but belong to neither kind;
//   4. check-ins with no opportunity, the longest overdue first.
//
// Scope and exclusions are the caller's: only ownClientIds can appear (none when it is missing), and excludeIds never do,
// carried or not. A carried client is exempt from the recent-recommendation exclusion because the caller takes carried ids out
// of excludeIds before calling.

const { PRIORITY_RANK, impact } = require("../refi");

const DEFAULT_LIMIT = 3;
// Lenses that read as "saves $X a month". cash_out is the other kind; term_swap is neither.
const SAVINGS_LENSES = new Set(["rate_term", "arm_to_fixed"]);
const KIND_SAVINGS = 0;
const KIND_CASH = 1;
const KIND_OTHER = 2;

const kindOf = (best) => (SAVINGS_LENSES.has(best.lens) ? KIND_SAVINGS : best.lens === "cash_out" ? KIND_CASH : KIND_OTHER);

const money = (n) => Math.round(n).toLocaleString("en-US");
// A rate as the sweep carries it (already two decimals at most): 6.38 -> "6.38", 6.5 -> "6.5".
const rateText = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : null);
const idSet = (ids) => new Set(Array.from(ids || [], (id) => String(id)));

function paymentChange(change) {
  const whole = Math.round(change);
  if (whole > 0) return `payment up about $${money(whole)} a month`;
  if (whole < 0) return `payment down about $${money(-whole)} a month`;
  return "payment about the same";
}

// What the opportunity says about the client, written to follow the name ("<name> could save ..."). Null when the sweep row
// lacks the figure the sentence is built on, so nothing is ever said without its number.
function opportunityPhrase(best) {
  if (!best || typeof best !== "object") return null;
  switch (best.lens) {
    case "rate_term": {
      const save = Math.round(best.monthlySavings);
      return save > 0 ? `could save about $${money(save)} a month` : null;
    }
    case "cash_out": {
      const cash = Math.round(best.cashAvailable / 1000) * 1000;
      return cash > 0 ? `could tap about $${money(cash)} in equity` : null;
    }
    case "arm_to_fixed": {
      const rate = rateText(best.effRate);
      if (!rate) return null;
      const save = Math.round(best.monthlySavings);
      return save > 0
        ? `could lock in a fixed rate at about ${rate} percent and save about $${money(save)} a month`
        : `could lock in a fixed rate at about ${rate} percent ahead of the next rate adjustment`;
    }
    case "term_swap": {
      const rate = rateText(best.newRate);
      const change = typeof best.paymentChange === "number" && Number.isFinite(best.paymentChange) ? best.paymentChange : null;
      if (rate) return `could move to a shorter term at about ${rate} percent${change === null ? "" : `, ${paymentChange(change)}`}`;
      // No new rate: the longer-term option that cuts the payment.
      return change !== null && Math.round(change) < 0 ? `could cut the payment about $${money(-change)} a month with a longer term` : null;
    }
    default:
      return null;
  }
}

function checkInPhrase(checkIn) {
  if (!checkIn || checkIn.due !== true || !Number.isFinite(checkIn.monthsSince) || checkIn.monthsSince < 0) return null;
  const months = Math.floor(checkIn.monthsSince);
  return `${months} month${months === 1 ? "" : "s"} since your last check-in`;
}

// One sweep row -> a candidate, or null when there is nothing groundable to say (no name, no usable figure).
function describe(row) {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  const phrase = opportunityPhrase(row.best);
  const checkIn = checkInPhrase(row.checkIn);
  if (!phrase && !checkIn) return null;
  return { clientId: row.clientId, name, best: phrase ? row.best : null, phrase, checkIn, monthsSince: checkIn ? Math.floor(row.checkIn.monthsSince) : 0 };
}

function reasonFor(c, carried) {
  const subject = carried ? `${c.name}, who you put on today's list,` : c.name;
  if (!c.phrase) return carried ? `${subject} ${c.checkIn}` : `${subject}, ${c.checkIn}`;
  return c.checkIn ? `${subject} ${c.phrase}, ${c.checkIn}` : `${subject} ${c.phrase}`;
}

// Cross-client rank, the way orchestrator.js trimSweep orders opportunities: priority, then impact, both descending.
const byRank = (a, b) => (PRIORITY_RANK[b.best.priority] || 0) - (PRIORITY_RANK[a.best.priority] || 0) || impact(b.best) - impact(a.best);

function pickCallList({ sweep, ownClientIds, carriedIds, excludeIds, limit = DEFAULT_LIMIT } = {}) {
  const max = Math.max(0, Math.floor(limit) || 0);
  const own = idSet(ownClientIds);
  const excluded = idSet(excludeIds);
  const eligible = (key) => own.has(key) && !excluded.has(key);

  // Every row the sweep has, keyed by client id. A client with an opportunity and a due check-in is in both lists.
  const rows = new Map();
  for (const list of [sweep && sweep.opportunities, sweep && sweep.checkIns]) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || row.clientId == null) continue;
      const key = String(row.clientId);
      if (!rows.has(key)) rows.set(key, row);
    }
  }

  const picked = [];
  const used = new Set();
  const take = (c, reasonCode, carried = false) => {
    if (picked.length >= max) return;
    used.add(String(c.clientId));
    picked.push({ clientId: c.clientId, name: c.name, reasonCode, reason: reasonFor(c, carried) });
  };

  // 1. Carried, in the order the broker carried them.
  for (const id of Array.from(carriedIds || [])) {
    const key = String(id);
    if (picked.length >= max) break;
    if (used.has(key) || !eligible(key) || !rows.has(key)) continue;
    const c = describe(rows.get(key));
    if (c) take(c, "carry", true);
  }

  const pool = [];
  for (const [key, row] of rows) {
    if (used.has(key) || !eligible(key)) continue;
    const c = describe(row);
    if (c) pool.push(c);
  }

  // 2. Alternate the two kinds. Array.sort is stable, so equal rank keeps the sweep's name order.
  const ranked = pool.filter((c) => c.phrase).sort(byRank);
  const queues = [[], [], []];
  for (const c of ranked) queues[kindOf(c.best)].push(c);
  const lead = ranked.find((c) => kindOf(c.best) !== KIND_OTHER);
  let turn = lead ? kindOf(lead.best) : KIND_SAVINGS;
  while (picked.length < max && (queues[KIND_SAVINGS].length || queues[KIND_CASH].length)) {
    const next = queues[turn].shift();
    if (next) take(next, next.best.lens);
    turn = turn === KIND_SAVINGS ? KIND_CASH : KIND_SAVINGS;
  }

  // 3. Opportunities that are neither kind.
  for (const c of queues[KIND_OTHER]) take(c, c.best.lens);

  // 4. Check-ins with no opportunity, longest overdue first.
  const checkIns = pool.filter((c) => !c.phrase).sort((a, b) => b.monthsSince - a.monthsSince);
  for (const c of checkIns) take(c, "check_in");

  return picked;
}

module.exports = { pickCallList };

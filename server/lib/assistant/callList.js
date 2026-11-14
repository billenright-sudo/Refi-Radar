"use strict";
// Charlie's morning call list: who to put in front of the broker, and the one-line reason for each.
//
// Pure: it takes a runSweep result (lib/refi.js) and returns the picks. The reasons are code-authored from sweep fields only
// (a target's, from the client record, is the caller's), so every figure is grounded by construction. The briefing reads them
// aloud, so figures are digits, never words, and a reason has no contact details and no question mark (the briefing's one
// question is its own).
//
// Order (spec 5.2):
//   1. carried clients (the broker asked for them on "tomorrow's list"), in the order they were carried;
//   2. clients at their target rate (target-rate alerts spec 4.5): the caller's `targets` ([{ clientId, name, reason, reasonCode }],
//      reasonCode "target" or "target_still"), in the order given, each once and never one already carried;
//   3. the sweep's ranking (upgrades, spec 4.7, count as savings: a client leads with whichever of its best opportunity and best upgrade ranks higher), alternating a refi-savings client (rate_term, arm_to_fixed) with a cash-out client. The engine ranks
//      a cash-out dollar figure against a monthly saving, so cash-out would otherwise always win. The kind whose best client
//      ranks higher overall goes first, and when one kind runs out the other fills the list;
//   4. term_swap clients, which have an opportunity but belong to neither kind;
//   5. check-ins with no opportunity, the longest overdue first.
//
// Scope and exclusions are the caller's: only ownClientIds can appear (none when it is missing), and excludeIds never do,
// carried or not, except a target: the caller has already applied the exclusions that hold for one, so excludeIds does not
// filter `targets`. A carried client is exempt from the recent-recommendation exclusion because the caller takes carried ids out
// of excludeIds before calling.
//
// The broker explicitly asked for a carried client, so it is never dropped for lack of something to say: with a name in
// clientNames (a Map of client id -> name, the broker's own clients) it is listed even with no sweep row, no usable figure and
// no due check-in, and the reason then names it with no figure. Without a name it cannot be spoken, so it is left off.

const { PRIORITY_RANK, impact } = require("../refi");

const DEFAULT_LIMIT = 3;
// Lenses that read as "saves $X a month". cash_out is the other kind; term_swap is neither.
// The upgrade lenses (spec 4.7) read the same way, so they share the savings kind. `looks` agrees with the name ("look" for a couple).
const UPGRADE_PHRASES = {
  fha_to_conv: (x, looks) => `${looks} like they could leave FHA for a conventional loan and save about $${x} a month`,
  usda_to_conv: (x, looks) => `${looks} like they could leave USDA for a conventional loan and save about $${x} a month`,
  fha_streamline: (x, looks) => `${looks} like they could do an FHA streamline and save about $${x} a month`,
  va_irrrl: (x, looks) => `${looks} like they could do a VA streamline and save about $${x} a month`,
  drop_pmi: (x, looks) => `${looks} like they could ask their lender to drop about $${x} a month of PMI`,
};
// "Robert & Linda Chen" and "Robert and Linda Chen" are two people: they "look like".
const isCouple = (name) => / & | and /i.test(String(name == null ? "" : name));
const SAVINGS_LENSES = new Set(["rate_term", "arm_to_fixed", ...Object.keys(UPGRADE_PHRASES)]);
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

// What the opportunity says about the client, written to follow the name ("<name> could save ..."), its verb agreeing with `name`.
// Null when the sweep row lacks the figure the sentence is built on, so nothing is ever said without its number.
function opportunityPhrase(best, name) {
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
    default: {
      const say = Object.prototype.hasOwnProperty.call(UPGRADE_PHRASES, best.lens) ? UPGRADE_PHRASES[best.lens] : null;
      const monthly = Math.round(best.headline);
      return say && monthly > 0 ? say(money(monthly), isCouple(name) ? "look" : "looks") : null;
    }
  }
}

// What checkInStatus (refi.js) counted the months from: the last contact, else the closing, else the day the client was added.
// Each says only what is true; an unknown basis says nothing rather than guess.
const CHECK_IN_BASIS = new Map([
  ["last_contact", "since your last check-in"],
  ["close_date", "since closing"],
  ["created_at", "since you added them"],
]);

function checkInPhrase(checkIn) {
  if (!checkIn || checkIn.due !== true || !Number.isFinite(checkIn.monthsSince) || checkIn.monthsSince < 0) return null;
  const since = CHECK_IN_BASIS.get(checkIn.basis);
  if (!since) return null;
  const months = Math.floor(checkIn.monthsSince);
  return `${months} month${months === 1 ? "" : "s"} ${since}`;
}

// One sweep row -> a candidate, or null when there is nothing groundable to say (no name, no usable figure).
function describe(row) {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  // The client's lead is whichever of the best opportunity and the best upgrade ranks higher (the opportunity on a tie); one with
  // nothing to say is passed over for the other.
  const leads = [row.best, row.bestUpgrade].filter((l) => opportunityPhrase(l, name));
  const lead = leads.length === 2 && cmpLens(leads[0], leads[1]) > 0 ? leads[1] : leads[0] || null;
  const phrase = lead ? opportunityPhrase(lead, name) : null;
  const checkIn = checkInPhrase(row.checkIn);
  if (!phrase && !checkIn) return null;
  return { clientId: row.clientId, name, best: lead, phrase, checkIn, monthsSince: checkIn ? Math.floor(row.checkIn.monthsSince) : 0 };
}

function reasonFor(c, carried) {
  if (!c.phrase && !c.checkIn) return `${c.name}, who you asked me to put on today's list`; // a carried client with no figure to give
  const subject = carried ? `${c.name}, who you put on today's list,` : c.name;
  if (!c.phrase) return carried ? `${subject} ${c.checkIn}` : `${subject}, ${c.checkIn}`;
  return c.checkIn ? `${subject} ${c.phrase}, ${c.checkIn}` : `${subject} ${c.phrase}`;
}

// Cross-client rank, the way orchestrator.js trimSweep orders opportunities: priority, then impact, both descending.
const cmpLens = (a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0) || impact(b) - impact(a);
const byRank = (a, b) => cmpLens(a.best, b.best);

function pickCallList({ sweep, ownClientIds, carriedIds, excludeIds, clientNames, targets, limit = DEFAULT_LIMIT } = {}) {
  const max = Math.max(0, Math.floor(limit) || 0);
  const own = idSet(ownClientIds);
  const excluded = idSet(excludeIds);
  const eligible = (key) => own.has(key) && !excluded.has(key);

  // Names for carried clients that have nothing else to say. The id kept is the map's own key.
  const names = new Map();
  if (clientNames instanceof Map) {
    for (const [id, name] of clientNames) {
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (trimmed) names.set(String(id), { clientId: id, name: trimmed, best: null, phrase: null, checkIn: null, monthsSince: 0 });
    }
  }

  // Every row the sweep has, keyed by client id. A client with an opportunity and a due check-in is in both lists.
  const rows = new Map();
  for (const list of [sweep && sweep.opportunities, sweep && sweep.upgrades, sweep && sweep.checkIns]) {
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
    if (used.has(key) || !eligible(key)) continue;
    const c = (rows.has(key) && describe(rows.get(key))) || names.get(key);
    if (c) take(c, "carry", true);
  }

  // 2. At their target, in the order given.
  for (const t of Array.isArray(targets) ? targets : []) {
    const key = String(t.clientId);
    if (picked.length >= max) break;
    if (used.has(key) || !own.has(key)) continue;
    used.add(key);
    picked.push({ clientId: t.clientId, name: t.name, reasonCode: t.reasonCode, reason: t.reason });
  }

  const pool = [];
  for (const [key, row] of rows) {
    if (used.has(key) || !eligible(key)) continue;
    const c = describe(row);
    if (c) pool.push(c);
  }

  // 3. Alternate the two kinds. Array.sort is stable, so equal rank keeps the sweep's name order.
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

  // 4. Opportunities that are neither kind.
  for (const c of queues[KIND_OTHER]) take(c, c.best.lens);

  // 5. Check-ins with no opportunity, longest overdue first.
  const checkIns = pool.filter((c) => !c.phrase).sort((a, b) => b.monthsSince - a.monthsSince);
  for (const c of checkIns) take(c, "check_in");

  return picked;
}

module.exports = { pickCallList, opportunityPhrase, cmpLens };

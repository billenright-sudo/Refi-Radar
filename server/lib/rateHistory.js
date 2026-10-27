"use strict";
// Daily market-rate snapshots and day-over-day movement.
const db = require("../db");
const { MONTHS, WEEKDAYS, ordinal } = require("./dateLabels");

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// The providers a rate set can come from: "fred" (the Optimal Blue / FRED primary), "claude" (the Claude web-search fallback) and
// "estimated" (the hard-coded last resort). routes/rates.js knows which code path produced a set and says so (recordSnapshot's
// `provider`); a web-search result can carry any label, "Optimal Blue lock data …" included, so the label is no proof.
const PROVIDERS = new Set(["fred", "claude", "estimated"]);

// The FALLBACK reading of a set's source label, for callers that do not give the provider and for rows stored before the
// provider column: "fred" for "Optimal Blue lock data (2026-10-21) · ...", "estimated" for "Estimated — live fetch
// unavailable", and "claude" for anything else.
function providerOf(rates) {
  const source = String((rates && rates.source) || "");
  if (/^estimated/i.test(source)) return "estimated";
  if (/^Optimal Blue lock data\b/i.test(source)) return "fred";
  return "claude";
}

// Upsert today's (or the given YYYY-MM-DD) rate set — one row per day, latest write wins — with its provider: the route's
// `provider` when given ('fred' | 'claude' | 'estimated'), else the label's (providerOf). An estimated set (by either) is never
// stored (the route never offers one; this refuses it too), so a fallback number can never become "history".
function recordSnapshot(rates, day = dayKey(), provider) {
  const from = PROVIDERS.has(provider) ? provider : providerOf(rates);
  if (from === "estimated" || providerOf(rates) === "estimated") return;
  db.prepare(
    `INSERT INTO rate_snapshots (day, rates, captured_at, provider) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET rates = excluded.rates, captured_at = excluded.captured_at, provider = excluded.provider`
  ).run(day || dayKey(), JSON.stringify(rates), new Date().toISOString(), from);
}

const sourceOf = (rates) => String((rates && rates.source) || "");
// The rate set the browser sends back (routes/assistant.js cleanRates: the rate_* numbers, date, and the source cut to 200
// characters) is the one routes/rates.js served it, and every served set has a same-day snapshot: so a set that matches today's
// snapshot (same source, same rate numbers) came from that snapshot's code path.
const sameSet = (stored, rates) =>
  sourceOf(stored).slice(0, 200) === sourceOf(rates) &&
  Object.keys(rates || {}).filter((k) => /^rate_/.test(k) && Number.isFinite(rates[k])).every((k) => stored[k] === rates[k]);
// The provider of the CURRENT set: the caller's, else today's snapshot's when it holds this same set, else the label's.
function currentProvider(rates, provider) {
  if (PROVIDERS.has(provider)) return provider;
  const today = db.prepare("SELECT rates, provider FROM rate_snapshots WHERE day = ?").get(dayKey());
  if (today && PROVIDERS.has(today.provider)) {
    let stored = null;
    try { stored = JSON.parse(today.rates); } catch (_err) { stored = null; }
    if (stored && sameSet(stored, rates)) return today.provider;
  }
  return providerOf(rates);
}

// The 5/1 ARM has no day-over-day move: OBMMI has no ARM index, so one day's figure can be web-searched and the next the
// "30-year minus 0.10" estimate (routes/rates.js). Its level is still reported; its change never is.
const NO_DELTA_KEYS = new Set(["rate_5_1_arm"]);

// The spoken "since when" for a snapshot taken on `day`, seen from `today` (both YYYY-MM-DD, UTC days): "yesterday" one day
// back, the weekday ("Thursday") two to six days back, otherwise the date with an ordinal day ("October 18th", with the year
// when it is not this year's), which toSpeech reads "October eighteenth" (a bare "October 18" is read "October eighteen"); the
// digits still ground the model's "since October 18th". Code computes it so the model never has to (and never says "since
// yesterday" about an older snapshot). Pure.
function sinceLabel(day, today = dayKey()) {
  const then = new Date(`${day}T00:00:00Z`);
  const now = new Date(`${today}T00:00:00Z`);
  const days = Math.round((now - then) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 6) return WEEKDAYS[then.getUTCDay()];
  const date = `${MONTHS[then.getUTCMonth()]} ${ordinal(then.getUTCDate())}`;
  return then.getUTCFullYear() === now.getUTCFullYear() ? date : `${date}, ${then.getUTCFullYear()}`;
}

// Compare the given current rates to the most recent snapshot from a prior day. There is a movement only when that snapshot
// came from the same provider as the current rates and neither is an estimate (a FRED figure diffed against a web-search one
// is no market move): otherwise deltas is null and hasHistory false, as before any prior day was recorded. Two web-search
// ("claude") sets must also carry the same, non-empty source label: the search can return a different publisher each day, and
// two publishers' averages are no move either. The current set's provider is `provider` when given, else the one the route
// stored today for this same set, else its label's (currentProvider). With a movement, `since` is the spoken label for the
// snapshot's day and `sinceDate` its YYYY-MM-DD.
function getMovement(rates, provider) {
  const none = { current: rates, previous: null, deltas: null, hasHistory: false, since: null, sinceDate: null };
  const row = db
    .prepare("SELECT day, rates, provider FROM rate_snapshots WHERE day < ? ORDER BY day DESC LIMIT 1")
    .get(dayKey());
  if (!row) return none;
  const previous = JSON.parse(row.rates);
  // a row stored before the provider column existed: read its provider off the stored source label
  const previousProvider = row.provider || providerOf(previous);
  const nowProvider = currentProvider(rates, provider);
  if (previousProvider !== nowProvider || nowProvider === "estimated" || previousProvider === "estimated") return none;
  if (nowProvider === "claude" && (!sourceOf(rates) || sourceOf(previous).slice(0, 200) !== sourceOf(rates).slice(0, 200))) return none;

  const deltas = {};
  for (const key of Object.keys(rates || {})) {
    if (NO_DELTA_KEYS.has(key)) continue;
    if (Number.isFinite(rates[key]) && Number.isFinite(previous[key])) {
      // Round away float noise (7.40 - 7.50 = -0.0999999...); rates carry <= 3 decimals.
      deltas[key] = Math.round((rates[key] - previous[key]) * 10000) / 10000;
    }
  }
  return { current: rates, previous, deltas, hasHistory: true, since: sinceLabel(row.day), sinceDate: row.day };
}

module.exports = { recordSnapshot, getMovement, providerOf, sinceLabel, ordinal, MONTHS, WEEKDAYS };

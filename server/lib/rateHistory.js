"use strict";
// Daily market-rate snapshots and day-over-day movement.
const db = require("../db");

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// Where a rate set came from, read off its source label (routes/rates.js writes it): "fred" for the Optimal Blue / FRED primary
// ("Optimal Blue lock data (2026-10-21) · ..."), "estimated" for the hard-coded last resort ("Estimated — live fetch
// unavailable"), and "claude" for anything else (the Claude web-search fallback, whose label is whatever the search returned).
function providerOf(rates) {
  const source = String((rates && rates.source) || "");
  if (/^estimated/i.test(source)) return "estimated";
  if (/^Optimal Blue lock data\b/i.test(source)) return "fred";
  return "claude";
}

// Upsert today's (or the given YYYY-MM-DD) rate set — one row per day, latest write wins — with its provider. An estimated set
// is never stored (the route never offers one; this refuses it too), so a fallback number can never become "history".
function recordSnapshot(rates, day = dayKey()) {
  const provider = providerOf(rates);
  if (provider === "estimated") return;
  db.prepare(
    `INSERT INTO rate_snapshots (day, rates, captured_at, provider) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET rates = excluded.rates, captured_at = excluded.captured_at, provider = excluded.provider`
  ).run(day, JSON.stringify(rates), new Date().toISOString(), provider);
}

// The 5/1 ARM has no day-over-day move: OBMMI has no ARM index, so one day's figure can be web-searched and the next the
// "30-year minus 0.10" estimate (routes/rates.js). Its level is still reported; its change never is.
const NO_DELTA_KEYS = new Set(["rate_5_1_arm"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The spoken "since when" for a snapshot taken on `day`, seen from `today` (both YYYY-MM-DD, UTC days): "yesterday" one day
// back, the weekday ("Thursday") two to six days back, otherwise the date ("October 18", with the year when it is not this
// year's). Code computes it so the model never has to (and never says "since yesterday" about an older snapshot). Pure.
function sinceLabel(day, today = dayKey()) {
  const then = new Date(`${day}T00:00:00Z`);
  const now = new Date(`${today}T00:00:00Z`);
  const days = Math.round((now - then) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 6) return WEEKDAYS[then.getUTCDay()];
  const date = `${MONTHS[then.getUTCMonth()]} ${then.getUTCDate()}`;
  return then.getUTCFullYear() === now.getUTCFullYear() ? date : `${date}, ${then.getUTCFullYear()}`;
}

// Compare the given current rates to the most recent snapshot from a prior day. There is a movement only when that snapshot
// came from the same provider as the current rates and neither is an estimate (a FRED figure diffed against a web-search one
// is no market move): otherwise deltas is null and hasHistory false, as before any prior day was recorded. With a movement,
// `since` is the spoken label for the snapshot's day and `sinceDate` its YYYY-MM-DD.
function getMovement(rates) {
  const none = { current: rates, previous: null, deltas: null, hasHistory: false, since: null, sinceDate: null };
  const row = db
    .prepare("SELECT day, rates, provider FROM rate_snapshots WHERE day < ? ORDER BY day DESC LIMIT 1")
    .get(dayKey());
  if (!row) return none;
  const previous = JSON.parse(row.rates);
  // a row stored before the provider column existed: read its provider off the stored source label
  const previousProvider = row.provider || providerOf(previous);
  const currentProvider = providerOf(rates);
  if (previousProvider !== currentProvider || currentProvider === "estimated" || previousProvider === "estimated") return none;

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

module.exports = { recordSnapshot, getMovement, providerOf, sinceLabel };

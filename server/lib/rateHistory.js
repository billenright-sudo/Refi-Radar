"use strict";
// Daily market-rate snapshots and day-over-day movement.
const db = require("../db");

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// Upsert today's (or the given YYYY-MM-DD) rate set — one row per day, latest write wins.
function recordSnapshot(rates, day = dayKey()) {
  db.prepare(
    `INSERT INTO rate_snapshots (day, rates, captured_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET rates = excluded.rates, captured_at = excluded.captured_at`
  ).run(day, JSON.stringify(rates), new Date().toISOString());
}

// Compare the given current rates to the most recent snapshot from a prior day.
// deltas is null until a prior-day snapshot exists.
function getMovement(rates) {
  const row = db
    .prepare("SELECT rates FROM rate_snapshots WHERE day < ? ORDER BY day DESC LIMIT 1")
    .get(dayKey());
  const previous = row ? JSON.parse(row.rates) : null;

  let deltas = null;
  if (previous) {
    deltas = {};
    for (const key of Object.keys(rates || {})) {
      if (typeof rates[key] === "number" && typeof previous[key] === "number") {
        // Round away float noise (7.40 - 7.50 = -0.0999999...); rates carry <= 3 decimals.
        deltas[key] = Math.round((rates[key] - previous[key]) * 10000) / 10000;
      }
    }
  }
  return { current: rates, previous, deltas, hasHistory: previous !== null };
}

module.exports = { recordSnapshot, getMovement };

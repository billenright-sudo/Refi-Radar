"use strict";
// The 6-hour cache of the rate set /api/rates served (routes/rates.js), moved out of the route so the rate check
// (lib/pings/rateCheck.js) can clear it when a new FRED observation arrives: the next /api/rates, and so the briefing a ping opens,
// then carries that same observation instead of yesterday's for up to 6 hours.
const RATES_TTL_MS = 6 * 60 * 60 * 1000;

let entry = null; // { payload, expires, day }

// The cache is also bounded to the UTC day it was filled on: a payload cached before midnight must not be served after it, or that
// response would have no same-day snapshot and getMovement would compare the data against itself.
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// -> the cached payload while it is fresh and from today (UTC), else null.
function get(nowMs = Date.now()) {
  return entry && nowMs < entry.expires && entry.day === utcDay(nowMs) ? entry.payload : null;
}
function set(payload, nowMs = Date.now()) {
  entry = { payload, expires: nowMs + RATES_TTL_MS, day: utcDay(nowMs) };
}
function clear() {
  entry = null;
}

module.exports = { get, set, clear, RATES_TTL_MS };

"use strict";
// The one rule for "rates dropped", shared by the briefing's lead and the rate-drop ping (lib/pings/), so the two never contradict
// each other: the same rounding (two decimals, as tools.getMarketUpdate gives the briefing) and the same comparison. Pure: no
// database, no clock.

// The drop sizes a user may choose, in points; the smallest is the default and the one the briefing has always used.
const DEFAULT_THRESHOLD = 0.125;
const THRESHOLDS = [0.125, 0.25, 0.375, 0.5];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (date) => {
  if (typeof date !== "string" || !DAY_RE.test(date)) return false;
  const at = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date;
};
const twoDecimals = (v) => Number(v.toFixed(2));

// `movement` is what rateHistory.getMovement returns. -> { rate30, move30, obsDate, sinceDate } with the 30-year and its move rounded
// to two decimals exactly as tools.getMarketUpdate rounds them; null without history, a finite 30-year and 30-year delta, or real
// YYYY-MM-DD observation and previous-observation dates.
function marketMove(movement) {
  if (!movement || !movement.hasHistory || !movement.deltas || !movement.current) return null;
  const rate30 = movement.current.rate_30yr_fixed;
  const delta = movement.deltas.rate_30yr_fixed;
  if (!Number.isFinite(rate30) || !Number.isFinite(delta)) return null;
  const obsDate = movement.current.date;
  if (!realDay(obsDate) || !realDay(movement.sinceDate)) return null;
  return { rate30: twoDecimals(rate30), move30: twoDecimals(delta), obsDate, sinceDate: movement.sinceDate };
}

// Whether a two-decimal 30-year move is a drop of `threshold` or more. On two-decimal moves this is exactly "fell by the size or
// more" for all four sizes (0.125 and 0.375 round half up to 0.13 / 0.38, and -0.13 <= -0.125).
const isDrop = (move30, threshold) => Number.isFinite(move30) && Number.isFinite(threshold) && move30 <= -threshold;

module.exports = { DEFAULT_THRESHOLD, THRESHOLDS, marketMove, isDrop };

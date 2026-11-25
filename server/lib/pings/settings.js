"use strict";
// A user's rate-drop ping settings: validation, and the stored row (user_alert_settings in db.js). No row means the defaults, and
// the default is OFF. `db` is passed in (as lib/targets.js does), so tests can use their own.
const { cleanTimeZone, DEFAULT_TIME_ZONE } = require("../timeZone");
const { DEFAULT_THRESHOLD, THRESHOLDS } = require("../rateDrop");

const DEFAULTS = Object.freeze({
  enabled: false, threshold: DEFAULT_THRESHOLD, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels: "push", timeZone: null,
});
const CHANNELS = ["push", "email", "both"];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const BAD = "Something in these settings isn't valid.";
const BAD_THRESHOLD = "Choose a drop size of 0.125, 0.25, 0.375 or 0.5.";
const BAD_QUIET = "Quiet hours are times like 20:00.";
const BAD_CHANNEL = "Choose phone, email or both.";
const BAD_ZONE = "Choose a time zone from the list.";

// -> { value: Settings } | { error: string }. The body is the page's; every field is checked, none is trusted.
function parseSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: BAD };
  if (typeof body.enabled !== "boolean" || typeof body.weekdaysOnly !== "boolean") return { error: BAD };
  if (typeof body.threshold !== "number" || !THRESHOLDS.includes(body.threshold)) return { error: BAD_THRESHOLD };
  if (typeof body.quietStart !== "string" || !HHMM_RE.test(body.quietStart) || typeof body.quietEnd !== "string" || !HHMM_RE.test(body.quietEnd)) {
    return { error: BAD_QUIET };
  }
  if (typeof body.channels !== "string" || !CHANNELS.includes(body.channels)) return { error: BAD_CHANNEL };
  let timeZone = null;
  if (body.timeZone !== null && body.timeZone !== undefined) {
    timeZone = cleanTimeZone(body.timeZone);
    if (!timeZone) return { error: BAD_ZONE };
  }
  return {
    value: {
      enabled: body.enabled, threshold: body.threshold, quietStart: body.quietStart, quietEnd: body.quietEnd,
      weekdaysOnly: body.weekdaysOnly, channels: body.channels, timeZone,
    },
  };
}

// The zone to use when the user has chosen none: their Google calendar's, else the one the sign-up form sent, else null.
function fallbackZone(db, userId) {
  const google = db.prepare("SELECT time_zone FROM google_connections WHERE user_id = ?").get(userId);
  const fromGoogle = google && cleanTimeZone(google.time_zone);
  if (fromGoogle) return fromGoogle;
  const user = db.prepare("SELECT time_zone FROM users WHERE id = ?").get(userId);
  return (user && cleanTimeZone(user.time_zone)) || null;
}

// -> the stored settings, else DEFAULTS, with `timeZone` resolved: stored, else Google's, else the sign-up one, else null.
function getSettings(db, userId) {
  const row = db.prepare("SELECT * FROM user_alert_settings WHERE user_id = ?").get(userId);
  const base = row
    ? {
      enabled: row.enabled === 1, threshold: row.threshold, quietStart: row.quiet_start, quietEnd: row.quiet_end,
      weekdaysOnly: row.weekdays_only === 1, channels: row.channels, timeZone: cleanTimeZone(row.time_zone),
    }
    : { ...DEFAULTS };
  return { ...base, timeZone: base.timeZone || fallbackZone(db, userId) };
}

// Replaces the user's row with `value` (parseSettings's) and returns the settings as getSettings now reads them.
function saveSettings(db, userId, value) {
  db.prepare(
    `INSERT INTO user_alert_settings (user_id, enabled, threshold, quiet_start, quiet_end, weekdays_only, channels, time_zone, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, quiet_start = excluded.quiet_start,
       quiet_end = excluded.quiet_end, weekdays_only = excluded.weekdays_only, channels = excluded.channels,
       time_zone = excluded.time_zone, updated_at = excluded.updated_at`
  ).run(userId, value.enabled ? 1 : 0, value.threshold, value.quietStart, value.quietEnd, value.weekdaysOnly ? 1 : 0, value.channels, value.timeZone || null);
  return getSettings(db, userId);
}

const zoneFor = (db, userId) => getSettings(db, userId).timeZone || DEFAULT_TIME_ZONE;

// The drop size the briefing uses for this user, pings on or off: the stored one, else the default.
function thresholdFor(db, userId) {
  const row = db.prepare("SELECT threshold FROM user_alert_settings WHERE user_id = ?").get(userId);
  return row && THRESHOLDS.includes(row.threshold) ? row.threshold : DEFAULT_THRESHOLD;
}

module.exports = { DEFAULTS, CHANNELS, parseSettings, getSettings, saveSettings, zoneFor, thresholdFor };

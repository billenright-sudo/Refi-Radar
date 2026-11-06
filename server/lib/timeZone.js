"use strict";
// A person's own time zone (round 2, item 5): the sign-up form sends the browser's, and the billing confirmation email writes its
// dates in it, so the email says the same day the app does. Pure.

const DEFAULT_TIME_ZONE = "America/New_York";
const ZONE_MAX = 64;
// The shape of an IANA name ("America/New_York", "Etc/GMT+5", "UTC"): an offset such as "+05:00" is not one, even where Intl takes it.
const IANA_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

// -> the zone's canonical IANA name when `value` is one Intl knows (trimmed, any case), else null.
function cleanTimeZone(value) {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (!zone || zone.length > ZONE_MAX || !IANA_RE.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// "Nov 30, 2026": the day `ms` falls on in `timeZone`; a missing or bad zone is America/New_York.
function formatDateIn(ms, timeZone) {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: cleanTimeZone(timeZone) || DEFAULT_TIME_ZONE,
  });
}

module.exports = { DEFAULT_TIME_ZONE, cleanTimeZone, formatDateIn };

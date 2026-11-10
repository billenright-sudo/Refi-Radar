// Target-rate alerts: the client-side wording and ordering. The server decides the state; this only words and sorts it.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
};

// "2026-11-12" -> "November 12th"; the year is added when it is not today's year.
export function dayLabel(ymd, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return "";
  const label = `${MONTHS[Number(m[2]) - 1]} ${ordinal(Number(m[3]))}`;
  return Number(m[1]) === today.getFullYear() ? label : `${label}, ${m[1]}`;
}

const three = (x) => Number(x).toFixed(3);

// handledAt is SQLite UTC text; show the local date.
function localDay(utcText) {
  const d = new Date(String(utcText).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function targetStatusLine(target, today = new Date()) {
  if (!target) return null;
  switch (target.state) {
    case "watching":
      return `Watching: estimated ${three(target.estRate)}% as of ${dayLabel(target.asOf, today)}, ${three(target.gap)} above target`;
    case "at_target":
      return `Target reached ${dayLabel(target.reachedOn, today)} (estimated ${three(target.reachedRate)}%)`;
    case "handled":
      return `Target reached ${dayLabel(target.reachedOn, today)} · client reached ${dayLabel(localDay(target.handledAt), today)}`;
    case "already_below":
      return "Their rate is already at or below this target.";
    case "unpriceable":
      return "Can't estimate a rate for this client yet";
    case "no_rates":
      return "Waiting for the first day of live rates";
    default:
      return null;
  }
}

const RANK = { at_target: 0, watching: 1, handled: 2, already_below: 3, unpriceable: 4, no_rates: 5 };
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

export function closestToTarget(clients, limit = 5) {
  return (clients || [])
    .filter((c) => c && c.target)
    .sort((a, b) => {
      const ra = RANK[a.target.state] ?? 6, rb = RANK[b.target.state] ?? 6;
      if (ra !== rb) return ra - rb;
      if (ra === 0 && a.target.reachedOn !== b.target.reachedOn) return String(a.target.reachedOn) < String(b.target.reachedOn) ? -1 : 1;
      if (ra === 1 && a.target.gap !== b.target.gap) return a.target.gap - b.target.gap;
      return byName(a, b);
    })
    .slice(0, limit);
}

export const isAtTarget = (target) => target != null && target.state === "at_target";

// The server's range copy (server/lib/targets.js RANGE_ERROR), shown here for a field that is not a number at all.
export const TARGET_RANGE_ERROR = "A target rate is a number from 1.000 to 15.000.";

// What the client page's target Save does with the field: { send: false } for an empty one (nothing to save); { send: false,
// error } for one that is not a number (a number input the browser couldn't read says "" with badInput), so a typo never reaches
// the server, where a NaN body would read as null and clear the target; else { send: true, targetRate } for PUT
// /api/clients/:id/target. The range and "below the current rate" are the server's to refuse.
export function targetToSave(raw, { badInput = false } = {}) {
  const text = String(raw ?? "").trim();
  if (text === "") return badInput ? { send: false, error: TARGET_RANGE_ERROR } : { send: false };
  const n = Number(text);
  if (!Number.isFinite(n)) return { send: false, error: TARGET_RANGE_ERROR };
  return { send: true, targetRate: n };
}

// Whether a POST /api/rates answer may have stored a new day of live rates: then the client list is read again, so its target
// check runs on that day (as the briefing's does) and the screens say what Charlie says. An estimate never moves a target.
export const ratesMayMoveTargets = (data) => Boolean(data && data.success === true && data.rates);

// `clients` with the row of `client.id` replaced by `client` (a route's answer for that client), in order; the same list when
// there is no such row.
export function replaceClient(clients, client) {
  if (!client || client.id == null || !(clients || []).some((c) => c.id === client.id)) return clients;
  return clients.map((c) => (c.id === client.id ? client : c));
}

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

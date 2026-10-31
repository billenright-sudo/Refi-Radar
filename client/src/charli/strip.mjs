// The slim strip under Charlie on the home page: what the briefing knows, as a few small facts that each open their page. Pure: it
// reads getState().briefing.strip (session.mjs; every field is null when unknown) and gives back what to draw, so the screen only
// lays it out. Every figure is one the server sent; nothing is worked out here beyond how it is written.

// There is no calendar page in the app: the next event opens the calendar it came from.
export const CALENDAR_URL = "https://calendar.google.com/";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// "2026-10-29" -> "Oct 29"; anything that is not a real day -> "".
function shortDate(day) {
  const m = typeof day === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "";
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const real = new Date(Date.UTC(year, month - 1, date));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== date) return "";
  return `${MONTHS[month - 1]} ${date}`;
}

function moveText(move) {
  const size = Math.abs(move).toFixed(2);
  if (Number(size) === 0) return "unchanged";
  return `${move < 0 ? "down" : "up"} ${size}`;
}

// stripItems(strip) -> [{ key, label, value, detail?, view? | href? }], in the order they are drawn. An estimated rate set (`estimated: true`,
// as the server marks it) is labelled "estimated" and shows no move or date, as the spoken briefing says it. An item is there only when its
// fact is known. `view` is a nav id (nav.mjs) the item opens; `href` is an outside address (the calendar). [] when nothing is known.
export function stripItems(strip) {
  const s = strip && typeof strip === "object" ? strip : {};
  const items = [];

  if (isNumber(s.rate30)) {
    const parts = [];
    if (s.estimated === true) {
      parts.push("estimated");
    } else {
      if (isNumber(s.move30)) parts.push(moveText(s.move30));
      const asOf = shortDate(s.asOf);
      if (asOf) parts.push(`as of ${asOf}`);
    }
    items.push({ key: "rate", label: "30-year fixed", value: `${s.rate30.toFixed(2)}%`, detail: parts.join(", "), view: "rates" });
  }
  if (isNumber(s.opportunities)) {
    items.push({ key: "opportunities", label: "Opportunities", value: String(s.opportunities), view: "sweeps" });
  }
  if (isNumber(s.checkInsDue)) {
    items.push({ key: "checkIns", label: "Check-ins due", value: String(s.checkInsDue), view: "sweeps" });
  }
  const event = s.nextEvent;
  if (event && typeof event === "object" && typeof event.title === "string" && event.title.trim()) {
    const time = typeof event.start === "string" && event.start.trim() ? event.start.trim() : "all day";
    items.push({ key: "event", label: "Next on your calendar", value: event.title, detail: time, href: CALENDAR_URL });
  }
  return items;
}

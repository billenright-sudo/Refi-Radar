"use strict";
// The dates coming up for a client: birthdays (theirs, a spouse's, a child's), the wedding anniversary, the loan anniversary (from
// the close date already on file) and the home anniversary (from the purchase date). Built from lib/personal.js's details and the
// close date, for the Home page's "Dates coming up" list, the client page and Charlie. Reminders only: nothing here is priced and
// nothing is sent to a client.
//
// client/src/personal.mjs is this file's mirror for the browser (its test holds the two together). Pure: no I/O, no clock; the
// caller says what day today is ("YYYY-MM-DD", the user's own day).
const { parsePersonal } = require("./personal");
const { MONTHS, WEEKDAYS, ordinal } = require("./dateLabels");

const WINDOW_DAYS = 14;        // today and the fourteen days after it
const MS_PER_DAY = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MD_RE = /^(\d{2})-(\d{2})$/;
const KIND_ORDER = ["birthday", "spouse_birthday", "child_birthday", "wedding", "loan", "home"];

// "YYYY-MM-DD" as a UTC instant, or null when it is not a real day.
function dayMs(day) {
  const m = typeof day === "string" ? DAY_RE.exec(day) : null;
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(at).toISOString().slice(0, 10) === day ? at : null;
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// The day "MM-DD" falls on in year `y`: a leap-day date is kept on February 28th in a short year.
const inYear = (md, y) => (md === "02-29" && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`);

// The next time "MM-DD" comes round on or after `today`: { date, daysAway, year }, or null when either is unusable.
function nextOn(md, today) {
  const start = dayMs(today);
  if (start == null || typeof md !== "string" || !MD_RE.test(md)) return null;
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    const date = inYear(md, year);
    const at = dayMs(date);
    if (at != null && at >= start) return { date, daysAway: Math.round((at - start) / MS_PER_DAY), year };
  }
  return null;
}

// A client's dates from `today` through `days` days after it, in date order: [{ clientId, clientName, kind, who, date, daysAway,
// years }]. `client` is the shape the screens get ({ id, name, closeDate, personal }); `years` is the count an anniversary or a
// child's birthday reaches, null when there is no year to count from. A loan or home anniversary needs a full year behind it, and
// a home bought on the closing day has one anniversary, the loan's.
function occasionsFor(client, today, days = WINDOW_DAYS) {
  if (!client || typeof client !== "object" || dayMs(today) == null || !(days >= 0)) return [];
  const p = client.personal && typeof client.personal === "object" ? client.personal : {};
  const out = [];
  const add = (kind, md, { who = null, from = null, needsYears = false } = {}) => {
    const next = nextOn(md, today);
    if (!next || next.daysAway > days) return;
    const years = Number.isInteger(from) && next.year - from >= 1 ? next.year - from : null;
    if (needsYears && years == null) return;
    out.push({ clientId: client.id, clientName: client.name, kind, who, date: next.date, daysAway: next.daysAway, years });
  };
  const closeDate = typeof client.closeDate === "string" && dayMs(client.closeDate) != null ? client.closeDate : "";
  const purchaseDate = typeof p.purchaseDate === "string" && dayMs(p.purchaseDate) != null ? p.purchaseDate : "";

  add("birthday", p.birthday);
  add("spouse_birthday", p.spouseBirthday, { who: p.spouseName || null });
  for (const child of Array.isArray(p.children) ? p.children : []) {
    if (child && child.name) add("child_birthday", child.birthday, { who: child.name, from: child.birthYear });
  }
  add("wedding", p.anniversary, { from: p.anniversaryYear });
  if (closeDate) add("loan", closeDate.slice(5), { from: Number(closeDate.slice(0, 4)), needsYears: true });
  if (purchaseDate && purchaseDate !== closeDate) add("home", purchaseDate.slice(5), { from: Number(purchaseDate.slice(0, 4)), needsYears: true });

  return out.map((o, i) => [o, i]).sort(([a, i], [b, j]) =>
    a.daysAway - b.daysAway || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || i - j).map(([o]) => o);
}

// A book's dates, soonest first, then by client name.
function upcomingDates(clients, today, days = WINDOW_DAYS) {
  const all = [];
  for (const client of Array.isArray(clients) ? clients : []) all.push(...occasionsFor(client, today, days));
  const name = (o) => String(o.clientName || "").toLowerCase();
  return all.map((o, i) => [o, i]).sort(([a, i], [b, j]) =>
    a.daysAway - b.daysAway || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || i - j).map(([o]) => o);
}

const years = (n) => `${n} ${n === 1 ? "year" : "years"}`;
// What an occasion is called, on the screen and by Charlie.
function occasionText(o) {
  switch (o.kind) {
    case "birthday": return "Birthday";
    case "spouse_birthday": return `${o.who || "Spouse"}'s birthday`;
    case "child_birthday": return `${o.who}'s birthday${o.years ? `, turns ${o.years}` : ""}`;
    case "wedding": return `Wedding anniversary${o.years ? `, ${years(o.years)}` : ""}`;
    case "loan": return `Loan anniversary, ${years(o.years)}`;
    case "home": return `Home anniversary, ${years(o.years)}`;
    default: return "";
  }
}

// When `date` is, seen from `today`, in words: "today", "tomorrow", the weekday for the rest of the next six days, then the
// weekday and the date ("Tuesday, November 24th"). "" when either day is unusable.
function whenText(date, today) {
  const at = dayMs(date);
  const start = dayMs(today);
  if (at == null || start == null) return "";
  const away = Math.round((at - start) / MS_PER_DAY);
  if (away === 0) return "today";
  if (away === 1) return "tomorrow";
  const d = new Date(at);
  const weekday = WEEKDAYS[d.getUTCDay()];
  return away >= 2 && away <= 6 ? weekday : `${weekday}, ${MONTHS[d.getUTCMonth()]} ${ordinal(d.getUTCDate())}`;
}

// A clients row as the client occasionsFor reads.
const fromRow = (row) => ({ id: row.id, name: row.name, closeDate: row.close_date || "", personal: parsePersonal(row.personal) });

// An occasion as Charlie says it in a list, after the client's name: "loan anniversary Thursday, 3 years", "Maya's birthday
// tomorrow, turns 10", "birthday today". The occasion's own words (occasionText) with the day put before its count.
function spokenOccasion(o, today) {
  const [lead, ...rest] = occasionText(o).split(", ");
  const named = o.kind === "child_birthday" || (o.kind === "spouse_birthday" && o.who);
  const said = named ? lead : lead[0].toLowerCase() + lead.slice(1);
  return [`${said} ${whenText(o.date, today)}`, ...rest].join(", ");
}

module.exports = { WINDOW_DAYS, KIND_ORDER, occasionsFor, upcomingDates, occasionText, whenText, spokenOccasion, fromRow };

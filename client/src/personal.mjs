// A client's optional personal details (birthdays as month and day, an anniversary, children, pets, the purchase date, who
// referred them, preferred contact, a retirement year) and the dates coming up from them: the client form's Personal section, the
// client page's Personal card and Home's "Dates coming up" list. Reminders only: nothing here is priced and nothing is sent.
//
// occasionsFor / upcomingDates / occasionText mirror server/lib/occasions.js (the test holds the two together), and the shape
// mirrors server/lib/personal.js, which is what checks a save.

export const WINDOW_DAYS = 14;   // today and the fourteen days after it
export const MAX_CHILDREN = 12;
export const CONTACT_OPTIONS = [["", "No preference"], ["call", "Call"], ["text", "Text"], ["email", "Email"]];
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];   // February as its longest: a leap-day birthday is real
const MS_PER_DAY = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MD_RE = /^(\d{2})-(\d{2})$/;
const KIND_ORDER = ["birthday", "spouse_birthday", "child_birthday", "wedding", "loan", "home"];

export const EMPTY_PERSONAL = Object.freeze({
  birthday: "", spouseName: "", spouseBirthday: "", anniversary: "", anniversaryYear: null, children: Object.freeze([]),
  pets: "", purchaseDate: "", referredBy: "", preferredContact: "", retirementYear: null,
});

// ── dates coming up (mirror of server/lib/occasions.js) ───────────────────────

function dayMs(day) {
  const m = typeof day === "string" ? DAY_RE.exec(day) : null;
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(at).toISOString().slice(0, 10) === day ? at : null;
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const inYear = (md, y) => (md === "02-29" && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`);

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

// A client's dates from `today` ("YYYY-MM-DD", the user's own day) through `days` days after it, in date order:
// [{ clientId, clientName, kind, who, date, daysAway, years }].
export function occasionsFor(client, today, days = WINDOW_DAYS) {
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
export function upcomingDates(clients, today, days = WINDOW_DAYS) {
  const all = [];
  for (const client of Array.isArray(clients) ? clients : []) all.push(...occasionsFor(client, today, days));
  const name = (o) => String(o.clientName || "").toLowerCase();
  return all.map((o, i) => [o, i]).sort(([a, i], [b, j]) =>
    a.daysAway - b.daysAway || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || i - j).map(([o]) => o);
}

const yearsText = (n) => `${n} ${n === 1 ? "year" : "years"}`;
export function occasionText(o) {
  switch (o.kind) {
    case "birthday": return "Birthday";
    case "spouse_birthday": return `${o.who || "Spouse"}'s birthday`;
    case "child_birthday": return `${o.who}'s birthday${o.years ? `, turns ${o.years}` : ""}`;
    case "wedding": return `Wedding anniversary${o.years ? `, ${yearsText(o.years)}` : ""}`;
    case "loan": return `Loan anniversary, ${yearsText(o.years)}`;
    case "home": return `Home anniversary, ${yearsText(o.years)}`;
    default: return "";
  }
}

// ── labels for the screen ─────────────────────────────────────────────────────

// The browser's own day, "YYYY-MM-DD".
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
// "2026-11-19" -> "Thu, Nov 19"; "" when it is not a real day.
export function dayLabel(date) {
  const at = dayMs(date);
  if (at == null) return "";
  const d = new Date(at);
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
// How far off: "Today", "Tomorrow", "In 5 days".
export const awayLabel = (daysAway) => (daysAway === 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `In ${daysAway} days`);
// "03-09" -> "Mar 9"; with a year, "Mar 9, 2015"; "" when it is not a month and a day.
export function monthDayLabel(md, year = null) {
  const m = typeof md === "string" ? MD_RE.exec(md) : null;
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return "";
  return `${MONTH_NAMES[Number(m[1]) - 1]} ${Number(m[2])}${year ? `, ${year}` : ""}`;
}
// "2019-08-02" -> "Aug 2, 2019".
export function dateLabel(date) {
  const m = dayMs(date) != null ? DAY_RE.exec(date) : null;
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// The Personal card's rows, [label, text], only the ones with something to show.
export function personalRows(personal) {
  const p = personal && typeof personal === "object" ? personal : EMPTY_PERSONAL;
  const rows = [];
  if (p.birthday) rows.push(["Birthday", monthDayLabel(p.birthday)]);
  if (p.spouseName || p.spouseBirthday) {
    rows.push(["Spouse / co-borrower", [p.spouseName, p.spouseBirthday && `birthday ${monthDayLabel(p.spouseBirthday)}`].filter(Boolean).join(", ")]);
  }
  if (p.anniversary) rows.push(["Wedding anniversary", monthDayLabel(p.anniversary, p.anniversaryYear)]);
  const children = Array.isArray(p.children) ? p.children.filter((c) => c && c.name) : [];
  if (children.length) {
    rows.push(["Children", children.map((c) => (c.birthday ? `${c.name} (${monthDayLabel(c.birthday, c.birthYear)})` : c.name)).join(", ")]);
  }
  if (p.pets) rows.push(["Pets", p.pets]);
  if (p.purchaseDate) rows.push(["Home purchased", dateLabel(p.purchaseDate)]);
  if (p.referredBy) rows.push(["Referred by", p.referredBy]);
  if (p.preferredContact) rows.push(["Prefers", (CONTACT_OPTIONS.find(([v]) => v === p.preferredContact) || ["", p.preferredContact])[1]]);
  if (p.retirementYear) rows.push(["Plans to retire", String(p.retirementYear)]);
  return rows;
}

// ── the form ──────────────────────────────────────────────────────────────────
// The form keeps a date as its two picks ({ m, d }, each "" until picked) and a year as typed text.

export const daysInMonth = (m) => (Number(m) >= 1 && Number(m) <= 12 ? DAYS_IN[Number(m) - 1] : 31);
const toPicks = (md) => {
  const m = typeof md === "string" ? MD_RE.exec(md) : null;
  return m ? { m: String(Number(m[1])), d: String(Number(m[2])) } : { m: "", d: "" };
};
export const EMPTY_CHILD = Object.freeze({ name: "", birthday: Object.freeze({ m: "", d: "" }), birthYear: "" });
export function personalToForm(personal) {
  const p = personal && typeof personal === "object" ? personal : EMPTY_PERSONAL;
  return {
    birthday: toPicks(p.birthday), spouseName: p.spouseName || "", spouseBirthday: toPicks(p.spouseBirthday),
    anniversary: toPicks(p.anniversary), anniversaryYear: p.anniversaryYear ? String(p.anniversaryYear) : "",
    children: (Array.isArray(p.children) ? p.children : []).map((c) => ({
      name: c.name || "", birthday: toPicks(c.birthday), birthYear: c.birthYear ? String(c.birthYear) : "",
    })),
    pets: p.pets || "", purchaseDate: p.purchaseDate || "", referredBy: p.referredBy || "",
    preferredContact: p.preferredContact || "", retirementYear: p.retirementYear ? String(p.retirementYear) : "",
  };
}

// The form as the server takes it: { value } or { error } (the first thing to fix, in the form's own words). A date needs both
// picks or neither; a year is four digits in the server's own range (a past year from 1900 to `thisYear`, a retirement year from
// 1950 to 2100); the purchase date is this year or earlier. The server checks it all again (server/lib/personal.js).
export function formToPersonal(form, thisYear = new Date().getFullYear()) {
  const f = form && typeof form === "object" ? form : personalToForm(null);
  const md = (picks, label) => {
    const m = picks && picks.m ? String(picks.m) : "";
    const d = picks && picks.d ? String(picks.d) : "";
    if (!m && !d) return "";
    if (!m || !d) throw new Error(`${label}: pick both a month and a day`);
    if (Number(d) > daysInMonth(m)) throw new Error(`${label}: that month has no day ${d}`);
    return `${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  };
  const year = (text, label, min = 1900, max = thisYear) => {
    const t = String(text == null ? "" : text).trim();
    if (!t) return null;
    if (!/^\d{4}$/.test(t)) throw new Error(`${label}: a year is four digits`);
    if (Number(t) < min || Number(t) > max) throw new Error(`${label}: a year from ${min} to ${max}`);
    return Number(t);
  };
  try {
    const anniversary = md(f.anniversary, "Wedding anniversary");
    const children = [];
    for (const c of Array.isArray(f.children) ? f.children : []) {
      const name = String(c.name || "").trim();
      const birthday = md(c.birthday, name ? `${name}'s birthday` : "A child's birthday");
      const birthYear = year(c.birthYear, name ? `${name}'s birth year` : "A child's birth year");
      if (!name && !birthday && birthYear == null) continue;   // a row left empty
      if (!name) throw new Error("Each child needs a name");
      children.push({ name, birthday, birthYear: birthday ? birthYear : null });
    }
    const purchaseDate = f.purchaseDate || "";
    if (purchaseDate && (dayMs(purchaseDate) == null || Number(purchaseDate.slice(0, 4)) < 1900 || Number(purchaseDate.slice(0, 4)) > thisYear)) {
      throw new Error("Home purchase date: a real date, this year or earlier");
    }
    return { value: {
      birthday: md(f.birthday, "Birthday"), spouseName: String(f.spouseName || "").trim(),
      spouseBirthday: md(f.spouseBirthday, "Spouse's birthday"), anniversary,
      anniversaryYear: anniversary ? year(f.anniversaryYear, "Anniversary year") : null, children,
      pets: String(f.pets || "").trim(), purchaseDate, referredBy: String(f.referredBy || "").trim(),
      preferredContact: f.preferredContact || "", retirementYear: year(f.retirementYear, "Retirement year", 1950, 2100),
    } };
  } catch (err) {
    return { error: err.message };
  }
}

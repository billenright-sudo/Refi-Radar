"use strict";
// The optional personal details on a client: birthdays, an anniversary, children, pets, the purchase date, who referred them, how
// they like to be reached and a retirement year. They are for greetings and reminders only (lib/occasions.js):
//   * typed by hand on the client form, never read from an import file or an LOS feed (lib/intake/fields.js has no such field, and
//     its privacy guard still refuses a date-of-birth column);
//   * never priced: no lens, sweep, target, upgrade or call-list order reads them (marital and family status are protected under
//     fair-lending rules);
//   * a birthday is a month and a day ("MM-DD"), never a year. Only a child may carry a birth year, so the app can say "turns 18";
//   * no gender, anywhere: a key this file does not name is never kept.
// Stored as one JSON text in clients.personal ('' when there is nothing), read back through parsePersonal so whatever the column
// holds comes out in this shape.

const TEXT_MAX = { spouseName: 120, pets: 200, referredBy: 120 };
const CHILD_NAME_MAX = 60;
const MAX_CHILDREN = 12;
const CONTACTS = ["call", "text", "email"];
const MIN_YEAR = 1900;
const RETIRE_MIN = 1950;
const RETIRE_MAX = 2100;
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];   // February as its longest: a leap-day birthday is real

const EMPTY = Object.freeze({
  birthday: "", spouseName: "", spouseBirthday: "", anniversary: "", anniversaryYear: null, children: Object.freeze([]),
  pets: "", purchaseDate: "", referredBy: "", preferredContact: "", retirementYear: null,
});
const empty = () => ({ ...EMPTY, children: [] });
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

// "3-9" / "03-09" -> "03-09"; "" for blank; null when it is not a month and a day.
function monthDay(v) {
  if (blank(v)) return "";
  const m = typeof v === "string" ? /^(\d{1,2})-(\d{1,2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN[month - 1]) return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
// A whole year from `min` to `max`: the number, null for blank, NaN when it is not one.
function year(v, min, max) {
  if (blank(v)) return null;
  const n = typeof v === "number" ? v : /^\d{4}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}
// One line of text, at most `max` characters: the text, or null when it is not text or is too long.
function line(v, max) {
  if (blank(v)) return "";
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? null : t;
}
// "YYYY-MM-DD", a real day from 1900 to the end of `thisYear`: the text, "" for blank, null otherwise.
function realDay(v, thisYear) {
  if (blank(v)) return "";
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const at = new Date(`${m[0]}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== m[0]) return null;
  const y = Number(m[1]);
  return y >= MIN_YEAR && y <= thisYear ? m[0] : null;
}

// What the form sent, made safe: { value } in EMPTY's shape, or { error } naming the first thing wrong. `thisYear` is the latest
// year a past date may carry. Nothing given (undefined, null, {}) is EMPTY.
function cleanPersonal(input, thisYear = new Date().getUTCFullYear()) {
  if (input == null) return { value: empty() };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "Personal details could not be read" };
  const out = empty();

  for (const [key, label] of [["birthday", "Birthday"], ["spouseBirthday", "Spouse's birthday"], ["anniversary", "Wedding anniversary"]]) {
    const md = monthDay(input[key]);
    if (md === null) return { error: `${label} needs a real month and day` };
    out[key] = md;
  }
  const annYear = year(input.anniversaryYear, MIN_YEAR, thisYear);
  if (Number.isNaN(annYear)) return { error: `Anniversary year is a year from ${MIN_YEAR} to ${thisYear}` };
  out.anniversaryYear = out.anniversary ? annYear : null;

  for (const [key, label] of [["spouseName", "Spouse's name"], ["pets", "Pets"], ["referredBy", "Referred by"]]) {
    const text = line(input[key], TEXT_MAX[key]);
    if (text === null) return { error: `${label} is text of at most ${TEXT_MAX[key]} characters` };
    out[key] = text;
  }

  if (input.children != null) {
    if (!Array.isArray(input.children)) return { error: "Children could not be read" };
    for (const raw of input.children) {
      const child = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      if (blank(child.name) && blank(child.birthday) && blank(child.birthYear)) continue;   // an empty row on the form
      const name = line(child.name, CHILD_NAME_MAX);
      if (!name) return { error: name === null ? `A child's name is text of at most ${CHILD_NAME_MAX} characters` : "Each child needs a name" };
      const birthday = monthDay(child.birthday);
      if (birthday === null) return { error: `${name}'s birthday needs a real month and day (child)` };
      const birthYear = year(child.birthYear, MIN_YEAR, thisYear);
      if (Number.isNaN(birthYear)) return { error: `${name}'s birth year is a year from ${MIN_YEAR} to ${thisYear} (child)` };
      out.children.push({ name, birthday, birthYear: birthday ? birthYear : null });
    }
    if (out.children.length > MAX_CHILDREN) return { error: "A client can have twelve children on file at most" };
  }

  const purchase = realDay(input.purchaseDate, thisYear);
  if (purchase === null) return { error: "Home purchase date needs a real date, this year or earlier" };
  out.purchaseDate = purchase;

  if (!blank(input.preferredContact) && !CONTACTS.includes(input.preferredContact)) return { error: "Preferred contact is call, text or email" };
  out.preferredContact = blank(input.preferredContact) ? "" : input.preferredContact;

  const retire = year(input.retirementYear, RETIRE_MIN, RETIRE_MAX);
  if (Number.isNaN(retire)) return { error: `Retirement year is a year from ${RETIRE_MIN} to ${RETIRE_MAX}` };
  out.retirementYear = retire;

  return { value: out };
}

const isEmpty = (p) => JSON.stringify(p) === JSON.stringify(empty());
// A cleaned value as the column keeps it: '' when there is nothing.
const storePersonal = (value) => (isEmpty(value) ? "" : JSON.stringify(value));

// The column's text as a value in EMPTY's shape, whatever it holds: each part that does not read cleanly is left blank, and the
// rest is kept. Never throws.
function parsePersonal(text) {
  let raw = null;
  try { raw = typeof text === "string" && text ? JSON.parse(text) : null; } catch (_err) { raw = null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
  const whole = cleanPersonal(raw, RETIRE_MAX);
  if (whole.value) return whole.value;
  const out = empty();
  for (const key of Object.keys(EMPTY)) {
    if (key === "children") {
      for (const child of Array.isArray(raw.children) ? raw.children.slice(0, MAX_CHILDREN) : []) {
        const one = cleanPersonal({ children: [child] }, RETIRE_MAX);
        if (one.value) out.children.push(...one.value.children);
      }
      continue;
    }
    // the anniversary's year reads with its date
    const part = key === "anniversaryYear" ? { anniversary: raw.anniversary, anniversaryYear: raw.anniversaryYear } : { [key]: raw[key] };
    const one = cleanPersonal(part, RETIRE_MAX);
    if (one.value) out[key] = one.value[key];
  }
  return out;
}

module.exports = { EMPTY, CONTACTS, MAX_CHILDREN, cleanPersonal, parsePersonal, storePersonal, monthDay };

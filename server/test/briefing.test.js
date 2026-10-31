"use strict";
// The code-authored morning briefing (Task 5): buildBriefing in lib/assistant/briefing.js, against a throwaway DB with seeded
// clients, fixed rates (and stored FRED snapshots for a move) and a fake ctx.google. No model call and no network anywhere.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-briefing-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const fu = require("../lib/assistant/followups");
const { recordSnapshot } = require("../lib/rateHistory");
const { CAREER_QUESTION } = require("../lib/assistant/coaching");
const { openerFor } = require("../lib/assistant/openers");
const assistantRoutes = require("../routes/assistant");
const { buildBriefing, speakable, DROP_THRESHOLD, CLOSE_QUESTION, CLOSE_NO_CALLS, COUPLE_OF_CALLS } = require("../lib/assistant/briefing");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const PHX = "America/Phoenix";            // UTC-7 all year
const TODAY = "2026-10-30";               // a Friday
const YESTERDAY = "2026-10-29";
const at = (date, hour, minute = 0) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour + 7, minute);
};
const NOW_MS = at(TODAY, 8);              // 8:00 AM in Phoenix
const NOW_UTC = "2026-10-30 15:00:00";

const BASE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const live = (obs, numbers = {}) => ({ ...BASE, ...numbers, date: obs, source: `Optimal Blue lock data (${obs})` });
const LIVE = live(YESTERDAY);
const EST = { ...BASE, date: TODAY, source: "Estimated — live fetch unavailable" };

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first, stage) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage) VALUES (?, ?, ?, 'User', ?, ?)"
).run(orgId, role, first, email, stage).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);

const orgId = addOrg("Briefing Org");
const annId = addUser(orgId, "broker", "ann@briefing.test", "Ann", "established");
const louId = addUser(orgId, "lo", "lou@briefing.test", "Lou", "developing");
const nellId = addUser(orgId, "broker", "nell@briefing.test", "Nell", null);

// Every seeded client has an email and a phone: none may ever be read out.
const CONTACTS = [];
let seq = 0;
function addClient(userId, name, fields = {}) {
  seq += 1;
  const email = `client${seq}@book.example`;
  const phone = `555-01${String(seq).padStart(2, "0")}-${String(4000 + seq)}`;
  CONTACTS.push(email, phone, phone.replace(/\D/g, ""));
  const f = { loanType: "30yr_fixed", rate: 4.0, balance: 300000, value: 340000, lastContact: "2026-09-01", ...fields };
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, last_contact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, name, email, phone, f.loanType, f.rate, f.balance, f.value, f.lastContact).lastInsertRowid);
}

// Ann's book: Lucy (a rate-and-term saving), Owen (cash-out), Grace (a check-in only, nothing to refinance). Lou's: Larry.
function seedBook() {
  return {
    lucy: addClient(annId, "Lucy Tran", { rate: 7.5, balance: 400000, value: 500000 }),
    owen: addClient(annId, "Owen Prescott", { rate: 6.0, balance: 300000, value: 800000 }),
    grace: addClient(annId, "Grace Okafor", { lastContact: "2025-10-01" }),
    larry: addClient(louId, "Larry Stone", { rate: 7.5, balance: 400000, value: 500000 }),
  };
}

test.beforeEach(() => {
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "rate_snapshots", "clients"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

// A stand-in for googleFor(): connection() plus listDay, recording each date asked and how many reads were ever in flight at once.
const event = (title, startLabel, date, endHour, endMinute = 0) => ({ title, start: startLabel, end: "", allDay: false, endAt: at(date, endHour, endMinute) });
function fakeGoogle({ connection = { timeZone: PHX, googleEmail: "ann@gmail.example" }, byDate = {}, listed } = {}) {
  const google = { asked: [], inFlight: 0, maxInFlight: 0 };
  google.connection = () => connection;
  google.listDay = async ({ date }) => {
    google.asked.push(date);
    google.inFlight += 1;
    google.maxInFlight = Math.max(google.maxInFlight, google.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return listed ? await listed(date) : { events: byDate[date] || [] };
    } finally {
      google.inFlight -= 1;
    }
  };
  return google;
}

const brief = (userId, { rates = LIVE, google, localHour = 8, localDate = TODAY, nowMs = NOW_MS, ...rest } = {}) => {
  const user = userRow(userId);
  return buildBriefing({ user, ctx: { user, rates, db, google }, db, localHour, localDate, nowMs, ...rest });
};

const questionMarks = (text) => (text.match(/\?/g) || []).length;
const recRows = (where = "1 = 1", ...args) => db.prepare(`SELECT * FROM charlie_recommendations WHERE ${where} ORDER BY id`).all(...args);
const quiet = (fn) => async () => {
  const realError = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = realError; }
};

// ── shape and kind ───────────────────────────────────────────────────────────

test("kind is \"morning\" from 4 to 11 local and \"catch_up\" otherwise (8 and 15 included)", async () => {
  seedBook();
  const kinds = {};
  for (const localHour of [3, 4, 8, 11, 12, 15, 20]) kinds[localHour] = (await brief(annId, { localHour })).kind;
  assert.deepStrictEqual(kinds, { 3: "catch_up", 4: "morning", 8: "morning", 11: "morning", 12: "catch_up", 15: "catch_up", 20: "catch_up" });
});

test("the opener is openerFor's, with the user's first name, and the route still re-exports the moved openers", async () => {
  seedBook();
  const r = await brief(annId);
  assert.ok(r.reply.startsWith(openerFor({ localHour: 8, localDate: TODAY, name: "Ann" })), r.reply);
  assert.strictEqual(assistantRoutes.openerFor, openerFor);
  assert.ok(assistantRoutes.GREETING_OPENERS.partOfDay.morning.length >= 3);
});

test("sections come in order: market, call list, calendar, then the one question at the end", async () => {
  seedBook();
  const google = fakeGoogle({ byDate: { [TODAY]: [event("Team sync", "9:00 AM", TODAY, 9, 30)] } });
  const r = await brief(annId, { google });
  const market = r.reply.indexOf("The 30-year is at 6.52%");
  const calls = r.reply.indexOf("Today's calls:");
  const calendar = r.reply.indexOf("on your calendar today");
  assert.ok(market > 0, r.reply);
  assert.ok(calls > market, r.reply);
  assert.ok(calendar > calls, r.reply);
  assert.ok(r.reply.indexOf("?") > calendar, r.reply);
  assert.equal(questionMarks(r.reply), 1, r.reply);
  assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
  assert.ok(r.reply.includes("Team sync at 9:00 AM"), r.reply);
  assert.deepStrictEqual(r.sources, ["live rates 2026-10-29", "sweep engine", "google calendar 2026-10-30"]);
});

test("the strip carries the 30-year, its move and as-of date, the user's own counts and the next event (null when unknown)", async () => {
  seedBook();
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 6.6 }), "2026-10-28", "fred");
  const google = fakeGoogle({ byDate: { [TODAY]: [
    event("Early call", "7:00 AM", TODAY, 7, 30),                   // already over at 8:00
    event("Call Lucy 555-201-0103", "9:00 AM", TODAY, 9, 30),
  ] } });
  const r = await brief(annId, { google });
  assert.deepStrictEqual(r.strip, {
    rate30: 6.52, move30: -0.08, asOf: YESTERDAY, opportunities: 2, checkInsDue: 1,
    nextEvent: { title: "an event", start: "9:00 AM" },
  });
  const bare = await brief(nellId, { rates: null });
  assert.deepStrictEqual(bare.strip, { rate30: null, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null });
});

// ── the market line ──────────────────────────────────────────────────────────

test("a 30-year drop past the threshold leads with \"Rates dropped\" in the first briefing after it, then is an ordinary move", async () => {
  seedBook();
  assert.equal(DROP_THRESHOLD, 0.125);
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 6.55 }), "2026-10-28", "fred");
  const rates = live(YESTERDAY, { rate_30yr_fixed: 6.4 });
  const opener = openerFor({ localHour: 8, localDate: TODAY, name: "Ann" });

  const first = await brief(annId, { rates });
  assert.ok(first.reply.startsWith(`${opener} Rates dropped: the 30-year is at 6.4%, down 0.15 since October 28th, as of October 29th.`), first.reply);
  assert.ok(fu.dropAlreadyLed(db, annId, YESTERDAY));

  const again = await brief(annId, { rates });
  assert.ok(!again.reply.includes("Rates dropped"), again.reply);
  assert.ok(again.reply.startsWith(`${opener} The 30-year is at 6.4%, down 0.15 since October 28th, as of October 29th.`), again.reply);
  assert.equal(again.strip.move30, -0.15);

  // led for Ann only: another broker's first briefing still leads with it
  assert.ok((await brief(nellId, { rates })).reply.includes("Rates dropped: "));
});

test("a drop smaller than the threshold is stated, never led with", async () => {
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 6.62 }), "2026-10-28", "fred");
  const r = await brief(annId, { rates: live(YESTERDAY, { rate_30yr_fixed: 6.5 }) });
  assert.ok(r.reply.includes("The 30-year is at 6.5%, down 0.12 since October 28th, as of October 29th."), r.reply);
  assert.ok(!r.reply.includes("Rates dropped"), r.reply);
  assert.ok(!fu.dropAlreadyLed(db, annId, YESTERDAY));
});

test("15-year, FHA and jumbo moves of 0.05 or more get one clause each; smaller ones are left out", async () => {
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 6.42, rate_15yr_fixed: 6.03, rate_30yr_fha: 6.2, rate_30yr_jumbo: 6.81 }), "2026-10-28", "fred");
  const r = await brief(annId, { rates: live(YESTERDAY, { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_30yr_fha: 6.18, rate_30yr_jumbo: 6.87 }) });
  assert.ok(r.reply.includes("The 30-year is at 6.52%, up 0.1 since October 28th, as of October 29th. The 15-year is down 0.12 and jumbo is up 0.06."), r.reply);
  assert.ok(!r.reply.includes("FHA"), r.reply);
});

test("a quiet day (every move under 0.05) is one short market sentence", async () => {
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 6.54, rate_15yr_fixed: 5.93 }), "2026-10-28", "fred");
  const r = await brief(nellId);
  const opener = openerFor({ localHour: 8, localDate: TODAY, name: "Nell" });
  assert.equal(r.reply, `${opener} The 30-year is at 6.52%, little changed since October 28th, as of October 29th. ${CAREER_QUESTION}`);
});

test("with no earlier observation there is no move, only the rate as of its observation date", async () => {
  const r = await brief(nellId);
  assert.ok(r.reply.includes("The 30-year is at 6.52%, as of October 29th."), r.reply);
  assert.ok(!/since|down|up \d/.test(r.reply), r.reply);
});

test("an estimated rate set says estimated and claims no move, even with a stored observation", async () => {
  seedBook();
  recordSnapshot(live("2026-10-28", { rate_30yr_fixed: 7.2 }), "2026-10-28", "fred");
  const r = await brief(annId, { rates: EST });
  assert.ok(r.reply.includes("The 30-year is at an estimated 6.52%."), r.reply);
  assert.ok(!/since October|since yesterday|dropped|down 0|up 0|as of/.test(r.reply), r.reply);
  assert.ok(r.reply.includes("Today's calls, on estimated rates:"), r.reply);
  assert.equal(r.strip.move30, null);
  assert.equal(r.strip.asOf, null);
  assert.equal(r.strip.estimated, true, "the strip says it too, so the screen can label the rate as the briefing does");
  assert.ok(r.sources.includes("estimated rates 2026-10-30"), r.sources.join(" | "));
});

test("a live rate set's strip never says estimated", async () => {
  const r = await brief(nellId);
  assert.ok(!("estimated" in r.strip) || r.strip.estimated === false, JSON.stringify(r.strip));
  assert.equal(r.strip.rate30, 6.52);
});

// ── the call list ────────────────────────────────────────────────────────────

test("the call list is the user's own sweep, recorded as briefing recommendations for today", async () => {
  const ids = seedBook();
  const r = await brief(annId);
  assert.ok(r.reply.includes("Today's calls: "), r.reply);
  assert.ok(r.reply.includes("Lucy Tran could save about $"), r.reply);
  assert.ok(r.reply.includes("Owen Prescott could tap about $"), r.reply);
  assert.ok(r.reply.includes("and Grace Okafor, 12 months since your last check-in."), r.reply);
  const rows = recRows("user_id = ?", annId);
  assert.deepStrictEqual(rows.map((row) => [row.client_id, row.day, row.source]).sort(),
    [[ids.lucy, TODAY, "briefing"], [ids.owen, TODAY, "briefing"], [ids.grace, TODAY, "briefing"]].sort());
});

test("clients reached in the last 7 days and clients recommended in the last 3 days are left off; a carried client comes first", async () => {
  const ids = seedBook();
  fu.logCall(db, { userId: annId, clientId: ids.lucy, outcome: "reached", nowUtc: "2026-10-26 18:00:00" });
  fu.recordRecommendations(db, annId, "2026-10-28", [{ clientId: ids.owen, source: "sweep", reasonCode: "cash_out" }]);
  const carriedOnly = addClient(annId, "Cara Mendez", { lastContact: "2026-10-01" });   // nothing to say about her but the carry
  fu.addCarry(db, annId, carriedOnly, YESTERDAY);
  const r = await brief(annId);
  // Owen's open sweep row is asked about as a follow-up instead; neither he nor Lucy is on the list
  assert.ok(r.reply.includes("Today's calls: Cara Mendez, who you asked me to put on today's list; and Grace Okafor, 12 months since your last check-in."), r.reply);
  assert.ok(!r.reply.includes("Lucy Tran"), r.reply);
  assert.ok(!r.reply.includes("Owen Prescott could"), r.reply);
});

test("\"Plus N more check-ins due\" when more of the user's own check-ins are due than the list names", async () => {
  seedBook();
  for (const name of ["Dee Lang", "Eli Moss", "Fay Nunez"]) addClient(annId, name, { lastContact: "2025-09-01" });
  addClient(louId, "Lou's Overdue", { lastContact: "2025-01-01" });   // not Ann's: never counted
  const r = await brief(annId);
  // four of Ann's check-ins are due; the list's three slots are Lucy, Owen and the longest overdue of them
  assert.ok(r.reply.includes("Plus 3 more check-ins due."), r.reply);
  assert.equal(r.strip.checkInsDue, 4);
});

test("Review Focus 3: a second briefing the same day lists the same clients, adds no rows, and asks a follow-up a second time", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  const first = await brief(annId);
  const listed = recRows("user_id = ? AND day = ? AND source = 'briefing'", annId, TODAY).map((row) => row.client_id).sort();
  assert.equal(first.followUp.clientId, ids.lucy);
  const asked = () => recRows("user_id = ? AND client_id = ? AND day = ?", annId, ids.lucy, YESTERDAY)[0];
  assert.equal(asked().ask_count, 1);

  const second = await brief(annId);
  const listedAgain = recRows("user_id = ? AND day = ? AND source = 'briefing'", annId, TODAY).map((row) => row.client_id).sort();
  assert.deepStrictEqual(listedAgain, listed, "one briefing row per listed client, the same clients");
  assert.equal(second.reply, first.reply, "the same list is read again, not left off as recently recommended");
  assert.equal(new Set(listedAgain).size, listedAgain.length);
  assert.equal(second.followUp.clientId, ids.lucy);
  assert.equal(asked().ask_count, 2);

  const third = await brief(annId);
  assert.equal(third.followUp, null, "asked twice: it is not asked again");
  assert.equal(asked().ask_count, 2);
  assert.ok(third.reply.endsWith(CLOSE_QUESTION), third.reply);
});

// ── team scope ───────────────────────────────────────────────────────────────

test("team scope: a broker's list has none of an LO's clients and one count-only team line; an LO gets no team line", async () => {
  const ids = seedBook();
  const broker = await brief(annId);
  assert.ok(!broker.reply.includes("Larry Stone"), broker.reply);
  assert.ok(broker.reply.includes("Your loan officers have 1 opportunity open."), broker.reply);
  assert.ok(!recRows("client_id = ?", ids.larry).some((row) => row.user_id === annId));
  assert.equal(broker.strip.opportunities, 2, "the strip counts the broker's own book only");

  const lo = await brief(louId);
  assert.ok(lo.reply.includes("Larry Stone"), lo.reply);
  assert.ok(!/loan officers/i.test(lo.reply), lo.reply);
  for (const name of ["Lucy Tran", "Owen Prescott", "Grace Okafor"]) assert.ok(!lo.reply.includes(name), lo.reply);
});

test("a broker whose loan officers have no opportunities gets no team line", async () => {
  addClient(annId, "Grace Okafor", { lastContact: "2025-10-01" });
  addClient(louId, "Quiet Client");
  const r = await brief(annId);
  assert.ok(!/loan officers/i.test(r.reply), r.reply);
});

// ── the calendar ─────────────────────────────────────────────────────────────

test("Review Focus 1: a title with a phone number, an email or a question mark is read as \"an event\"", async () => {
  seedBook();
  const google = fakeGoogle({ byDate: { [TODAY]: [
    event("Call Lucy 555-201-0103", "9:00 AM", TODAY, 9, 30),
    event("Lunch with lucy.tran@mail.example", "12:00 PM", TODAY, 13),
    event("Rate lock?", "2:00 PM", TODAY, 14, 30),
    event("Call (555) 2010103", "3:00 PM", TODAY, 15, 30),
  ] } });
  const r = await brief(annId, { google });
  for (const bad of ["555-201-0103", "5552010103", "2010103", "0103", "lucy.tran@mail.example", "@", "Rate lock"]) {
    assert.ok(!r.reply.includes(bad), `${bad}: ${r.reply}`);
  }
  assert.ok(r.reply.includes("You have 4 events on your calendar today, starting with an event at 9:00 AM, then an event at 12:00 PM."), r.reply);
  assert.equal(questionMarks(r.reply), 1, r.reply);
  for (const [title, start] of [["Call (555) 2010103", "3:00 PM"], ["Rate lock?", "2:00 PM"]]) {
    const one = await brief(annId, { google: fakeGoogle({ byDate: { [TODAY]: [event(title, start, TODAY, 16)] } }) });
    assert.ok(one.reply.includes(`You have 1 event on your calendar today: an event at ${start}.`), one.reply);
    assert.deepStrictEqual(one.strip.nextEvent, { title: "an event", start });
  }
});

test("the calendar names the first one or two events still ahead, and an empty day is clear", async () => {
  seedBook();
  const later = await brief(annId, { localHour: 15, nowMs: at(TODAY, 15), google: fakeGoogle({ byDate: { [TODAY]: [
    event("Team sync", "9:00 AM", TODAY, 9, 30),
    event("Closing review", "4:00 PM", TODAY, 16, 30),
    event("Wrap-up", "5:00 PM", TODAY, 17, 30),
    event("Dinner", "7:00 PM", TODAY, 20),
  ] } }) });
  assert.ok(later.reply.includes("You have 4 events on your calendar today; next up, Closing review at 4:00 PM, then Wrap-up at 5:00 PM."), later.reply);
  assert.ok(!later.reply.includes("Team sync"), later.reply);
  const clear = await brief(annId, { google: fakeGoogle() });
  assert.ok(clear.reply.includes("Your calendar is clear today."), clear.reply);
  assert.equal(clear.strip.nextEvent, null);
});

test("the calendar is skipped when Google is not connected, needs a reconnect, or cannot be read", quiet(async () => {
  seedBook();
  for (const google of [
    undefined,
    fakeGoogle({ connection: { code: "not_connected" } }),
    fakeGoogle({ connection: { code: "reconnect" } }),
    fakeGoogle({ listed: () => ({ code: "reconnect" }) }),
    fakeGoogle({ listed: () => ({ error: "Google Calendar could not be read" }) }),
    fakeGoogle({ listed: () => Promise.reject(new Error("boom")) }),
  ]) {
    const r = await brief(annId, { google });
    assert.ok(!/calendar/i.test(r.reply.replace(CLOSE_QUESTION, "")), r.reply);
    assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
    assert.ok(!r.sources.some((s) => s.startsWith("google calendar")), r.sources.join(" | "));
  }
}));

test("Google is read one call at a time: today's events, then the calendar follow-ups (yesterday, then today)", async () => {
  seedBook();
  const google = fakeGoogle({ byDate: { [TODAY]: [event("Team sync", "9:00 AM", TODAY, 9, 30)] } });
  await brief(annId, { google });
  assert.deepStrictEqual(google.asked, [TODAY, YESTERDAY, TODAY]);
  assert.equal(google.maxInFlight, 1, "never two Google reads at once");
});

test("a calendar follow-up read that hangs is given up on after the wait, and the briefing goes ahead without it", async () => {
  seedBook();
  const google = fakeGoogle({ listed: (date) => (google.asked.length === 1 ? { events: [event("Team sync", "9:00 AM", TODAY, 9, 30)] } : new Promise(() => {})) });
  const started = Date.now();
  const r = await brief(annId, { google, calendarWaitMs: 150 });
  assert.ok(Date.now() - started < 2000, "did not wait on the hung read");
  assert.ok(r.reply.includes("Team sync at 9:00 AM"), r.reply);
  assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
});

test("today's read that hangs skips the calendar, and the follow-up read is not started beside it", async () => {
  seedBook();
  const google = fakeGoogle({ listed: () => new Promise(() => {}) });
  const r = await brief(annId, { google, calendarWaitMs: 100 });
  assert.deepStrictEqual(google.asked, [TODAY], "no second Google call while the first is still out");
  assert.ok(!r.reply.includes("on your calendar today"), r.reply);
  assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
});

// ── follow-ups and the one question ──────────────────────────────────────────

test("an open follow-up for Lucy from yesterday is the closing question, and followUp names her", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  const r = await brief(annId);
  assert.ok(r.reply.endsWith("Yesterday I suggested calling Lucy Tran. Were you able to reach them?"), r.reply);
  assert.equal(questionMarks(r.reply), 1, r.reply);
  const row = recRows("user_id = ? AND day = ?", annId, YESTERDAY)[0];
  assert.deepStrictEqual(r.followUp, { recId: row.id, clientId: ids.lucy, name: "Lucy Tran", source: "briefing" });
  assert.ok(!r.reply.includes(COUPLE_OF_CALLS), r.reply);
  assert.ok(!r.reply.includes("Lucy Tran could"), "recommended yesterday and still open: not on today's list");
});

test("the follow-up question: \"This morning\" for today's row after noon, \"Earlier\" for an older one, and a calendar call", async () => {
  const ids = seedBook();
  // a briefing at 8 AM recorded today's list; at 1 PM the same day it is asked about
  await brief(annId);
  const afternoon = await brief(annId, { localHour: 13, nowMs: at(TODAY, 13) });
  assert.match(afternoon.reply, /This morning I suggested calling (Lucy Tran|Owen Prescott|Grace Okafor)\. Were you able to reach them\?$/);

  db.prepare("DELETE FROM charlie_recommendations").run();
  fu.recordRecommendations(db, annId, "2026-10-26", [{ clientId: ids.owen, source: "sweep", reasonCode: "cash_out" }]);
  assert.ok((await brief(annId)).reply.endsWith("Earlier I suggested calling Owen Prescott. Were you able to reach them?"));

  db.prepare("DELETE FROM charlie_recommendations").run();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.grace, source: "calendar", reasonCode: "calendar", dueAt: "2026-10-29 18:00:00" }]);
  const cal = await brief(annId);
  assert.ok(cal.reply.endsWith("How did the call with Grace Okafor go?"), cal.reply);
  assert.equal(cal.followUp.source, "calendar");
});

test("a first open after noon does not ask about the list it has just made", async () => {
  seedBook();
  const r = await brief(annId, { localHour: 15, nowMs: at(TODAY, 15) });
  assert.ok(r.reply.includes("Today's calls: "), r.reply);
  assert.equal(r.followUp, null);
  assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
  assert.ok(recRows("user_id = ?", annId).every((row) => row.ask_count === 0));
});

test("with two open follow-ups the briefing says it has a couple, asks only the first, and counts both as asked", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, "2026-10-28", [{ clientId: ids.owen, source: "briefing", reasonCode: "cash_out" }]);
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.grace, source: "sweep", reasonCode: "check_in" }]);
  const r = await brief(annId);
  assert.equal(COUPLE_OF_CALLS, "I've also got a couple of calls to check on with you.");
  assert.ok(r.reply.endsWith(`${COUPLE_OF_CALLS} Earlier I suggested calling Owen Prescott. Were you able to reach them?`), r.reply);
  assert.equal(questionMarks(r.reply), 1, r.reply);
  assert.ok(!/\btwo\b/i.test(r.reply), r.reply);
  const counts = Object.fromEntries(recRows("user_id = ? AND day < ?", annId, TODAY).map((row) => [row.client_id, row.ask_count]));
  assert.deepStrictEqual(counts, { [ids.owen]: 1, [ids.lucy]: 1, [ids.grace]: 0 });
});

test("with no follow-up the close is the career question for a user with no stage, else the standing close", async () => {
  seedBook();
  assert.ok((await brief(nellId)).reply.endsWith(CAREER_QUESTION));
  assert.ok((await brief(annId)).reply.endsWith(CLOSE_QUESTION));
  assert.equal(CLOSE_QUESTION, "Want a full sweep, an update on a client, or should I get those calls on your calendar?");
});

// ── Review Focus 2: every section can fail ──────────────────────────────────

test("Review Focus 2: no Google, no rates, an empty book or a sweep that throws still give a briefing ending in one question", quiet(async () => {
  const check = async (label, run) => {
    let r;
    await assert.doesNotReject(async () => { r = await run(); }, label);
    assert.equal(typeof r.reply, "string", label);
    assert.ok(r.reply.trim().endsWith("?"), `${label}: ${r.reply}`);
    assert.equal(questionMarks(r.reply), 1, `${label}: ${r.reply}`);
    assert.ok(["morning", "catch_up"].includes(r.kind), label);
  };
  await check("empty book", () => brief(annId));
  seedBook();
  await check("no Google", () => brief(annId, { google: undefined }));
  await check("no rates", () => brief(annId, { rates: null }));
  await check("everything missing", () => brief(nellId, { rates: null, google: fakeGoogle({ connection: { code: "not_connected" } }) }));
  const realSweep = refi.runSweep;
  refi.runSweep = () => { throw new Error("sweep blew up"); };
  try {
    await check("sweep throws", () => brief(annId, { google: fakeGoogle() }));
    const r = await brief(annId);
    assert.ok(!r.reply.includes("Today's calls"), r.reply);
    assert.equal(r.strip.opportunities, null);
  } finally {
    refi.runSweep = realSweep;
  }
  await check("a bad localDate", () => brief(annId, { localDate: "not-a-date" }));
}));

test("no rates still lists a carried client, and leaves the market and the counts out", async () => {
  const ids = seedBook();
  fu.addCarry(db, annId, ids.grace, YESTERDAY);
  const r = await brief(annId, { rates: null });
  assert.ok(!r.reply.includes("30-year"), r.reply);
  assert.ok(r.reply.includes("Today's call: Grace Okafor, who you asked me to put on today's list."), r.reply);
  assert.deepStrictEqual(r.sources, []);
});

// ── locks ────────────────────────────────────────────────────────────────────

test("no briefing ever reads out a client's email or phone", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  const google = fakeGoogle({ byDate: { [TODAY]: [event("Lucy Tran call", "9:00 AM", TODAY, 9, 30)] } });
  const replies = [];
  for (const userId of [annId, louId, nellId]) {
    for (const localHour of [8, 15]) replies.push((await brief(userId, { localHour, google })).reply);
  }
  for (const reply of replies) {
    for (const contact of CONTACTS) assert.ok(!reply.includes(contact), `${contact}: ${reply}`);
  }
});

// ── fix round 1 ──────────────────────────────────────────────────────────────

test("the since label is the previous observation's own date, never a relative day", async () => {
  recordSnapshot(live("2026-10-23", { rate_30yr_fixed: 6.6 }), "2026-10-23", "fred");
  const r = await brief(nellId);
  assert.ok(r.reply.includes("The 30-year is at 6.52%, down 0.08 since October 23rd, as of October 29th."), r.reply);
});

test("speakable: contact-shaped text (any digit-run separator, fullwidth forms, @, ?) and text over 80 characters is not spoken", () => {
  for (const text of [
    "Call 555-201-0103", "Call 555–201–0103", "555/201/0103", "555_201_0103", "555,201,0103", "555 – 201 – 0103",
    "５５５２０１０１０３", "Call (555) 201 0103", "Room 123-4567", "1234567",
    "lucy@mail.example", "lucy＠mail.example", "Rate lock?", "Rate lock？", "x".repeat(81), "", "   ", null, 42,
  ]) {
    assert.equal(speakable(text), null, JSON.stringify(text));
  }
  assert.equal(speakable("Room 123-456"), "Room 123-456", "6 digits are kept");
  assert.equal(speakable("Team sync 10:30"), "Team sync 10:30");
  assert.equal(speakable("  Lucy \n Tran "), "Lucy Tran");
  assert.equal(speakable("x".repeat(80)), "x".repeat(80));
});

test("Review Focus 1, every separator: a phone-shaped title is read as \"an event\"", async () => {
  seedBook();
  for (const title of ["Call 555–201–0103", "555/201/0103", "555_201_0103", "555,201,0103", "Call 555 – 201 – 0103", "Call ５５５２０１０１０３", `Plan ${"x".repeat(80)}`]) {
    const r = await brief(annId, { google: fakeGoogle({ byDate: { [TODAY]: [event(title, "9:00 AM", TODAY, 9, 30)] } }) });
    assert.ok(r.reply.includes("You have 1 event on your calendar today: an event at 9:00 AM."), `${title}: ${r.reply}`);
    assert.ok(!/0103|０１０３|xxxx/.test(r.reply), `${title}: ${r.reply}`);
  }
  const kept = await brief(annId, { google: fakeGoogle({ byDate: { [TODAY]: [event("Room 123-456", "9:00 AM", TODAY, 9, 30)] } }) });
  assert.ok(kept.reply.includes("Room 123-456 at 9:00 AM"), kept.reply);
});

test("a client whose name holds an email or a phone number is never spoken: off the call list, and its follow-up is never asked", async () => {
  seedBook();
  const byEmail = addClient(annId, "lucy@mail.example", { rate: 7.5, balance: 400000, value: 500000 });
  const byPhone = addClient(annId, "Lucy 555-201-0103", { rate: 7.5, balance: 400000, value: 500000 });
  fu.recordRecommendations(db, annId, YESTERDAY, [
    { clientId: byEmail, source: "briefing", reasonCode: "rate_term" },
    { clientId: byPhone, source: "calendar", reasonCode: "calendar", dueAt: "2026-10-29 18:00:00" },
  ]);
  // two more with the best savings in the book and nothing recorded: they would top the list if their names could be read
  const topEmail = addClient(annId, "zed@mail.example", { rate: 8.5, balance: 400000, value: 500000 });
  const topPhone = addClient(annId, "Zed 555.201.0104", { rate: 8.5, balance: 400000, value: 500000 });
  const r = await brief(annId);
  for (const bad of ["lucy@mail.example", "zed@mail.example", "@", "555-201-0103", "555.201.0104", "0103", "0104", "Zed"]) {
    assert.ok(!r.reply.includes(bad), `${bad}: ${r.reply}`);
  }
  assert.ok(r.reply.includes("Lucy Tran could save"), r.reply);
  assert.equal(r.followUp, null);
  assert.ok(r.reply.endsWith(CLOSE_QUESTION), r.reply);
  assert.deepStrictEqual(recRows("client_id IN (?, ?)", byEmail, byPhone).map((row) => [row.day, row.ask_count]), [[YESTERDAY, 0], [YESTERDAY, 0]]);
  assert.equal(recRows("client_id IN (?, ?, ?, ?) AND day = ?", byEmail, byPhone, topEmail, topPhone, TODAY).length, 0, "not recorded as recommended today");
});

test("a briefing row and a calendar row for the same client are one call: named once, both counted as asked", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "calendar", reasonCode: "calendar", dueAt: "2026-10-29 18:00:00" }]);
  const r = await brief(annId);
  assert.ok(!r.reply.includes(COUPLE_OF_CALLS), r.reply);
  assert.ok(r.reply.endsWith("Yesterday I suggested calling Lucy Tran. Were you able to reach them?"), r.reply);
  assert.deepStrictEqual(recRows("client_id = ? AND day = ?", ids.lucy, YESTERDAY).map((row) => [row.source, row.ask_count]),
    [["briefing", 1], ["calendar", 1]]);

  // with a second client too, the couple is two clients, and Lucy's rows are both counted again
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.grace, source: "sweep", reasonCode: "check_in" }]);
  const two = await brief(annId);
  assert.ok(two.reply.includes(COUPLE_OF_CALLS), two.reply);
  assert.deepStrictEqual(recRows("day = ?", YESTERDAY).map((row) => [row.client_id, row.ask_count]),
    [[ids.lucy, 2], [ids.lucy, 2], [ids.grace, 1]]);
});

test("R11: with no call list (an empty book, a failed sweep, or everyone left off) the close does not offer to book \"those calls\"", quiet(async () => {
  assert.equal(CLOSE_NO_CALLS, "Want a full sweep, or an update on a client?");
  const empty = await brief(annId);
  assert.ok(empty.reply.endsWith(CLOSE_NO_CALLS), empty.reply);

  const ids = seedBook();
  for (const clientId of [ids.lucy, ids.owen, ids.grace]) {
    fu.logCall(db, { userId: annId, clientId, outcome: "reached", nowUtc: "2026-10-29 17:00:00" });
  }
  const allReached = await brief(annId);
  assert.ok(!allReached.reply.includes("Today's call"), allReached.reply);
  assert.ok(allReached.reply.endsWith(CLOSE_NO_CALLS), allReached.reply);

  db.prepare("DELETE FROM contact_log").run();
  const realSweep = refi.runSweep;
  refi.runSweep = () => { throw new Error("sweep blew up"); };
  try {
    assert.ok((await brief(annId)).reply.endsWith(CLOSE_NO_CALLS));
  } finally {
    refi.runSweep = realSweep;
  }
  assert.ok((await brief(annId)).reply.endsWith(CLOSE_QUESTION), "with a list, the close offers to book it");
}));

test("R12: a carried client listed today is not carried again tomorrow; one the list had no room for stays carried", async () => {
  const ids = seedBook();
  const extra = [];
  for (const name of ["Cara Mendez", "Dov Baker", "Eve Lund"]) extra.push(addClient(annId, name, { lastContact: "2026-10-01" }));
  for (const clientId of [...extra, ids.grace]) fu.addCarry(db, annId, clientId, YESTERDAY);   // four carried, three slots

  const today = await brief(annId);
  assert.ok(today.reply.includes("Today's calls: Cara Mendez, who you asked me to put on today's list; Dov Baker"), today.reply);
  assert.ok(!today.reply.includes("Grace Okafor"), today.reply);
  const carry = (clientId) => recRows("client_id = ? AND source = 'carry'", clientId)[0];
  for (const clientId of extra) {
    assert.equal(carry(clientId).status, "expired");
    assert.equal(carry(clientId).resolved_at, NOW_UTC);
  }
  assert.equal(carry(ids.grace).status, "open", "no room for her: still carried");

  // re-opening today reads the same list (the carried clients are still today's)
  assert.equal((await brief(annId)).reply, today.reply);

  const TOMORROW = "2026-10-31";
  assert.deepStrictEqual(fu.carriedIds(db, annId, TOMORROW), [ids.grace]);
  const tomorrow = await brief(annId, { localDate: TOMORROW, nowMs: at(TOMORROW, 8) });
  assert.ok(tomorrow.reply.includes("Today's calls: Grace Okafor, who you put on today's list, 12 months since your last check-in"), tomorrow.reply);
  for (const name of ["Cara Mendez, who", "Dov Baker, who", "Eve Lund, who"]) assert.ok(!tomorrow.reply.includes(name), tomorrow.reply);
});

test("R12 + R3: a carried client reached in the last 7 days is listed on the first open and on a same-day reopen, with no new rows", async () => {
  seedBook();   // Lucy, Owen and Grace: one more client than the two slots left after Cara, so a dropped Cara would be replaced
  const cara = addClient(annId, "Cara Mendez", { lastContact: "2026-10-01" });
  fu.logCall(db, { userId: annId, clientId: cara, outcome: "reached", nowUtc: "2026-10-28 17:00:00" });
  fu.addCarry(db, annId, cara, YESTERDAY);

  const first = await brief(annId);
  assert.ok(first.reply.includes("Today's calls: Cara Mendez, who you asked me to put on today's list; "), first.reply);
  assert.equal(recRows("client_id = ? AND source = 'carry'", cara)[0].status, "expired", "consumed by the first open");
  const rowsAfterFirst = recRows("user_id = ?", annId).map((row) => [row.client_id, row.day, row.source]);

  const reopen = await brief(annId);
  assert.equal(reopen.reply, first.reply, "the reopen reads the same list");
  assert.deepStrictEqual(recRows("user_id = ?", annId).map((row) => [row.client_id, row.day, row.source]), rowsAfterFirst, "no new rows");
});

test("consumeCarries leaves a carry dated the briefing's own day (asked for later today) for tomorrow", () => {
  const cara = addClient(annId, "Cara Mendez");
  fu.addCarry(db, annId, cara, YESTERDAY);
  fu.addCarry(db, annId, cara, TODAY);
  assert.equal(fu.consumeCarries(db, annId, [cara], NOW_UTC, TODAY), 1);
  assert.deepStrictEqual(recRows("client_id = ?", cara).map((row) => [row.day, row.status]), [[YESTERDAY, "expired"], [TODAY, "open"]]);
  assert.throws(() => fu.consumeCarries(db, annId, [cara], "2026-10-30T15:00:00Z", TODAY), TypeError);
  assert.throws(() => fu.recommendedOn(db, annId, TODAY, "nope"), TypeError);
});

test("a missing or impossible localDate falls back to the UTC date, and a bad localHour to the UTC hour: no section vanishes", async () => {
  const ids = seedBook();
  fu.recordRecommendations(db, annId, YESTERDAY, [{ clientId: ids.lucy, source: "briefing", reasonCode: "rate_term" }]);
  const google = () => fakeGoogle({ byDate: { [TODAY]: [event("Team sync", "9:00 AM", TODAY, 9, 30)] } });
  for (const localDate of [null, "2026-13-45", undefined, "yesterday"]) {
    db.prepare("UPDATE charlie_recommendations SET ask_count = 0").run();
    const r = await brief(annId, { localDate, google: google() });
    assert.ok(r.reply.includes("Today's calls: "), `${localDate}: ${r.reply}`);
    assert.ok(r.reply.includes("Team sync at 9:00 AM"), `${localDate}: ${r.reply}`);
    assert.ok(r.reply.endsWith("Yesterday I suggested calling Lucy Tran. Were you able to reach them?"), `${localDate}: ${r.reply}`);
    assert.ok(recRows("day = ? AND source = 'briefing'", TODAY).length > 0);
  }
  // NOW_MS is 15:00 UTC: a bad hour is the UTC hour, so this is a catch-up
  for (const localHour of [null, 24, -1, 8.5, "8"]) assert.equal((await brief(annId, { localHour })).kind, "catch_up", String(localHour));
});

test("the calendar follow-ups are not started once the wait is used up, even when today's read did answer", async () => {
  seedBook();
  const google = fakeGoogle({ listed: () => {
    const until = Date.now() + 80;
    while (Date.now() < until) { /* today's read answers, but only after the whole wait */ }
    return { events: [event("Team sync", "9:00 AM", TODAY, 9, 30)] };
  } });
  const r = await brief(annId, { google, calendarWaitMs: 50 });
  assert.deepStrictEqual(google.asked, [TODAY], "no follow-up read started with no time left to wait for it");
  assert.ok(r.reply.includes("Team sync at 9:00 AM"), r.reply);
  const none = fakeGoogle();
  await brief(annId, { google: none, calendarWaitMs: 0 });
  assert.deepStrictEqual(none.asked, [], "no wait at all: Google is not called");
});

test("\"Plus N more check-ins\" counts only clients that could be listed: not listed, not left off, and not asked about", async () => {
  seedBook();
  const named = {};
  for (const name of ["Dee Lang", "Eli Moss", "Fay Nunez", "Hal Ortiz"]) named[name] = addClient(annId, name, { lastContact: "2025-09-01" });
  fu.logCall(db, { userId: annId, clientId: named["Eli Moss"], outcome: "reached", nowUtc: "2026-10-28 17:00:00" });   // left off
  fu.recordRecommendations(db, annId, "2026-10-25", [{ clientId: named["Fay Nunez"], source: "sweep", reasonCode: "check_in" }]);   // asked about
  const r = await brief(annId);
  // due: Grace, Dee, Eli, Fay, Hal. Listed: Dee. Eli was reached, Fay is the follow-up: Grace and Hal remain
  assert.ok(r.reply.includes("Plus 2 more check-ins due."), r.reply);
  assert.ok(r.reply.endsWith("Earlier I suggested calling Fay Nunez. Were you able to reach them?"), r.reply);
});

"use strict";
// Dates coming up in the morning briefing (lib/assistant/briefing.js): the user's own clients' birthdays and anniversaries in the
// next week, at most two named, built in code from the client record. Against a throwaway DB with fixed clocks in America/Phoenix.
// No model call and no network anywhere.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-briefing-dates-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { buildBriefing, CLOSE_NO_CALLS } = require("../lib/assistant/briefing");
const { spokenOccasion, occasionsFor } = require("../lib/occasions");
const { EMPTY } = require("../lib/personal");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const TODAY = "2026-11-17";   // a Tuesday
const at = (date, hour) => {   // a local time in Phoenix (UTC-7 all year)
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour + 7, 0);
};

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Dates Org')").run().lastInsertRowid);
const addUser = (role, first, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)").run(orgId, role, first, email).lastInsertRowid);
const annId = addUser("broker", "Ann", "ann@briefing-dates.test");
const louId = addUser("lo", "Lou", "lou@briefing-dates.test");
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);

// A client nothing else in the briefing has a line for: reached yesterday, no target, no program.
function addClient(name, { closeDate = "", personal = null, userId = annId } = {}) {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, close_date, last_contact, personal)
    VALUES (?, ?, ?, '30yr_fixed', 3.0, 300000, 600000, 760, ?, '2026-11-16', ?)
  `).run(orgId, userId, name, closeDate, personal ? JSON.stringify({ ...EMPTY, ...personal }) : "").lastInsertRowid);
}

test.beforeEach(() => {
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "client_upgrades", "rate_snapshots", "clients"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

// No rates: the market, the sweep and the call list are left out, so the dates line stands on its own.
const brief = (userId = annId, localDate = TODAY) => {
  const user = userRow(userId);
  return buildBriefing({ user, ctx: { user, rates: null, db }, db, localHour: 8, localDate, nowMs: at(localDate, 8) });
};
const datesOf = (reply) => (/Dates coming up: .*?\.(?: Plus \d+ more in the next week\.)?(?= [A-Z]|$)/.exec(reply) || [""])[0];

test("no dates in the next week: the briefing says nothing about dates", async () => {
  addClient("Far Off", { closeDate: "2023-11-30", personal: { birthday: "11-24" } });   // 13 and 7 days away
  const b = await brief();
  assert.equal(datesOf(b.reply), "", b.reply);
  assert.ok(!/Dates coming up/.test(b.reply), b.reply);
  assert.ok(!b.sources.includes("client record"), JSON.stringify(b.sources));
  assert.ok(b.reply.endsWith(CLOSE_NO_CALLS), b.reply);
});

test("one date: named with its day and its count, cited to the client record, before the one question", async () => {
  addClient("Marisol & Daniel Okafor", { closeDate: "2023-11-19" });
  const b = await brief();
  assert.equal(datesOf(b.reply), "Dates coming up: Marisol & Daniel Okafor, loan anniversary Thursday, 3 years.", b.reply);
  assert.ok(b.sources.includes("client record"), JSON.stringify(b.sources));
  assert.ok(b.reply.endsWith(CLOSE_NO_CALLS), b.reply);
  assert.equal((b.reply.match(/\?/g) || []).length, 1, "one question, the last sentence");
});

test("two dates, soonest first; the rest are counted, not named", async () => {
  addClient("Marisol & Daniel Okafor", { closeDate: "2023-11-19",
    personal: { children: [{ name: "Maya", birthday: "11-18", birthYear: 2016 }], anniversary: "11-23", anniversaryYear: 2011 } });
  addClient("Priya Bhatt", { personal: { birthday: "11-17" } });
  const b = await brief();
  assert.equal(datesOf(b.reply),
    "Dates coming up: Priya Bhatt, birthday today; and Marisol & Daniel Okafor, Maya's birthday tomorrow, turns 10. Plus 2 more in the next week.",
    b.reply);
});

test("only the user's own clients: a broker's briefing leaves a loan officer's dates out", async () => {
  addClient("Lou's Client", { userId: louId, personal: { birthday: "11-18" } });
  const ann = await brief(annId);
  assert.equal(datesOf(ann.reply), "", ann.reply);
  const lou = await brief(louId);
  assert.equal(datesOf(lou.reply), "Dates coming up: Lou's Client, birthday tomorrow.", lou.reply);
});

test("a name that may not be read aloud is never said: the client's, or a child's", async () => {
  addClient("call 555 123 4567", { personal: { birthday: "11-18" } });                                   // a phone-shaped name
  addClient("Okafor", { personal: { children: [{ name: "a@b.co", birthday: "11-18", birthYear: null }, { name: "Maya", birthday: "11-19", birthYear: null }] } });
  const b = await brief();
  assert.equal(datesOf(b.reply), "Dates coming up: Okafor, Maya's birthday Thursday.", b.reply);
});

test("the day is the user's own: the same book read a day later moves on", async () => {
  addClient("Priya Bhatt", { personal: { birthday: "11-18" } });
  assert.equal(datesOf((await brief(annId, "2026-11-17")).reply), "Dates coming up: Priya Bhatt, birthday tomorrow.");
  assert.equal(datesOf((await brief(annId, "2026-11-18")).reply), "Dates coming up: Priya Bhatt, birthday today.");
  assert.equal(datesOf((await brief(annId, "2026-11-19")).reply), "");
});

test("spokenOccasion: the day sits before the count, and a kind's own word is lower case after the client's name", () => {
  const c = { id: 1, name: "X", closeDate: "2020-11-19", personal: { ...EMPTY, spouseBirthday: "11-20", spouseName: "Daniel",
    anniversary: "11-21", purchaseDate: "2015-11-22" } };
  assert.deepStrictEqual(occasionsFor(c, TODAY).map((o) => spokenOccasion(o, TODAY)), [
    "loan anniversary Thursday, 6 years", "Daniel's birthday Friday", "wedding anniversary Saturday", "home anniversary Sunday, 11 years",
  ]);
  const noName = { id: 1, name: "X", closeDate: "", personal: { ...EMPTY, spouseBirthday: "11-25" } };
  assert.deepStrictEqual(occasionsFor(noName, TODAY).map((o) => spokenOccasion(o, TODAY)), ["spouse's birthday Wednesday, November 25th"]);
});

"use strict";
// Charlie's dates coming up (lib/assistant/tools.js upcomingDatesTool, lib/assistant/prompt.js): "any birthdays this week?" is
// answered from the client record, each date said as the tool gives it. Against a throwaway DB and a scripted fake Anthropic
// client: no model call and no network anywhere.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-dates-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { tools, TOOL_SCHEMA, upcomingDatesTool, findClient } = require("../lib/assistant/tools");
const { CHARLI_SYSTEM, CANT_VERIFY } = require("../lib/assistant/prompt");
const { runTurn, ungroundedNumbers } = require("../lib/assistant/orchestrator");
const { EMPTY } = require("../lib/personal");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const TODAY = "2026-11-17";   // a Tuesday
const NOW = Date.UTC(2026, 10, 17, 16, 0);
const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, date: "2026-11-16",
  source: "Optimal Blue lock data (2026-11-16)" };

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, first, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)").run(orgId, role, first, email).lastInsertRowid);
function addClient(orgId, userId, name, { closeDate = "", personal = null } = {}) {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, close_date, personal)
    VALUES (?, ?, ?, '30yr_fixed', 6.5, 300000, 400000, 760, ?, ?)
  `).run(orgId, userId, name, closeDate, personal ? JSON.stringify({ ...EMPTY, ...personal }) : "").lastInsertRowid);
}

const org = addOrg("Dates");
const broker = addUser(org, "broker", "Bea", "bea@dates.test");
const lo = addUser(org, "lo", "Lou", "lou@dates.test");
const otherOrg = addOrg("Elsewhere");
const outsider = addUser(otherOrg, "broker", "Out", "out@dates.test");

const okafor = addClient(org, broker, "Marisol & Daniel Okafor", { closeDate: "2023-11-19",
  personal: { children: [{ name: "Maya", birthday: "11-20", birthYear: 2010 }], anniversary: "11-28", anniversaryYear: 2008 } });
const bhatt = addClient(org, lo, "Priya Bhatt", { personal: { birthday: "11-17" } });
addClient(org, lo, "No Dates");
addClient(otherOrg, outsider, "Other Org", { personal: { birthday: "11-18" } });

const ctxOf = (id, role, orgId = org, extra = {}) => ({ user: { id, role, org_id: orgId }, rates: RATES, db, now: NOW, localDate: TODAY, ...extra });

test("upcomingDatesTool: a broker's whole org, soonest first, each date in the tool's own words; a teammate's client names its owner", () => {
  const r = upcomingDatesTool({}, ctxOf(broker, "broker"));
  assert.equal(r.source, "client record");
  assert.deepStrictEqual(r.data, {
    days: 14, more: 0,
    dates: [
      { clientId: bhatt, name: "Priya Bhatt", ownerName: "Lou User", occasion: "Birthday", when: "today", date: "2026-11-17" },
      { clientId: okafor, name: "Marisol & Daniel Okafor", occasion: "Loan anniversary, 3 years", when: "Thursday", date: "2026-11-19" },
      { clientId: okafor, name: "Marisol & Daniel Okafor", occasion: "Maya's birthday, turns 16", when: "Friday", date: "2026-11-20" },
      { clientId: okafor, name: "Marisol & Daniel Okafor", occasion: "Wedding anniversary, 18 years", when: "Saturday, November 28th", date: "2026-11-28" },
    ],
  });
});

test("upcomingDatesTool: a loan officer sees their own clients only; another org's are never seen", () => {
  const r = upcomingDatesTool({}, ctxOf(lo, "lo"));
  assert.deepStrictEqual(r.data.dates.map((d) => d.name), ["Priya Bhatt"]);
  assert.equal("ownerName" in r.data.dates[0], false);
  assert.deepStrictEqual(upcomingDatesTool({}, ctxOf(outsider, "broker", otherOrg)).data.dates.map((d) => d.name), ["Other Org"]);
});

test("upcomingDatesTool: days narrows or widens the window, 1 to 60; anything else is refused", () => {
  assert.deepStrictEqual(upcomingDatesTool({ days: 3 }, ctxOf(broker, "broker")).data.dates.map((d) => d.when), ["today", "Thursday", "Friday"]);
  assert.equal(upcomingDatesTool({ days: 3 }, ctxOf(broker, "broker")).data.days, 3);
  assert.equal(upcomingDatesTool({ days: 60 }, ctxOf(broker, "broker")).data.dates.length, 4);
  for (const days of [0, 61, 2.5, "7", -1]) {
    const bad = upcomingDatesTool({ days }, ctxOf(broker, "broker"));
    assert.match(bad.source, /^\([^)]+\)$/, String(days));
    assert.match(bad.data.error, /1 to 60/);
  }
});

test("upcomingDatesTool: the day is the user's own; with none sent it is the clock's UTC day; twenty dates at most, the rest counted", () => {
  const tomorrow = upcomingDatesTool({}, ctxOf(broker, "broker", org, { localDate: "2026-11-18" }));
  assert.deepStrictEqual(tomorrow.data.dates.map((d) => d.when), ["tomorrow", "Friday", "Saturday, November 28th"]);
  const noLocal = upcomingDatesTool({}, ctxOf(broker, "broker", org, { localDate: undefined }));
  assert.deepStrictEqual(noLocal.data.dates.map((d) => d.when), ["today", "Thursday", "Friday", "Saturday, November 28th"]);

  const crowd = addOrg("Crowd");
  const boss = addUser(crowd, "broker", "Boss", "boss@dates.test");
  for (let i = 0; i < 23; i++) addClient(crowd, boss, `Client ${String(i).padStart(2, "0")}`, { personal: { birthday: "11-18" } });
  const many = upcomingDatesTool({}, ctxOf(boss, "broker", crowd));
  assert.equal(many.data.dates.length, 20);
  assert.equal(many.data.more, 3);
});

test("upcomingDatesTool: the model is shown no more than it says: no children's birth years, no spouse, pets or referral", () => {
  const r = upcomingDatesTool({}, ctxOf(broker, "broker"));
  const payload = JSON.stringify(r.data);
  for (const hidden of ["2010", "2008", "birthYear", "pets", "referredBy", "retirement"]) assert.ok(!payload.includes(hidden), hidden);
  // and findClient does not carry the personal details
  const found = findClient({ query: "okafor" }, ctxOf(broker, "broker"));
  assert.equal("personal" in found.data.matches[0], false);
  assert.ok(!JSON.stringify(found.data).includes("Maya"));
});

test("upcomingDatesTool is one of Charlie's tools, described, with an optional days", () => {
  assert.equal(tools.upcomingDatesTool, upcomingDatesTool);
  const t = TOOL_SCHEMA.find((x) => x.name === "upcomingDatesTool");
  assert.ok(t && /birthday/i.test(t.description) && /anniversar/i.test(t.description));
  assert.deepStrictEqual(t.input_schema.required, []);
  assert.deepStrictEqual(Object.keys(t.input_schema.properties), ["days"]);
});

test("CHARLI_SYSTEM carries the dates rule exactly, once, as a paragraph of its own", () => {
  const RULE =
    "Dates: when the user asks about clients' birthdays, anniversaries or what dates are coming up, call upcomingDatesTool and say each " +
    "one as it gives it: the client, the occasion and the day in its own words. Never work out a date, a weekday, an age or a count of " +
    "years yourself. These are reminders for a personal touch only: never say or imply that a birthday, an anniversary, a marriage or " +
    "children make a client a better or worse fit for a loan.";
  assert.equal(CHARLI_SYSTEM.split(RULE).length, 2);
  assert.ok(CHARLI_SYSTEM.split("\n\n").includes(RULE));
});

// ── through a turn: the tool's dates ground what Charlie says ─────────────────

const resp = (content, stop_reason) => ({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason,
  usage: { input_tokens: 100, output_tokens: 20 } });
const say = (t) => resp([{ type: "text", text: t }], "end_turn");
const useTool = (name, input = {}) => resp([{ type: "tool_use", id: "toolu_1", name, input }], "tool_use");
function fakeClient(script) {
  const calls = [];
  return { calls, messages: { create: async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error("fake client: script exhausted at call " + calls.length);
    return typeof next === "function" ? next(params) : next;
  } } };
}
const ask = (question, reply, ctx = ctxOf(broker, "broker")) =>
  runTurn({ messages: [{ role: "user", content: question }], ctx, client: fakeClient([useTool("upcomingDatesTool"), say(reply)]) });

test("a turn: dates said as the tool gave them stand, cited to the client record", async () => {
  const replies = [
    "Four dates coming up. Priya Bhatt's birthday is today. Marisol & Daniel Okafor's loan anniversary is Thursday, 3 years. " +
      "Maya's birthday is Friday, she turns 16. And the Okafors' wedding anniversary is Saturday, November 28th, 18 years.",
    "Priya Bhatt has a birthday today, and Marisol & Daniel Okafor have their 3-year loan anniversary Thursday. Maya Okafor turns 16 on Friday.",
    "Just one today: Priya Bhatt's birthday. She's Lou User's client.",
  ];
  for (const question of ["any birthdays this week?", "what dates are coming up for my clients?", "any anniversaries coming up?"]) {
    for (const reply of replies) {
      const r = await ask(question, reply);
      assert.equal(r.reply, reply, `${question} -> ${reply}`);
      assert.deepStrictEqual(r.sources, ["client record"]);
    }
  }
});

test("a turn: an age, a count of years or a date the tool did not give is can't-verify", async () => {
  for (const reply of [
    "Maya's birthday is Friday, she turns 21.",
    "Marisol & Daniel Okafor's wedding anniversary is Saturday, November 28th, 25 years.",
    "Priya Bhatt's birthday is November 30th.",
  ]) {
    const r = await ask("any birthdays this week?", reply);
    assert.equal(r.reply, CANT_VERIFY, reply);
  }
});

test("every figure in the tool's own words is grounded by its payload as the model gets it", () => {
  const r = upcomingDatesTool({}, ctxOf(broker, "broker"));
  const payloads = [JSON.stringify({ source: r.source, data: r.data })];
  for (const d of r.data.dates) assert.deepStrictEqual(ungroundedNumbers(`${d.name}: ${d.occasion}, ${d.when}.`, payloads), [], d.occasion);
});

"use strict";
// Target-rate alerts in the morning briefing (lib/assistant/briefing.js, spec 4.5 and 4.6): a client at their target leads the
// call list after the carried clients, is announced once, and a broker's team line counts their loan officers' clients at target.
// Against a throwaway DB with stored FRED snapshots and fixed clocks in America/Phoenix. No model call and no network anywhere.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-briefing-targets-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const fu = require("../lib/assistant/followups");
const T = require("../lib/targets");
const { recordSnapshot } = require("../lib/rateHistory");
const { buildBriefing } = require("../lib/assistant/briefing");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const OBS = "2026-11-10";    // a Tuesday: the FRED observation the first check reads
const DAY1 = "2026-11-11";   // the first briefing after it
const DAY2 = "2026-11-12";
const at = (date, hour, minute = 0) => {   // a local time in Phoenix (UTC-7 all year)
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour + 7, minute);
};
const utc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// A FRED set. Every seeded client (760, LTV 80 or under, 30-year fixed) is top tier, so its estimated rate is `topTier`.
const rates = (obs, topTier, numbers = {}) => ({
  rate_30yr_fixed: 6.12, rate_15yr_fixed: 5.52, rate_5_1_arm: 5.61, rate_30yr_top_tier: topTier, ...numbers,
  date: obs, source: `Optimal Blue lock data (${obs})`,
});
// Stored as the rates route stores a FRED day (captured on `day`), and returned as the set the browser holds.
const fred = (set, day = set.date) => { recordSnapshot(set, day, "fred"); return set; };
const HIT = () => fred(rates(OBS, 5.875));

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)"
).run(orgId, role, first, email).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);

const orgId = addOrg("Targets Org");
const annId = addUser(orgId, "broker", "ann@briefing-targets.test", "Ann");
const louId = addUser(orgId, "lo", "lou@briefing-targets.test", "Lou");

function addClient(userId, name, fields = {}) {
  const f = { rate: 6.75, balance: 300000, value: 400000, lastContact: "2026-10-01", target: null, ...fields };
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact, target_rate)
    VALUES (?, ?, ?, '30yr_fixed', ?, ?, ?, 760, ?, ?)
  `).run(orgId, userId, name, f.rate, f.balance, f.value, f.lastContact, f.target).lastInsertRowid);
}
const client = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const announced = (...ids) => ids.map((id) => client(id).target_announced_on);
const lucyFor = (userId) => addClient(userId, "Lucy Tran", { rate: 7.5, balance: 400000, value: 500000 });   // a sweep pick

test.beforeEach(() => {
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "rate_snapshots", "clients"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

const brief = (userId, { set, localDate, hour = 8, ...rest }) => {
  const user = userRow(userId);
  return buildBriefing({ user, ctx: { user, rates: set, db }, db, localHour: hour, localDate, nowMs: at(localDate, hour), ...rest });
};
// The "Today's calls" sentence of a reply ("" when there is none). A reason holds "5.875%", so a sentence ends at ". " + a capital.
const callListOf = (reply) => (/Today's calls?(?:, on estimated rates)?: .*?\.(?= [A-Z]|$)/.exec(reply) || [""])[0];
const SAID_AT_TARGET = /is at target|is still at a/;
const quiet = (fn) => async () => {
  const realError = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = realError; }
};

// ── the call list ────────────────────────────────────────────────────────────

test("newly at target leads after carried, ahead of the sweep, with the target wording", async () => {
  const set = HIT();
  addClient(annId, "Helen Brandt", { target: 6 });
  lucyFor(annId);
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.match(callListOf(r.reply),
    /^Today's calls: Helen Brandt is at target, estimated 5\.875% against a 6\.000% target; and Lucy Tran could save about \$[\d,]+ a month\.$/, r.reply);
  assert.deepStrictEqual(r.sources, [`daily rates ${OBS}`, "sweep engine", "client record"]);

  // a carried client still comes first
  db.prepare("DELETE FROM charlie_recommendations").run();
  db.prepare("UPDATE clients SET target_announced_on = NULL").run();
  const cara = addClient(annId, "Cara Mendez", { rate: 4.0 });   // nothing to say about her but the carry
  fu.addCarry(db, annId, cara, OBS);
  const carried = await brief(annId, { set, localDate: DAY1 });
  assert.match(callListOf(carried.reply),
    /^Today's calls: Cara Mendez, who you asked me to put on today's list; Helen Brandt is at target, estimated 5\.875% against a 6\.000% target; and Lucy Tran could save/, carried.reply);
});

test("at target overrides the sweep bar", async () => {
  const set = fred(rates(OBS, 6.0, { rate_15yr_fixed: 6.3 }));
  const ivy = addClient(annId, "Ivy Chen", { rate: 6.25, target: 6.1 });
  const swept = refi.sweepClient(client(ivy), set);
  assert.equal(swept.best, null, "a drop of 0.25: the sweep has nothing for Ivy");
  assert.equal(swept.checkIn.due, false);
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.equal(callListOf(r.reply), "Today's call: Ivy Chen is at target, estimated 6.000% against a 6.100% target.");
  assert.equal(r.strip.opportunities, 0);
  assert.deepStrictEqual(db.prepare("SELECT client_id, reason_code FROM charlie_recommendations").all(), [{ client_id: ivy, reason_code: "target" }]);
});

test("announced once", async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  const first = await brief(annId, { set, localDate: DAY1 });
  assert.equal(callListOf(first.reply), "Today's call: Helen Brandt is at target, estimated 5.875% against a 6.000% target.");
  assert.deepStrictEqual(announced(helen), [DAY1]);

  // a rebuild the same day reads the same words, and announces nothing again
  const rebuild = await brief(annId, { set, localDate: DAY1, hour: 9 });
  assert.equal(callListOf(rebuild.reply), callListOf(first.reply));
  assert.deepStrictEqual(announced(helen), [DAY1]);

  // the next day: not announced again, but asked about (yesterday's list row is open)
  const next = await brief(annId, { set, localDate: DAY2 });
  assert.ok(!SAID_AT_TARGET.test(next.reply), next.reply);
  assert.ok(next.reply.endsWith("Yesterday I suggested calling Helen Brandt. Were you able to reach them?"), next.reply);
  // answered "not reached", she is recently recommended: still not listed
  fu.resolveForClient(db, annId, helen, "not_reached", utc(at(DAY2, 9)), { includeCarry: false });
  const answered = await brief(annId, { set, localDate: DAY2, hour: 10 });
  assert.ok(!answered.reply.includes("Helen Brandt"), answered.reply);
  assert.deepStrictEqual(announced(helen), [DAY1]);
});

test("still at target after three days", async () => {
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  await brief(annId, { set: HIT(), localDate: DAY1 });
  const tenAm = utc(at(DAY1, 10));
  fu.logCall(db, { userId: annId, clientId: helen, outcome: "not_reached", nowUtc: tenAm });
  fu.resolveForClient(db, annId, helen, "not_reached", tenAm, { includeCarry: false });

  const third = await brief(annId, { set: rates(OBS, 5.875), localDate: "2026-11-14" });
  assert.ok(!third.reply.includes("Helen Brandt"), `recommended 3 days ago and not reached: ${third.reply}`);

  // day 4: a newer observation reaches Bea's target (Helen's estimate wobbles, still a hit); Lucy is a sweep pick
  const bea = addClient(annId, "Bea Ruiz", { target: 5.85 });
  lucyFor(annId);
  const later = fred(rates("2026-11-13", 5.85), "2026-11-15");
  const fourth = await brief(annId, { set: later, localDate: "2026-11-15" });
  assert.match(callListOf(fourth.reply),
    /^Today's calls: Bea Ruiz is at target, estimated 5\.850% against a 5\.850% target; Helen Brandt is still at a 6\.000% target, since November 10th; and Lucy Tran could save about \$[\d,]+ a month\.$/, fourth.reply);
  assert.deepStrictEqual(announced(helen, bea), [DAY1, "2026-11-15"], "still at target is no new announcement");
  assert.deepStrictEqual(db.prepare("SELECT reason_code FROM charlie_recommendations WHERE day = '2026-11-15' ORDER BY id").all()
    .map((r) => r.reason_code), ["target", "target_still", "rate_term"]);
});

test("handled is never listed", async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  T.checkTargets(db, orgId, at(OBS, 18));   // the hit is recorded that evening (the client list loaded)
  fu.logCall(db, { userId: annId, clientId: helen, outcome: "reached", nowUtc: utc(at(OBS, 19)) });
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.ok(!r.reply.includes("Helen Brandt"), r.reply);
  assert.deepStrictEqual(announced(helen), [null]);
  assert.equal(T.viewsFor(db, [client(helen)], annId).get(helen).state, "handled");
});

test("already below is never listed", async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  const others = ["Abe Ames", "Bo Banks", "Cy Cole"].map((name) => addClient(annId, name, { target: 6 }));
  T.checkTargets(db, orgId, at(OBS, 18));
  assert.equal(client(helen).target_reached_on, OBS);
  db.prepare("UPDATE clients SET current_rate = 5.9 WHERE id = ?").run(helen);   // refinanced since
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.ok(!r.reply.includes("Helen Brandt"), r.reply);
  assert.ok(callListOf(r.reply).startsWith("Today's calls: Abe Ames is at target"), r.reply);
  assert.ok(!r.reply.includes("Plus"), `no overflow count: ${r.reply}`);
  assert.deepStrictEqual(announced(helen, ...others), [null, DAY1, DAY1, DAY1]);
});

test("four at once", async () => {
  const set = HIT();
  const ids = ["Abe Ames", "Bo Banks", "Cy Cole", "Di Dunn"].map((name) => addClient(annId, name, { target: 6 }));
  const r = await brief(annId, { set, localDate: DAY1 });
  const said = (name) => `${name} is at target, estimated 5.875% against a 6.000% target`;
  const list = `Today's calls: ${said("Abe Ames")}; ${said("Bo Banks")}; and ${said("Cy Cole")}.`;
  assert.equal(callListOf(r.reply), list);
  assert.ok(r.reply.includes(`${list} Plus 1 more client at their target.`), r.reply);
  assert.deepStrictEqual(announced(...ids), [DAY1, DAY1, DAY1, null]);

  const next = await brief(annId, { set, localDate: DAY2 });
  assert.equal(callListOf(next.reply), `Today's call: ${said("Di Dunn")}.`);
  assert.ok(!next.reply.includes("Plus"), next.reply);
  assert.deepStrictEqual(announced(...ids), [DAY1, DAY1, DAY1, DAY2]);
});

test("newly at target: in the order the hits were recorded, then by name", async () => {
  const set = HIT();
  const zoe = addClient(annId, "Zoe Webb", { target: 6 });
  T.checkTargets(db, orgId, at(OBS, 18));   // Zoe's hit is recorded the evening before
  const abe = addClient(annId, "Abe Ames", { target: 6 });
  const r = await brief(annId, { set, localDate: DAY1 });   // Abe's, by this briefing's own check
  assert.ok(client(zoe).target_reached_at < client(abe).target_reached_at);
  assert.ok(callListOf(r.reply).startsWith("Today's calls: Zoe Webb is at target, estimated 5.875% against a 6.000% target; and Abe Ames is at target"), r.reply);
});

test("five at once: the overflow says clients", async () => {
  const set = HIT();
  for (const name of ["Abe Ames", "Bo Banks", "Cy Cole", "Di Dunn", "Ed Ely"]) addClient(annId, name, { target: 6 });
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.ok(r.reply.includes(" Plus 2 more clients at their target."), r.reply);
});

test("bypasses the 7-day and 3-day exclusions", async () => {
  const set = HIT();
  const gil = addClient(annId, "Gil Hart", { target: 6 });
  const hal = addClient(annId, "Hal Ito", { target: 6 });
  // two days before the hit (recorded by the first briefing): Gil was reached; Hal was put forward and not reached
  const before = utc(at("2026-11-09", 10));
  fu.logCall(db, { userId: annId, clientId: gil, outcome: "reached", nowUtc: before });
  fu.recordRecommendations(db, annId, "2026-11-09", [{ clientId: hal, source: "sweep", reasonCode: "rate_term" }]);
  fu.logCall(db, { userId: annId, clientId: hal, outcome: "not_reached", nowUtc: before });
  fu.resolveForClient(db, annId, hal, "not_reached", before, { includeCarry: false });
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.equal(callListOf(r.reply),
    "Today's calls: Gil Hart is at target, estimated 5.875% against a 6.000% target; and Hal Ito is at target, estimated 5.875% against a 6.000% target.");
  assert.deepStrictEqual(announced(gil, hal), [DAY1, DAY1]);
});

test("a follow-up client is deferred", async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  fu.recordRecommendations(db, annId, OBS, [{ clientId: helen, source: "briefing", reasonCode: "rate_term" }]);
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.ok(r.reply.endsWith("Yesterday I suggested calling Helen Brandt. Were you able to reach them?"), r.reply);
  assert.ok(!SAID_AT_TARGET.test(r.reply), r.reply);
  assert.equal(callListOf(r.reply), "");
  assert.deepStrictEqual(announced(helen), [null]);
  assert.ok(!r.sources.includes("client record"), r.sources.join(" | "));
});

test("a carried client stays carried", async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  fu.addCarry(db, annId, helen, OBS);
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.match(callListOf(r.reply), /^Today's call: Helen Brandt, who you put on today's list, could save about \$[\d,]+ a month\.$/, r.reply);
  assert.ok(!SAID_AT_TARGET.test(r.reply) && !r.reply.includes("Plus"), r.reply);
  assert.deepStrictEqual(announced(helen), [null]);
  assert.equal(db.prepare("SELECT reason_code FROM charlie_recommendations WHERE source = 'briefing'").get().reason_code, "carry");
});

// ── teams ────────────────────────────────────────────────────────────────────

test("LO's client: LO is told, broker counts it", async () => {
  // Larry (Lou's) reaches his target with nothing the sweep would pick; Lucy is Ann's own
  const set = fred(rates(OBS, 6.0, { rate_15yr_fixed: 6.3 }));
  const larry = addClient(louId, "Larry Stone", { rate: 6.25, target: 6.1 });
  lucyFor(annId);
  const none = await brief(annId, { set, localDate: DAY1 });
  assert.ok(none.reply.includes(" 1 of your loan officers' clients is at target."), none.reply);
  assert.ok(!none.reply.includes("Larry Stone") && !/opportunit/.test(none.reply), none.reply);
  assert.match(callListOf(none.reply), /^Today's call: Lucy Tran could save/, none.reply);
  assert.deepStrictEqual(none.sources, [`daily rates ${OBS}`, "sweep engine", "client record"]);
  assert.equal(client(larry).target_reached_on, OBS, "the broker's check stored the hit");
  assert.deepStrictEqual(announced(larry), [null], "and announced nothing of a loan officer's client");

  // one more of Lou's with an opportunity: the count goes on the opportunities line
  addClient(louId, "Lars Berg", { rate: 7.5, balance: 400000, value: 500000 });
  const both = await brief(annId, { set, localDate: DAY1, hour: 9 });
  assert.ok(both.reply.includes(" Your loan officers have 1 opportunity open, and 1 of their clients is at target."), both.reply);

  const lo = await brief(louId, { set, localDate: DAY1 });
  assert.ok(callListOf(lo.reply).startsWith("Today's calls: Larry Stone is at target, estimated 6.000% against a 6.100% target; "), lo.reply);
  assert.ok(!/loan officers/.test(lo.reply), lo.reply);
  assert.deepStrictEqual(announced(larry), [DAY1]);

  // with no rates in hand the stored hit still counts
  const bare = await brief(annId, { set: null, localDate: DAY1, hour: 10 });
  assert.ok(bare.reply.includes(" 1 of your loan officers' clients is at target."), bare.reply);
  assert.deepStrictEqual(bare.sources, ["client record"]);
});

// ── which rates act ──────────────────────────────────────────────────────────

test("a weekend reopen announces nothing new", async () => {
  const FRI = "2026-11-13";
  const SAT = "2026-11-14";
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  const bea = addClient(annId, "Bea Ruiz", { target: 5.8 });
  const fri = await brief(annId, { set: fred(rates(FRI, 5.875)), localDate: FRI });
  assert.ok(callListOf(fri.reply).startsWith("Today's calls: Helen Brandt is at target"), fri.reply);
  assert.equal(client(bea).target_checked_on, FRI);

  // Saturday's fetch repeats Friday's observation (here at numbers that would reach Bea's target): not a new check
  const sat = await brief(annId, { set: fred(rates(FRI, 5.75), SAT), localDate: SAT });
  assert.ok(!SAID_AT_TARGET.test(sat.reply), sat.reply);
  assert.equal(client(bea).target_reached_on, null);
  assert.deepStrictEqual(announced(helen, bea), [FRI, null]);
});

test("rates no real snapshot", async () => {
  addClient(annId, "Helen Brandt", { target: 6 });
  lucyFor(annId);
  const web = { ...rates(OBS, 5.5), source: "web search" };   // would reach Helen's target if it counted
  recordSnapshot(web, OBS, "claude");
  const EST = { ...rates(DAY1, 5.5), source: "Estimated — live fetch unavailable" };
  for (const set of [web, EST]) {
    const reset = () => {
      for (const table of ["charlie_recommendations", "user_briefing_state"]) db.prepare(`DELETE FROM ${table}`).run();
    };
    reset();
    db.prepare("UPDATE clients SET target_rate = 6 WHERE name = 'Helen Brandt'").run();
    const withTarget = await brief(annId, { set, localDate: DAY1 });
    assert.ok(!SAID_AT_TARGET.test(withTarget.reply), withTarget.reply);
    assert.ok(!withTarget.sources.includes("client record"), withTarget.sources.join(" | "));
    assert.ok(db.prepare("SELECT * FROM clients").all().every((c) => c.target_checked_on === null && c.target_reached_on === null));

    // the same briefing over a book with no target at all
    reset();
    db.prepare("UPDATE clients SET target_rate = NULL").run();
    const without = await brief(annId, { set, localDate: DAY1 });
    assert.equal(withTarget.reply, without.reply);
    assert.deepStrictEqual(withTarget.sources, without.sources);
  }
});

test("a target check that throws leaves the targets out and the rest as before", quiet(async () => {
  const set = HIT();
  const helen = addClient(annId, "Helen Brandt", { target: 6 });
  lucyFor(annId);
  addClient(louId, "Larry Stone", { target: 6 });
  T.checkTargets(db, orgId, at(OBS, 18));   // Helen's and Larry's hits are stored
  const realCheck = T.checkTargets;
  T.checkTargets = () => { throw new Error("check blew up"); };
  try {
    const r = await brief(annId, { set, localDate: DAY1 });
    assert.match(callListOf(r.reply), /^Today's calls: Lucy Tran could save .*; and Helen Brandt could save/, r.reply);
    assert.ok(r.reply.includes(" Your loan officers have 1 opportunity open."), r.reply);
    assert.ok(!r.sources.includes("client record"), r.sources.join(" | "));
    assert.deepStrictEqual(announced(helen), [null]);
  } finally {
    T.checkTargets = realCheck;
  }
}));

"use strict";
// Upgrade alerts in the morning briefing (lib/assistant/briefing.js, spec 4.7): a client who newly qualifies for an upgrade lens is
// named once, ahead of the sweep's ranking, announced (client_upgrades.announced_on), and said no more as "now" the next day.
// Against a throwaway DB with stored FRED snapshots and fixed clocks in America/Phoenix. No model call and no network anywhere.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-briefing-upgrades-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const UA = require("../lib/upgradeAlerts");
const { recordSnapshot } = require("../lib/rateHistory");
const { ungroundedNumbers } = require("../lib/assistant/orchestrator");
const { buildBriefing } = require("../lib/assistant/briefing");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const OBS = "2026-11-10";
const DAY1 = "2026-11-11";
const DAY2 = "2026-11-12";
const at = (date, hour) => {   // a local time in Phoenix (UTC-7 all year)
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour + 7, 0);
};
const SET = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, rate_30yr_fha: 6.1, rate_30yr_va: 5.8,
  date: OBS, source: `Optimal Blue lock data (${OBS})` };
const fred = (set = SET) => { recordSnapshot(set, set.date, "fred"); return set; };

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Upgrades Org')").run().lastInsertRowid);
const annId = Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'Ann', 'User', 'ann@briefing-upgrades.test')"
).run(orgId).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);

// A VA client with a 7.5% loan closed in mid-2025: the IRRRL qualifies at the VA rate of 5.8. Government loans skip the rate lenses.
function addVa(name, fields = {}) {
  const f = { rate: 7.5, ...fields };
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, credit_score_known,
      loan_program, close_date, balance_as_of, original_amount, original_value, property_zip, occupancy, last_contact)
    VALUES (?, ?, ?, '30yr_fixed', ?, 300000, 400000, 720, 1, 'va', '2025-06-15', '2025-06-15', 300000, 400000, '85016', 'primary', '2026-11-01')
  `).run(orgId, annId, name, f.rate).lastInsertRowid);
}
const announcedOn = (id) => db.prepare("SELECT announced_on FROM client_upgrades WHERE client_id = ?").all(id).map((r) => r.announced_on);

test.beforeEach(() => {
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "client_upgrades", "rate_snapshots", "clients"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

const brief = (userId, { set, localDate, hour = 8 }) => {
  const user = userRow(userId);
  return buildBriefing({ user, ctx: { user, rates: set, db }, db, localHour: hour, localDate, nowMs: at(localDate, hour) });
};
const callListOf = (reply) => (/Today's calls?(?:, on estimated rates)?: .*?\.(?= [A-Z]|$)/.exec(reply) || [""])[0];
const quiet = (fn) => async () => {
  const realError = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = realError; }
};

test("a newly qualified client is named once as 'now', announced, with a grounded figure", async () => {
  const set = fred();
  const vee = addVa("Vee Sample");
  const swept = refi.runSweep(db.prepare("SELECT * FROM clients").all(), set, new Date(at(DAY1, 8)));
  const first = await brief(annId, { set, localDate: DAY1 });
  assert.match(callListOf(first.reply),
    /^Today's call: Vee Sample now looks like they could do a VA streamline and save about \$[\d,]+ a month\.$/, first.reply);
  assert.deepStrictEqual(ungroundedNumbers(callListOf(first.reply), [swept]), [], first.reply);
  assert.deepStrictEqual(db.prepare("SELECT client_id, reason_code FROM charlie_recommendations").all(), [{ client_id: vee, reason_code: "upgrade" }]);
  assert.deepStrictEqual(announcedOn(vee), [DAY1]);

  // a rebuild the same day reads the same words and announces nothing again
  const again = await brief(annId, { set, localDate: DAY1, hour: 9 });
  assert.equal(callListOf(again.reply), callListOf(first.reply));
  assert.deepStrictEqual(announcedOn(vee), [DAY1]);

  // the next day: no longer "now" (yesterday's list asks about her instead)
  const next = await brief(annId, { set, localDate: DAY2 });
  assert.ok(!next.reply.includes(" now looks like"), next.reply);
  assert.deepStrictEqual(announcedOn(vee), [DAY1]);
});

test("a newly qualified client leads the sweep's ranking", async () => {
  const set = fred();
  Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
    VALUES (?, ?, 'Lucy Tran', '30yr_fixed', 7.5, 400000, 500000, 760, '2026-11-01')`).run(orgId, annId).lastInsertRowid);
  addVa("Vee Sample");
  const r = await brief(annId, { set, localDate: DAY1 });
  assert.match(callListOf(r.reply), /^Today's calls: Vee Sample now looks like .*; and Lucy Tran could save about \$[\d,]+ a month\.$/, r.reply);

});

test("an upgrade check that throws leaves the 'now' out and the rest as before", quiet(async () => {
  const set = fred();
  const vee = addVa("Vee Sample");
  const real = UA.checkUpgrades;
  UA.checkUpgrades = () => { throw new Error("check blew up"); };
  try {
    const r = await brief(annId, { set, localDate: DAY1 });
    assert.match(callListOf(r.reply), /^Today's call: Vee Sample looks like they could do a VA streamline/, r.reply);
    assert.deepStrictEqual(announcedOn(vee), []);
  } finally {
    UA.checkUpgrades = real;
  }
}));

test("no FRED snapshot: no 'now', the sweep still names the upgrade", async () => {
  addVa("Vee Sample");
  const r = await brief(annId, { set: SET, localDate: DAY1 });
  assert.ok(!r.reply.includes(" now looks like"), r.reply);
  assert.match(callListOf(r.reply), /^Today's call: Vee Sample looks like they could do a VA streamline/, r.reply);
});

"use strict";
// The rate check (lib/pings/rateCheck.js) end to end against a throwaway DB: a fake FRED, a fake push sender, a fake mail sender and a
// fake clock. No network, no Claude call, no real mail. Sample people only.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-rate-check-"));
process.env.NODE_ENV = "test";

const test = require("node:test");
const { beforeEach, after } = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { recordSnapshot } = require("../lib/rateHistory");
const ratesCache = require("../lib/ratesCache");
const { saveSettings, DEFAULTS } = require("../lib/pings/settings");
const { pingText } = require("../lib/pings/text");
const { runRateCheck, claimPing, finishPing, releasePing } = require("../lib/pings/rateCheck");
const { recordAcceptance, CURRENT_VERSIONS } = require("../lib/terms");

after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const at = (iso) => Date.parse(iso);
const T = at("2026-11-24T15:00:00Z");                    // Tuesday 10:00 in New York
const drop = { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" };

// ── fixtures ──────────────────────────────────────────────────────────────────

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Sample Brokerage')").run().lastInsertRowid);
const addUser = (role, email, first, extra = "") => Number(db.prepare(
  `INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, ?, ?, 'Sample', ?, 1)`
).run(orgId, role, first, email).lastInsertRowid);
const ann = { id: addUser("broker", "ann@rcheck.test", "Ann"), email: "ann@rcheck.test" };
const lee = { id: addUser("lo", "lee@rcheck.test", "Lee"), email: "lee@rcheck.test" };
const bob = { id: addUser("lo", "bob@rcheck.test", "Bob"), email: "bob@rcheck.test" };
db.prepare(
  `INSERT INTO clients (org_id, user_id, name, email, loan_type, current_rate, loan_balance, property_value)
   VALUES (?, ?, 'Sample Client One', 'sample.one@example.test', '30yr_fixed', 7.5, 300000, 450000)`
).run(orgId, ann.id);

const EP = (who, n = 1) => `https://fcm.googleapis.com/fcm/send/${who}-device-${n}`;
const addSub = (user, n = 1) => db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'pk', 'au')").run(user.id, EP(user.email.split("@")[0], n));

const FULL = (obs, v30) => ({
  rate_30yr_fixed: v30, rate_15yr_fixed: 5.7, rate_5_1_arm: Math.round((v30 - 0.1) * 100) / 100, rate_30yr_jumbo: 6.6, rate_30yr_fha: 6.1,
  rate_30yr_top_tier: 6.35, date: obs, source: `Optimal Blue lock data (${obs}) · ARM estimated`,
});

// A FRED that answers per series_id. serve(overrides) replaces what series say; every URL is recorded.
function makeFred() {
  const state = { overrides: {}, fail: false };
  const urls = [];
  const base = (date, v30, prev) => ({
    OBMMIC30YF: prev ? [[date, v30], prev] : [[date, v30]],
    OBMMIC15YF: [[date, "5.700"]], OBMMIJUMBO30YF: [[date, "6.600"]], OBMMIFHA30YF: [[date, "6.100"]],
    OBMMIC30YFLVLE80FGE740: [[date, "6.350"]], OBMMIVA30YF: [[date, "6.050"]],
  });
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (state.fail) throw new TypeError("fetch failed");
    const id = new URL(url).searchParams.get("series_id");
    const list = state.overrides[id] || base("2026-11-24", "6.402", ["2026-11-21", "6.555"])[id];
    return { ok: true, status: 200, json: async () => ({ observations: list.map(([date, value]) => ({ date, value })) }) };
  };
  fetchImpl.urls = urls;
  fetchImpl.serve = (o) => { state.overrides = o; };
  // a whole new publish: every series on `date`, the 30-year at v30, and the observation before it
  fetchImpl.publish = (date, v30, prev) => { state.overrides = base(date, v30, prev); };
  fetchImpl.down = (flag = true) => { state.fail = flag; };
  return fetchImpl;
}

// A fake push sender: records each call; `statusFor(sub)` says what each device answers (201 by default).
function makePush({ statusFor = () => 201, enabled = true } = {}) {
  const calls = [];
  return {
    enabled, calls,
    async send(sub, payload, opts) {
      calls.push({ endpoint: sub.endpoint, payload, ttlSeconds: opts.ttlSeconds });
      const status = statusFor(sub);
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, gone: status === 404 || status === 410, status };
    },
  };
}
function makeMail({ enabled = true, ok = true } = {}) {
  const calls = [];
  return { enabled, calls, async sendRateDrop(args) { calls.push(args); return ok; } };
}

let fred, push, mail;
const run = (o = {}) => runRateCheck({
  db, env: { FRED_API_KEY: "test-key" }, nowMs: T, fetchImpl: fred, push, mail, billingConfig: { enabled: false }, ...o,
});
const sentRow = (user, obs = "2026-11-24") => {
  const r = db.prepare("SELECT channel, status FROM rate_alerts_sent WHERE user_id = ? AND observation_date = ?").get(user.id, obs);
  return r ? { channel: r.channel, status: r.status } : undefined;
};
const subCount = (user) => db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(user.id).n;

beforeEach(() => {
  for (const t of ["rate_alerts_sent", "push_subscriptions", "user_alert_settings", "rate_snapshots", "terms_acceptances"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("UPDATE users SET removed_at = NULL, time_zone = 'America/New_York'").run();
  db.prepare("UPDATE organizations SET billing_status = NULL, billing_exempt = 0, billing_tester_until = NULL").run();
  ratesCache.clear();
  recordSnapshot(FULL("2026-11-21", 6.555), "2026-11-21", "fred");
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true });
  saveSettings(db, lee.id, { ...DEFAULTS, enabled: true });
  addSub(ann); addSub(lee);
  fred = makeFred();
  push = makePush();
  mail = makeMail();
});

const quiet = async (fn) => {
  const keep = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  for (const k of Object.keys(keep)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try { await fn(); } finally { Object.assign(console, keep); }
  return lines;
};

// ── the claim ─────────────────────────────────────────────────────────────────

test("claimPing is once per user and observation; releasePing frees a claim only until it is sent", () => {
  assert.equal(claimPing(db, ann.id, "2026-11-24", "2026-11-24 15:00:00"), true);
  assert.equal(claimPing(db, ann.id, "2026-11-24", "2026-11-24 15:00:01"), false);
  assert.equal(claimPing(db, lee.id, "2026-11-24", "2026-11-24 15:00:00"), true, "another user");
  assert.equal(claimPing(db, ann.id, "2026-11-25", "2026-11-25 15:00:00"), true, "another observation");
  releasePing(db, ann.id, "2026-11-25");
  assert.equal(claimPing(db, ann.id, "2026-11-25", "2026-11-25 15:05:00"), true, "released, so claimable again");
  finishPing(db, ann.id, "2026-11-24", "push");
  assert.deepEqual(sentRow(ann), { channel: "push", status: "sent" });
  releasePing(db, ann.id, "2026-11-24");
  assert.deepEqual(sentRow(ann), { channel: "push", status: "sent" }, "a sent ping is never released");
  assert.equal(claimPing(db, ann.id, "2026-11-24", "2026-11-24 16:00:00"), false);
});

// ── the run ───────────────────────────────────────────────────────────────────

test("one drop, one ping per user, a second run sends nothing", async () => {
  const s1 = await run({ nowMs: at("2026-11-24T15:00:00Z") });
  assert.deepEqual(s1, { fetched: true, observation: "2026-11-24", recorded: true, drop: "yes", sent: 2, held: 0, skipped: 0, failed: 0 });
  assert.equal(push.calls.length, 2);
  const s2 = await run({ nowMs: at("2026-11-24T15:30:00Z") });
  assert.equal(s2.sent, 0);
  assert.equal(s2.recorded, false, "the same observation is not recorded twice");
  assert.equal(s2.skipped, 2);
  assert.equal(push.calls.length, 2);
  assert.deepEqual(sentRow(ann), { channel: "push", status: "sent" });
  assert.equal(sentRow(bob), undefined, "Bob has pings off");
});

test("the run stores the observation and empties the rates cache, so the briefing carries the same one", async () => {
  ratesCache.set({ success: true, rates: { rate_30yr_fixed: 6.555 } });
  await run();
  assert.equal(ratesCache.get(), null);
  const row = db.prepare("SELECT provider, rates FROM rate_snapshots WHERE day = '2026-11-24'").get();
  assert.equal(row.provider, "fred");
  assert.equal(JSON.parse(row.rates).rate_30yr_fixed, 6.402);
  assert.equal(JSON.parse(row.rates).source, "Optimal Blue lock data (2026-11-24) · ARM estimated");
  ratesCache.set({ success: true });
  await run({ nowMs: T + 60_000 });
  assert.deepEqual(ratesCache.get(), { success: true }, "a repeat of the same observation leaves the cache alone");
});

test("two overlapping runs still send once", async () => {
  await Promise.all([run(), run()]);
  assert.equal(push.calls.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_alerts_sent").get().n, 2);
});

test("held at night, sent at 07:00, if the drop still stands", async () => {
  assert.equal((await run({ nowMs: at("2026-11-25T02:00:00Z") })).held, 2);   // Tue 21:00 in New York
  assert.equal(push.calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_alerts_sent").get().n, 0, "a hold claims nothing");
  assert.equal((await run({ nowMs: at("2026-11-25T11:30:00Z") })).held, 2);   // 06:30
  const s = await run({ nowMs: at("2026-11-25T12:30:00Z") });                 // 07:30
  assert.equal(s.sent, 2);
  assert.equal(push.calls.length, 2);
});

test("held, then a newer observation that is no drop: nothing is sent", async () => {
  await run({ nowMs: at("2026-11-25T02:00:00Z") });
  fred.publish("2026-11-25", "6.450", ["2026-11-24", "6.402"]);
  const s = await run({ nowMs: at("2026-11-25T21:00:00Z") });
  assert.equal(s.drop, "none");
  assert.equal(s.observation, "2026-11-25");
  assert.equal(push.calls.length, 0);
});

test("a Friday drop held over the weekend goes on Monday morning, not Saturday", async () => {
  fred.publish("2026-11-27", "6.402", ["2026-11-26", "6.555"]);
  recordSnapshot(FULL("2026-11-26", 6.555), "2026-11-26", "fred");
  assert.equal((await run({ nowMs: at("2026-11-28T15:00:00Z") })).held, 2);   // Saturday 10:00: weekdays only
  assert.equal(push.calls.length, 0);
  // Lee turns weekdays-only off and gets it on Saturday
  saveSettings(db, lee.id, { ...DEFAULTS, enabled: true, weekdaysOnly: false });
  const s = await run({ nowMs: at("2026-11-28T16:00:00Z") });
  assert.equal(s.sent, 1);
  assert.equal(sentRow(lee, "2026-11-27").status, "sent");
  assert.equal(sentRow(ann, "2026-11-27"), undefined);
  // Monday 2026-11-30 07:30: 3 days old, inside the 4-day window
  assert.equal((await run({ nowMs: at("2026-11-30T12:30:00Z") })).sent, 1);
});

test("the push TTL runs to the user's quiet start", async () => {
  await run({ nowMs: at("2026-11-24T23:30:00Z") });   // 18:30: quiet starts at 20:00
  assert.deepEqual(push.calls.map((c) => c.ttlSeconds), [5400, 5400]);
});

test("a drop under the user's size is not theirs", async () => {
  saveSettings(db, lee.id, { ...DEFAULTS, enabled: true, threshold: 0.25 });
  const s = await run();
  assert.equal(s.sent, 1);
  assert.equal(s.skipped, 1);
  assert.equal(sentRow(lee), undefined);
});

test("a drop whose observation is more than four days old is nobody's", async () => {
  const stale = await run({ nowMs: at("2026-11-30T15:00:00Z") });   // the observation is 6 days old
  assert.equal(stale.sent, 0);
  assert.equal(stale.skipped, 2);
  assert.equal(push.calls.length, 0);
  assert.equal((await run({ nowMs: at("2026-11-28T15:00:00Z"), })).held, 2, "four days old, on a Saturday: still news, held for the weekend rule");
});

test("a small drop pings nobody: drop 'none'", async () => {
  fred.publish("2026-11-24", "6.480", ["2026-11-21", "6.555"]);
  const s = await run();
  assert.equal(s.drop, "none");
  assert.equal(s.sent + s.held + s.skipped + s.failed, 0);
  assert.equal(push.calls.length, 0);
  assert.equal(s.recorded, true, "the observation is still recorded");
});

test("FRED revised the previous day, or skipped one: unconfirmed, nobody pinged", async () => {
  fred.publish("2026-11-24", "6.402", ["2026-11-21", "6.500"]);
  const a = await run();
  assert.equal(a.drop, "unconfirmed");
  assert.equal(a.sent, 0);
  fred.publish("2026-11-24", "6.402", ["2026-11-20", "6.555"]);
  const b = await run({ nowMs: T + 60_000 });
  assert.equal(b.drop, "unconfirmed");
  fred.publish("2026-11-24", "6.402");
  assert.equal((await run({ nowMs: T + 120_000 })).drop, "unconfirmed", "no previous observation in FRED's reply");
  assert.equal(push.calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_alerts_sent").get().n, 0);
});

test("a rounding-sized difference in FRED's previous number is still confirmed", async () => {
  fred.publish("2026-11-24", "6.402", ["2026-11-21", "6.5552"]);
  assert.equal((await run()).drop, "yes");
});

test("FRED older than what is stored: unconfirmed, nobody pinged", async () => {
  await run({ nowMs: at("2026-11-25T02:00:00Z") });   // stores 11-24, holds the pings
  fred.publish("2026-11-21", "6.555", ["2026-11-20", "6.600"]);
  const s = await run({ nowMs: at("2026-11-25T12:30:00Z") });
  assert.equal(s.drop, "unconfirmed");
  assert.equal(push.calls.length, 0);
});

test("a partial publish records nothing and sends nothing", async () => {
  fred.serve({ OBMMIC30YF: [["2026-11-25", "6.30"], ["2026-11-24", "6.402"]] });   // the other series are still on the 24th
  const before = db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n;
  const s = await run();
  assert.equal(s.recorded, false);
  assert.equal(s.sent, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_snapshots").get().n, before);
  assert.equal(push.calls.length, 0);
});

test("FRED down: no ping from a stored or web-searched set, and no Claude call", async () => {
  // a drop is already stored (a web-searched set must never act on its own either)
  recordSnapshot(FULL("2026-11-24", 6.402), "2026-11-24", "fred");
  recordSnapshot({ ...FULL("2026-11-24", 6.0), source: "Mortgage News Daily" }, "2026-11-23", "claude");
  fred.down();
  const realFetch = global.fetch;
  let strayCalls = 0;
  global.fetch = async () => { strayCalls += 1; throw new Error("no network in this test"); };
  let lines;
  let s;
  try { lines = await quiet(async () => { s = await run(); }); } finally { global.fetch = realFetch; }
  assert.equal(s.fetched, false);
  assert.equal(s.sent, 0);
  assert.equal(s.recorded, false);
  assert.equal(push.calls.length, 0);
  assert.equal(strayCalls, 0, "nothing but the injected fetch was used");
  assert.ok(fred.urls.length > 0 && fred.urls.every((u) => u.startsWith("https://api.stlouisfed.org/fred/")));
  assert.ok(lines.every((l) => !l.includes("test-key")), "the FRED key is not logged");
});

test("no FRED key: nothing is fetched and nothing is sent", async () => {
  const s = await run({ env: {} });
  assert.equal(s.fetched, false);
  assert.equal(fred.urls.length, 0);
  assert.equal(push.calls.length, 0);
});

test("a gone endpoint is deleted, the other device still gets it", async () => {
  addSub(ann, 2);
  push = makePush({ statusFor: (sub) => (sub.endpoint === EP("ann", 1) ? 410 : 201) });
  const s = await run();
  assert.equal(s.sent, 2);
  assert.equal(subCount(ann), 1);
  assert.equal(db.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id = ?").get(ann.id).endpoint, EP("ann", 2));
  assert.equal(subCount(lee), 1);
  assert.equal(sentRow(ann).status, "sent");
});

test("a failing device keeps its subscription; every channel failing releases the claim, so the next run retries", async () => {
  push = makePush({ statusFor: () => 500 });
  const s1 = await run();
  assert.equal(s1.failed, 2);
  assert.equal(s1.sent, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_alerts_sent").get().n, 0);
  assert.equal(subCount(ann), 1);
  assert.equal(subCount(lee), 1);
  push = makePush();
  const s2 = await run({ nowMs: T + 600_000 });
  assert.equal(s2.sent, 2);
  assert.equal(s2.failed, 0);
});

test("a gone endpoint with no other device is a failed channel: the claim is released", async () => {
  push = makePush({ statusFor: (sub) => (sub.endpoint === EP("ann", 1) ? 404 : 201) });
  const s = await run();
  assert.equal(s.sent, 1);
  assert.equal(s.failed, 1);
  assert.equal(subCount(ann), 0);
  assert.equal(sentRow(ann), undefined);
});

test("a success is never undone: if any one device took it, the ping is sent and not retried", async () => {
  addSub(ann, 2);
  push = makePush({ statusFor: (sub) => (sub.endpoint === EP("ann", 2) ? 500 : 201) });
  const s = await run();
  assert.equal(s.sent, 2);
  const again = await run({ nowMs: T + 600_000 });
  assert.equal(again.sent, 0);
  assert.equal(push.calls.filter((c) => c.endpoint.includes("ann")).length, 2, "Ann's two devices were tried once each");
});

// A db whose "delete a gone device" statement throws `times` times (a disk error on the volume); everything else is the real db.
const flakyDeletes = (times) => {
  let left = times;
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql) => {
          if (left > 0 && /DELETE FROM push_subscriptions WHERE id/.test(sql)) {
            return { run: () => { left -= 1; throw Object.assign(new Error("disk I/O error"), { name: "SqliteError" }); } };
          }
          return target.prepare(sql);
        };
      }
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
};

test("a failed delete of a gone device after another device took the ping never releases the claim", async () => {
  addSub(ann, 2);
  push = makePush({ statusFor: (sub) => (sub.endpoint === EP("ann", 2) ? 410 : 201) });
  let s1;
  const lines = await quiet(async () => { s1 = await run({ db: flakyDeletes(1) }); });
  assert.equal(s1.sent, 2, "Ann and Lee are both counted as sent");
  assert.equal(s1.failed, 0);
  assert.equal(sentRow(ann).status, "sent");
  assert.ok(lines.some((l) => /SqliteError/.test(l)), "the failure is logged by name");
  assert.ok(!lines.some((l) => /ann@|fcm\.googleapis/.test(l)));
  const before = push.calls.length;
  const s2 = await run({ nowMs: T + 1_800_000 });
  assert.equal(s2.sent, 0);
  assert.equal(push.calls.length, before, "nothing is sent to Ann (or anyone) on the second run");
});

test("a locked brokerage gets nothing; an active one gets it", async () => {
  const locked = { enabled: true };
  db.prepare("UPDATE organizations SET billing_status = 'canceled' WHERE id = ?").run(orgId);
  recordAcceptance(db, ann.id, CURRENT_VERSIONS, T, null);
  recordAcceptance(db, lee.id, CURRENT_VERSIONS, T, null);
  const s = await run({ billingConfig: locked });
  assert.equal(s.skipped, 2);
  assert.equal(s.sent, 0);
  assert.equal(push.calls.length, 0);
  db.prepare("UPDATE organizations SET billing_status = 'active' WHERE id = ?").run(orgId);
  assert.equal((await run({ billingConfig: locked, nowMs: T + 60_000 })).sent, 2);
});

test("a user who has not accepted the current terms is locked while billing is on", async () => {
  db.prepare("UPDATE organizations SET billing_status = 'active' WHERE id = ?").run(orgId);
  recordAcceptance(db, ann.id, CURRENT_VERSIONS, T, null);   // Lee has not
  const s = await run({ billingConfig: { enabled: true } });
  assert.equal(s.sent, 1);
  assert.equal(s.skipped, 1);
  assert.ok(sentRow(ann) && !sentRow(lee));
});

test("removed and not-yet-invited users are not pinged", async () => {
  db.prepare("UPDATE users SET removed_at = 1700000000000 WHERE id = ?").run(lee.id);
  const s = await run();
  assert.equal(s.sent, 1);
  assert.equal(sentRow(lee), undefined);
  db.prepare("UPDATE users SET invite_accepted = 0 WHERE id = ?").run(ann.id);
  assert.equal((await run({ nowMs: T + 60_000 })).sent, 0);
  db.prepare("UPDATE users SET invite_accepted = 1 WHERE id = ?").run(ann.id);
});

test("email channel goes to the user's own login email", async () => {
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, channels: "email" });
  const s = await run();
  assert.equal(s.sent, 2);
  assert.equal(mail.calls.length, 1);
  assert.equal(mail.calls[0].to, ann.email);
  assert.deepEqual(mail.calls[0].drop, drop);
  assert.equal(mail.calls[0].localDate, "2026-11-24");
  assert.ok(!push.calls.some((c) => c.endpoint.includes("ann")), "no push call for Ann");
  assert.deepEqual(sentRow(ann), { channel: "email", status: "sent" });
  assert.deepEqual(sentRow(lee), { channel: "push", status: "sent" });
});

test("both channels: each is tried and the row says both", async () => {
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, channels: "both" });
  await run();
  assert.equal(mail.calls.length, 1);
  assert.ok(push.calls.some((c) => c.endpoint.includes("ann")));
  assert.deepEqual(sentRow(ann), { channel: "both", status: "sent" });
});

test("both channels, push failing: the email is enough and the row says email", async () => {
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, channels: "both" });
  push = makePush({ statusFor: () => 500 });
  const s = await run();
  assert.deepEqual(sentRow(ann), { channel: "email", status: "sent" });
  assert.equal(s.sent, 1);
  assert.equal(s.failed, 1, "Lee's only channel failed");
});

test("a channel that is switched off at the server is skipped without a claim left behind", async () => {
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, channels: "email" });
  mail = makeMail({ enabled: false });
  const s = await run();
  assert.equal(s.skipped, 1);
  assert.equal(sentRow(ann), undefined);
  const noPush = await run({ push: null, nowMs: T + 60_000 });
  assert.equal(noPush.sent, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_alerts_sent").get().n, 1, "only Lee's, from the first run");
  assert.equal(push.calls.length, 1, "Lee's, from the first run");
});

test("a user with the phone channel on but no device is skipped, and retried when one is added", async () => {
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(ann.id);
  const s = await run();
  assert.equal(s.sent, 1);
  assert.equal(s.skipped, 1);
  assert.equal(sentRow(ann), undefined);
  addSub(ann);
  assert.equal((await run({ nowMs: T + 60_000 })).sent, 1);
});

test("the push payload is the ping text and nothing else", async () => {
  await run();
  assert.deepEqual(push.calls[0].payload, pingText(drop, "2026-11-24"));
  assert.deepEqual(Object.keys(push.calls[0].payload).sort(), ["body", "tag", "title", "url"]);
});

test("each user's own day names the date: a user in Tokyo reads the 25th", async () => {
  db.prepare("UPDATE users SET time_zone = 'Asia/Tokyo' WHERE id = ?").run(ann.id);
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, quietStart: "00:00", quietEnd: "00:00", weekdaysOnly: false });
  await run({ nowMs: at("2026-11-24T16:00:00Z") });   // already the 25th, 01:00 in Tokyo
  const annCall = push.calls.find((c) => c.endpoint.includes("ann"));
  assert.match(annCall.payload.body, /\(as of November 24th\)/);
  const mail2 = makeMail();
  db.prepare("DELETE FROM rate_alerts_sent WHERE user_id = ?").run(lee.id);
  saveSettings(db, lee.id, { ...DEFAULTS, enabled: true, channels: "email", quietStart: "00:00", quietEnd: "00:00" });
  db.prepare("UPDATE users SET time_zone = 'Asia/Tokyo' WHERE id = ?").run(lee.id);
  await run({ nowMs: at("2026-11-24T16:30:00Z"), mail: mail2 });
  assert.equal(mail2.calls[0].localDate, "2026-11-25");
});

test("no log line carries a client, a user email, a user id or an endpoint", async () => {
  push = makePush({ statusFor: (sub) => (sub.endpoint === EP("lee", 1) ? 500 : 201) });
  saveSettings(db, ann.id, { ...DEFAULTS, enabled: true, channels: "both" });
  const lines = await quiet(async () => { await run(); await run({ nowMs: T + 60_000 }); await run({ nowMs: at("2026-11-25T02:00:00Z") }); });
  assert.ok(lines.length >= 1);
  for (const l of lines) {
    for (const bad of ["Sample Client One", "sample.one@example.test", ann.email, lee.email, EP("ann", 1), EP("lee", 1), "fcm.googleapis.com", "test-key"]) {
      assert.ok(!l.includes(bad), `a log line carries ${bad}: ${l}`);
    }
  }
  assert.ok(lines.some((l) => /^\[pings\] obs 2026-11-24 30yr 6\.4 move -0\.15: sent \d+, held \d+, skipped \d+, failed \d+$/.test(l)), lines.join(" | "));
});

test("a failure inside one user's step is counted and logged by name only, and the next user is still served", async () => {
  push = makePush();
  const real = push.send;
  push.send = async (sub, ...rest) => { if (sub.endpoint.includes("ann")) throw new TypeError(`boom for ${sub.endpoint} ${ann.email}`); return real(sub, ...rest); };
  let s;
  const lines = await quiet(async () => { s = await run(); });
  assert.equal(s.sent, 1);
  assert.equal(s.failed, 1);
  assert.equal(sentRow(ann), undefined, "released");
  assert.ok(lines.every((l) => !l.includes(ann.email) && !l.includes("fcm.googleapis.com") && !l.includes("boom")), lines.join(" | "));
});

test("the summary has the nine counts and nothing else", async () => {
  const s = await run();
  assert.deepEqual(Object.keys(s).sort(), ["drop", "failed", "fetched", "held", "observation", "recorded", "sent", "skipped"]);
  for (const k of ["sent", "held", "skipped", "failed"]) assert.ok(Number.isInteger(s[k]));
});

test("past the deadline the rest of the users are held for the next run, and nobody is sent", async () => {
  const s = await run({ deadlineMs: 0 });
  assert.equal(s.sent, 0);
  assert.equal(s.held, 2);
  assert.equal(push.calls.length, 0);
});

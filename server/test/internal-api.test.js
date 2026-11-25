"use strict";
// POST /internal/rate-check (routes/internal.js): the shared-secret door Cloud Scheduler uses, and the start-up wiring that decides
// whether the rate check and its channels are on (lib/pings/channels.js). Offline: a fake FRED, a fake push sender, a throwaway DB.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-internal-api-"));
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");

const db = require("../db");
const { recordSnapshot } = require("../lib/rateHistory");
const { saveSettings, DEFAULTS } = require("../lib/pings/settings");
const channels = require("../lib/pings/channels");

const internalRouter = require("../routes/internal");
const SECRET32 = "s3cret-".padEnd(32, "x");
const NOW = Date.parse("2026-11-24T15:00:00Z");

let server, base, app;
before(async () => {
  app = express();
  app.use(express.json());
  app.use("/internal", internalRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const post = async (p, headers = {}) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};

function fakeFred(gate) {
  const urls = [];
  const f = async (url) => {
    urls.push(String(url));
    if (gate) await gate;
    const id = new URL(url).searchParams.get("series_id");
    const list = id === "OBMMIC30YF" ? [["2026-11-24", "6.402"], ["2026-11-21", "6.555"]] : [["2026-11-24", "6.000"]];
    return { ok: true, status: 200, json: async () => ({ observations: list.map(([date, value]) => ({ date, value })) }) };
  };
  f.urls = urls;
  return f;
}

beforeEach(() => {
  for (const t of ["rate_alerts_sent", "push_subscriptions", "user_alert_settings", "rate_snapshots"]) db.prepare(`DELETE FROM ${t}`).run();
  app.set("rateCheckEnv", undefined);
  app.set("rateCheckDeps", undefined);
  app.set("rateCheckLimit", undefined);
  // the limiter counts per client address, and every test here is the same client
  for (const ip of ["::1", "127.0.0.1", "::ffff:127.0.0.1"]) internalRouter.limiter.resetKey(ip);
});

test("not available without the secret", async () => {
  const r = await post("/internal/rate-check", {});
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { success: false, error: "not available" });
  // a secret shorter than 32 characters is no secret at all, even sent back correctly
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: "short" });
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": "short" })).status, 404);
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: "   " });
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": "   " })).status, 404);
});

test("403 on a wrong secret, 200 with counts only on the right one", async () => {
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32 });
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": "nope" })).status, 403);
  assert.deepEqual((await post("/internal/rate-check", { "x-rate-check-secret": "nope" })).body, { success: false });
  assert.equal((await post("/internal/rate-check", {})).status, 403, "no header");
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": `${SECRET32}x` })).status, 403, "longer");
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": SECRET32.slice(0, -1) })).status, 403, "shorter");
  const r = await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["drop", "failed", "fetched", "held", "observation", "recorded", "sent", "skipped", "success"]);
  assert.equal(r.body.success, true);
  assert.equal(r.body.fetched, false, "no FRED key in this environment");
});

test("the secret is read with its surrounding whitespace trimmed", async () => {
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: `${SECRET32}\n` });
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 })).status, 200);
});

test("a second call while one runs is 409, and the first still finishes", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32, FRED_API_KEY: "k" });
  app.set("rateCheckDeps", { fetchImpl: fakeFred(gate), now: () => NOW });
  const first = post("/internal/rate-check", { "x-rate-check-secret": SECRET32 });
  await new Promise((r) => setTimeout(r, 100));
  const second = await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { success: false, busy: true });
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.body.fetched, true);
  // and the next call is welcome again
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 })).status, 200);
});

test("a run that throws answers 500 and frees the door", async () => {
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32, FRED_API_KEY: "k" });
  app.set("rateCheckDeps", { fetchImpl: fakeFred(), now: () => NOW, push: { enabled: true, send: async () => ({ ok: true }) } });
  const realPrepare = db.prepare.bind(db);
  const keep = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  db.prepare = (sql) => { if (/FROM users u JOIN user_alert_settings/.test(sql)) throw new Error("boom at /Users/someone"); return realPrepare(sql); };
  recordSnapshot({ rate_30yr_fixed: 6.555, rate_15yr_fixed: 5.7, rate_5_1_arm: 6.4, date: "2026-11-21", source: "Optimal Blue lock data (2026-11-21)" }, "2026-11-21", "fred");
  let r;
  try { r = await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 }); } finally { db.prepare = realPrepare; console.error = keep; }
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { success: false });
  assert.ok(lines.every((l) => !l.includes("someone") && !l.includes("boom")), lines.join(" | "));
  assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 })).status, 200);
});

test("the door is limited: ten a minute", async () => {
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32 });
  app.set("rateCheckLimit", 3);
  const seen = [];
  for (let i = 0; i < 5; i += 1) seen.push((await post("/internal/rate-check", { "x-rate-check-secret": "wrong" })).status);
  assert.deepEqual(seen, [403, 403, 403, 429, 429]);
});

test("end to end through the door: one ping goes out, and the answer carries counts only", async () => {
  const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Sample Brokerage')").run().lastInsertRowid);
  const annId = Number(db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted, time_zone) VALUES (?, 'broker', 'Ann', 'Sample', 'ann@intapi.test', 1, 'America/New_York')"
  ).run(orgId).lastInsertRowid);
  saveSettings(db, annId, { ...DEFAULTS, enabled: true });
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://fcm.googleapis.com/fcm/send/ann-device', 'pk', 'au')").run(annId);
  recordSnapshot({ rate_30yr_fixed: 6.555, rate_15yr_fixed: 5.7, rate_5_1_arm: 6.4, date: "2026-11-21", source: "Optimal Blue lock data (2026-11-21)" }, "2026-11-21", "fred");
  const sends = [];
  app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32, FRED_API_KEY: "k" });
  app.set("rateCheckDeps", { fetchImpl: fakeFred(), now: () => NOW, push: { enabled: true, send: async (sub, payload) => { sends.push({ sub, payload }); return { ok: true }; } } });
  const keep = console.log;
  console.log = () => {};
  let r;
  try { r = await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 }); } finally { console.log = keep; }
  assert.deepEqual(r.body, { success: true, fetched: true, observation: "2026-11-24", recorded: true, drop: "yes", sent: 1, held: 0, skipped: 0, failed: 0 });
  assert.equal(sends.length, 1);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("ann@intapi.test") && !text.includes("fcm.googleapis.com"));
});

// ── start-up wiring ───────────────────────────────────────────────────────────

test("rateCheckStatus: on only with a long enough secret and a FRED key; reasons never carry a value", () => {
  assert.deepEqual(channels.rateCheckStatus({}), { enabled: false, reason: "RATE_CHECK_SECRET not set" });
  assert.deepEqual(channels.rateCheckStatus({ RATE_CHECK_SECRET: "short" }), { enabled: false, reason: "RATE_CHECK_SECRET shorter than 32 characters" });
  assert.deepEqual(channels.rateCheckStatus({ RATE_CHECK_SECRET: SECRET32 }), { enabled: false, reason: "FRED_API_KEY not set" });
  assert.deepEqual(channels.rateCheckStatus({ RATE_CHECK_SECRET: SECRET32, FRED_API_KEY: "k" }), { enabled: true, reason: "" });
});

test("buildChannels: the start-up line names reasons only, and the channels are null when off", () => {
  const off = channels.buildChannels({}, { mailReady: () => false });
  assert.equal(off.push, null);
  assert.equal(off.mail, null);
  assert.equal(off.line, "[pings] rate check off (RATE_CHECK_SECRET not set), push off (VAPID keys not set), email off");
  const { makeVapidKeys } = require("../lib/pings/push");
  const k = makeVapidKeys();
  const env = { RATE_CHECK_SECRET: SECRET32, FRED_API_KEY: "fred-key-value", VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, APP_URL: "https://x.test" };
  const on = channels.buildChannels(env, { mailReady: () => true, sendRateDrop: async () => true, sendTestPing: async () => true });
  assert.equal(on.line, "[pings] rate check on, push on, email on");
  assert.equal(on.push.enabled, true);
  assert.equal(on.push.publicKey, k.publicKey);
  assert.equal(typeof on.push.send, "function");
  assert.equal(on.mail.enabled, true);
  for (const secret of [SECRET32, "fred-key-value", k.privateKey, k.publicKey]) assert.ok(!on.line.includes(secret));
  assert.ok(!JSON.stringify(on.push).includes(k.privateKey), "the private key is not on the object the routes see");
});

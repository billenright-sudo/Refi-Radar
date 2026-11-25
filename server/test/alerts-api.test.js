"use strict";
// The Profile page's notification routes (routes/alerts.js, mounted at /api/profile/alerts) behind a signed rr_token cookie, against a
// throwaway DB, with a fake push sender and a fake mail sender. No network.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-alerts-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { DEFAULTS, saveSettings } = require("../lib/pings/settings");
const { TEST_TEXT } = require("../lib/pings/text");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, ?, ?, 'Sample', ?, 1)"
).run(orgId, role, first, email).lastInsertRowid);
const org = addOrg("Alpha");
const ann = addUser(org, "broker", "ann@alerts.test", "Ann");
const lee = addUser(org, "lo", "lee@alerts.test", "Lee");

const alertsRouter = require("../routes/alerts");
let server, base, app;
before(async () => {
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/profile/alerts", alertsRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const as = (userId) => async (method, p, body) => {
  const headers = { "content-type": "application/json" };
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, body: data };
};
const A = as(ann);
const L = as(lee);
const nobody = as(null);
const R = "/api/profile/alerts";

// A real-looking device: an actual P-256 public key and a 16-octet secret, as a browser gives them.
const device = (host = "fcm.googleapis.com", n = 1) => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://${host}/fcm/send/device-${n}-${crypto.randomBytes(4).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
};

function makePush(statusFor = () => 201) {
  const calls = [];
  return { enabled: true, publicKey: "PUBLIC-KEY-SAMPLE", calls, async send(sub, payload, opts) {
    calls.push({ endpoint: sub.endpoint, payload, ttlSeconds: opts.ttlSeconds });
    const s = statusFor(sub);
    return s < 300 ? { ok: true } : { ok: false, gone: s === 404 || s === 410, status: s };
  } };
}
function makeMail(ok = true) {
  const calls = [];
  return { enabled: true, calls, async sendTestPing(args) { calls.push(args); return ok; }, async sendRateDrop() { return true; } };
}
const channelsOn = (push = makePush(), mail = makeMail()) => app.set("rateCheckDeps", { push, mail });

beforeEach(() => {
  for (const t of ["push_subscriptions", "user_alert_settings"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("UPDATE users SET time_zone = NULL").run();
  app.set("rateCheckDeps", undefined);
  app.set("pingTestLimit", undefined);
  for (const id of [ann, lee]) alertsRouter.limiter.resetKey(`user:${id}`);
});

const devices = (id) => db.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id").all(id).map((r) => r.endpoint);

test("an unauthenticated call is 401 on every alerts route", async () => {
  for (const [method, p, body] of [["GET", R], ["PUT", R, DEFAULTS], ["POST", `${R}/devices`, device()], ["DELETE", `${R}/devices`, { endpoint: "x" }], ["POST", `${R}/test`, {}]]) {
    assert.equal((await nobody(method, p, body)).status, 401, `${method} ${p}`);
  }
});

test("GET alerts: defaults off, push and email unavailable without keys", async () => {
  const r = await A("GET", R);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { settings: { ...DEFAULTS, timeZone: null }, available: { push: false, email: false }, vapidPublicKey: null, devices: 0 });
});

test("GET alerts: with the channels on, the public key and the device count are shown; a private key never is", async () => {
  channelsOn();
  await A("POST", `${R}/devices`, device());
  const r = await A("GET", R);
  assert.deepEqual(r.body.available, { push: true, email: true });
  assert.equal(r.body.vapidPublicKey, "PUBLIC-KEY-SAMPLE");
  assert.equal(r.body.devices, 1);
  assert.deepEqual(Object.keys(r.body).sort(), ["available", "devices", "settings", "vapidPublicKey"]);
});

test("the zone shown is the Google calendar's or the sign-up one when the user has chosen none", async () => {
  db.prepare("UPDATE users SET time_zone = 'America/Denver' WHERE id = ?").run(ann);
  assert.equal((await A("GET", R)).body.settings.timeZone, "America/Denver");
});

test("PUT saves and answers the same shape as GET; a second save replaces the first", async () => {
  channelsOn();
  const ok = { enabled: true, threshold: 0.25, quietStart: "21:30", quietEnd: "06:45", weekdaysOnly: false, channels: "both", timeZone: "America/Los_Angeles" };
  const put = await A("PUT", R, ok);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { settings: ok, available: { push: true, email: true }, vapidPublicKey: "PUBLIC-KEY-SAMPLE", devices: 0 });
  assert.deepEqual((await A("GET", R)).body.settings, ok);
  assert.equal((await A("PUT", R, { ...ok, threshold: 0.5 })).body.settings.threshold, 0.5);
  assert.deepEqual((await L("GET", R)).body.settings, { ...DEFAULTS, timeZone: null }, "Lee's settings are Lee's own");
});

test("PUT answers 400 with the settings' own messages", async () => {
  channelsOn();
  const ok = { ...DEFAULTS, enabled: true, channels: "email" };
  const cases = [
    [{ ...ok, threshold: 0.1 }, "Choose a drop size of 0.125, 0.25, 0.375 or 0.5."],
    [{ ...ok, quietStart: "9pm" }, "Quiet hours are times like 20:00."],
    [{ ...ok, channels: "sms" }, "Choose phone, email or both."],
    [{ ...ok, timeZone: "+05:00" }, "Choose a time zone from the list."],
    [{ ...ok, enabled: "yes" }, "Something in these settings isn't valid."],
  ];
  for (const [body, error] of cases) {
    const r = await A("PUT", R, body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { success: false, error });
  }
  assert.equal((await A("GET", R)).body.settings.enabled, false, "nothing was saved");
});

test("PUT refuses to turn on a channel that is not available", async () => {
  const r = await A("PUT", R, { ...DEFAULTS, enabled: true, channels: "push" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Phone notifications aren't available yet. Choose email.");
  const e = await A("PUT", R, { ...DEFAULTS, enabled: true, channels: "email" });
  assert.equal(e.status, 400);
  assert.equal(e.body.error, "Email notifications aren't available yet.");
  assert.equal((await A("PUT", R, { ...DEFAULTS, enabled: true, channels: "both" })).body.error, "Phone notifications aren't available yet. Choose email.");
  // with only email on, email works and push is refused
  app.set("rateCheckDeps", { push: null, mail: makeMail() });
  assert.equal((await A("PUT", R, { ...DEFAULTS, enabled: true, channels: "email" })).status, 200);
  assert.equal((await A("PUT", R, { ...DEFAULTS, enabled: true, channels: "push" })).status, 400);
  // turning pings off is always allowed
  app.set("rateCheckDeps", undefined);
  assert.equal((await A("PUT", R, { ...DEFAULTS, enabled: false, channels: "push" })).status, 200);
});

test("devices: allowlist, key shape, ownership, cap of 10", async () => {
  const BAD = { success: false, error: "That device can't get notifications." };
  const good = device();
  const post = (body) => A("POST", `${R}/devices`, body);
  assert.deepEqual((await post({ endpoint: "https://evil.example.test/push", keys: good.keys })).body, BAD);
  assert.equal((await post({ endpoint: "https://evil.example.test/push", keys: good.keys })).status, 400);
  assert.equal((await post({ endpoint: "https://169.254.169.254/latest", keys: good.keys })).status, 400);
  assert.equal((await post({ endpoint: good.endpoint, keys: { p256dh: "short", auth: good.keys.auth } })).status, 400);
  assert.equal((await post({ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: "short" } })).status, 400);
  assert.equal((await post({ endpoint: good.endpoint, keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"), auth: good.keys.auth } })).status, 400, "a point not on the curve");
  assert.equal((await post({ endpoint: good.endpoint })).status, 400);
  assert.equal((await post({ endpoint: 5, keys: good.keys })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal(devices(ann).length, 0);
  assert.deepEqual((await post(good)).body, { devices: 1 });
  assert.deepEqual((await post(good)).body, { devices: 1 }, "the same device twice is one device");

  const first = devices(ann)[0];
  for (let i = 0; i < 11; i += 1) await post(device("updates.push.services.mozilla.com", i));
  assert.equal(devices(ann).length, 10);
  assert.ok(!devices(ann).includes(first), "the oldest went");

  // Lee cannot remove Ann's, and a device moves to the user who adds it last
  const annDevice = devices(ann)[0];
  const del = await L("DELETE", `${R}/devices`, { endpoint: annDevice });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { devices: 0 });
  assert.ok(devices(ann).includes(annDevice), "Ann's device is still Ann's");
  const shared = device("web.push.apple.com", 99);
  await post(shared);
  assert.deepEqual((await L("POST", `${R}/devices`, shared)).body, { devices: 1 });
  assert.ok(!devices(ann).includes(shared.endpoint));
  assert.deepEqual(devices(lee), [shared.endpoint]);
  // a user removes their own
  assert.deepEqual((await L("DELETE", `${R}/devices`, { endpoint: shared.endpoint })).body, { devices: 0 });
  assert.equal((await L("DELETE", `${R}/devices`, { endpoint: 5 })).status, 400);
});

test("a device is stored with its keys and nothing about the browser", async () => {
  const d = device();
  await A("POST", `${R}/devices`, { ...d, userAgent: "Sample Browser", extra: "x" });
  const row = db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").get(ann);
  assert.deepEqual({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, { endpoint: d.endpoint, p256dh: d.keys.p256dh, auth: d.keys.auth });
  assert.deepEqual(Object.keys(row).sort(), ["auth", "created_at", "endpoint", "id", "p256dh", "user_id"]);
});

test("the test notification: the fixed text, to the caller's own devices and email", async () => {
  const push = makePush();
  const mail = makeMail();
  channelsOn(push, mail);
  await A("POST", `${R}/devices`, device());
  await A("POST", `${R}/devices`, device("fcm.googleapis.com", 2));
  await L("POST", `${R}/devices`, device("fcm.googleapis.com", 3));
  const r = await A("POST", `${R}/test`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: true });
  assert.equal(push.calls.length, 2, "only Ann's devices");
  assert.deepEqual(push.calls[0].payload, TEST_TEXT);
  assert.equal(mail.calls.length, 0, "channel push does not email");
  await A("PUT", R, { ...DEFAULTS, channels: "email" });
  assert.deepEqual((await A("POST", `${R}/test`, {})).body, { sent: true });
  assert.deepEqual(mail.calls, [{ to: "ann@alerts.test" }]);
  assert.equal(push.calls.length, 2);
  await A("PUT", R, { ...DEFAULTS, channels: "both" });
  await A("POST", `${R}/test`, {});
  assert.equal(push.calls.length, 4);
  assert.equal(mail.calls.length, 2);
});

test("the test notification: a dead device is removed, and nothing delivered says sent: false", async () => {
  const push = makePush(() => 410);
  channelsOn(push, makeMail());
  await A("POST", `${R}/devices`, device());
  assert.deepEqual((await A("POST", `${R}/test`, {})).body, { sent: false });
  assert.equal(devices(ann).length, 0);
  assert.deepEqual((await A("POST", `${R}/test`, {})).body, { sent: false }, "no device at all");
});

test("the test notification: 503 when neither channel is available; three an hour per user", async () => {
  const r = await A("POST", `${R}/test`, {});
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { success: false, error: "Notifications aren't available yet." });
  channelsOn();
  await A("POST", `${R}/devices`, device());
  const seen = [];
  for (let i = 0; i < 5; i += 1) seen.push((await A("POST", `${R}/test`, {})).status);
  assert.deepEqual(seen, [200, 200, 200, 429, 429]);
  assert.equal((await L("POST", `${R}/test`, {})).status, 200, "Lee has his own three");
});

test("a failure inside the test send is a quiet 'sent: false', and nothing private is logged", async () => {
  const push = makePush();
  push.send = async () => { throw new TypeError("boom https://fcm.googleapis.com/fcm/send/secret ann@alerts.test"); };
  channelsOn(push, makeMail());
  await A("POST", `${R}/devices`, device());
  const keep = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  let r;
  try { r = await A("POST", `${R}/test`, {}); } finally { console.error = keep; }
  assert.deepEqual(r.body, { sent: false });
  assert.ok(lines.every((l) => !l.includes("ann@alerts.test") && !l.includes("fcm.googleapis.com") && !l.includes("boom")), lines.join(" | "));
});

test("saveSettings from elsewhere shows up in GET (one row per user)", async () => {
  saveSettings(db, ann, { ...DEFAULTS, enabled: true, threshold: 0.375 });
  assert.equal((await A("GET", R)).body.settings.threshold, 0.375);
});

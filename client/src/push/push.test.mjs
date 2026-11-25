// The phone-notification logic takes every browser object as an argument, so it all runs here with fakes and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushSupport, keyToBytes, deviceBody, loadAlerts, saveAlerts, addDevice, removeDevice, sendTest, enablePush, resyncPush,
  IOS_STEP, BLOCKED, UNSUPPORTED, WHAT_YOU_GET,
} from "./push.mjs";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const OLD_BROWSER = "Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko";

// { navigator, window } the way pushSupport reads them.
function env({ ua, standalone = false, push = false, permission = "default", touch = 0 }) {
  const navigator = { userAgent: ua, maxTouchPoints: touch, standalone, ...(push ? { serviceWorker: {} } : {}) };
  const window = { ...(push ? { PushManager: function PushManager() {}, Notification: { permission } } : {}), matchMedia: () => ({ matches: standalone }) };
  return { navigator, window };
}

test("pushSupport", () => {
  assert.equal(pushSupport(env({ ua: IPHONE_SAFARI, standalone: false })), "ios_home_screen");
  assert.equal(pushSupport(env({ ua: IPHONE_SAFARI, standalone: true, push: true, permission: "default" })), "ready");
  assert.equal(pushSupport(env({ ua: ANDROID_CHROME, push: true, permission: "denied" })), "blocked");
  assert.equal(pushSupport(env({ ua: ANDROID_CHROME, push: true, permission: "default" })), "ready");
  assert.equal(pushSupport(env({ ua: OLD_BROWSER, push: false })), "unsupported");
  // an iPad that says it is a Mac, in Safari: still needs the Home Screen
  assert.equal(pushSupport(env({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", touch: 5 })), "ios_home_screen");
  assert.equal(pushSupport({}), "unsupported");
});

test("keyToBytes turns base64url into bytes", () => {
  assert.deepEqual([...keyToBytes("AQID-_8")], [1, 2, 3, 251, 255]);
  assert.ok(keyToBytes("AQID") instanceof Uint8Array);
});

test("deviceBody takes only the endpoint and the two keys", () => {
  const sub = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/x", expirationTime: null, keys: { p256dh: "P", auth: "A", extra: "no" }, other: 1 }) };
  assert.deepEqual(deviceBody(sub), { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "P", auth: "A" } });
  assert.equal(deviceBody({ toJSON: () => ({ endpoint: "e" }) }), null);
  assert.equal(deviceBody(null), null);
});

// A fake server in the style of profile.test.mjs.
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
    calls.push(call);
    const handler = routes[`${call.method} ${url}`];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    const { status, body } = await handler(call.body);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}
const SETTINGS = { enabled: true, threshold: 0.125, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels: "push", timeZone: "America/Phoenix" };
const ALERTS = { settings: SETTINGS, available: { push: true, email: true }, vapidPublicKey: "AQID", devices: 1 };

test("the alert calls use the server's routes and answer { ok, data } or { error }", async () => {
  const s = fakeServer({
    "GET /api/profile/alerts": () => ({ status: 200, body: ALERTS }),
    "PUT /api/profile/alerts": (b) => ({ status: 200, body: { ...ALERTS, settings: b } }),
    "POST /api/profile/alerts/devices": () => ({ status: 200, body: { devices: 2 } }),
    "DELETE /api/profile/alerts/devices": () => ({ status: 200, body: { devices: 1 } }),
    "POST /api/profile/alerts/test": () => ({ status: 200, body: { sent: true } }),
  });
  assert.deepEqual(await loadAlerts(s.fetch), { ok: true, data: ALERTS });
  assert.equal((await saveAlerts(s.fetch, { ...SETTINGS, threshold: 0.5 })).data.settings.threshold, 0.5);
  assert.deepEqual((await addDevice(s.fetch, { endpoint: "e", keys: { p256dh: "p", auth: "a" } })).data, { devices: 2 });
  assert.deepEqual((await removeDevice(s.fetch, "e")).data, { devices: 1 });
  assert.deepEqual((await sendTest(s.fetch)).data, { sent: true });
  assert.equal(s.calls[3].headers["Content-Type"], "application/json");
  assert.deepEqual(s.calls[3].body, { endpoint: "e" });
  assert.deepEqual(s.calls[4].body, {});
});

test("the server's own words are shown for the answers it writes, anything else is a plain line", async () => {
  const s = fakeServer({
    "PUT /api/profile/alerts": () => ({ status: 400, body: { success: false, error: "Choose a drop size of 0.125, 0.25, 0.375 or 0.5." } }),
    "POST /api/profile/alerts/test": () => ({ status: 429, body: { error: "Too many test notifications. Please try again in an hour." } }),
    "GET /api/profile/alerts": () => ({ status: 500, body: { error: "Database error" } }),
  });
  assert.deepEqual(await saveAlerts(s.fetch, SETTINGS), { ok: false, error: "Choose a drop size of 0.125, 0.25, 0.375 or 0.5." });
  assert.equal((await sendTest(s.fetch)).error, "Too many test notifications. Please try again in an hour.");
  const loaded = await loadAlerts(s.fetch);
  assert.equal(loaded.ok, false);
  assert.ok(!/Database/.test(loaded.error));
  assert.match((await removeDevice(async () => { throw new Error("offline"); }, "e")).error, /reach the server/);
  assert.match((await loadAlerts(async () => ({ ok: false, status: 401, json: async () => ({}) }))).error, /session has ended/);
});

// A fake browser for enablePush / resyncPush.
function browser({ permission = "default", ask = "granted", existing = null } = {}) {
  const log = { asked: 0, registered: [], subscribed: [] };
  const sub = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/sample", expirationTime: null, keys: { p256dh: "PP", auth: "AA" } }) };
  const registration = {
    pushManager: {
      getSubscription: async () => existing,
      subscribe: async (opts) => { log.subscribed.push(opts); return sub; },
    },
  };
  const navigator = {
    serviceWorker: {
      register: async (url, opts) => { log.registered.push([url, opts]); return registration; },
      ready: Promise.resolve(registration),
    },
  };
  const Notification = { permission, requestPermission: async () => { log.asked++; return ask; } };
  return { navigator, Notification, log, sub };
}

test("enablePush asks, registers /sw.js at scope /, subscribes, and posts the device", async () => {
  const b = browser();
  const s = fakeServer({ "POST /api/profile/alerts/devices": () => ({ status: 200, body: { devices: 1 } }) });
  const res = await enablePush({ navigator: b.navigator, Notification: b.Notification, vapidPublicKey: "AQID", fetchFn: s.fetch });
  assert.deepEqual(res, { ok: true });
  assert.equal(b.log.asked, 1);
  assert.deepEqual(b.log.registered, [["/sw.js", { scope: "/" }]]);
  assert.equal(b.log.subscribed[0].userVisibleOnly, true);
  assert.deepEqual([...b.log.subscribed[0].applicationServerKey], [1, 2, 3]);
  assert.deepEqual(s.calls[0].body, { endpoint: "https://fcm.googleapis.com/sample", keys: { p256dh: "PP", auth: "AA" } });
});

test("enablePush: a refusal posts nothing and says why", async () => {
  const b = browser({ ask: "denied" });
  const s = fakeServer({});
  const res = await enablePush({ navigator: b.navigator, Notification: b.Notification, vapidPublicKey: "AQID", fetchFn: s.fetch });
  assert.deepEqual(res, { error: BLOCKED });
  assert.equal(s.calls.length, 0);
  assert.equal(b.log.registered.length, 0);
  const dismissed = await enablePush({ navigator: b.navigator, Notification: browser({ ask: "default" }).Notification, vapidPublicKey: "AQID", fetchFn: s.fetch });
  assert.match(dismissed.error, /didn't allow/);
  assert.match((await enablePush({ navigator: b.navigator, Notification: b.Notification, vapidPublicKey: null, fetchFn: s.fetch })).error, /aren't available/);
});

test("enablePush: a failed subscribe is one plain line", async () => {
  const b = browser();
  b.navigator.serviceWorker.register = async () => { throw new Error("boom with an endpoint https://x"); };
  const res = await enablePush({ navigator: b.navigator, Notification: b.Notification, vapidPublicKey: "AQID", fetchFn: fakeServer({}).fetch });
  assert.ok(res.error && !/boom|https/.test(res.error));
});

test("resyncPush never asks for permission", async () => {
  const b = browser({ permission: "default" });
  const s = fakeServer({ "GET /api/profile/alerts": () => ({ status: 200, body: ALERTS }) });
  await resyncPush({ navigator: b.navigator, Notification: b.Notification, fetchFn: s.fetch });
  assert.equal(b.log.asked, 0);
  assert.equal(s.calls.length, 0, "nothing is even asked of the server");
  const denied = browser({ permission: "denied" });
  await resyncPush({ navigator: denied.navigator, Notification: denied.Notification, fetchFn: s.fetch });
  assert.equal(denied.log.asked, 0);
  assert.equal(s.calls.length, 0);
});

test("resyncPush with permission granted and pings on re-posts the current subscription", async () => {
  const b = browser({ permission: "granted" });
  const s = fakeServer({
    "GET /api/profile/alerts": () => ({ status: 200, body: ALERTS }),
    "POST /api/profile/alerts/devices": () => ({ status: 200, body: { devices: 1 } }),
  });
  assert.deepEqual(await resyncPush({ navigator: b.navigator, Notification: b.Notification, fetchFn: s.fetch }), { ok: true });
  assert.equal(b.log.asked, 0);
  assert.equal(s.calls[1].url, "/api/profile/alerts/devices");
});

test("resyncPush does nothing when pings are off or the phone channel is not chosen", async () => {
  for (const settings of [{ ...SETTINGS, enabled: false }, { ...SETTINGS, channels: "email" }]) {
    const b = browser({ permission: "granted" });
    const s = fakeServer({ "GET /api/profile/alerts": () => ({ status: 200, body: { ...ALERTS, settings } }) });
    await resyncPush({ navigator: b.navigator, Notification: b.Notification, fetchFn: s.fetch });
    assert.equal(s.calls.length, 1);
    assert.equal(b.log.registered.length, 0);
  }
});

test("the copy is the plan's wording", () => {
  assert.match(IOS_STEP, /Add to Home Screen/);
  assert.match(WHAT_YOU_GET, /Never a client's name/);
  assert.ok(BLOCKED && UNSUPPORTED);
});

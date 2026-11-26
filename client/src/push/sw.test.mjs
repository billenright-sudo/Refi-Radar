// public/sw.js is a classic script, so it runs here inside node:vm with a fake service-worker scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { OPEN_URL, OPEN_MESSAGE } from "./open.mjs";

const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));   // the script's objects come from another realm

function load({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const calls = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { calls.push("skipWaiting"); return Promise.resolve(); },
    registration: { showNotification: (title, options) => { shown.push([title, options]); return Promise.resolve(); } },
    clients: {
      claim: () => { calls.push("claim"); return Promise.resolve(); },
      matchAll: async () => windows,
      openWindow: async (url) => { calls.push(["openWindow", url]); return {}; },
    },
  };
  vm.runInNewContext(SOURCE, { self });
  const fire = async (type, event = {}) => {
    let pending = Promise.resolve();
    await handlers[type]({ ...event, waitUntil: (p) => { pending = p; } });
    await pending;
  };
  return { fire, shown, calls, handlers };
}

test("push shows the ping and always opens /", async () => {
  const { fire, shown } = load();
  await fire("push", { data: { json: () => ({ title: "Rates dropped", body: "The national average 30-year is 6.4%…", url: "https://evil.example/", tag: "rate-drop" }) } });
  assert.deepEqual(plain(shown[0]), ["Rates dropped", { body: "The national average 30-year is 6.4%…", tag: "rate-drop", renotify: true, icon: "/icon.svg", data: { url: "/" } }]);
});

test("an unreadable push still shows the generic notice", async () => {
  const generic = ["Broker Radar", { body: "Open Charlie for today's market update.", tag: "rate-drop", renotify: true, icon: "/icon.svg", data: { url: "/" } }];
  for (const data of [{ json: () => { throw new SyntaxError("bad"); } }, null, { json: () => "text" }, { json: () => ({ title: 5, body: {} }) }]) {
    const { fire, shown } = load();
    await fire("push", { data });
    assert.deepEqual(plain(shown[0]), generic);
  }
});

test("title and body are cut to 60 and 240 characters", async () => {
  const { fire, shown } = load();
  await fire("push", { data: { json: () => ({ title: "t".repeat(100), body: "b".repeat(500), tag: "x" }) } });
  assert.equal(shown[0][0].length, 60);
  assert.equal(shown[0][1].body.length, 240);
});

test("install and activate take over at once, and nothing is cached or fetched", async () => {
  const { fire, calls, handlers } = load();
  await fire("install");
  await fire("activate");
  assert.deepEqual(calls, ["skipWaiting", "claim"]);
  assert.equal(handlers.fetch, undefined);
  assert.ok(!/caches|fetch\(/.test(SOURCE.replace(/\/\/.*$/gm, "")), "the worker never touches a cache or the network");
});

test("the worker's open address and message are the app's (open.mjs)", () => {
  assert.ok(SOURCE.includes(`const OPEN_URL = ${JSON.stringify(OPEN_URL)};`), "the same address as open.mjs");
  assert.ok(SOURCE.includes(`const OPEN_MESSAGE = ${JSON.stringify(OPEN_MESSAGE)};`), "the same message as open.mjs");
});

test("click: a home window that cannot be navigated is asked to go Home itself, then focused", async () => {
  const notification = { close: () => {} };
  const at = "https://app.example.test/";

  const noNavigateLog = [];
  const noNavigate = load({ windows: [{ url: at, postMessage: (data) => { noNavigateLog.push(["postMessage", plain(data)]); }, focus: async () => { noNavigateLog.push(["focus"]); } }] });
  await noNavigate.fire("notificationclick", { notification });
  assert.deepEqual(noNavigateLog, [["postMessage", { type: OPEN_MESSAGE }], ["focus"]]);
  assert.deepEqual(noNavigate.calls, []);

  const refusedLog = [];
  const refused = load({ windows: [{
    url: at,
    navigate: async (to) => { refusedLog.push(["navigate", to]); throw new TypeError("not controlled"); },
    postMessage: (data) => { refusedLog.push(["postMessage", plain(data)]); },
    focus: async () => { refusedLog.push(["focus"]); },
  }] });
  await refused.fire("notificationclick", { notification });
  assert.deepEqual(refusedLog, [["navigate", OPEN_URL], ["postMessage", { type: OPEN_MESSAGE }], ["focus"]]);
  assert.deepEqual(refused.calls, [], "no second window");

  const navigatedLog = [];
  await load({ windows: [{ url: at, navigate: async (to) => { navigatedLog.push(["navigate", to]); }, postMessage: () => { navigatedLog.push(["postMessage"]); }, focus: async () => { navigatedLog.push(["focus"]); } }] }).fire("notificationclick", { notification });
  assert.deepEqual(navigatedLog, [["navigate", OPEN_URL], ["focus"]], "a window that was navigated is not asked as well");

  const stuck = load({ windows: [{ url: at, focus: async () => { throw new Error("cannot focus"); } }] });
  await stuck.fire("notificationclick", { notification });
  assert.deepEqual(stuck.calls, [["openWindow", OPEN_URL]], "a window that can be neither sent nor focused: a new one opens on Home");
});

test("click: a window on the home path is focused and reloaded on Home; a window on another path is focused and left alone; none opens Home", async () => {
  const closed = [];
  const notification = { close: () => closed.push(1) };
  const windowAt = (url, log) => ({ url, navigate: async (to) => { log.push(["navigate", url, to]); }, postMessage: () => { log.push(["postMessage", url]); }, focus: async () => { log.push(["focus", url]); } });

  const homeLog = [];
  const home = load({ windows: [windowAt("https://app.example.test/", homeLog)] });
  await home.fire("notificationclick", { notification });
  assert.deepEqual(homeLog, [["navigate", "https://app.example.test/", OPEN_URL], ["focus", "https://app.example.test/"]]);
  assert.deepEqual(home.calls, []);

  const homeQueryLog = [];
  await load({ windows: [windowAt("https://app.example.test/?x=1#top", homeQueryLog)] }).fire("notificationclick", { notification });
  assert.equal(homeQueryLog[0][0], "navigate", "a query or fragment on / is still the home path");

  const otherLog = [];
  const other = load({ windows: [windowAt("https://app.example.test/profile", otherLog)] });
  await other.fire("notificationclick", { notification });
  assert.deepEqual(otherLog, [["focus", "https://app.example.test/profile"]], "typed work on another path is not thrown away");
  assert.deepEqual(other.calls, []);

  const mixedLog = [];
  await load({ windows: [windowAt("https://app.example.test/profile", mixedLog), windowAt("https://app.example.test/", mixedLog)] }).fire("notificationclick", { notification });
  assert.deepEqual(mixedLog, [["navigate", "https://app.example.test/", OPEN_URL], ["focus", "https://app.example.test/"]], "the home window wins when there is one");

  const none = load({ windows: [] });
  await none.fire("notificationclick", { notification });
  assert.deepEqual(none.calls, [["openWindow", OPEN_URL]]);
  assert.equal(closed.length, 5);
});

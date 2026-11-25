// public/sw.js is a classic script, so it runs here inside node:vm with a fake service-worker scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

test("click: a window on the home path is focused and reloaded; a window on another path is focused and left alone; none opens /", async () => {
  const closed = [];
  const notification = { close: () => closed.push(1) };
  const windowAt = (url, log) => ({ url, navigate: async (to) => { log.push(["navigate", url, to]); }, focus: async () => { log.push(["focus", url]); } });

  const homeLog = [];
  const home = load({ windows: [windowAt("https://app.example.test/", homeLog)] });
  await home.fire("notificationclick", { notification });
  assert.deepEqual(homeLog, [["navigate", "https://app.example.test/", "/"], ["focus", "https://app.example.test/"]]);
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
  assert.deepEqual(mixedLog, [["navigate", "https://app.example.test/", "/"], ["focus", "https://app.example.test/"]], "the home window wins when there is one");

  const none = load({ windows: [] });
  await none.fire("notificationclick", { notification });
  assert.deepEqual(none.calls, [["openWindow", "/"]]);
  assert.equal(closed.length, 5);
});

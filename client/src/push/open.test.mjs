// The notification-open mark (open.mjs) has no DOM, so it runs here with plain strings and objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_URL, OPEN_MESSAGE, openedFromNotification, withoutOpenMark, isOpenMessage } from "./open.mjs";

test("the address a tap opens is the home path with the mark, and the app reads it back", () => {
  assert.equal(OPEN_URL, "/?from=notification");
  assert.equal(openedFromNotification(OPEN_URL.slice(1)), true);
});

test("openedFromNotification: only the exact mark counts", () => {
  assert.equal(openedFromNotification("?from=notification"), true);
  assert.equal(openedFromNotification("?google=connected&from=notification"), true);
  assert.equal(openedFromNotification(""), false);
  assert.equal(openedFromNotification("?from=email"), false);
  assert.equal(openedFromNotification("?from="), false);
  assert.equal(openedFromNotification("?notification"), false);
  assert.equal(openedFromNotification("?From=notification"), false);
  for (const bad of [null, undefined, 5, {}]) assert.equal(openedFromNotification(bad), false);
});

test("withoutOpenMark: the mark comes out of the address and everything else stays", () => {
  assert.equal(withoutOpenMark("https://app.example.test/?from=notification"), "/");
  assert.equal(withoutOpenMark("https://app.example.test/?x=1&from=notification#top"), "/?x=1#top");
  assert.equal(withoutOpenMark("https://app.example.test/?from=notification&billing=done"), "/?billing=done");
  assert.equal(withoutOpenMark("https://app.example.test/"), "/");
  assert.equal(withoutOpenMark("https://app.example.test/?from=email"), "/", "any value of the mark's name is taken out");
  for (const bad of [null, undefined, "", "not an address"]) assert.equal(withoutOpenMark(bad), "/");
});

test("isOpenMessage: only the worker's open message", () => {
  assert.equal(OPEN_MESSAGE, "notification-open");
  assert.equal(isOpenMessage({ type: OPEN_MESSAGE }), true);
  for (const other of [null, undefined, "notification-open", 5, [], {}, { type: "other" }, { type: 5 }]) assert.equal(isOpenMessage(other), false);
});

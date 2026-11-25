// The Notifications card's logic (notifications.mjs) has no DOM, so it runs here with plain objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardState, formToSettings, settingsToForm, zoneChoices, zoneLabel, channelOptions, fitChannel, DROP_SIZES, DEFAULT_FORM, NOT_AVAILABLE,
} from "./notifications.mjs";
import { IOS_STEP, BLOCKED, UNSUPPORTED } from "../push/push.mjs";

// The GET /api/profile/alerts answer, with the available channels set.
const alerts = ({ push = true, email = true, enabled = true, channels = "push", devices = 0 } = {}) => ({
  settings: { enabled, threshold: 0.125, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels, timeZone: "America/Phoenix" },
  available: { push, email },
  vapidPublicKey: push ? "AQID" : null,
  devices,
});

test("iOS in Safari: the one-step note, and only email offered", () => {
  const s = cardState({ alerts: alerts({ push: true, email: true }), support: "ios_home_screen" });
  assert.deepEqual(s.channelChoices, ["email"]);
  assert.equal(s.showIosStep, true);
});

test("nothing available: the card says so and offers nothing", () => {
  assert.deepEqual(
    cardState({ alerts: alerts({ push: false, email: false }), support: "ready" }),
    { channelChoices: [], showIosStep: false, note: "Rate-drop notifications aren't switched on for Broker Radar yet.", canTest: false },
  );
  assert.equal(NOT_AVAILABLE, "Rate-drop notifications aren't switched on for Broker Radar yet.");
});

test("both available in a ready browser: both offered, the test works once pings are on", () => {
  const on = cardState({ alerts: alerts(), support: "ready" });
  assert.deepEqual(on.channelChoices, ["push", "email"]);
  assert.equal(on.showIosStep, false);
  assert.equal(on.note, null);
  assert.equal(on.canTest, true);
  assert.equal(cardState({ alerts: alerts({ enabled: false }), support: "ready" }).canTest, false);
});

test("blocked and unsupported browsers: email only, with the plain reason", () => {
  const blocked = cardState({ alerts: alerts(), support: "blocked" });
  assert.deepEqual(blocked.channelChoices, ["email"]);
  assert.equal(blocked.note, BLOCKED);
  const unsupported = cardState({ alerts: alerts(), support: "unsupported" });
  assert.deepEqual(unsupported.channelChoices, ["email"]);
  assert.equal(unsupported.note, UNSUPPORTED);
  assert.ok(IOS_STEP.includes("Home Screen"));
});

test("with only phone available, a browser that cannot do it has nothing to choose", () => {
  const s = cardState({ alerts: alerts({ push: true, email: false }), support: "unsupported" });
  assert.deepEqual(s.channelChoices, []);
  assert.equal(s.note, UNSUPPORTED);
  assert.equal(s.canTest, false);
});

test("the email-only server: no phone notes at all", () => {
  const s = cardState({ alerts: alerts({ push: false, email: true }), support: "ios_home_screen" });
  assert.deepEqual(s.channelChoices, ["email"]);
  assert.equal(s.showIosStep, false);
  assert.equal(s.note, null);
});

test("no answer from the server yet: nothing is offered", () => {
  assert.deepEqual(cardState({ alerts: null, support: "ready" }), { channelChoices: [], showIosStep: false, note: null, canTest: false });
});

test("formToSettings fills the browser's zone and keeps the rest", () => {
  assert.equal(formToSettings({ ...DEFAULT_FORM, timeZone: null }, "America/Phoenix").timeZone, "America/Phoenix");
  assert.equal(formToSettings({ ...DEFAULT_FORM, timeZone: "America/Denver" }, "America/Phoenix").timeZone, "America/Denver");
  assert.equal(formToSettings({ ...DEFAULT_FORM, timeZone: null }, "").timeZone, null);
  const s = formToSettings({ enabled: true, threshold: "0.25", quietStart: "21:30", quietEnd: "06:00", weekdaysOnly: false, channels: "both", timeZone: "America/Chicago" }, "America/Phoenix");
  assert.deepEqual(s, { enabled: true, threshold: 0.25, quietStart: "21:30", quietEnd: "06:00", weekdaysOnly: false, channels: "both", timeZone: "America/Chicago" });
});

test("the defaults are the server's: off, an eighth, 8 p.m. to 7 a.m., weekdays, phone", () => {
  assert.deepEqual(DEFAULT_FORM, { enabled: false, threshold: 0.125, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels: "push", timeZone: null });
});

test("settingsToForm keeps what the server saved", () => {
  const { settings } = alerts({ channels: "both" });
  assert.deepEqual(settingsToForm(settings), settings);
  assert.deepEqual(settingsToForm(null), DEFAULT_FORM);
});

test("the four drop sizes, each with its plain-words label", () => {
  assert.deepEqual(DROP_SIZES.map((d) => [d.value, d.label]), [
    [0.125, "0.125 (an eighth)"], [0.25, "0.25 (a quarter)"], [0.375, "0.375 (three eighths)"], [0.5, "0.5 (a half)"],
  ]);
});

test("zoneChoices lists the US zones, plus the saved and browser zones when they are others", () => {
  const base = zoneChoices(null, null);
  assert.ok(base.includes("America/New_York") && base.includes("America/Phoenix") && base.includes("Pacific/Honolulu"));
  assert.equal(new Set(base).size, base.length);
  assert.deepEqual(zoneChoices("America/Phoenix", "America/Phoenix"), base);
  const more = zoneChoices("Europe/London", "Asia/Tokyo");
  assert.deepEqual(more.slice(0, 2), ["Europe/London", "Asia/Tokyo"]);
  assert.equal(zoneLabel("America/Phoenix"), "Arizona (Phoenix)");
  assert.equal(zoneLabel("Europe/London"), "Europe/London");
});

test("a channel the browser cannot do is changed to one it can", () => {
  assert.deepEqual(channelOptions(["push", "email"]).map((o) => o.value), ["push", "email", "both"]);
  assert.deepEqual(channelOptions(["email"]).map((o) => o.value), ["email"]);
  assert.deepEqual(channelOptions([]), []);
  assert.equal(fitChannel("both", ["email"]), "email");
  assert.equal(fitChannel("push", ["email"]), "email");
  assert.equal(fitChannel("email", ["push"]), "push");
  assert.equal(fitChannel("both", ["push", "email"]), "both");
  assert.equal(fitChannel("push", []), "push");
});

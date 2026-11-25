// The Notifications card's logic (notifications.mjs) has no DOM, so it runs here with plain objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardState, formToSettings, settingsToForm, zoneChoices, zoneLabel, channelOptions, fitChannel, shownChannel, savePlan, DROP_SIZES, DEFAULT_FORM, NOT_AVAILABLE,
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

// ── saving: the stored channel is only changed when the user changed it ──

const plan = ({ saved, patch = {}, choices }) => savePlan({ saved, form: { ...settingsToForm(saved), ...patch }, choices, browserZone: "America/Phoenix" });

test("saved phone channel, a browser that cannot push, only quiet hours changed: the PUT keeps phone and asks for no permission", () => {
  const { settings: saved } = alerts({ channels: "push" });
  for (const support of ["blocked", "unsupported", "ios_home_screen"]) {
    const { channelChoices } = cardState({ alerts: alerts({ channels: "push" }), support });
    assert.deepEqual(channelChoices, ["email"]);
    const p = plan({ saved, patch: { quietStart: "21:00" }, choices: channelChoices });
    assert.equal(p.settings.channels, "push", support);
    assert.equal(p.settings.quietStart, "21:00");
    assert.equal(p.askPush, false, support);
    assert.equal(p.forgetPush, false, support);
  }
  const both = alerts({ channels: "both" }).settings;
  assert.equal(plan({ saved: both, patch: { weekdaysOnly: false }, choices: ["email"] }).settings.channels, "both");
});

test("a browser that can push: a save that does not touch How and does not turn pings on raises no permission prompt", () => {
  const { settings: saved } = alerts({ channels: "push" });
  for (const patch of [{ threshold: 0.25 }, { quietEnd: "06:00" }, { weekdaysOnly: false }, { timeZone: "America/Denver" }]) {
    const p = plan({ saved, patch, choices: ["push", "email"] });
    assert.equal(p.askPush, false);
    assert.equal(p.settings.channels, "push");
  }
});

test("changing How, or turning pings on, still asks and still fits the channel to this browser", () => {
  const { settings: on } = alerts({ channels: "email" });
  assert.equal(plan({ saved: on, patch: { channels: "both" }, choices: ["push", "email"] }).askPush, true);
  assert.equal(plan({ saved: on, patch: { channels: "push" }, choices: ["push", "email"] }).askPush, true);
  assert.equal(plan({ saved: on, patch: { channels: "email" }, choices: ["push", "email"] }).askPush, false);
  const { settings: off } = alerts({ enabled: false, channels: "push" });
  const turnedOn = plan({ saved: off, patch: { enabled: true }, choices: ["push", "email"] });
  assert.equal(turnedOn.askPush, true);
  assert.equal(turnedOn.settings.enabled, true);
  // turning pings on with phone chosen where this browser cannot push: it becomes email, and the card's note (the Home Screen step) says why
  const iphone = plan({ saved: off, patch: { enabled: true }, choices: ["email"] });
  assert.equal(iphone.settings.channels, "email");
  assert.equal(iphone.askPush, false);
  assert.equal(cardState({ alerts: alerts({ enabled: false, channels: "push" }), support: "ios_home_screen" }).showIosStep, true);
  // pings left off never ask
  assert.equal(plan({ saved: off, patch: { channels: "both" }, choices: ["push", "email"] }).askPush, false);
});

test("a save that turns pings off or leaves email only says to forget this browser's device", () => {
  const { settings: saved } = alerts({ channels: "push" });
  assert.equal(plan({ saved, patch: { enabled: false }, choices: ["push", "email"] }).forgetPush, true);
  assert.equal(plan({ saved, patch: { channels: "email" }, choices: ["push", "email"] }).forgetPush, true);
  assert.equal(plan({ saved, patch: { channels: "both" }, choices: ["push", "email"] }).forgetPush, false);
  assert.equal(plan({ saved, patch: {}, choices: ["push", "email"] }).forgetPush, false);
});

test("a stored phone channel this browser cannot do is shown as it is, not replaced", () => {
  assert.equal(shownChannel("push", ["email"]), "push");
  assert.equal(shownChannel("both", ["email"]), "both");
  assert.equal(shownChannel("email", ["email"]), "email");
  assert.equal(shownChannel("push", ["push", "email"]), "push");
  assert.equal(shownChannel("push", []), "push");
  assert.deepEqual(channelOptions(["email"], "push"), [
    { value: "email", label: "Email" },
    { value: "push", label: "Phone notification (set up on another device)" },
  ]);
  assert.deepEqual(channelOptions(["email"], "both").map((o) => o.value), ["email", "both"]);
  assert.deepEqual(channelOptions(["email"], "email").map((o) => o.value), ["email"]);
  assert.deepEqual(channelOptions(["push", "email"], "push").map((o) => o.value), ["push", "email", "both"]);
  assert.deepEqual(channelOptions([], "push").map((o) => o.value), ["push"], "so the card is not locked out of its own saved settings");
});

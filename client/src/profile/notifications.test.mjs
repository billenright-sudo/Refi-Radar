// The Notifications card's logic (notifications.mjs) has no DOM, so it runs here with plain objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardState, formToSettings, settingsToForm, zoneChoices, zoneLabel, channelOptions, fitChannel, shownChannel, savePlan, DROP_SIZES, DEFAULT_FORM, NOT_AVAILABLE, EMAIL_OFF, PHONE_OFF, BLOCKED_NO_EMAIL, UNSUPPORTED_NO_EMAIL, IOS_STEP_NO_EMAIL, SETUP_HERE, NO_PHONE_YET, nothingSent,
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
  assert.equal(s.note, UNSUPPORTED_NO_EMAIL, "email is not available, so the note does not point to it");
  assert.equal(s.canTest, false);
});

test("the email-only server: no phone notes at all", () => {
  const s = cardState({ alerts: alerts({ push: false, email: true, channels: "email" }), support: "ios_home_screen" });
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

const plan = ({ saved, patch = {}, choices, devices = 0, pushOnServer = true }) => savePlan({ saved, form: { ...settingsToForm(saved), ...patch }, choices, devices, pushOnServer, browserZone: "America/Phoenix" });

test("saved phone channel with a device set up, a browser that cannot push, only quiet hours changed: the PUT keeps phone and asks for no permission", () => {
  const { settings: saved } = alerts({ channels: "push" });
  for (const support of ["blocked", "unsupported", "ios_home_screen"]) {
    const { channelChoices } = cardState({ alerts: alerts({ channels: "push" }), support });
    assert.deepEqual(channelChoices, ["email"]);
    const p = plan({ saved, patch: { quietStart: "21:00" }, choices: channelChoices, devices: 1 });
    assert.equal(p.settings.channels, "push", support);
    assert.equal(p.settings.quietStart, "21:00");
    assert.equal(p.askPush, false, support);
    assert.equal(p.forgetPush, false, support);
  }
  const both = alerts({ channels: "both" }).settings;
  assert.equal(plan({ saved: both, patch: { weekdaysOnly: false }, choices: ["email"], devices: 1 }).settings.channels, "both");
});

test("a browser that can push: a save that does not touch How and does not turn pings on raises no permission prompt", () => {
  const { settings: saved } = alerts({ channels: "push" });
  for (const patch of [{ threshold: 0.25 }, { quietEnd: "06:00" }, { weekdaysOnly: false }, { timeZone: "America/Denver" }]) {
    const p = plan({ saved, patch, choices: ["push", "email"], devices: 1 });   // with a device set up (no device is the T1 case)
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

test("a stored phone channel this browser cannot do is shown as it is only when a device is really set up", () => {
  assert.equal(shownChannel("push", ["email"], 1), "push");
  assert.equal(shownChannel("both", ["email"], 1), "both");
  assert.equal(shownChannel("email", ["email"], 1), "email");
  assert.equal(shownChannel("push", ["push", "email"], 0), "push");
  assert.equal(shownChannel("push", [], 2), "push");
  assert.deepEqual(channelOptions(["email"], "push", 1), [
    { value: "email", label: "Email" },
    { value: "push", label: "Phone notification (set up on another device)" },
  ]);
  assert.deepEqual(channelOptions(["email"], "both", 1), [
    { value: "email", label: "Email" },
    { value: "both", label: "Both (phone set up on another device)" },
  ]);
  assert.deepEqual(channelOptions(["email"], "email", 1).map((o) => o.value), ["email"]);
  assert.deepEqual(channelOptions(["push", "email"], "push", 0).map((o) => o.value), ["push", "email", "both"]);
  assert.deepEqual(channelOptions([], "push", 1).map((o) => o.value), ["push"], "so the card is not locked out of its own saved settings");
});

test("a new user with no device, on a browser that cannot push, is never shown a phone option", () => {
  for (const support of ["blocked", "unsupported", "ios_home_screen"]) {
    const saved = { ...DEFAULT_FORM, timeZone: "America/Phoenix" };   // the server's defaults: off, phone
    const { channelChoices } = cardState({ alerts: { settings: saved, available: { push: true, email: true }, devices: 0 }, support });
    assert.deepEqual(channelOptions(channelChoices, saved.channels, 0), [{ value: "email", label: "Email" }], support);
    assert.equal(shownChannel(saved.channels, channelChoices, 0), "email", support);
  }
  assert.deepEqual(channelOptions([], "push", 0), [], "and nothing at all when nothing is available");
});

test("turning pings on: with a device set up the phone channel is kept, with none it becomes email", () => {
  const off = alerts({ enabled: false, channels: "push" }).settings;
  for (const support of ["blocked", "ios_home_screen", "unsupported"]) {
    const { channelChoices } = cardState({ alerts: alerts({ enabled: false, channels: "push" }), support });
    const withDevice = plan({ saved: off, patch: { enabled: true }, choices: channelChoices, devices: 1 });
    assert.equal(withDevice.settings.channels, "push", support);
    assert.equal(withDevice.askPush, false, support);
    const without = plan({ saved: off, patch: { enabled: true }, choices: channelChoices, devices: 0 });
    assert.equal(without.settings.channels, "email", support);
    assert.equal(without.askPush, false, support);
  }
});

test("a stored channel the server cannot send right now is shown and saved back, with one plain line", () => {
  const both = alerts({ push: true, email: false, channels: "both" });
  const state = cardState({ alerts: both, support: "ready" });
  assert.deepEqual(state.channelChoices, ["push"]);
  assert.equal(state.note, EMAIL_OFF);
  assert.deepEqual(channelOptions(state.channelChoices, "both", 0), [
    { value: "push", label: "Phone notification" },
    { value: "both", label: "Both (email isn't available right now)" },
  ]);
  assert.equal(shownChannel("both", state.channelChoices, 0), "both");
  const p = plan({ saved: both.settings, patch: { quietStart: "21:00" }, choices: state.channelChoices });
  assert.equal(p.settings.channels, "both");
  assert.equal(p.askPush, false);
  const email = alerts({ push: true, email: false, channels: "email" });
  const e = cardState({ alerts: email, support: "ready" });
  assert.deepEqual(channelOptions(e.channelChoices, "email", 0).map((o) => o.value), ["push", "email"]);
  assert.equal(plan({ saved: email.settings, patch: { threshold: 0.25 }, choices: e.channelChoices }).settings.channels, "email");
  assert.equal(cardState({ alerts: alerts({ push: true, email: false, channels: "push" }), support: "ready" }).note, null, "no line when email is simply not saved");
});

// ── third pass ──

test("S1: pings on, phone stored, no device, a browser that cannot push: the channel is kept, labelled, and Email can still be picked", () => {
  for (const support of ["blocked", "unsupported", "ios_home_screen"]) {
    for (const [stored, label, value] of [["push", "Phone notification (no device set up yet)", "push"], ["both", "Both (no phone set up yet)", "both"]]) {
      const a = alerts({ enabled: true, channels: stored });
      const { channelChoices } = cardState({ alerts: a, support });
      const extra = { enabled: true };
      assert.deepEqual(channelOptions(channelChoices, stored, 0, extra), [{ value: "email", label: "Email" }, { value, label }], `${support} ${stored}`);
      assert.equal(shownChannel(stored, channelChoices, 0, extra), stored);
      const quiet = plan({ saved: a.settings, patch: { quietStart: "21:00" }, choices: channelChoices, devices: 0 });
      assert.equal(quiet.settings.channels, stored, `${support} ${stored}: a quiet-hours-only save keeps the channel`);
      assert.equal(quiet.askPush, false);
      assert.equal(quiet.forgetPush, false);
      const email = plan({ saved: a.settings, patch: { channels: "email" }, choices: channelChoices, devices: 0 });
      assert.equal(email.settings.channels, "email", "picking Email in How still saves email");
    }
  }
  // not for pings that are off (still Q1: email shown, email saved), and not on a browser that can push
  const off = alerts({ enabled: false, channels: "push" });
  assert.deepEqual(channelOptions(["email"], "push", 0, { enabled: false }), [{ value: "email", label: "Email" }]);
  assert.equal(plan({ saved: off.settings, patch: { enabled: true }, choices: ["email"], devices: 0 }).settings.channels, "email");
});

test("S2: with email not available, the blocked, unsupported and Safari-tab notes do not point to email, and the email line still shows", () => {
  const a = (channels) => alerts({ push: true, email: false, channels });
  const blocked = cardState({ alerts: a("both"), support: "blocked" });
  assert.equal(blocked.note, BLOCKED_NO_EMAIL);
  assert.equal(blocked.emailNote, EMAIL_OFF);
  assert.ok(!/email/i.test(BLOCKED_NO_EMAIL) && !/email/i.test(UNSUPPORTED_NO_EMAIL) && !/choose email|can choose email/i.test(IOS_STEP_NO_EMAIL));
  const unsupported = cardState({ alerts: a("email"), support: "unsupported" });
  assert.equal(unsupported.note, UNSUPPORTED_NO_EMAIL);
  assert.equal(unsupported.emailNote, EMAIL_OFF);
  const ios = cardState({ alerts: a("both"), support: "ios_home_screen" });
  assert.equal(ios.showIosStep, true);
  assert.equal(ios.iosStep, IOS_STEP_NO_EMAIL);
  assert.equal(ios.emailNote, EMAIL_OFF);
  // email available: the notes are as before, and no second line
  const normal = cardState({ alerts: alerts({ channels: "push" }), support: "blocked" });
  assert.equal(normal.note, BLOCKED);
  assert.equal(normal.emailNote, undefined);
  assert.equal(cardState({ alerts: alerts({ channels: "push" }), support: "ios_home_screen" }).iosStep, IOS_STEP);
  // no email saved and email off: the blocked note alone
  assert.equal(cardState({ alerts: a("push"), support: "blocked" }).emailNote, undefined);
});

test("S3: phone switched off on the server: a stored phone choice says so, with one plain line", () => {
  const extra = { pushOnServer: false, enabled: true };
  for (const [stored, label] of [["push", "Phone notification (isn't available right now)"], ["both", "Both (phone isn't available right now)"]]) {
    const a = alerts({ push: false, email: true, channels: stored, devices: 2 });
    const state = cardState({ alerts: a, support: "ready" });
    assert.deepEqual(state.channelChoices, ["email"]);
    assert.equal(state.note, PHONE_OFF, stored);
    assert.deepEqual(channelOptions(state.channelChoices, stored, 2, extra), [{ value: "email", label: "Email" }, { value: stored, label }], stored);
    assert.equal(shownChannel(stored, state.channelChoices, 2, extra), stored);
    const p = plan({ saved: a.settings, patch: { quietStart: "21:00" }, choices: state.channelChoices, devices: 2, pushOnServer: false });
    assert.equal(p.settings.channels, stored);
    assert.equal(p.askPush, false);
  }
  assert.equal(cardState({ alerts: alerts({ push: false, email: true, channels: "email" }), support: "ready" }).note, null, "no line when no phone is saved");
});

// ── fourth pass ──

test("T1: pings on, phone saved, no device, a browser that can push: Save is open, and a save sets this browser up", () => {
  const a = alerts({ enabled: true, channels: "push", devices: 0 });
  const state = cardState({ alerts: a, support: "ready" });
  assert.equal(state.setUpHere, true);
  assert.equal(state.deviceNote, SETUP_HERE);
  assert.equal(SETUP_HERE, "No device is set up for phone notifications yet. Press Save to set up this one.");
  const p = plan({ saved: a.settings, patch: {}, choices: state.channelChoices, devices: 0 });
  assert.equal(p.askPush, true, "an untouched card still registers this browser");
  assert.equal(p.softAsk, true, "and a refusal does not stop the other fields from saving");
  assert.equal(p.settings.channels, "push");
  const both = alerts({ enabled: true, channels: "both", devices: 0 });
  assert.equal(cardState({ alerts: both, support: "ready" }).setUpHere, true);
  assert.equal(plan({ saved: both.settings, patch: {}, choices: ["push", "email"], devices: 0 }).askPush, true);
  // a save that also changes How is an ordinary asking save: a refusal stops it
  const changed = plan({ saved: a.settings, patch: { channels: "both" }, choices: state.channelChoices, devices: 0 });
  assert.equal(changed.askPush, true);
  assert.equal(changed.softAsk, false);
});

test("T1: the same state on a browser that cannot push keeps the channel and says what to do on the phone", () => {
  for (const support of ["blocked", "unsupported", "ios_home_screen"]) {
    const a = alerts({ enabled: true, channels: "push", devices: 0 });
    const state = cardState({ alerts: a, support });
    assert.equal(state.deviceNote, NO_PHONE_YET, support);
    assert.equal(NO_PHONE_YET, "No phone is set up for these yet. On your phone, open Broker Radar, sign in, and press Save on this card.");
    assert.equal(state.setUpHere, undefined, support);
    const p = plan({ saved: a.settings, patch: { quietStart: "21:00" }, choices: state.channelChoices, devices: 0 });
    assert.equal(p.settings.channels, "push");
    assert.equal(p.askPush, false);
  }
});

test("T1: outside that state P2 stands: a device exists, pings are off, email only, or phone is off on the server", () => {
  const one = alerts({ enabled: true, channels: "push", devices: 1 });
  for (const support of ["ready", "blocked"]) {
    const state = cardState({ alerts: one, support });
    assert.equal(state.deviceNote, undefined);
    assert.equal(state.setUpHere, undefined);
  }
  const quiet = plan({ saved: one.settings, patch: { quietStart: "21:00" }, choices: ["push", "email"], devices: 1 });
  assert.equal(quiet.askPush, false, "a quiet-hours save with a device elsewhere raises no prompt");
  assert.equal(plan({ saved: one.settings, patch: { quietStart: "21:00" }, choices: ["email"], devices: 1 }).askPush, false);
  assert.equal(cardState({ alerts: alerts({ enabled: false, channels: "push", devices: 0 }), support: "ready" }).deviceNote, undefined);
  assert.equal(cardState({ alerts: alerts({ enabled: true, channels: "email", devices: 0 }), support: "ready" }).deviceNote, undefined);
  assert.equal(cardState({ alerts: alerts({ push: false, email: true, enabled: true, channels: "push", devices: 0 }), support: "ready" }).deviceNote, undefined);
  const off = alerts({ enabled: false, channels: "push", devices: 0 });
  assert.equal(plan({ saved: off.settings, patch: { quietStart: "21:00" }, choices: ["push", "email"], devices: 0 }).askPush, false);
});

test("T2: nothing the card says points to email when email is not available", () => {
  assert.equal(nothingSent(true), "Nothing could be sent. Check that notifications are allowed on this device, or choose email.");
  assert.equal(nothingSent(false), "Nothing could be sent. Check that notifications are allowed on this device.");
  assert.ok(!/email/i.test(nothingSent(false)));
});

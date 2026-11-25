// The Notifications card's logic, with no DOM and no React (the card is NotificationsCard.jsx; the server calls and the browser side of
// phone notifications are ../push/push.mjs). What each state shows is decided here so it can be tested.

import { IOS_STEP, BLOCKED, UNSUPPORTED, IOS_STEP_NO_EMAIL, BLOCKED_NO_EMAIL, UNSUPPORTED_NO_EMAIL } from "../push/push.mjs";

export const NOT_AVAILABLE = "Rate-drop notifications aren't switched on for Broker Radar yet.";
export { IOS_STEP, BLOCKED, UNSUPPORTED, IOS_STEP_NO_EMAIL, BLOCKED_NO_EMAIL, UNSUPPORTED_NO_EMAIL };

// The server's defaults (server/lib/pings/settings.js): pings off, an eighth of a point, quiet from 8 p.m. to 7 a.m., weekdays only, phone.
export const DEFAULT_FORM = { enabled: false, threshold: 0.125, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels: "push", timeZone: null };

export const DROP_SIZES = [
  { value: 0.125, label: "0.125 (an eighth)" },
  { value: 0.25, label: "0.25 (a quarter)" },
  { value: 0.375, label: "0.375 (three eighths)" },
  { value: 0.5, label: "0.5 (a half)" },
];

// What the card shows, from the server's GET /api/profile/alerts answer and pushSupport's word for this browser.
//   channelChoices: which of "push" / "email" can be picked here (phone needs the server's keys and a browser that can do it)
//   showIosStep:    the "add to Home Screen first" step
//   note:           one line to show about why a channel is missing, or null
//   canTest:        whether "Send a test" is offered (pings on, and something to send to)
export function cardState({ alerts, support }) {
  if (!alerts || !alerts.available || !alerts.settings) return { channelChoices: [], showIosStep: false, note: null, canTest: false };
  const { available, settings } = alerts;
  const channelChoices = [];
  if (available.push && support === "ready") channelChoices.push("push");
  if (available.email) channelChoices.push("email");
  const showIosStep = !!available.push && support === "ios_home_screen";
  const stored = settings.channels;
  const phoneSaved = stored === "push" || stored === "both";
  const phoneOff = !available.push && phoneSaved && (settings.enabled === true || alerts.devices > 0);   // a phone choice that is kept but cannot be sent
  const emailOff = !available.email && (stored === "email" || stored === "both");
  let browserNote = null;
  if (available.push && support === "blocked") browserNote = available.email ? BLOCKED : BLOCKED_NO_EMAIL;
  else if (available.push && support === "unsupported") browserNote = available.email ? UNSUPPORTED : UNSUPPORTED_NO_EMAIL;
  let note = null;
  if (!available.push && !available.email) note = NOT_AVAILABLE;
  else if (browserNote) note = browserNote;
  else if (showIosStep) note = null;   // the Home Screen step is the line
  else if (phoneOff) note = PHONE_OFF;
  else if (emailOff) note = EMAIL_OFF;
  const state = { channelChoices, showIosStep, note, canTest: !!settings.enabled && channelChoices.length > 0 };
  if (showIosStep) state.iosStep = available.email ? IOS_STEP : IOS_STEP_NO_EMAIL;
  if ((browserNote || showIosStep) && emailOff) state.emailNote = EMAIL_OFF;
  // pings on, phone saved, no device yet: this browser can set itself up with a save; any other can only say what to do on the phone
  if (settings.enabled === true && phoneSaved && !(alerts.devices > 0) && available.push) {
    if (support === "ready") { state.setUpHere = true; state.deviceNote = SETUP_HERE; } else state.deviceNote = NO_PHONE_YET;
  }   // the browser note is shown too, and it must not point to email
  return state;
}

// The saved settings -> the form's starting values (a missing answer gives the defaults).
export function settingsToForm(settings) {
  return settings ? { ...DEFAULT_FORM, ...settings } : { ...DEFAULT_FORM };
}

// The form -> the seven fields the server takes. A zone the user never chose becomes the browser's (or null when even that is unknown).
export function formToSettings(form, browserZone) {
  return {
    enabled: form.enabled === true,
    threshold: Number(form.threshold),
    quietStart: form.quietStart,
    quietEnd: form.quietEnd,
    weekdaysOnly: form.weekdaysOnly === true,
    channels: form.channels,
    timeZone: form.timeZone || browserZone || null,
  };
}

// ── channel ──

const CHANNEL_LABELS = { push: "Phone notification", email: "Email", both: "Both" };
const EMAIL_OFF_LABELS = { both: "Both (email isn't available right now)", email: "Email (isn't available right now)" };
const NO_DEVICE_LABELS = { push: "Phone notification (no device set up yet)", both: "Both (no phone set up yet)" };
const PHONE_OFF_LABELS = { push: "Phone notification (isn't available right now)", both: "Both (phone isn't available right now)" };
const ELSEWHERE_LABELS = { push: "Phone notification (set up on another device)", both: "Both (phone set up on another device)" };

const wantsPush = (channels) => channels === "push" || channels === "both";
const wantsEmail = (channels) => channels === "email" || channels === "both";

export const SETUP_HERE = "No device is set up for phone notifications yet. Press Save to set up this one.";
export const NO_PHONE_YET = "No phone is set up for these yet. On your phone, open Broker Radar, sign in, and press Save on this card.";
export const nothingSent = (emailOk) => `Nothing could be sent. Check that notifications are allowed on this device${emailOk ? ", or choose email." : "."}`;
export const PHONE_OFF = "Phone notifications aren't available right now. Your choice is kept, and phone notifications will resume when they are.";
export const EMAIL_OFF = "Email isn't available right now. Your choice is kept, and email notifications will resume when it is.";

// The stored channel, when it is none of the menu's own values and must still be listed (and kept when saving), else null:
//   * a phone channel this browser cannot do is listed only when the user really has a device set up (`devices` > 0): it is then "set up
//     on another device". With no device that claim would be false, so the menu shows only what this browser can do;
//   * a channel that includes email while the server has email switched off is listed with that said, so the card never hides a saved choice.
function keptOption(choices, channels, devices, { enabled = false, pushOnServer = true } = {}) {
  const own = choices.map((value) => value);
  if (choices.includes("push") && choices.includes("email")) own.push("both");
  if (!channels || own.includes(channels)) return null;
  if (wantsPush(channels) && !choices.includes("push")) {
    // phone switched off on the server: the saved choice is listed as that, once the user has pings on or a device
    if (!pushOnServer) return enabled || devices > 0 ? { value: channels, label: PHONE_OFF_LABELS[channels] } : null;
    if (devices > 0) return { value: channels, label: ELSEWHERE_LABELS[channels] };
    // pings on, phone saved, no device: kept, so a save from a browser that cannot push does not turn it into email
    return enabled ? { value: channels, label: NO_DEVICE_LABELS[channels] } : null;
  }
  if (wantsEmail(channels) && !choices.includes("email")) return { value: channels, label: EMAIL_OFF_LABELS[channels] };
  return null;
}

// The channel options to show for the choices available: one choice shows just that; both choices add "Both"; the stored channel is added
// when keptOption says so.
export function channelOptions(choices, current, devices = 0, extra = {}) {
  const options = choices.map((value) => ({ value, label: CHANNEL_LABELS[value] }));
  if (choices.includes("push") && choices.includes("email")) options.push({ value: "both", label: CHANNEL_LABELS.both });
  const kept = keptOption(choices, current, devices, extra);
  if (kept) options.push(kept);
  return options;
}

// The saved channel moved onto what is available here ("both" on an iPhone in Safari becomes "email"). With nothing available it is kept.
export function fitChannel(channels, choices) {
  if (choices.length === 0) return channels;
  const push = wantsPush(channels) && choices.includes("push");
  const email = wantsEmail(channels) && choices.includes("email");
  if (push && email) return "both";
  if (push) return "push";
  if (email) return "email";
  return choices[0];
}

// What the channel menu shows: the stored channel when keptOption lists it, else the channel fitted to this browser.
export function shownChannel(channels, choices, devices = 0, extra = {}) {
  return keptOption(choices, channels, devices, extra) ? channels : fitChannel(channels, choices);
}

// What a save sends and does. A stored channel the menu keeps (keptOption) is sent unchanged, with no permission prompt, even when this
// save turns pings on. Any other channel is fitted to this browser, and the permission prompt is raised only when this save changed "How"
// or turned pings on. `saved` is the server's settings, `form` the card's values, `devices` the server's count of this user's devices.
// -> { settings, askPush, softAsk, forgetPush }
//   askPush:    ask this browser for permission and register it (the save turns phone pings on, here)
//   forgetPush: pings are off or email only after this save, so this browser's device is removed from the server
export function savePlan({ saved, form, choices, devices = 0, pushOnServer = true, browserZone }) {
  const kept = keptOption(choices, form.channels, devices, { enabled: saved.enabled === true, pushOnServer }) !== null;
  const touched = form.channels !== saved.channels || (form.enabled === true && saved.enabled !== true);
  // the one exception to "an untouched card never asks": pings on, phone saved, no device yet, on a browser that can push
  const setUpHere = !kept && saved.enabled === true && wantsPush(saved.channels) && !(devices > 0) && choices.includes("push");
  const channels = kept ? form.channels : fitChannel(form.channels, choices);
  const settings = formToSettings({ ...form, channels }, browserZone);
  return {
    settings,
    askPush: !kept && (touched || setUpHere) && settings.enabled && wantsPush(settings.channels),
    softAsk: !kept && !touched && setUpHere && settings.enabled && wantsPush(settings.channels),   // a refusal here does not stop the save
    forgetPush: !settings.enabled || settings.channels === "email",
  };
}

// ── time zone ──

const US_ZONES = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Arizona (Phoenix)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii (Honolulu)"],
];

export const zoneLabel = (zone) => (US_ZONES.find(([name]) => name === zone) || [null, zone])[1];

// The zones to pick from: the saved zone and the browser's first when they are not one of the US zones, then the US zones.
export function zoneChoices(current, browserZone) {
  const us = US_ZONES.map(([name]) => name);
  const extra = [current, browserZone].filter((z, i, all) => typeof z === "string" && z && !us.includes(z) && all.indexOf(z) === i);
  return [...extra, ...us];
}

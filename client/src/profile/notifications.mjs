// The Notifications card's logic, with no DOM and no React (the card is NotificationsCard.jsx; the server calls and the browser side of
// phone notifications are ../push/push.mjs). What each state shows is decided here so it can be tested.

import { IOS_STEP, BLOCKED, UNSUPPORTED } from "../push/push.mjs";

export const NOT_AVAILABLE = "Rate-drop notifications aren't switched on for Broker Radar yet.";
export { IOS_STEP, BLOCKED, UNSUPPORTED };

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
  let note = null;
  if (!available.push && !available.email) note = NOT_AVAILABLE;
  else if (available.push && support === "blocked") note = BLOCKED;
  else if (available.push && support === "unsupported") note = UNSUPPORTED;
  return { channelChoices, showIosStep, note, canTest: !!settings.enabled && channelChoices.length > 0 };
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
const ELSEWHERE_LABELS = { push: "Phone notification (set up on another device)", both: "Both (phone set up on another device)" };

const wantsPush = (channels) => channels === "push" || channels === "both";

// The channel options to show for the choices available: one choice shows just that; both choices add "Both". A saved phone channel this
// browser cannot do (`current`) is listed too, as set up on another device, so the card never shows a channel it will not save.
export function channelOptions(choices, current) {
  const options = choices.map((value) => ({ value, label: CHANNEL_LABELS[value] }));
  if (choices.includes("push") && choices.includes("email")) options.push({ value: "both", label: CHANNEL_LABELS.both });
  else if (wantsPush(current) && !choices.includes("push")) options.push({ value: current, label: ELSEWHERE_LABELS[current] });
  return options;
}

// The saved channel moved onto what is available here ("both" on an iPhone in Safari becomes "email"). With nothing available it is kept.
export function fitChannel(channels, choices) {
  if (choices.length === 0) return channels;
  const push = wantsPush(channels) && choices.includes("push");
  const email = (channels === "email" || channels === "both") && choices.includes("email");
  if (push && email) return "both";
  if (push) return "push";
  if (email) return "email";
  return choices[0];
}

// What the channel menu shows: a phone channel this browser cannot do stays as it is (see channelOptions); anything else is fitted.
export function shownChannel(channels, choices) {
  return wantsPush(channels) && !choices.includes("push") ? channels : fitChannel(channels, choices);
}

// What a save sends and does. The stored channel goes unchanged unless, in this save, the user changed "How" or turned pings on (only
// then is it fitted to this browser); the permission prompt is raised only in those saves too. `saved` is the server's settings, `form`
// the card's values. -> { settings, askPush, forgetPush }
//   askPush:    ask this browser for permission and register it (the save turns phone pings on, here)
//   forgetPush: pings are off or email only after this save, so this browser's device is removed from the server
export function savePlan({ saved, form, choices, browserZone }) {
  const touched = form.channels !== saved.channels || (form.enabled === true && saved.enabled !== true);
  const channels = touched ? fitChannel(form.channels, choices) : form.channels;
  const settings = formToSettings({ ...form, channels }, browserZone);
  return {
    settings,
    askPush: touched && settings.enabled && wantsPush(settings.channels),
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

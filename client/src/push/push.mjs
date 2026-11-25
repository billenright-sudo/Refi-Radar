// Phone notifications for rate-drop pings: the logic, with no DOM and no React (the card is profile/NotificationsCard.jsx). Every browser
// object (navigator, window, Notification) and the fetch are passed in, so all of it runs under node --test. The service worker itself is
// public/sw.js. The server side is server/routes/alerts.js:
//   GET    /api/profile/alerts          -> { settings, available: { push, email }, vapidPublicKey | null, devices }
//   PUT    /api/profile/alerts          { enabled, threshold, quietStart, quietEnd, weekdaysOnly, channels, timeZone } -> the same as GET
//   POST   /api/profile/alerts/devices  { endpoint, keys: { p256dh, auth } } -> { devices }
//   DELETE /api/profile/alerts/devices  { endpoint } -> { devices }
//   POST   /api/profile/alerts/test     {} -> { sent }      400 / 429 / 503 carry the server's own line
// Each call answers { ok: true, data } or { ok: false, error } like profile.mjs, and never throws.

export const WHAT_YOU_GET = "Market news only: a note when the national average 30-year falls by your drop size. Never a client's name. At most one per rate update, and never in your quiet hours.";
export const IOS_STEP = "On iPhone or iPad, phone notifications work only after you add Broker Radar to your Home Screen: tap Share, then Add to Home Screen (iOS 16.4 or later). Open Broker Radar from that icon, sign in, and turn notifications on here. Until then you can choose email.";
export const BLOCKED = "Notifications are blocked for Broker Radar in this browser's settings. Allow them there, or choose email.";
export const UNSUPPORTED = "This browser can't show phone notifications. You can choose email instead.";
const NOT_ALLOWED = "You didn't allow notifications, so none were turned on. You can try again, or choose email.";
const NOT_AVAILABLE = "Phone notifications aren't available yet. Choose email.";
const NO_DEVICE = "This device couldn't be set up for notifications. Try again, or choose email.";

const NO_SERVER = "Couldn't reach the server. Check your connection and try again.";
const SESSION_ENDED = "Your session has ended. Sign in again.";
const NOT_SAVED = "That didn't save. Try again.";

// ── what this browser can do ──

const isIos = (navigator) => {
  const ua = String((navigator && navigator.userAgent) || "");
  // An iPad in "desktop site" mode says it is a Mac; only a touch screen gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1);
};
const isStandalone = (navigator, window) => {
  try {
    return navigator.standalone === true || !!(window && window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch {
    return false;
  }
};

// -> "ready" (can ask now) | "ios_home_screen" (iPhone/iPad in a Safari tab: add to the Home Screen first) | "blocked" (the user said no
// in the browser) | "unsupported".
export function pushSupport({ navigator, window } = {}) {
  if (!navigator || !window) return "unsupported";
  if (isIos(navigator) && !isStandalone(navigator, window)) return "ios_home_screen";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.Notification) return "unsupported";
  return window.Notification.permission === "denied" ? "blocked" : "ready";
}

// ── small helpers ──

// A base64url string (the server's VAPID public key) -> the bytes `applicationServerKey` wants.
export function keyToBytes(base64url) {
  const padded = String(base64url).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(base64url).length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// A PushSubscription -> exactly what the server takes, or null when it is not a usable subscription. Nothing else is sent.
export function deviceBody(subscription) {
  let json = null;
  try { json = subscription && subscription.toJSON ? subscription.toJSON() : null; } catch { json = null; }
  const keys = json && json.keys;
  if (!json || typeof json.endpoint !== "string" || !json.endpoint || !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// ── the API wrappers (the answer pattern of profile.mjs) ──

async function send(fetchFn, method, url, body) {
  try {
    const init = body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetchFn(url, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: !!res.ok, status: res.status, data };
  } catch {
    return { network: true };
  }
}

const SPEAKS = new Set([400, 429, 503]);
const messageOf = (data) => (data && typeof data.error === "string" && data.error.trim()) || "";
const isObject = (data) => !!data && typeof data === "object" && !Array.isArray(data);

function answer(res, { accept, fallback }) {
  if (res.network) return { ok: false, error: NO_SERVER };
  if (res.ok) return accept(res.data) ? { ok: true, data: res.data } : { ok: false, error: fallback };
  if (res.status === 401) return { ok: false, error: SESSION_ENDED };
  if (SPEAKS.has(res.status)) return { ok: false, error: messageOf(res.data) || fallback };
  return { ok: false, error: fallback };
}

const isAlerts = (data) => isObject(data) && isObject(data.settings) && isObject(data.available);
const hasDevices = (data) => isObject(data) && typeof data.devices === "number";

export const loadAlerts = async (fetchFn) =>
  answer(await send(fetchFn, "GET", "/api/profile/alerts"), { accept: isAlerts, fallback: "Couldn't load your notification settings. Try again." });
export const saveAlerts = async (fetchFn, settings) =>
  answer(await send(fetchFn, "PUT", "/api/profile/alerts", settings), { accept: isAlerts, fallback: NOT_SAVED });
export const addDevice = async (fetchFn, body) =>
  answer(await send(fetchFn, "POST", "/api/profile/alerts/devices", body), { accept: hasDevices, fallback: NO_DEVICE });
export const removeDevice = async (fetchFn, endpoint) =>
  answer(await send(fetchFn, "DELETE", "/api/profile/alerts/devices", { endpoint }), { accept: hasDevices, fallback: NOT_SAVED });
export const sendTest = async (fetchFn) =>
  answer(await send(fetchFn, "POST", "/api/profile/alerts/test", {}), {
    accept: (data) => isObject(data) && typeof data.sent === "boolean",
    fallback: "The test didn't go through. Try again.",
  });

// ── turning phone notifications on ──

// Whether a subscription was made for this public key. A browser that does not say which key it used cannot be compared: it counts as the same.
function sameKey(subscription, bytes) {
  const made = subscription && subscription.options && subscription.options.applicationServerKey;
  if (!made) return true;
  const have = new Uint8Array(made);
  return have.length === bytes.length && have.every((byte, i) => byte === bytes[i]);
}

// Registers the worker and gets (or makes) this browser's subscription. Never asks for permission. A subscription made for another public
// key than the server's current one (the keys were changed) is unsubscribed, removed from the server, and made again.
async function currentSubscription(navigator, vapidPublicKey, fetchFn) {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const ready = navigator.serviceWorker.ready ? await navigator.serviceWorker.ready : registration;
  const manager = (ready || registration).pushManager;
  const bytes = keyToBytes(vapidPublicKey);
  const existing = await manager.getSubscription();
  if (existing && sameKey(existing, bytes)) return existing;
  if (existing) {
    try { if (existing.endpoint) await removeDevice(fetchFn, existing.endpoint); } catch { /* the server ignores a device it cannot use */ }
    try { await existing.unsubscribe(); } catch { /* subscribe below replaces it anyway */ }
  }
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}

// Takes this browser's device off the server and off the push service: for a save that leaves pings off or email only, and for signing out.
// It never registers the worker and never throws; every failure is swallowed (the server ignores the devices of users whose pings are off).
// -> { ok: true } | { skipped: true }
export async function forgetDevice({ navigator, fetchFn }) {
  try {
    const workers = navigator && navigator.serviceWorker;
    if (!workers || typeof workers.getRegistration !== "function") return { skipped: true };
    const registration = await workers.getRegistration("/");
    const subscription = registration && registration.pushManager ? await registration.pushManager.getSubscription() : null;
    if (!subscription) return { skipped: true };
    try { if (subscription.endpoint) await removeDevice(fetchFn, subscription.endpoint); } catch { /* swallowed */ }
    try { await subscription.unsubscribe(); } catch { /* swallowed */ }
    return { ok: true };
  } catch {
    return { skipped: true };
  }
}

// Asks for permission, so call it from a tap and from nowhere else. -> { ok: true } | { error } (a line to show as it is).
export async function enablePush({ navigator, Notification, vapidPublicKey, fetchFn }) {
  if (!vapidPublicKey) return { error: NOT_AVAILABLE };
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return { error: BLOCKED };
    if (permission !== "granted") return { error: NOT_ALLOWED };
    const body = deviceBody(await currentSubscription(navigator, vapidPublicKey, fetchFn));
    if (!body) return { error: NO_DEVICE };
    const res = await addDevice(fetchFn, body);
    return res.ok ? { ok: true } : { error: res.error };
  } catch {
    return { error: NO_DEVICE };   // never the browser's own text: it can carry the push address
  }
}

// On app load: when permission is already "granted" and the user has phone pings on, tell the server about this browser's current
// subscription again (a push service can change it). It never prompts, and asks the server for nothing when permission is not granted.
// -> { ok: true } | { skipped: true } | { error }
export async function resyncPush({ navigator, Notification, fetchFn }) {
  try {
    if (!Notification || Notification.permission !== "granted" || !navigator || !navigator.serviceWorker) return { skipped: true };
    const loaded = await loadAlerts(fetchFn);
    if (!loaded.ok) return { error: loaded.error };
    const { settings, vapidPublicKey } = loaded.data;
    if (!settings.enabled || settings.channels === "email" || !vapidPublicKey) return { skipped: true };
    const body = deviceBody(await currentSubscription(navigator, vapidPublicKey, fetchFn));
    if (!body) return { skipped: true };
    const res = await addDevice(fetchFn, body);
    return res.ok ? { ok: true } : { error: res.error };
  } catch {
    return { error: NO_DEVICE };
  }
}

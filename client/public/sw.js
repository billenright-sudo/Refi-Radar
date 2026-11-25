// Broker Radar's service worker. It does one job: show the rate-drop notification the server sent and open the app when it is tapped.
// It shows only what the server put in the push (market news written by server code), adds no data of its own, stores nothing and
// caches nothing, and has no fetch handler, so every page and API call goes to the network exactly as without it.
// The notification always opens "/" whatever the push says: the payload's own url is never used (no open redirect).

const FALLBACK_TITLE = "Broker Radar";
const FALLBACK_BODY = "Open Charlie for today's market update.";
const FALLBACK_TAG = "rate-drop";
const TITLE_MAX = 60;
const BODY_MAX = 240;
const TAG_MAX = 40;

const text = (value, max, fallback) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (err) {
    payload = null;
  }
  if (!payload || typeof payload !== "object") payload = {};
  event.waitUntil(
    self.registration.showNotification(text(payload.title, TITLE_MAX, FALLBACK_TITLE), {
      body: text(payload.body, BODY_MAX, FALLBACK_BODY),
      tag: text(payload.tag, TAG_MAX, FALLBACK_TAG),
      icon: "/icon.svg",
      data: { url: "/" },
    })
  );
});

// An open Broker Radar window is sent to "/" (a reload, so the briefing is rebuilt with fresh rates) and brought forward; with none open,
// a new one opens at "/".
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows && windows[0];
      if (open) {
        try {
          if (open.navigate) await open.navigate("/");
          if (open.focus) await open.focus();
          return undefined;
        } catch (err) {
          // a window that cannot be navigated or focused: fall through and open a new one
        }
      }
      return self.clients.openWindow("/");
    })
  );
});

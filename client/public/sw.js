// Broker Radar's service worker. It does one job: show the rate-drop notification the server sent and open the app when it is tapped.
// It shows only what the server put in the push (market news written by server code), adds no data of its own, stores nothing and
// caches nothing, and has no fetch handler, so every page and API call goes to the network exactly as without it.
// The notification always opens Home (OPEN_URL) whatever the push says: the payload's own url is never used (no open redirect).

// Home with the mark the app reads to land on Home whatever the profile still lacks, and the message for a window this script cannot
// move itself. src/push/open.mjs holds the same two values (this classic script cannot import it); sw.test.mjs checks they match.
const OPEN_URL = "/?from=notification";
const OPEN_MESSAGE = "notification-open";

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
      renotify: true,   // a second drop under the same tag still sounds (a tag is always set)
      icon: "/icon.svg",
      data: { url: "/" },
    })
  );
});

// Where a window is, as a path ("" when it cannot be told): this script has no URL parser in every test scope, and needs only the path.
const pathOf = (win) => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(String((win && win.url) || ""));
  return match ? match[1] || "/" : "";
};

// Sends a home-path window to Home: by navigating it where the browser allows, else by asking the page to go there itself (App.jsx
// listens). A browser that refuses the navigation (a window this worker does not control, for one) gets the message too.
const sendHome = async (win) => {
  if (win.navigate) {
    try {
      await win.navigate(OPEN_URL);
      return;
    } catch (err) {
      // ask the page instead
    }
  }
  if (win.postMessage) win.postMessage({ type: OPEN_MESSAGE });
};

// An open Broker Radar window on the home path "/" is reloaded on Home (so the briefing is rebuilt with fresh rates, whatever page of
// the app was showing) and brought forward. A window open on any other path is only brought forward, never navigated: whatever is
// typed there stays. With none open, a new one opens on Home.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const list = windows || [];
      const home = list.find((win) => pathOf(win) === "/");
      const open = home || list[0];
      if (open) {
        try {
          if (home) await sendHome(home);
          if (open.focus) await open.focus();
          return undefined;
        } catch (err) {
          // a window that cannot be focused: fall through and open a new one
        }
      }
      return self.clients.openWindow(OPEN_URL);
    })
  );
});

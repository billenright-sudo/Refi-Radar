// A tap on a rate notification opens Broker Radar on Home, with no DOM and no React here. The service worker (public/sw.js) sends the
// window to OPEN_URL; where it cannot move a window itself it posts OPEN_MESSAGE and the page goes there (App.jsx). The app reads the
// mark once, lands on Home whatever the profile still lacks, and takes the mark out of the address so a reload does not repeat it.
// public/sw.js is a classic script and cannot import this file: it holds the same two values, and sw.test.mjs checks they match.

const OPEN_PARAM = "from";
const OPEN_VALUE = "notification";
export const OPEN_URL = `/?${OPEN_PARAM}=${OPEN_VALUE}`;
export const OPEN_MESSAGE = "notification-open";

// Whether this page visit was opened from a notification. `search` is location.search.
export function openedFromNotification(search) {
  if (typeof search !== "string") return false;
  return new URLSearchParams(search).get(OPEN_PARAM) === OPEN_VALUE;
}

// The address without the mark, as path + query + fragment (for history.replaceState). `href` is location.href; "/" when it cannot be read.
export function withoutOpenMark(href) {
  let url;
  try { url = new URL(href); } catch { return "/"; }
  url.searchParams.delete(OPEN_PARAM);
  return url.pathname + url.search + url.hash;
}

// Whether a message from the service worker asks the page to open Home.
export function isOpenMessage(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data) && data.type === OPEN_MESSAGE;
}

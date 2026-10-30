// The words of the "Calendar & email" card, with no DOM and no React (the card is in ../profile/cards.jsx).
//
//   GET /api/google/status -> { configured, connected, status, googleEmail }
//     status: "connected" | "reconnect" | null. `connected` only means a connection row exists, so an expired one
//     (status "reconnect") is connected too: the card must offer Reconnect, not Disconnect.
//   The OAuth callback sends the browser back to /?google=connected | denied | scope | error (scope: the calendar permission box
//   was left unticked on Google's consent screen).

// The card's one-line state and the single button it offers.
//   -> { label, action: "connect" | "reconnect" | "disconnect" | null }   (null: nothing to click)
export function googleCard(status) {
  const s = status && typeof status === "object" && !Array.isArray(status) ? status : {};
  if (!s.configured) return { label: "Google isn't set up on this server", action: null };
  if (s.status === "reconnect") return { label: "Your Google connection expired", action: "reconnect" };
  if (s.connected) {
    const email = typeof s.googleEmail === "string" ? s.googleEmail.trim() : "";
    return { label: email ? `Calendar connected as ${email}` : "Calendar connected", action: "disconnect" };
  }
  return { label: "Connect Google Calendar so Charlie can read and book your day", action: "connect" };
}

// The line to show when Google sends the browser back, from the page's query string ("?google=denied"); null when
// there is none (or it is not one of the four the server sends).
export function returnNotice(search) {
  if (typeof search !== "string") return null;
  switch (new URLSearchParams(search).get("google")) {
    case "connected": return "Google Calendar is connected.";
    case "denied": return "Google wasn't connected — permission was declined.";
    case "scope": return "Google wasn't connected — tick the calendar permission and try again.";
    case "error": return "Google couldn't be connected. Try again.";
    default: return null;
  }
}

// Keep in sync with NMLS_PATTERN and parseNmls in server/lib/assistant/outreach.js: one to twelve digits after trimming,
// or nothing at all (which clears the ID).
export function validNmls(text) {
  return typeof text === "string" && /^\d{0,12}$/.test(text.trim());
}

// The one address Connect and Reconnect will send the browser to: Google's own sign-in, over https (the server builds it in
// lib/google/oauth.js). The trailing slash matters: it is what keeps "https://accounts.google.com.evil.test/" out.
export function connectUrlOk(url) {
  return typeof url === "string" && url.startsWith("https://accounts.google.com/");
}

// What an NMLS field shows once the saved value has been read again. A field nobody has edited (it still shows what was saved
// before) follows the new saved value; one the user has typed in is left exactly as it is. Strings in, a string out.
export function inputAfterReload(current, previousSaved, nextSaved) {
  const shown = typeof current === "string" ? current : "";
  return shown.trim() !== (previousSaved || "") ? shown : (nextSaved || "");
}

// Runs `task` (an async re-read) for each trigger, never two at once. A trigger that arrives while it is running is not lost:
// one more run follows when it finishes (however many arrived), so a change that happened mid-read is always read afterwards.
// A { soft: true } trigger (window focus, tab visible again) is dropped instead: a read is already on its way. The task reports its
// own failures; one that throws does not stop the runner. trigger() resolves when the runs it started are done.
export function createCoalescer(task) {
  let running = false;
  let again = false;
  return async function trigger({ soft = false } = {}) {
    if (running) {
      if (!soft) again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try { await task(); } catch { /* the task reports its own failures */ }
      } while (again);
    } finally {
      running = false;
    }
  };
}

// The words of the "Calendar & email" card, with no DOM and no React (the card is in CharliView.jsx).
//
//   GET /api/google/status -> { configured, connected, status, googleEmail }
//     status: "connected" | "reconnect" | null. `connected` only means a connection row exists, so an expired one
//     (status "reconnect") is connected too: the card must offer Reconnect, not Disconnect.
//   The OAuth callback sends the browser back to /?google=connected | denied | error.

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
  return { label: "Connect Google Calendar so Charli can read and book your day", action: "connect" };
}

// The line to show when Google sends the browser back, from the page's query string ("?google=denied"); null when
// there is none (or it is not one of the three the server sends).
export function returnNotice(search) {
  if (typeof search !== "string") return null;
  switch (new URLSearchParams(search).get("google")) {
    case "connected": return "Google Calendar is connected.";
    case "denied": return "Google wasn't connected — permission was declined.";
    case "error": return "Google couldn't be connected. Try again.";
    default: return null;
  }
}

// Keep in sync with NMLS_PATTERN and parseNmls in server/lib/assistant/outreach.js: one to twelve digits after trimming,
// or nothing at all (which clears the ID).
export function validNmls(text) {
  return typeof text === "string" && /^\d{0,12}$/.test(text.trim());
}

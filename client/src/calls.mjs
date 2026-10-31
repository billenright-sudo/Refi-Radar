// The client page's "Calls" section, with no DOM and no React (ClientDetail in App.jsx draws it): the calls logged for one client,
// newest first, with the broker's own notes. The notes are shown here and nowhere else; nothing in this file or the route it calls
// is ever sent to Charlie (spec 5.4).
//
// Server contract (server/routes/clients.js):
//   GET /api/clients/:id/calls  -> { success, calls: [{ at, outcome, notes }] }   at most 50, newest first; at is SQLite UTC text
//                                  ("YYYY-MM-DD HH:MM:SS"), outcome "reached" | "not_reached"; 403 / 404 as for the client itself

export const OUTCOME_LABELS = Object.freeze({ reached: "Reached", not_reached: "Couldn't reach" });
const FAILED = "Couldn't load the calls for this client.";
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// The calls as the page lists them: [{ key, date, outcome, label, notes }], in the server's order. `date` is the call's day on the
// device's own calendar (the stored time is UTC); `notes` is plain text, drawn as text (never as HTML). A row without a real time or
// a known outcome is left out. Pure.
export function callRows(calls) {
  return (Array.isArray(calls) ? calls : [])
    .filter((c) => c && typeof c === "object" && typeof c.at === "string" && AT_RE.test(c.at) && Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, c.outcome))
    .map((c) => ({ at: new Date(`${c.at.replace(" ", "T")}Z`), c }))
    .filter(({ at }) => !Number.isNaN(at.getTime()))
    .map(({ at, c }, key) => ({
      key,
      date: at.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
      outcome: c.outcome,
      label: OUTCOME_LABELS[c.outcome],
      notes: typeof c.notes === "string" ? c.notes : "",
    }));
}

// GET the calls for client `clientId` (a positive integer) with the given fetch. Never throws.
//   -> { ok: true, calls: callRows(...) } | { ok: false, error }   `error` is a line to show the user as it is.
export async function loadCalls(fetchFn, clientId) {
  if (!Number.isInteger(clientId) || clientId <= 0) return { ok: false, error: FAILED };
  try {
    const res = await fetchFn(`/api/clients/${clientId}/calls`, { method: "GET" });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.success !== true) return { ok: false, error: FAILED };
    return { ok: true, calls: callRows(data.calls) };
  } catch {
    return { ok: false, error: FAILED };
  }
}

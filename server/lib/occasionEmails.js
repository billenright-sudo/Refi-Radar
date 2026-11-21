"use strict";
// The occasions a broker marked as emailed ("Mark sent" on an occasion email): one row per (client, occasion kind, family member,
// occasion date) in occasion_emails (server/db.js). Read back for the Dates Coming Up rows (routes/clients.js presentClients),
// Charlie's upcomingDatesTool and the morning briefing, so an occasion already emailed is shown as such and not offered again.
// Synchronous, better-sqlite3 handle first. Nothing here sends anything.
const { KIND_ORDER } = require("./occasions");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d) => typeof d === "string" && DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

// Records one occasion as emailed. `who` is the family member's stored name ('' when there is none). -> true when it was new,
// false when it was already recorded (a second tap changes nothing). Throws on a kind or a date that is not one.
function record(db, { clientId, userId, kind, who, date }) {
  if (!KIND_ORDER.includes(kind)) throw new TypeError(`kind must be one of ${KIND_ORDER.join(", ")}, got ${JSON.stringify(kind)}`);
  if (!realDay(date)) throw new TypeError(`date must be a real "YYYY-MM-DD", got ${JSON.stringify(date)}`);
  const info = db.prepare(
    "INSERT OR IGNORE INTO occasion_emails (client_id, user_id, kind, who, occasion_date) VALUES (?, ?, ?, ?, ?)"
  ).run(clientId, userId, kind, typeof who === "string" ? who : "", date);
  return info.changes === 1;
}

// The emailed occasions of `clientIds` dated `sinceDay` or later: Map clientId -> [{ kind, who, date }], in date order.
function forClients(db, clientIds, sinceDay) {
  const out = new Map();
  const ids = (Array.isArray(clientIds) ? clientIds : []).filter(Number.isInteger);
  if (!ids.length) return out;
  const rows = db.prepare(`
    SELECT client_id, kind, who, occasion_date FROM occasion_emails
    WHERE client_id IN (SELECT value FROM json_each(?)) AND occasion_date >= ?
    ORDER BY occasion_date, id
  `).all(JSON.stringify(ids), sinceDay);
  for (const r of rows) {
    if (!out.has(r.client_id)) out.set(r.client_id, []);
    out.get(r.client_id).push({ kind: r.kind, who: r.who, date: r.occasion_date });
  }
  return out;
}

// Whether `occasion` ({ kind, who, date }, as lib/occasions.js gives it: who null when there is none) is in `emailed`.
const isEmailed = (emailed, occasion) =>
  Array.isArray(emailed) && !!occasion &&
  emailed.some((e) => e.kind === occasion.kind && e.who === (occasion.who || "") && e.date === occasion.date);

module.exports = { record, forClients, isEmailed };

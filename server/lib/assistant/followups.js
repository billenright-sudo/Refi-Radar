"use strict";
// Charlie's follow-ups: who he put in front of the broker, what became of it, and the calls the broker logged.
//
// Everything here is synchronous and takes the better-sqlite3 handle first. Two formats are used throughout, so every
// comparison is a plain string compare:
//   - an instant (nowUtc, dueAt, sinceUtc, and the stored asked_at / resolved_at / contact_log.at) is SQLite UTC text,
//     "YYYY-MM-DD HH:MM:SS" (what datetime('now') writes). An ISO string ("...T...Z") is NOT that format and compares wrongly
//     against it, so one is refused rather than stored.
//   - a date (day, localDate, sinceDay, obsDate) is "YYYY-MM-DD".
//
// A recommendation is open until the broker answers it (resolveForClient), dismisses it, or Charlie has asked twice.
// Rows live in charlie_recommendations; calls in contact_log; the last rate drop the briefing led with in user_briefing_state.

// What a row can be closed as ('open' is where it starts, not somewhere to resolve to).
const RESOLUTIONS = ["reached", "not_reached", "expired"];
// Charlie asks about a row at most this many times in total.
const MAX_ASKS = 2;
// A briefing or sweep recommendation made today is first asked about from this local hour (before it, the broker is still working the list).
const ASK_FROM_HOUR = 12;

const UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertUtc(value, label) {
  if (typeof value !== "string" || !UTC_RE.test(value)) {
    throw new TypeError(`${label} must be SQLite UTC text "YYYY-MM-DD HH:MM:SS", got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertDay(value, label) {
  if (typeof value !== "string" || !DAY_RE.test(value)) {
    throw new TypeError(`${label} must be "YYYY-MM-DD", got ${JSON.stringify(value)}`);
  }
  return value;
}

// Record what Charlie recommended. `items` is [{ clientId, source, reasonCode, dueAt? }]. One row per (user, client, day,
// source): recording the same item again refreshes its reason (and due time, when given) but never reopens, resets or
// duplicates it. All or nothing: one bad item stores none.
function recordRecommendations(db, userId, day, items) {
  assertDay(day, "day");
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (item.dueAt != null) assertUtc(item.dueAt, "dueAt");
  }
  const upsert = db.prepare(`
    INSERT INTO charlie_recommendations (user_id, client_id, day, source, reason_code, due_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, client_id, day, source) DO UPDATE SET
      reason_code = excluded.reason_code,
      due_at      = COALESCE(excluded.due_at, charlie_recommendations.due_at)
  `);
  db.transaction(() => {
    for (const item of list) {
      upsert.run(userId, item.clientId, day, item.source, item.reasonCode ?? "", item.dueAt ?? null);
    }
  })();
}

// The recommendations Charlie should ask "did you get to ...?" about now, oldest first:
// [{ id, clientId, name, source, day, dueAt }]. Open, asked fewer than twice, and due:
//   - a briefing or sweep row once its day is over, or from noon (localHour >= 12) on its own day;
//   - a calendar row once its due_at (the event's end) has passed.
// A carry row is a note for tomorrow's list, never a question. A row whose client is gone, or is no longer this user's, is skipped.
function openFollowUps(db, userId, { localDate, localHour, nowUtc }) {
  assertDay(localDate, "localDate");
  assertUtc(nowUtc, "nowUtc");
  const hour = Number(localHour);
  if (!Number.isFinite(hour)) throw new TypeError(`localHour must be a number, got ${JSON.stringify(localHour)}`);
  return db.prepare(`
    SELECT r.id AS id, r.client_id AS clientId, c.name AS name, r.source AS source, r.day AS day, r.due_at AS dueAt
    FROM charlie_recommendations r
    JOIN clients c ON c.id = r.client_id AND c.user_id = @userId
    WHERE r.user_id = @userId
      AND r.status = 'open'
      AND r.ask_count < @maxAsks
      AND (
        (r.source IN ('briefing', 'sweep') AND (r.day < @localDate OR (r.day = @localDate AND @afterNoon = 1)))
        OR (r.source = 'calendar' AND r.due_at IS NOT NULL AND r.due_at <= @nowUtc)
      )
    ORDER BY r.day ASC, r.id ASC
  `).all({ userId, maxAsks: MAX_ASKS, localDate, afterNoon: hour >= ASK_FROM_HOUR ? 1 : 0, nowUtc });
}

// Charlie has just asked about these rows: count it and stamp when. After the second ask openFollowUps stops returning a row.
function markAsked(db, ids, nowUtc) {
  assertUtc(nowUtc, "nowUtc");
  const mark = db.prepare("UPDATE charlie_recommendations SET ask_count = ask_count + 1, asked_at = ? WHERE id = ?");
  db.transaction(() => {
    for (const id of new Set(ids || [])) mark.run(nowUtc, id);
  })();
}

// "Drop it": the row is expired and never asked about again. Only the user's own row; returns whether a row changed.
function dismiss(db, userId, recId) {
  return db.prepare("UPDATE charlie_recommendations SET status = 'expired' WHERE id = ? AND user_id = ?")
    .run(recId, userId).changes > 0;
}

// The broker has dealt with this client (status: 'reached', 'not_reached' or 'expired'): close every row still open for
// them, whichever source it came from, and stamp when. Rows already closed are left as they are. Returns the rows changed.
function resolveForClient(db, userId, clientId, status, nowUtc) {
  if (!RESOLUTIONS.includes(status)) throw new TypeError(`status must be one of ${RESOLUTIONS.join(", ")}, got ${JSON.stringify(status)}`);
  assertUtc(nowUtc, "nowUtc");
  return db.prepare(`
    UPDATE charlie_recommendations SET status = ?, resolved_at = ?
    WHERE user_id = ? AND client_id = ? AND status = 'open'
  `).run(status, nowUtc, userId, clientId).changes;
}

// "Put them on tomorrow's list": a carry row dated `day` (the day it was asked for). Asking again for the same day does not
// duplicate it, and reopens it if it had been closed.
function addCarry(db, userId, clientId, day) {
  assertDay(day, "day");
  db.prepare(`
    INSERT INTO charlie_recommendations (user_id, client_id, day, source) VALUES (?, ?, ?, 'carry')
    ON CONFLICT(user_id, client_id, day, source) DO UPDATE SET status = 'open', resolved_at = NULL
  `).run(userId, clientId, day);
}

// The client ids on today's list because an earlier day carried them: open carry rows with day < localDate, oldest first,
// each client once, only clients that are still this user's.
function carriedIds(db, userId, localDate) {
  assertDay(localDate, "localDate");
  return db.prepare(`
    SELECT r.client_id AS clientId
    FROM charlie_recommendations r
    JOIN clients c ON c.id = r.client_id AND c.user_id = @userId
    WHERE r.user_id = @userId AND r.source = 'carry' AND r.status = 'open' AND r.day < @localDate
    GROUP BY r.client_id
    ORDER BY MIN(r.day), MIN(r.id)
  `).all({ userId, localDate }).map((r) => r.clientId);
}

// A carry puts a client on ONE day's list: once a briefing has listed them, the carry rows that put them there (open, dated
// before `beforeDay` when it is given, which the briefing always does) are expired and stamped. A carry the broker asks for
// later that same day is dated that day, so it is left for the next day's list. A carried client the list had no room for is
// not passed in, and stays carried. Returns the rows changed.
function consumeCarries(db, userId, clientIds, nowUtc, beforeDay) {
  assertUtc(nowUtc, "nowUtc");
  if (beforeDay !== undefined) assertDay(beforeDay, "beforeDay");
  const expire = db.prepare(`
    UPDATE charlie_recommendations SET status = 'expired', resolved_at = @nowUtc
    WHERE user_id = @userId AND client_id = @clientId AND source = 'carry' AND status = 'open'
      AND (@beforeDay IS NULL OR day < @beforeDay)
  `);
  let changed = 0;
  db.transaction(() => {
    for (const clientId of new Set(clientIds || [])) {
      changed += expire.run({ nowUtc, userId, clientId, beforeDay: beforeDay ?? null }).changes;
    }
  })();
  return changed;
}

// What was recorded for this user on `day` from `source` ('briefing', 'sweep', 'calendar' or 'carry'), whatever became of it,
// in the order it was recorded: [{ clientId, reasonCode }]. The briefing reads its own earlier list for the day from here.
const SOURCES = ["briefing", "sweep", "calendar", "carry"];
function recommendedOn(db, userId, day, source) {
  assertDay(day, "day");
  if (!SOURCES.includes(source)) throw new TypeError(`source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
  return db.prepare(`
    SELECT client_id AS clientId, reason_code AS reasonCode FROM charlie_recommendations
    WHERE user_id = ? AND day = ? AND source = ? ORDER BY id
  `).all(userId, day, source);
}

// Write a call to the contact log and return its id. outcome is 'reached' or 'not_reached' (anything else is refused by the
// table); notes are the broker's own and stay in the log.
function logCall(db, { userId, clientId, outcome, notes, nowUtc }) {
  assertUtc(nowUtc, "nowUtc");
  const info = db.prepare("INSERT INTO contact_log (client_id, user_id, at, outcome, notes) VALUES (?, ?, ?, ?, ?)")
    .run(clientId, userId, nowUtc, outcome, notes ?? "");
  return Number(info.lastInsertRowid);
}

// The ids of the clients this user reached at or after `sinceUtc`. A not_reached call does not count.
function reachedSince(db, userId, sinceUtc) {
  assertUtc(sinceUtc, "sinceUtc");
  const rows = db.prepare("SELECT DISTINCT client_id FROM contact_log WHERE user_id = ? AND outcome = 'reached' AND at >= ?")
    .all(userId, sinceUtc);
  return new Set(rows.map((r) => r.client_id));
}

// The ids of the clients recommended on or after `sinceDay` whose item is still open or was not reached (so they should not be
// put forward again yet). Carry rows are left out: a carried name is meant to come back.
function recentlyRecommended(db, userId, sinceDay) {
  assertDay(sinceDay, "sinceDay");
  const rows = db.prepare(`
    SELECT DISTINCT client_id FROM charlie_recommendations
    WHERE user_id = ? AND day >= ? AND status IN ('open', 'not_reached') AND source <> 'carry'
  `).all(userId, sinceDay);
  return new Set(rows.map((r) => r.client_id));
}

// Has the briefing already led with the rate drop seen on FRED observation date `obsDate` (or a later one) for this user?
function dropAlreadyLed(db, userId, obsDate) {
  assertDay(obsDate, "obsDate");
  const row = db.prepare("SELECT last_drop_obs FROM user_briefing_state WHERE user_id = ?").get(userId);
  return Boolean(row && row.last_drop_obs && row.last_drop_obs >= obsDate);
}

// Remember that the briefing led with the drop seen on `obsDate`. One row per user; it only ever moves forward.
function markDropLed(db, userId, obsDate) {
  assertDay(obsDate, "obsDate");
  db.prepare(`
    INSERT INTO user_briefing_state (user_id, last_drop_obs) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_drop_obs = MAX(COALESCE(user_briefing_state.last_drop_obs, ''), excluded.last_drop_obs)
  `).run(userId, obsDate);
}

module.exports = {
  recordRecommendations,
  openFollowUps,
  markAsked,
  dismiss,
  resolveForClient,
  addCarry,
  carriedIds,
  consumeCarries,
  recommendedOn,
  logCall,
  reachedSince,
  recentlyRecommended,
  dropAlreadyLed,
  markDropLed,
};

"use strict";
// Charlie's morning briefing (spec 5.2), built in code from tool data like the greeting it replaces: no model call, so every
// figure is grounded by construction. The model takes over only when the broker replies.
//
// buildBriefing({ user, ctx, db, localHour, localDate, nowMs }) -> { reply, sources, kind, strip, followUp }
//
// The reply, in order:
//   1. the opener (openerFor, with the user's first name);
//   2. the market line: the 30-year, its move since the previous FRED observation (named by its date) and "as of" the latest,
//      then one clause each for a 15-year, FHA or jumbo move of 0.05 or more. A 30-year drop of DROP_THRESHOLD or more leads
//      with "Rates dropped:" in the first briefing after that observation only. An estimated set says so and claims no move;
//   3. the call list (callList.js) over the user's OWN clients, less the ones its follow-ups ask about, recorded
//      as today's 'briefing' recommendations (a carried client it lists is no longer carried), then "Plus N more clients at their
//      target." for the newly-at-target clients it had no room for, and "Plus N more check-ins due." for the due clients it could
//      have listed but did not (one already counted as at target is not counted again). Clients at their target rate (target-rate
//      alerts spec 4.5, read after targets.checkTargets has run
//      on the latest FRED observation) come right after the carried ones: first the newly reached, "<name> is at target,
//      estimated 5.875% against a 6.000% target", whatever the sweep or the 7- and 3-day exclusions say, and only a client the
//      follow-ups ask about waits. The first briefing that lists one announces it (target_announced_on = today, in the same
//      transaction as the list) and a rebuild that day says the same; from the next day one not yet handled is "<name> is still
//      at a 6.000% target, since November 10th" and follows the list's exclusions like any pick. A carried client is listed
//      as carried, and is not announced by it;
//   4. a broker's one count-only team line: their loan officers' open opportunities, and how many of their clients are at
//      target (said alone when there are no opportunities or no rates);
//   5. today's calendar: the count and the first one or two events still ahead;
//   6. open follow-ups (followups.js), at most two clients and none that today's list carries (unless a call booked with them
//      today has ended), after the calendar's calls have been matched (calendarFollowUps.js);
//   7. exactly one question: the first follow-up's, else the close (CLOSE_QUESTION offers to book the list's calls; with no
//      list, CLOSE_NO_CALLS does not). No career question (round 2): the stage is set on the Profile page.
//
// Nothing that could hold contact details is spoken: a client name or an event title is read only when speakable() passes it
// (no "@", no "?", no run of seven or more digits however punctuated, at most 80 characters). A title that fails is "an event";
// a client whose name fails is left off the list and never asked about.
//
// Every section is computed on its own and a section that fails (no rates, no Google, an empty book, a sweep that throws, a
// target check that throws: no target lines) is left out silently: the briefing still renders and still ends in its one
// question. A localDate or localHour the browser got wrong is replaced by the UTC date or hour of nowMs, so no section is lost
// to it. Figures are digits from tool data; there
// are no figure words and no "?" before the last sentence.
//
// Google is only ever called one request at a time (a token refresh is single-flight per user in lib/google/oauth.js; this keeps
// the briefing to one Calendar request at a time as well): today's
// events first, then the calendar follow-ups, and neither is waited on past CALENDAR_WAIT_MS in total. A read given up on is
// left to finish on its own (the follow-ups' upsert simply lands for the next open), and nothing else is started beside it; a
// read is never started once the wait is used up.
const refi = require("../refi");   // called as refi.runSweep(): tests can swap it
const targets = require("../targets");   // called as targets.checkTargets(): tests can swap it
const upgradeAlerts = require("../upgradeAlerts");   // called as upgradeAlerts.checkUpgrades(): tests can swap it
const assistantTools = require("./tools");   // called as assistantTools.x(): tests can swap a tool
const followups = require("./followups");
const { pickCallList, opportunityPhrase, cmpLens } = require("./callList");
const { collectCalendarFollowUps } = require("./calendarFollowUps");
const { isCitation } = require("./orchestrator");
const { openerFor } = require("./openers");
const { localToday, addDays } = require("../google/time");
const { MONTHS, ordinal } = require("../dateLabels");

// Phase 1: a 30-year fall of this much or more between two observations leads the market line. Phase 2 makes it per user.
const DROP_THRESHOLD = 0.125;
// A 15-year, FHA or jumbo move smaller than this is left out, and a 30-year one is "little changed".
const MOVE_WORTH_SAYING = 0.05;
// The longest the briefing waits on Google in all (today's events, then the calendar follow-ups).
const CALENDAR_WAIT_MS = 4000;
const CALL_LIST_LIMIT = 3;
const MAX_FOLLOW_UPS = 2;
const REACHED_WINDOW_MS = 7 * 86_400_000;   // a client reached in the last 7 days is left off the list
const RECENT_DAYS = 3;                      // and one recommended in the last 3 days whose item is open or not reached
const MAX_SPOKEN = 80;                      // a name or title longer than this is not read out
const TARGET_SOURCE = "client record";      // what a target line is cited as: the hit stored on the client

const CLOSE_QUESTION = "Want a full sweep, an update on a client, or should I get those calls on your calendar?";
const CLOSE_NO_CALLS = "Want a full sweep, or an update on a client?";
const COUPLE_OF_CALLS = "I've also got a couple of calls to check on with you.";
const AN_EVENT = "an event";
const NO_TITLE = "(no title)";   // what lib/google/calendar.js calls an untitled event

// The other products whose moves are worth a clause, as the market line names them.
const OTHER_PRODUCTS = [["rate_15yr_fixed", "the 15-year"], ["rate_30yr_fha", "FHA"], ["rate_30yr_jumbo", "jumbo"]];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Seven or more digits with at most three other characters (not letters) between each: a phone number however it is written
// ("555-201-0103", "555 – 201 – 0103", "555/201/0103", "(555) 201 0103"). Run on NFKC text, so fullwidth digits count too.
const DIGIT_RUN_RE = /\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){6,}/u;

const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");
// A failed section is logged by its name and the error's name only: never a message, which could carry client data.
const skip = (section, err) => console.error(`briefing ${section} skipped:`, errName(err));
const noQuestion = (text) => String(text).replace(/[?？]/g, "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
const hasRates = (rates) => !!rates && Number.isFinite(rates.rate_30yr_fixed);
const isEstimated = (rates) => /^estimated/i.test(String(rates.source || ""));

// The text as it may be read aloud (NFKC, whitespace collapsed, trimmed), or null when it must not be: empty, longer than
// MAX_SPOKEN, or holding an "@", a "?" or a phone-shaped digit run. The one check for client names and event titles alike.
function speakable(text) {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_SPOKEN || /[@?？]/.test(t) || DIGIT_RUN_RE.test(t)) return null;
  return t;
}

// "2026-10-29" -> "October 29th" (with the year when it is not `localDate`'s year). The ordinal is how toSpeech reads a day.
function spokenDate(date, localDate) {
  const [, y, m, d] = DAY_RE.exec(date);
  const ref = typeof localDate === "string" ? DAY_RE.exec(localDate) : null;
  return `${MONTHS[Number(m) - 1]} ${ordinal(Number(d))}${ref && ref[1] !== y ? `, ${y}` : ""}`;
}
const realDay = (date) => {
  const m = typeof date === "string" ? DAY_RE.exec(date) : null;
  if (!m) return false;
  const at = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date;
};

// "down 0.15" / "up 0.1": a move as getMarketUpdate gives it (two decimals), said as the number it is.
const moveText = (delta) => `${delta < 0 ? "down" : "up"} ${Number(Math.abs(delta).toFixed(2))}`;

// The time a promise is given before the briefing goes on without it. `work` never rejects (see attempt).
const TIMED_OUT = Symbol("timed out");
function within(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), TIMED_OUT); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
const attempt = (section, fn) => Promise.resolve().then(fn).catch((err) => { skip(section, err); return null; });

// ── the sections ─────────────────────────────────────────────────────────────

// -> { line, source, strip: { rate30, move30, asOf } } (an estimated set: strip also has estimated: true, so the screen can label the rate
// as the briefing does) or null when there are no usable rates.
function marketSection({ ctx, db, userId, localDate }) {
  const market = assistantTools.getMarketUpdate({}, ctx);
  const data = market && isCitation(market.source) && market.data;
  const rates = data && data.rates;
  const rate30 = rates && rates.rate_30yr_fixed;
  if (!Number.isFinite(rate30)) return null;
  if (data.estimated) {
    return { line: `The 30-year is at an estimated ${rate30}%.`, source: market.source, strip: { rate30, move30: null, asOf: null, estimated: true } };
  }
  const asOf = realDay(rates.date) ? rates.date : null;
  const asOfText = asOf ? `, as of ${spokenDate(asOf, localDate)}` : "";
  // The move is named by the previous observation's own date ("since October 28th"), never by a day relative to it: a stale
  // print must not read as "since yesterday".
  const deltas = data.hasHistory && data.deltas && realDay(data.sinceDate) ? data.deltas : null;
  const move30 = deltas && Number.isFinite(deltas.rate_30yr_fixed) ? deltas.rate_30yr_fixed : null;
  const strip = { rate30, move30, asOf };
  if (move30 === null) return { line: `The 30-year is at ${rate30}%${asOfText}.`, source: market.source, strip };

  const moved = Math.abs(move30) >= MOVE_WORTH_SAYING ? moveText(move30) : "little changed";
  let line = `the 30-year is at ${rate30}%, ${moved} since ${spokenDate(data.sinceDate, localDate)}${asOfText}.`;
  // The drop leads once per observation: the first briefing after it arrives, never again as news.
  if (move30 <= -DROP_THRESHOLD && asOf && !followups.dropAlreadyLed(db, userId, asOf)) {
    line = `Rates dropped: ${line}`;
    followups.markDropLed(db, userId, asOf);
  } else {
    line = capitalize(line);
  }
  const clauses = OTHER_PRODUCTS
    .filter(([key]) => Number.isFinite(deltas[key]) && Math.abs(deltas[key]) >= MOVE_WORTH_SAYING)
    .map(([key, label]) => `${label} is ${moveText(deltas[key])}`);
  if (clauses.length) {
    const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
    line += ` ${capitalize(joined)}.`;
  }
  return { line, source: market.source, strip };
}

// The sweep of `rows` at the briefing's own clock, with the label runSweepTool gives the same sweep.
function sweepOf(rows, rates, nowMs) {
  const result = refi.runSweep(rows, rates, new Date(nowMs));
  const source = !isEstimated(rates) ? "sweep engine" : rates.date ? `sweep engine (estimated rates ${rates.date})` : "sweep engine (estimated rates)";
  return { result, source };
}

// The `rows` at their target and not yet handled (lib/targets.js views of what the briefing's check stored; a stored hit is at
// target with no snapshot too). None when the check failed (`targetCheck` null) or the views cannot be read.
function atTargetRows(db, rows, targetCheck, viewerId) {
  if (!targetCheck) return [];
  try {
    const views = targets.viewsFor(db, rows, viewerId);
    return rows.filter((r) => views.has(r.id) && views.get(r.id).state === "at_target");
  } catch (err) { skip("targets", err); return []; }
}

// A broker's team line: their loan officers' clients (the org's, not their own) with an opportunity, as a count only, and how many
// of those clients are at their target (with no rates too: the hit is stored). A count from an estimated rate set says so, as the
// call list does. -> { line, source, atTarget } or null.
function teamSection({ user, ctx, db, nowMs, targetCheck }) {
  if (user.role !== "broker") return null;
  const rows = db.prepare("SELECT * FROM clients WHERE org_id = ? AND user_id != ? ORDER BY name ASC").all(user.org_id, user.id);
  if (rows.length === 0) return null;
  let n = 0;
  let source = null;
  if (hasRates(ctx.rates)) {
    const swept = sweepOf(rows, ctx.rates, nowMs);
    const count = swept.result && swept.result.counts && swept.result.counts.withOpportunity;
    if (Number.isInteger(count) && count > 0) {
      n = count;
      source = swept.source;
    }
  }
  const k = atTargetRows(db, rows, targetCheck, user.id).length;
  if (n === 0 && k === 0) return null;
  const atTarget = k === 1 ? "is at target" : "are at target";
  if (n === 0) return { line: `${k} of your loan officers' clients ${atTarget}.`, source: TARGET_SOURCE, atTarget: k };
  const estimated = isEstimated(ctx.rates) ? ", on estimated rates" : "";
  const clause = k > 0 ? `, and ${k} of their clients ${atTarget}` : "";
  return { line: `Your loan officers have ${plural(n, "opportunity", "opportunities")} open${estimated}${clause}.`, source, atTarget: k };
}

// What a calendar title is read as: the title when speakable() passes it, else "an event".
const spokenTitle = (title) => (title === NO_TITLE ? AN_EVENT : speakable(title) || AN_EVENT);

// Today's events as the briefing reads them: { line, source, nextEvent }. The ones still ahead (not yet ended, or all day) are
// named, the first one or two of them.
function calendarSection({ date, events, nowMs }) {
  const n = events.length;
  const source = `google calendar ${date}`;
  if (n === 0) return { line: "Your calendar is clear today.", source, nextEvent: null };
  const ahead = events.filter((e) => e && (e.allDay || !Number.isFinite(e.endAt) || e.endAt > nowMs));
  const shown = ahead.slice(0, 2).map((e) => ({ title: spokenTitle(e.title), start: e.allDay ? null : e.start || null }));
  const said = shown.map((e) => (e.start ? `${e.title} at ${e.start}` : `${e.title}, all day`)).join(", then ");
  const count = `You have ${plural(n, "event")} on your calendar today`;
  let line;
  if (shown.length === 0) line = `${count}.`;
  else if (ahead.length < n) line = `${count}; next up, ${said}.`;
  else if (shown.length < n) line = `${count}, starting with ${said}.`;
  else line = `${count}: ${said}.`;
  return { line, source, nextEvent: shown[0] || null };
}

// Today's carried clients: `carried`, still carried from an earlier day, and `carriedToday`, the ones an earlier open today
// listed as carried (it consumed their carry rows, and they are still today's) and the broker has not reached since that list
// (followups.reachedSinceCarried): one reached since is dealt with like any client reached today. `earlier` is that open's list.
function carriesOn(db, userId, localDate) {
  const carried = followups.carriedIds(db, userId, localDate);
  const earlier = followups.recommendedOn(db, userId, localDate, "briefing");
  const reachedSince = followups.reachedSinceCarried(db, userId, localDate);
  const carriedToday = earlier.filter((r) => r.reasonCode === "carry" && !reachedSince.has(r.clientId)).map((r) => r.clientId);
  return { carried, earlier, carriedToday };
}

// The user's own clients at their target as call-list targets (callList.js), each list in the order the hits were recorded, then
// by name (the rows' own order: Array.sort is stable). `newly`: not announced before today, so a rebuild today reads the same
// words; listed whatever the 7- and 3-day exclusions say, but never while the follow-ups ask about the client. `still`: announced
// on an earlier day and not handled, left off by `excludeIds` like any pick. The figures are the ones stored with the hit (a hit
// without them is not spoken).
function targetPicks({ db, userId, localDate, speakableRows, targetCheck, excludeIds, followUpClientIds }) {
  const hitAt = (r) => String(r.target_reached_at ?? "");
  const rows = atTargetRows(db, speakableRows, targetCheck, userId)
    .filter((r) => Number.isFinite(r.target_reached_rate) && realDay(r.target_reached_on))
    .sort((a, b) => (hitAt(a) < hitAt(b) ? -1 : hitAt(a) > hitAt(b) ? 1 : 0));
  const pick = (r, reasonCode, says) => {
    const name = speakable(r.name);
    return { clientId: r.id, name, reasonCode, reason: `${name} ${says}` };
  };
  const target = (r) => Number(r.target_rate).toFixed(3);
  const newly = rows.filter((r) => (r.target_announced_on == null || r.target_announced_on === localDate) && !followUpClientIds.has(r.id))
    .map((r) => pick(r, "target", `is at target, estimated ${r.target_reached_rate.toFixed(3)}% against a ${target(r)}% target`));
  const still = rows.filter((r) => r.target_announced_on != null && r.target_announced_on < localDate && !excludeIds.has(r.id))
    .map((r) => pick(r, "target_still", `is still at a ${target(r)}% target, since ${spokenDate(r.target_reached_on, localDate)}`));
  return { newly, still };
}

// The user's own clients who newly qualify for an upgrade (upgradeAlerts.newlyQualified: new, and not announced on an earlier day)
// as call-list targets, one pick per client: its best newly qualified lens, "<name> now <phrase>" (callList.js's upgrade phrases,
// built on the lens headline). Listed whatever the 7- and 3-day exclusions say, but never while the follow-ups ask about the client.
// -> { picks, pairs }: `pairs` are every newly qualified lens of the clients picked, which the list announces.
function upgradePicks({ db, localDate, nowMs, speakableRows, upgradeCheck, followUpClientIds }) {
  if (!upgradeCheck) return { picks: [], pairs: [] };
  const rows = speakableRows.filter((r) => !followUpClientIds.has(r.id));
  const views = upgradeAlerts.upgradeViewsFor(db, rows, upgradeCheck, nowMs);
  const byClient = new Map();
  for (const q of upgradeAlerts.newlyQualified(db, rows, views, localDate)) {
    const lens = views.get(q.clientId).lenses.find((l) => l.lens === q.lens);
    const phrase = lens && opportunityPhrase(lens);
    if (!phrase) continue;
    if (!byClient.has(q.clientId)) byClient.set(q.clientId, { name: speakable(q.name), lenses: [] });
    byClient.get(q.clientId).lenses.push({ lens, phrase });
  }
  const ranked = [...byClient].map(([clientId, c]) => ({ clientId, name: c.name, lenses: c.lenses.sort((a, b) => cmpLens(a.lens, b.lens)) }))
    .sort((a, b) => cmpLens(a.lenses[0].lens, b.lenses[0].lens));   // stable: equal rank keeps the rows' name order
  return {
    picks: ranked.map((c) => ({ clientId: c.clientId, name: c.name, reasonCode: "upgrade", reason: `${c.name} now ${c.lenses[0].phrase}` })),
    pairs: ranked.flatMap((c) => c.lenses.map((l) => ({ clientId: c.clientId, lens: l.lens.lens }))),
  };
}

// -> { picks, line, targetLine, moreLine, consumed, announced, announcedUpgrades, targetSaid }. Only `speakableRows` (the user's own clients whose
// names may be read) can be listed.
function callListSection({ db, userId, localDate, nowMs, speakableRows, sweep, estimated, followUpClientIds, targetCheck, upgradeCheck }) {
  const { carried, earlier, carriedToday } = carriesOn(db, userId, localDate);
  // "A logged contact in the last 7 days" (spec 5.2): a reached call in contact_log, or a last_contact the client record has from
  // then until now (the Sweeps page's Log contact writes it as SQLite UTC text, an import or a close date as YYYY-MM-DD; both
  // compare as text). A last_contact later than now (a future close date it was seeded from) is no contact.
  const since = sqliteUtc(nowMs - REACHED_WINDOW_MS);
  const nowUtc = sqliteUtc(nowMs);
  const reached = followups.reachedSince(db, userId, since);
  for (const row of speakableRows) {
    if (typeof row.last_contact === "string" && row.last_contact >= since && row.last_contact <= nowUtc) reached.add(row.id);
  }
  const recent = followups.recentlyRecommended(db, userId, addDays(localDate, -RECENT_DAYS));
  // An earlier open today: its list stays the list (its clients are not "recently recommended" to it).
  const listedToday = new Set(earlier.map((r) => r.clientId));
  // Ruling R3: (reached ∪ recently recommended) − carried, so a carried client is never left off: neither one still carried nor
  // one an earlier open today listed as carried (and consumed), so a reopen reads the same list. The clients this briefing's
  // follow-ups ask about are left off too: a reopen after noon asks about today's earlier list, and must not also tell the broker
  // to call the client it asks "were you able to reach them?" about. The follow-ups ask about a carried client only once a call
  // booked with them today has ended (F-2), and that client stays left off.
  const excludeIds = new Set([...reached, ...[...recent].filter((id) => !listedToday.has(id)), ...followUpClientIds]);
  for (const id of [...carried, ...carriedToday]) if (!followUpClientIds.has(id)) excludeIds.delete(id);

  const { newly, still } = targetPicks({ db, userId, localDate, speakableRows, targetCheck, excludeIds, followUpClientIds });
  let upgradeNewly = { picks: [], pairs: [] };
  try {
    upgradeNewly = upgradePicks({ db, localDate, nowMs, speakableRows, upgradeCheck, followUpClientIds });
  } catch (err) { skip("upgrades", err); }
  const picks = pickCallList({
    sweep,
    ownClientIds: speakableRows.map((r) => r.id),
    carriedIds: [...new Set([...carriedToday, ...carried])],
    excludeIds,
    clientNames: new Map(speakableRows.map((r) => [r.id, r.name])),   // Ruling R7: a carried client with no sweep row is still named
    targets: [...newly, ...upgradeNewly.picks, ...still],
    limit: CALL_LIST_LIMIT,
  });

  let line = null;
  if (picks.length) {
    const reasons = picks.map((p) => p.reason);
    const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join("; ")}; and ${reasons[reasons.length - 1]}`;
    line = `Today's call${picks.length === 1 ? "" : "s"}${estimated ? ", on estimated rates" : ""}: ${list}.`;
  }

  // The newly-at-target clients the list had no room for (one listed as carried is listed).
  const picked = new Set(picks.map((p) => p.clientId));
  const unlisted = new Set(newly.filter((t) => !picked.has(t.clientId)).map((t) => t.clientId));
  const targetLine = unlisted.size > 0 ? `Plus ${plural(unlisted.size, "more client", "more clients")} at their target.` : null;

  // The due check-ins the list could have named and did not: own and speakable, not left off, not listed, not asked about, and
  // not already counted as at their target.
  const listable = new Set(speakableRows.map((r) => r.id));
  const more = new Set(((sweep && sweep.checkIns) || []).map((r) => r.clientId)
    .filter((id) => listable.has(id) && !excludeIds.has(id) && !picked.has(id) && !followUpClientIds.has(id) && !unlisted.has(id))).size;
  let moreLine = null;
  if (more > 0) moreLine = picks.length ? `Plus ${more} more check-in${more === 1 ? "" : "s"} due.` : `You have ${plural(more, "check-in")} due.`;

  // carried clients this list has taken: consumed (only the carries that put them on today's list, not one asked for today)
  const carriedSet = new Set(carried);
  const consumed = picks.filter((p) => p.reasonCode === "carry" && carriedSet.has(p.clientId)).map((p) => p.clientId);
  // the newly-at-target clients this list announces, and whether it says anything of a target at all
  const announced = picks.filter((p) => p.reasonCode === "target").map((p) => p.clientId);
  const upgraded = new Set(picks.filter((p) => p.reasonCode === "upgrade").map((p) => p.clientId));
  const announcedUpgrades = upgradeNewly.pairs.filter((p) => upgraded.has(p.clientId));
  const targetSaid = Boolean(targetLine) || picks.some((p) => p.reasonCode === "target" || p.reasonCode === "target_still");
  return { picks, line, targetLine, moreLine, consumed, announced, announcedUpgrades, targetSaid };
}

// The clients a list has just announced as newly at target: announced today, once (a rebuild today leaves the date as it is).
// Not an edit of the client, so updated_at is left alone.
function announceTargets(db, clientIds, localDate) {
  const mark = db.prepare("UPDATE clients SET target_announced_on = ? WHERE id = ? AND target_announced_on IS NULL");
  for (const id of clientIds) mark.run(localDate, id);
}

// Open follow-ups as at most MAX_FOLLOW_UPS clients: { shown: [{ ...first row, name }], rowIds }. A client can have more than
// one open row (a briefing row and a calendar row the same day): that is one call, asked about by its first row, and every one
// of its rows counts as asked. A client whose name may not be read out is skipped, never asked. So is a client in `carriedIds`
// (F-2): today's list carries them, and the list is where they go; their rows stay open for a day they are not carried. The one
// exception is a call booked with them today that has ended: when they come first they are asked "How did the call go?" (that
// row is their question) instead of being listed again. Second, they would go unnamed ("a couple of calls"), so they stay listed.
function pickFollowUps(rows, carriedIds = new Set(), localDate = null) {
  const callEnded = new Set(rows.filter((r) => r.source === "calendar" && r.day === localDate && carriedIds.has(r.clientId))
    .map((r) => r.clientId));
  const byClient = new Map();
  for (const row of rows) {
    const name = speakable(row.name);
    if (!name || (carriedIds.has(row.clientId) && !callEnded.has(row.clientId))) continue;
    if (!byClient.has(row.clientId)) byClient.set(row.clientId, { first: { ...row, name }, ids: [] });
    const entry = byClient.get(row.clientId);
    if (callEnded.has(row.clientId) && row.source === "calendar" && entry.first.source !== "calendar") entry.first = { ...row, name };
    entry.ids.push(row.id);
  }
  const chosen = [...byClient].filter(([clientId], i) => i === 0 || !callEnded.has(clientId)).slice(0, MAX_FOLLOW_UPS)
    .map(([, c]) => c);
  return { shown: chosen.map((c) => c.first), rowIds: chosen.flatMap((c) => c.ids) };
}

// The one question about a follow-up (its name already speakable). A row from today is "Earlier today": the table keeps no time of
// day, and a list first made at 2 or 7 PM is no "this morning".
function followUpQuestion(row, localDate) {
  if (row.source === "calendar") return `How did the call with ${row.name} go?`;
  const when = row.day === localDate ? "Earlier today" : row.day === addDays(localDate, -1) ? "Yesterday" : "Earlier";
  return `${when} I suggested calling ${row.name}. Were you able to reach them?`;
}

// ── the briefing ─────────────────────────────────────────────────────────────

async function buildBriefing({ user, ctx, db, localHour, localDate, nowMs = Date.now(), calendarWaitMs = CALENDAR_WAIT_MS }) {
  // the route sends a checked date and hour; anything else is the UTC day and hour of nowMs, so no section is lost to it
  const today = realDay(localDate) ? localDate : new Date(nowMs).toISOString().slice(0, 10);
  const hour = Number.isInteger(localHour) && localHour >= 0 && localHour <= 23 ? localHour : new Date(nowMs).getUTCHours();
  const kind = hour >= 4 && hour <= 11 ? "morning" : "catch_up";
  const userId = user.id;
  const nowUtc = sqliteUtc(nowMs);
  const rates = ctx && ctx.rates;
  const sources = [];
  const cite = (source) => { if (isCitation(source) && !sources.includes(source)) sources.push(source); };
  const strip = { rate30: null, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null };

  // 2. the market
  let market = null;
  try {
    market = marketSection({ ctx, db, userId, localDate: today });
    if (market) Object.assign(strip, market.strip);
  } catch (err) { skip("market", err); }

  // the org's targets, checked on the latest FRED observation before any book is read, so the rows carry its hits. A check that
  // throws leaves every target line out (targetCheck stays null) and nothing else changes.
  let targetCheck = null;
  try { targetCheck = { snapshot: targets.checkTargets(db, user.org_id, nowMs) }; } catch (err) { skip("targets", err); }

  // the org's upgrade alerts, recorded on the latest FRED observation. A check that throws leaves the "now" lines out and nothing else changes.
  let upgradeCheck = null;
  try { upgradeCheck = upgradeAlerts.checkUpgrades(db, user.org_id, nowMs); } catch (err) { skip("upgrades", err); }

  // the user's OWN book and its sweep (for a broker too: the call list is never the team's)
  let ownRows = [];
  let sweep = null;
  let sweepSource = null;
  try {
    ownRows = db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(userId);
    if (hasRates(rates)) {
      const swept = sweepOf(ownRows, rates, nowMs);
      sweep = swept.result;
      sweepSource = swept.source;
      strip.opportunities = sweep.counts.withOpportunity;
      strip.checkInsDue = sweep.counts.checkInsDue;
    }
  } catch (err) { skip("sweep", err); sweep = null; sweepSource = null; }

  // 4. the team line
  let team = null;
  try { team = teamSection({ user, ctx, db, nowMs, targetCheck }); } catch (err) { skip("team", err); }

  // 5. today's calendar, then 6. the calendar's calls matched to follow-ups: one Google call at a time, within the wait
  let calendar = null;
  const deadline = Date.now() + calendarWaitMs;
  const left = () => deadline - Date.now();
  const google = ctx && ctx.google;
  if (google && left() > 0) {
    const read = await within(attempt("calendar", async () => {
      const connection = google.connection();
      if (!connection || connection.code) return null;
      const date = localToday(connection.timeZone, nowMs);
      const listed = await google.listDay({ date });
      return listed && Array.isArray(listed.events) ? { date, events: listed.events } : null;
    }), left());
    if (read && read !== TIMED_OUT) {
      try { calendar = calendarSection({ ...read, nowMs }); } catch (err) { skip("calendar", err); }
      // only once today's read has answered, so the two never run side by side; never started with no time left to wait
      if (left() > 0) {
        await within(attempt("calendar follow-ups", () => collectCalendarFollowUps(ctx, { localDate: today, db, userId })), left());
      }
    }
  }
  if (calendar) strip.nextEvent = calendar.nextEvent;

  // 6. open follow-ups, read before today's list is recorded (a list made now is not yet something to ask about)
  let followUps = { shown: [], rowIds: [] };
  try {
    let carriedNow = new Set();
    try {
      const { carried, carriedToday } = carriesOn(db, userId, today);
      carriedNow = new Set([...carried, ...carriedToday]);
    } catch (err) { skip("carries", err); }   // the follow-ups still go: with no carries read, none are skipped
    followUps = pickFollowUps(followups.openFollowUps(db, userId, { localDate: today, localHour: hour, nowUtc }), carriedNow, today);
  } catch (err) { skip("follow-ups", err); }
  const shown = followUps.shown;

  // 3. the call list over the clients whose names may be read, recorded as today's briefing recommendations
  let calls = null;
  try {
    calls = callListSection({
      db, userId, localDate: today, nowMs, sweep,
      speakableRows: ownRows.filter((r) => speakable(r.name)),
      estimated: hasRates(rates) && isEstimated(rates),
      followUpClientIds: new Set(shown.map((f) => f.clientId)),
      targetCheck, upgradeCheck,
    });
  } catch (err) { skip("call list", err); }
  if (calls && calls.picks.length) {
    try {
      db.transaction(() => {
        followups.recordRecommendations(db, userId, today,
          calls.picks.map((p) => ({ clientId: p.clientId, source: "briefing", reasonCode: p.reasonCode })));
        if (calls.consumed.length) followups.consumeCarries(db, userId, calls.consumed, nowUtc, today);
        if (calls.announced.length) announceTargets(db, calls.announced, today);
        if (calls.announcedUpgrades.length) upgradeAlerts.announceUpgrades(db, calls.announcedUpgrades, today);
      })();
    } catch (err) { skip("recording the call list", err); }
  }

  if (followUps.rowIds.length) {
    try { followups.markAsked(db, followUps.rowIds, nowUtc); } catch (err) { skip("marking follow-ups", err); }
  }

  // sources, in reply order
  if (market) cite(market.source);
  if ((calls && calls.picks.length) || strip.opportunities !== null) cite(sweepSource);
  if ((calls && calls.targetSaid) || (team && team.atTarget > 0)) cite(TARGET_SOURCE);
  if (team) cite(team.source);
  if (calendar) cite(calendar.source);

  // 7. the one question
  const first = shown[0] || null;
  const hasList = Boolean(calls && calls.picks.length);
  const question = first ? followUpQuestion(first, today) : hasList ? CLOSE_QUESTION : CLOSE_NO_CALLS;

  const name = typeof user.first_name === "string" ? user.first_name.trim() : "";
  const body = [
    openerFor({ localHour: hour, localDate: today, name }),
    market && market.line,
    calls && calls.line,
    calls && calls.targetLine,
    calls && calls.moreLine,
    team && team.line,
    calendar && calendar.line,
    shown.length >= 2 ? COUPLE_OF_CALLS : null,
  ].filter(Boolean).join(" ");

  return {
    reply: `${noQuestion(body)} ${question}`,
    sources,
    kind,
    strip,
    followUp: first ? { recId: first.id, clientId: first.clientId, name: first.name, source: first.source } : null,
  };
}

module.exports = { buildBriefing, speakable, DROP_THRESHOLD, CALENDAR_WAIT_MS, CLOSE_QUESTION, CLOSE_NO_CALLS, COUPLE_OF_CALLS };

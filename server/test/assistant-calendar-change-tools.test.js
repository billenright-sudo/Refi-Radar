"use strict";
// cancelEventTool and moveEventTool (lib/assistant/tools.js): they find ONE event on the broker's own calendar, refuse the ones she
// won't change in code-written words, and otherwise package the change for confirmation. They change nothing. Google is a
// stand-in that records what it was asked; NO test here touches the network. All names are made up.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-cal-change-tools-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { tools, TOOL_SCHEMA, cancelEventTool, moveEventTool } = require("../lib/assistant/tools");

const orgA = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Alpha')").run().lastInsertRowid);
const brokerA = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'T', 'User', 'broker@a.co')").run(orgA).lastInsertRowid);
const brokerCtx = { user: { id: brokerA, role: "broker", org_id: orgA }, rates: { date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" }, db };

const PHX = "America/Phoenix";
const TUE = Date.UTC(2026, 9, 27, 15, 0);        // Tuesday 2026-10-27, 08:00 in Phoenix
const WED = "2026-10-28";
const at = (date, hh, mm = 0) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh + 7, mm);   // Phoenix is UTC-7
const label = (hh, mm = 0) => `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;

// A timed event as lib/google listDayDetailed gives it.
let seq = 0;
function ev(title, date, hh, mm = 0, minutes = 30, over = {}) {
  seq += 1;
  const startAt = at(date, hh, mm);
  const endAt = startAt + minutes * 60_000;
  const end = new Date(endAt - 7 * 3_600_000);
  return {
    id: `evt${String(seq).padStart(6, "0")}`, etag: `"etag-${seq}"`, title, start: label(hh, mm), end: label(end.getUTCHours(), end.getUTCMinutes()),
    allDay: false, startAt, endAt, startDate: null, guests: false, repeats: false, mine: true, ...over,
  };
}
const allDay = (title, date, over = {}) => {
  seq += 1;
  return { id: `evt${String(seq).padStart(6, "0")}`, etag: `"etag-${seq}"`, title, start: null, end: null, allDay: true, startAt: null, endAt: null, startDate: date, guests: false, repeats: false, mine: true, ...over };
};

function fakeGoogle({ connection = { timeZone: PHX, googleEmail: "ann@gmail.example" }, days = {}, listed } = {}) {
  const asked = { listDayDetailed: [], deleteEvent: [], patchEvent: [], insertEvent: [], getEvent: [] };
  return {
    asked,
    connection: () => connection,
    listDay: async () => { throw new Error("the model-facing read is not used for a change"); },
    listDayDetailed: async (query) => { asked.listDayDetailed.push(query.date); return listed ? listed(query) : { events: days[query.date] || [] }; },
    deleteEvent: async (c) => { asked.deleteEvent.push(c); return { done: true }; },
    patchEvent: async (c) => { asked.patchEvent.push(c); return { done: true }; },
    getEvent: async (c) => { asked.getEvent.push(c); return { gone: true }; },
    insertEvent: async (e) => { asked.insertEvent.push(e); return { eventId: "never" }; },
  };
}
const ctxOf = (google, now = TUE) => ({ ...brokerCtx, google, now });
const NON_CITING = /^\([^)]+\)$/;

const refusal = (r) => { assert.match(r.source, NON_CITING); assert.equal(r.data.code, "calendar_change"); assert.equal(r.sideEffect, undefined, "nothing is packaged"); return r.data.line; };

// ── the tools exist and are offered ──────────────────────────────────────────

test("the two tools are registered and in the schema; the model is told neither id nor etag exists", () => {
  assert.equal(typeof tools.cancelEventTool, "function");
  assert.equal(typeof tools.moveEventTool, "function");
  const names = TOOL_SCHEMA.map((t) => t.name);
  assert.ok(names.includes("cancelEventTool") && names.includes("moveEventTool"));
  for (const name of ["cancelEventTool", "moveEventTool"]) {
    const t = TOOL_SCHEMA.find((s) => s.name === name);
    assert.deepStrictEqual(Object.keys(t.input_schema.properties).filter((k) => /id|etag|guest|attendee|organizer/i.test(k)), [], "no id-like input");
    assert.match(t.description, /does NOT (?:cancel|move) anything/);
  }
  assert.deepStrictEqual(TOOL_SCHEMA.find((s) => s.name === "moveEventTool").input_schema.required, ["date", "newTime"]);
  assert.deepStrictEqual(TOOL_SCHEMA.find((s) => s.name === "cancelEventTool").input_schema.required, ["date"]);
});

// ── cancel: finding the event ────────────────────────────────────────────────

test("cancelEventTool: the one event that starts at that time is the event, whatever title was said; the read-back shows its real title", async () => {
  const sam = ev("Walkthrough with Sam", WED, 10);
  const google = fakeGoogle({ days: { [WED]: [sam, ev("Lunch", WED, 12)] } });
  const r = await cancelEventTool({ date: "tomorrow", time: "10:00", title: "dentist" }, ctxOf(google));
  assert.deepStrictEqual(google.asked.listDayDetailed, [WED]);
  assert.deepStrictEqual(r, {
    data: { preview: { title: "Walkthrough with Sam", day: "Wednesday, October 28th", time: "10:00 AM", allDay: false } },
    source: "(unsaved)",
    sideEffect: {
      type: "cancelEvent",
      event: { id: sam.id, etag: sam.etag, title: "Walkthrough with Sam", date: WED, time: "10:00", allDay: false, startAt: sam.startAt, timeZone: PHX, durationMinutes: 30 },
    },
  });
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent, google.asked.insertEvent], [[], [], []], "packaging changes nothing");
});

test("cancelEventTool: by title, case and punctuation ignored, every word given must be in the title; a time given must match too", async () => {
  const google = fakeGoogle({ days: { [WED]: [ev("Closing: Sam & Pat's house", WED, 10), ev("Closing call with Ray", WED, 14)] } });
  const ok = await cancelEventTool({ date: WED, title: "SAM pat closing" }, ctxOf(google));
  assert.equal(ok.sideEffect.event.title, "Closing: Sam & Pat's house");
  assert.equal(ok.sideEffect.event.time, "10:00");
  assert.ok((await cancelEventTool({ date: WED, title: "closing", time: "14:00" }, ctxOf(google))).sideEffect, "one at 2 PM");
  assert.match(refusal(await cancelEventTool({ date: WED, title: "closing sam", time: "15:00" }, ctxOf(google))), /^I don't see that on your calendar for Wednesday, October 28th\.$/, "the time given must match too");
  assert.match(refusal(await cancelEventTool({ date: WED, title: "sam ray" }, ctxOf(google))), /^I don't see that/, "every word must appear");
});

test("cancelEventTool: nothing fits is the not-found line; more than one is the which-one line, up to four, by their real titles and times", async () => {
  const day = [ev("Call with Pat", WED, 9), ev("Call with Ray", WED, 11), ev("Call with Sue", WED, 13), ev("Call with Tom", WED, 15), ev("Call with Uma", WED, 16)];
  const google = fakeGoogle({ days: { [WED]: day } });
  assert.equal(refusal(await cancelEventTool({ date: WED, title: "dentist" }, ctxOf(google))), "I don't see that on your calendar for Wednesday, October 28th.");
  assert.equal(refusal(await cancelEventTool({ date: WED, time: "10:00" }, ctxOf(google))), "I don't see that on your calendar for Wednesday, October 28th.");
  assert.equal(
    refusal(await cancelEventTool({ date: WED, title: "call" }, ctxOf(google))),
    'I see more than one that fits on Wednesday, October 28th: "Call with Pat" at 9:00 AM, "Call with Ray" at 11:00 AM, "Call with Sue" at 1:00 PM, "Call with Tom" at 3:00 PM. Which one?'
  );
  const two = fakeGoogle({ days: { [WED]: [ev("Call with Pat", WED, 9), ev("Pat review", WED, 9, 0), ev("Lunch", WED, 12)] } });
  assert.equal(
    refusal(await cancelEventTool({ date: WED, time: "09:00" }, ctxOf(two))),
    'I see more than one that fits on Wednesday, October 28th: "Call with Pat" at 9:00 AM, "Pat review" at 9:00 AM. Which one?',
    "two at the same time: she never picks"
  );
  // a title narrows two at one time down to one
  assert.ok((await cancelEventTool({ date: WED, time: "09:00", title: "review" }, ctxOf(two))).sideEffect);
});

test("cancelEventTool: an all-day event can be cancelled; the which-one line says all day", async () => {
  const trip = allDay("Out of town", WED);
  const google = fakeGoogle({ days: { [WED]: [trip] } });
  const r = await cancelEventTool({ date: WED, title: "out of town" }, ctxOf(google));
  assert.deepStrictEqual(r.data.preview, { title: "Out of town", day: "Wednesday, October 28th", time: null, allDay: true });
  assert.deepStrictEqual(r.sideEffect.event, { id: trip.id, etag: trip.etag, title: "Out of town", date: WED, time: null, allDay: true, startAt: null, timeZone: PHX, durationMinutes: null });
  const both = fakeGoogle({ days: { [WED]: [allDay("Trip", WED), allDay("Trip two", WED)] } });
  assert.match(refusal(await cancelEventTool({ date: WED, title: "trip" }, ctxOf(both))), /^I see more than one that fits on Wednesday, October 28th: "Trip", all day, "Trip two", all day\. Which one\?$/);
  // a time can never name an all-day event
  assert.match(refusal(await cancelEventTool({ date: WED, time: "09:00" }, ctxOf(google))), /^I don't see that/);
});

// ── the events she will not change ───────────────────────────────────────────

test("cancelEventTool and moveEventTool: guests, a repeating event, someone else's, already started: the code-written reasons, nothing packaged", async () => {
  const day = [
    ev("Lunch with Pat", WED, 12, 0, 30, { guests: true }),
    ev("Team standup", WED, 9, 0, 30, { repeats: true }),
    ev("Board meeting", WED, 14, 0, 30, { mine: false, guests: true }),
  ];
  const google = fakeGoogle({ days: { [WED]: day, "2026-10-27": [ev("Early call", "2026-10-27", 7, 0, 60)] } });
  for (const [tool, extra] of [[cancelEventTool, {}], [moveEventTool, { newTime: "16:00" }]]) {
    assert.equal(refusal(await tool({ date: WED, title: "lunch", ...extra }, ctxOf(google))), '"Lunch with Pat" has guests, and I never email guests. Open Google Calendar to change it so they\'re told.');
    assert.equal(refusal(await tool({ date: WED, title: "standup", ...extra }, ctxOf(google))), '"Team standup" is a repeating event. I can\'t change those yet. Open Google Calendar.');
    assert.equal(refusal(await tool({ date: WED, title: "board", ...extra }, ctxOf(google))), '"Board meeting" was set up by someone else, so I can\'t change it. Open Google Calendar.');
    assert.equal(refusal(await tool({ date: "today", title: "early", ...extra }, ctxOf(google))), '"Early call" has already started, so I\'ll leave it alone.');
  }
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent], [[], []]);
});

test("a title longer than eighty characters is cut in a line", async () => {
  const long = "A".repeat(100);
  const google = fakeGoogle({ days: { [WED]: [ev(long, WED, 12, 0, 30, { guests: true })] } });
  const line = refusal(await cancelEventTool({ date: WED, time: "12:00" }, ctxOf(google)));
  assert.ok(line.startsWith(`"${"A".repeat(79)}…" has guests`), line);
});

test("an event that started a minute ago is already started; one that starts this minute is not (the clock is the start)", async () => {
  const google = fakeGoogle({ days: { "2026-10-27": [ev("Started", "2026-10-27", 8, 0), ev("Later", "2026-10-27", 8, 30)] } });
  assert.match(refusal(await cancelEventTool({ date: "today", title: "started" }, ctxOf(google, at("2026-10-27", 8, 1)))), /has already started/);
  assert.match(refusal(await cancelEventTool({ date: "today", title: "started" }, ctxOf(google, at("2026-10-27", 8, 0)))), /has already started/, "at the start it has started");
  assert.ok((await cancelEventTool({ date: "today", title: "later" }, ctxOf(google, at("2026-10-27", 8, 1)))).sideEffect);
});

test("an all-day event today can be cancelled; one from a past day has already started", async () => {
  const google = fakeGoogle({ days: { "2026-10-27": [allDay("Out of town", "2026-10-27")], "2026-10-26": [allDay("Old trip", "2026-10-26")] } });
  assert.ok((await cancelEventTool({ date: "today", title: "out of town" }, ctxOf(google))).sideEffect);
  assert.match(refusal(await cancelEventTool({ date: "2026-10-26", title: "old trip" }, ctxOf(google))), /^"Old trip" has already started, so I'll leave it alone\.$/);
});

// ── cancel: bad input, Google trouble ────────────────────────────────────────

test("cancelEventTool: input errors go back to the model as plain errors; nothing is read from Google until the input is good", async () => {
  const google = fakeGoogle({ days: { [WED]: [ev("Lunch", WED, 12)] } });
  for (const [args, source] of [
    [{}, "(invalid input)"], [{ date: "someday", time: "10:00" }, "(invalid input)"], [{ date: WED }, "(invalid input)"],
    [{ date: WED, time: "10am" }, "(invalid input)"], [{ date: WED, title: 7 }, "(invalid input)"], [{ date: WED, title: "  ?! " }, "(invalid input)"],
  ]) {
    const r = await cancelEventTool(args, ctxOf(google));
    assert.equal(r.source, source, JSON.stringify(args));
    assert.equal(typeof r.data.error, "string");
    assert.equal(r.data.code, undefined);
    assert.equal(r.sideEffect, undefined);
  }
  assert.deepStrictEqual(google.asked.listDayDetailed, []);
  assert.match((await cancelEventTool({ date: WED }, ctxOf(google))).data.error, /time or the title/);
});

test("cancel and move: Google not connected, expired or unreachable are the same codes the other calendar tools give", async () => {
  for (const tool of [cancelEventTool, moveEventTool]) {
    const args = { date: WED, time: "10:00", newTime: "11:00" };
    for (const code of ["not_connected", "reconnect"]) {
      const r = await tool(args, ctxOf(fakeGoogle({ connection: { code } })));
      assert.deepStrictEqual([r.source, r.data.code], ["(not connected)", code]);
    }
    for (const code of ["not_connected", "reconnect", "unavailable"]) {
      const r = await tool(args, ctxOf(fakeGoogle({ listed: async () => ({ code }) })));
      assert.deepStrictEqual([r.source, r.data.code], ["(not connected)", code]);
    }
    const down = await tool(args, ctxOf(fakeGoogle({ listed: async () => ({ error: "Google Calendar could not be read" }) })));
    assert.equal(down.source, "(unavailable)");
    assert.equal(typeof down.data.error, "string");
    const none = await tool(args, { ...brokerCtx, now: TUE });
    assert.deepStrictEqual([none.source, none.data.code], ["(not connected)", "not_connected"]);
  }
});

// ── move ─────────────────────────────────────────────────────────────────────

test("moveEventTool: packages the move to a new start, same length, on the same day unless a new day is given; reads nothing else", async () => {
  const sam = ev("Walkthrough with Sam", WED, 10, 0, 45);
  const google = fakeGoogle({ days: { [WED]: [sam] } });
  const r = await moveEventTool({ date: WED, time: "10:00", newTime: "14:30" }, ctxOf(google));
  assert.deepStrictEqual(r, {
    data: { preview: { title: "Walkthrough with Sam", day: "Wednesday, October 28th", time: "10:00 AM", newDay: "Wednesday, October 28th", newTime: "2:30 PM", overlap: null } },
    source: "(unsaved)",
    sideEffect: {
      type: "moveEvent",
      event: {
        id: sam.id, etag: sam.etag, title: "Walkthrough with Sam", date: WED, time: "10:00", startAt: sam.startAt,
        newDate: WED, newTime: "14:30", durationMinutes: 45, timeZone: PHX,
      },
    },
  });
  assert.deepStrictEqual(google.asked.listDayDetailed, [WED], "the same day is read once");
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent], [[], []]);
  const far = fakeGoogle({ days: { [WED]: [sam] } });
  const r2 = await moveEventTool({ date: WED, title: "walkthrough", newDate: "friday", newTime: "09:00" }, ctxOf(far));
  assert.deepStrictEqual([r2.sideEffect.event.newDate, r2.sideEffect.event.newTime, r2.data.preview.newDay], ["2026-10-30", "09:00", "Friday, October 30th"]);
  assert.deepStrictEqual(far.asked.listDayDetailed, [WED, "2026-10-30"], "the new day is read to look for an overlap");
});

test("moveEventTool: the new start must be in the future and exist on the clock; the time asked for is required", async () => {
  const google = fakeGoogle({ days: { [WED]: [ev("Lunch", WED, 12)] } });
  assert.deepStrictEqual(await moveEventTool({ date: WED, time: "12:00", newDate: "today", newTime: "07:59" }, ctxOf(google)), { data: { error: "that time has already passed" }, source: "(invalid input)" });
  assert.equal((await moveEventTool({ date: WED, time: "12:00" }, ctxOf(google))).source, "(invalid input)");
  assert.equal((await moveEventTool({ date: WED, time: "12:00", newTime: "noon" }, ctxOf(google))).source, "(invalid input)");
  assert.equal((await moveEventTool({ date: WED, time: "12:00", newDate: "someday", newTime: "13:00" }, ctxOf(google))).source, "(invalid input)");
  const ny = fakeGoogle({ connection: { timeZone: "America/New_York", googleEmail: "a@b.c" }, days: { "2027-03-14": [ev("Closing", "2027-03-14", 9)] } });
  const clocks = await moveEventTool({ date: "2027-03-14", title: "closing", newTime: "02:30" }, ctxOf(ny));
  assert.deepStrictEqual(clocks, { data: { error: "that time doesn't exist that day — the clocks change" }, source: "(invalid input)" });
});

test("moveEventTool: to the time it is already at is a code line and nothing to confirm; an all-day event can't be moved", async () => {
  const google = fakeGoogle({ days: { [WED]: [ev("Lunch with Pat", WED, 12), allDay("Out of town", WED)] } });
  assert.equal(refusal(await moveEventTool({ date: WED, time: "12:00", newTime: "12:00" }, ctxOf(google))), '"Lunch with Pat" is already at that time.');
  assert.equal(refusal(await moveEventTool({ date: WED, title: "out of town", newTime: "12:00" }, ctxOf(google))), '"Out of town" is an all-day event. I can cancel it, but I can\'t move those yet.');
});

test("moveEventTool: a new slot that overlaps another timed event adds a heads-up naming it; the move is still packaged; the event itself never counts", async () => {
  const lunch = ev("Lunch with Pat", WED, 12, 0, 60);
  const google = fakeGoogle({ days: { [WED]: [ev("Walkthrough", WED, 9, 0, 60), lunch, allDay("Out of town", WED)] } });
  const r = await moveEventTool({ date: WED, title: "walkthrough", newTime: "11:30" }, ctxOf(google));   // 11:30-12:30 overlaps lunch
  assert.ok(r.sideEffect);
  assert.deepStrictEqual(r.data.preview.overlap, { title: "Lunch with Pat", time: "12:00 PM" });
  const touching = await moveEventTool({ date: WED, title: "walkthrough", newTime: "11:00" }, ctxOf(google));   // ends 12:00: touching is no overlap
  assert.equal(touching.data.preview.overlap, null);
  const onSelf = await moveEventTool({ date: WED, title: "walkthrough", newTime: "09:30" }, ctxOf(google));       // overlaps only its old slot
  assert.equal(onSelf.data.preview.overlap, null);
  // the heads-up is a nicety: a day that can't be read for it still lets the move be packaged
  const noRead = fakeGoogle({ listed: async (q) => (q.date === WED ? { events: [ev("Walkthrough", WED, 9, 0, 60)] } : { error: "Google Calendar could not be read" }) });
  const r3 = await moveEventTool({ date: WED, title: "walkthrough", newDate: "2026-10-30", newTime: "10:00" }, ctxOf(noRead));
  assert.ok(r3.sideEffect);
  assert.equal(r3.data.preview.overlap, null);
});

// ── what the model is shown ──────────────────────────────────────────────────

test("nothing the model could be shown carries an event id, an etag, a guest or an organizer: the data holds titles, spoken days and times only", async () => {
  const sam = ev("Walkthrough with Sam", WED, 10, 0, 30, { id: "secretEventId99", etag: '"secret-etag-77"' });
  const guests = ev("Lunch with Pat", WED, 12, 0, 30, { guests: true });
  const google = fakeGoogle({ days: { [WED]: [sam, guests] } });
  const results = [
    await cancelEventTool({ date: WED, time: "10:00" }, ctxOf(google)),
    await moveEventTool({ date: WED, time: "10:00", newTime: "15:00" }, ctxOf(google)),
    await cancelEventTool({ date: WED, title: "lunch" }, ctxOf(google)),
    await moveEventTool({ date: WED, title: "nothing" , newTime: "15:00" }, ctxOf(google)),
    await cancelEventTool({ date: WED, title: "w l" }, ctxOf(google)),
  ];
  for (const r of results) {
    const shown = JSON.stringify(r.data);
    assert.ok(!/secretEventId99|secret-etag|etag|"id"|attendee|organizer|guests\":/i.test(shown), shown);
  }
});

// ── events over more than one day (fix wave F1) ──────────────────────────────
// Through the real adapter (lib/google/calendar listDayDetailed) with a stand-in fetch that answers like events.list: every event
// that OVERLAPS the asked day, so one that began the day before, or runs on for days, is in Google's reply.
const calendarAdapter = require("../lib/google/calendar");
function realDay(items) {
  const overlaps = (it, min, max) => {
    if (it.start.date) {
      const day = min.slice(0, 10);
      return it.start.date <= day && it.end.date > day;
    }
    return Date.parse(it.start.dateTime) < Date.parse(max) && Date.parse(it.end.dateTime) > Date.parse(min);
  };
  const fetchFn = async (url) => {
    const q = new URL(url).searchParams;
    return { ok: true, status: 200, json: async () => ({ items: items.filter((it) => overlaps(it, q.get("timeMin"), q.get("timeMax"))) }) };
  };
  const google = fakeGoogle();
  google.listDayDetailed = async ({ date }) => { google.asked.listDayDetailed.push(date); return calendarAdapter.listDayDetailed("tok", { date, timeZone: PHX }, fetchFn); };
  return google;
}
const own = { self: true };
const conference = { id: "conf00001", etag: '"e2"', summary: "Mortgage Conference", start: { dateTime: "2026-10-27T09:00:00-07:00" }, end: { dateTime: "2026-10-29T17:00:00-07:00" }, organizer: own };
const vacation = { id: "vacation1", etag: '"e3"', summary: "Vacation", start: { date: "2026-10-27" }, end: { date: "2026-10-31" }, organizer: own };
const fullDay = { id: "fullday01", etag: '"e6"', summary: "Open house", start: { dateTime: "2026-10-28T09:00:00-07:00" }, end: { dateTime: "2026-10-29T09:00:00-07:00" }, organizer: own };
const lateCall = { id: "latecall1", etag: '"e7"', summary: "Late call with Kim", start: { dateTime: "2026-10-28T23:00:00-07:00" }, end: { dateTime: "2026-10-29T01:00:00-07:00" }, organizer: own };
const oneDayOff = { id: "dayoff001", etag: '"e8"', summary: "Day off", start: { date: "2026-10-28" }, end: { date: "2026-10-29" }, organizer: own };
const MULTI = (t) => `"${t}" runs over more than one day. I can't change those yet. Open Google Calendar.`;

test("F1: a timed event from Tuesday to Thursday is not found on Wednesday, and is refused on Tuesday (cancel and move)", async () => {
  const google = realDay([conference]);
  for (const [tool, extra] of [[cancelEventTool, {}], [moveEventTool, { newTime: "10:00" }]]) {
    assert.equal(refusal(await tool({ date: WED, title: "conference", ...extra }, ctxOf(google))), "I don't see that on your calendar for Wednesday, October 28th.");
    assert.equal(refusal(await tool({ date: WED, time: "09:00", ...extra }, ctxOf(google))), "I don't see that on your calendar for Wednesday, October 28th.", "a time never matches an event that began on an earlier day");
    assert.equal(refusal(await tool({ date: "2026-10-27", title: "conference", ...extra }, ctxOf(google))), MULTI("Mortgage Conference"));
  }
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent], [[], []]);
});

test("F1: an all-day event from Tuesday to Friday is not found on Wednesday, and is refused on Tuesday (cancel and move)", async () => {
  const google = realDay([vacation]);
  for (const [tool, extra] of [[cancelEventTool, {}], [moveEventTool, { newTime: "10:00" }]]) {
    assert.equal(refusal(await tool({ date: WED, title: "vacation", ...extra }, ctxOf(google))), "I don't see that on your calendar for Wednesday, October 28th.");
    assert.equal(refusal(await tool({ date: "today", title: "vacation", ...extra }, ctxOf(google))), MULTI("Vacation"), "more than one day comes before the all-day move line");
  }
});

test("F1: a timed event of exactly 24 hours is refused; a one-day all-day event can still be cancelled", async () => {
  const google = realDay([fullDay, oneDayOff]);
  assert.equal(refusal(await cancelEventTool({ date: WED, title: "open house" }, ctxOf(google))), MULTI("Open house"));
  assert.equal(refusal(await moveEventTool({ date: WED, time: "09:00", newTime: "10:00" }, ctxOf(google))), MULTI("Open house"));
  const r = await cancelEventTool({ date: WED, title: "day off" }, ctxOf(google));
  assert.equal(r.sideEffect.event.id, "dayoff001");
});

test("F1: the more-than-one-day line comes after guests and repeating, and before already started", async () => {
  const google = realDay([
    { ...conference, id: "confguest1", summary: "Conference with guests", attendees: [{ self: true }, {}] },
    { ...conference, id: "confrepeat", summary: "Conference repeating", recurringEventId: "series12345" },
    { ...conference, id: "confstart1", summary: "Conference started", start: { dateTime: "2026-10-27T07:00:00-07:00" } },
  ]);
  assert.match(refusal(await cancelEventTool({ date: "today", title: "guests" }, ctxOf(google))), /has guests/);
  assert.match(refusal(await cancelEventTool({ date: "today", title: "repeating" }, ctxOf(google))), /is a repeating event/);
  assert.equal(refusal(await cancelEventTool({ date: "today", title: "started" }, ctxOf(google))), MULTI("Conference started"));
});

test("F1: an 11 PM to 1 AM event is an ordinary event on the day it starts: cancel and move are packaged, the read-back names that day", async () => {
  const { cancelReadBack, moveReadBack } = require("../lib/assistant/calendarChange");
  const google = realDay([lateCall]);
  const c = await cancelEventTool({ date: WED, title: "late call" }, ctxOf(google));
  assert.deepStrictEqual(c.sideEffect.event, {
    id: "latecall1", etag: '"e7"', title: "Late call with Kim", date: WED, time: "23:00", allDay: false,
    startAt: Date.parse("2026-10-28T23:00:00-07:00"), timeZone: PHX, durationMinutes: 120,
  });
  assert.equal(cancelReadBack("Just to confirm —", c.sideEffect.event), 'Just to confirm — cancel "Late call with Kim" on Wednesday, October 28th at 11:00 PM Mountain Standard Time?');
  const m = await moveEventTool({ date: WED, time: "23:00", newTime: "22:00" }, ctxOf(google));
  assert.equal(m.sideEffect.event.date, WED);
  assert.equal(m.sideEffect.event.durationMinutes, 120);
  assert.equal(moveReadBack("Just to confirm —", m.sideEffect.event), 'Just to confirm — move "Late call with Kim" from Wednesday, October 28th at 11:00 PM to Wednesday, October 28th at 10:00 PM Mountain Standard Time?');
  // asked for Thursday, the day it ends on, it is not there
  assert.equal(refusal(await cancelEventTool({ date: "2026-10-29", title: "late call" }, ctxOf(google))), "I don't see that on your calendar for Thursday, October 29th.");
});

// ── title matching in two passes (fix wave F4) ───────────────────────────────
test("F4: function words are ignored, then (only if nothing fit) generic words; a name is enough against Charlie's own 'Call Dave'", async () => {
  const { findMatches } = require("../lib/assistant/calendarChange");
  const callDave = ev("Call Dave", WED, 15);
  const titles = (said, day) => findMatches(day, { title: said }).map((e) => e.title);
  for (const said of ["call with Dave", "the Dave call", "Dave's call", "my meeting with Dave", "Dave", "call Dave", "the call with Dave"]) {
    assert.deepStrictEqual(titles(said, [callDave]), ["Call Dave"], said);
  }
  const lunch = ev("Lunch with Dave", WED, 12);
  assert.deepStrictEqual(titles("the Dave call", [lunch, callDave]), ["Call Dave"], "pass 1 fits one");
  assert.deepStrictEqual(titles("Dave", [lunch, callDave]), ["Lunch with Dave", "Call Dave"], "both fit: the which-one line");
  assert.deepStrictEqual(titles("my meeting with Dave", [lunch, callDave]), ["Lunch with Dave", "Call Dave"], "pass 2 fits both");
  assert.deepStrictEqual(titles("team meeting", [ev("Team meeting", WED, 9), ev("Team lunch", WED, 13)]), ["Team meeting"]);
  assert.deepStrictEqual(titles("the follow-up with Pat", [ev("Pat review", WED, 9)]), ["Pat review"], "follow up is generic");
  assert.deepStrictEqual(titles("the", [ev("Meet the Chens", WED, 9), ev("Lunch", WED, 13)]), ["Meet the Chens"], "nothing left: the words as given");
  assert.deepStrictEqual(titles("the call", [ev("Call Dave", WED, 9), ev("Lunch", WED, 13)]), ["Call Dave"]);
  assert.deepStrictEqual(titles("the meeting", [ev("Lunch", WED, 13)]), [], "generic words alone are kept: no event fits");
  assert.deepStrictEqual(titles("Dave Ray", [callDave]), [], "every remaining word must appear");
  // through the tool: the not-found line the reviewer met is gone; a time given must still match
  const google = fakeGoogle({ days: { [WED]: [callDave, lunch] } });
  assert.equal((await cancelEventTool({ date: WED, title: "call with Dave" }, ctxOf(google))).sideEffect.event.title, "Call Dave");
  assert.match(refusal(await cancelEventTool({ date: WED, title: "Dave" }, ctxOf(google))), /^I see more than one that fits on Wednesday, October 28th: "Call Dave" at 3:00 PM, "Lunch with Dave" at 12:00 PM\. Which one\?$|^I see more than one that fits on Wednesday, October 28th: "Lunch with Dave" at 12:00 PM, "Call Dave" at 3:00 PM\. Which one\?$/);
  assert.match(refusal(await cancelEventTool({ date: WED, title: "call with Dave", time: "16:00" }, ctxOf(google))), /^I don't see that/);
});

"use strict";
// Cancelling and moving a calendar event through the orchestrator (lib/assistant/orchestrator.js) with a scripted fake model and a
// scripted Google: the tools only package the change; the read-back, the reasons she won't, and every word about the change are
// code's; the model never sees an event id, an etag, a guest or an organizer; and the model can never say an event was cancelled
// or moved. NO test here touches the network. All names are made up.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-cal-change-orch-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { TOOL_SCHEMA } = require("../lib/assistant/tools");
const {
  CHARLI_SYSTEM, NOTHING_CHANGED, BOOKING_ASK, EVENT_CHANGE_UNSUPPORTED, GOOGLE_RECONNECT, GOOGLE_NOT_CONNECTED, CHANGE_CHANGED, ALREADY_OFF, COULD_NOT_CHANGE,
} = require("../lib/assistant/prompt");
const { runTurn, claimsEventChange, forModel, isActionRequest } = require("../lib/assistant/orchestrator");

const PHX = "America/Phoenix";
const TUE = Date.UTC(2026, 9, 27, 15, 0);        // Tuesday 2026-10-27, 08:00 in Phoenix
const WED = "2026-10-28";
const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Premier')").run().lastInsertRowid);
const brokerId = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, 'broker', 'B', 'User', 'b@m.co', '123456')").run(orgId).lastInsertRowid);
const baseCtx = { user: { id: brokerId, role: "broker", org_id: orgId }, rates: { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" }, db };

function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const next = script[calls.length - 1];
        if (next === undefined) throw new Error("fake client: script exhausted at call " + calls.length);
        return typeof next === "function" ? next(params) : next;
      },
    },
  };
}
const resp = (content, stop_reason) => ({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } });
const say = (t) => resp([{ type: "text", text: t }], "end_turn");
const useTool = (name, input = {}, id = "toolu_1") => resp([{ type: "tool_use", id, name, input }], "tool_use");
const userSays = (t) => [{ role: "user", content: t }];

const at = (hh, mm = 0) => Date.UTC(2026, 9, 28, hh + 7, mm);   // 2026-10-28 on a Phoenix clock
const SECRET_ID = "secretEventId99";
const SECRET_ETAG = '"secret-etag-77"';
const label = (hh, mm = 0) => `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
function ev(title, hh, mm, minutes, over = {}) {
  const end = new Date(at(hh, mm) + minutes * 60_000 - 7 * 3_600_000);
  return {
    id: `evt${Math.random().toString(36).slice(2, 10)}`, etag: `"e${Math.random().toString(36).slice(2, 8)}"`, title, start: label(hh, mm), end: label(end.getUTCHours(), end.getUTCMinutes()),
    allDay: false, startAt: at(hh, mm), endAt: at(hh, mm) + minutes * 60_000, startDate: null, guests: false, repeats: false, mine: true, ...over,
  };
}
const SAM = ev("Walkthrough with Sam", 10, 0, 30, { id: SECRET_ID, etag: SECRET_ETAG });
function fakeGoogle({ connection = { timeZone: PHX, googleEmail: "ann@gmail.example" }, events = [SAM], listed } = {}) {
  const asked = { listDayDetailed: [], deleteEvent: [], patchEvent: [], insertEvent: [], listDay: [] };
  return {
    asked,
    connection: () => connection,
    listDay: async (q) => { asked.listDay.push(q.date); return { events: events.map(({ title, start, end, allDay }) => ({ title, start, end, allDay })) }; },
    listDayDetailed: async (q) => { asked.listDayDetailed.push(q.date); return listed ? listed(q) : { events: q.date === WED ? events : [] }; },
    deleteEvent: async (c) => { asked.deleteEvent.push(c); return { done: true }; },
    patchEvent: async (c) => { asked.patchEvent.push(c); return { done: true }; },
    insertEvent: async (e) => { asked.insertEvent.push(e); return { eventId: "never" }; },
  };
}
const ctxOf = (google) => ({ ...baseCtx, google, now: TUE });
const turn = (text, script, google = fakeGoogle()) => {
  const client = fakeClient(script);
  return runTurn({ messages: userSays(text), ctx: ctxOf(google), client }).then((r) => ({ r, client, google }));
};

// ── the confirm flow's front half ────────────────────────────────────────────

test("cancel: the tool ends the turn with the code-written read-back, the card rows and a cancelEvent sideEffect; nothing is cancelled", async () => {
  const { r, client, google } = await turn("cancel my 10 AM walkthrough tomorrow", [useTool("cancelEventTool", { date: "tomorrow", time: "10:00" })]);
  assert.equal(r.reply, 'Just to confirm — cancel "Walkthrough with Sam" on Wednesday, October 28th at 10:00 AM Mountain Standard Time?');
  assert.deepStrictEqual(r.details, [
    { label: "Change", value: "Cancel this event" },
    { label: "Event", value: "Walkthrough with Sam" },
    { label: "When", value: "Wednesday, October 28th, 10:00 AM – 10:30 AM Mountain Standard Time" },
    { label: "Guests", value: "None — nobody is emailed" },
  ]);
  assert.deepStrictEqual(r.sideEffect, {
    type: "cancelEvent",
    event: { id: SECRET_ID, etag: SECRET_ETAG, title: "Walkthrough with Sam", date: WED, time: "10:00", allDay: false, startAt: at(10), timeZone: PHX, durationMinutes: 30 },
  });
  assert.deepStrictEqual(r.sources, [], "(unsaved) is not a citation");
  assert.equal(client.calls.length, 1, "short-circuits: no narration call");
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent], [[], []], "the orchestrator never changes the calendar");
});

test("cancel, all day: its own read-back and rows", async () => {
  const trip = ev("Out of town", 0, 0, 0, { allDay: true, start: null, end: null, startAt: null, endAt: null, startDate: WED });
  const { r } = await turn("cancel my out of town block tomorrow", [useTool("cancelEventTool", { date: "tomorrow", title: "out of town" })], fakeGoogle({ events: [trip] }));
  assert.equal(r.reply, 'Just to confirm — cancel "Out of town", all day on Wednesday, October 28th?');
  assert.deepStrictEqual(r.details, [
    { label: "Change", value: "Cancel this event" },
    { label: "Event", value: "Out of town" },
    { label: "When", value: "Wednesday, October 28th, all day" },
    { label: "Guests", value: "None — nobody is emailed" },
  ]);
});

test("move: the read-back names the old and the new time; the card shows both; an overlap adds the heads-up", async () => {
  const lunch = ev("Lunch with Pat", 14, 0, 60);
  const { r, google } = await turn(
    "move my 10 AM walkthrough tomorrow to 2:30",
    [useTool("moveEventTool", { date: "tomorrow", time: "10:00", newTime: "14:30" })],
    fakeGoogle({ events: [SAM, lunch] })
  );
  assert.equal(
    r.reply,
    'Just to confirm — move "Walkthrough with Sam" from Wednesday, October 28th at 10:00 AM to Wednesday, October 28th at 2:30 PM Mountain Standard Time? Heads up: that overlaps "Lunch with Pat" at 2:00 PM.'
  );
  assert.deepStrictEqual(r.details, [
    { label: "Change", value: "Move this event" },
    { label: "Event", value: "Walkthrough with Sam" },
    { label: "Now", value: "Wednesday, October 28th, 10:00 AM – 10:30 AM Mountain Standard Time" },
    { label: "Moves to", value: "Wednesday, October 28th, 2:30 PM – 3:00 PM Mountain Standard Time" },
    { label: "Overlaps", value: '"Lunch with Pat" at 2:00 PM' },
    { label: "Guests", value: "None — nobody is emailed" },
  ]);
  assert.deepStrictEqual(r.sideEffect.event, {
    id: SAM.id, etag: SAM.etag, title: "Walkthrough with Sam", date: WED, time: "10:00", startAt: at(10), newDate: WED, newTime: "14:30", durationMinutes: 30, timeZone: PHX,
  });
  assert.deepStrictEqual([google.asked.deleteEvent, google.asked.patchEvent], [[], []]);
  // no overlap: no heads-up, no row
  const clear = await turn("move my 10 AM walkthrough tomorrow to 4", [useTool("moveEventTool", { date: "tomorrow", time: "10:00", newTime: "16:00" })]);
  assert.equal(clear.r.reply, 'Just to confirm — move "Walkthrough with Sam" from Wednesday, October 28th at 10:00 AM to Wednesday, October 28th at 4:00 PM Mountain Standard Time?');
  assert.ok(!clear.r.details.some((d) => d.label === "Overlaps"));
});

test("the reasons she won't, not-found and which-one are code's words, said as they are, with no second model call", async () => {
  const guests = ev("Lunch with Pat", 12, 0, 30, { guests: true });
  const one = [useTool("cancelEventTool", { date: "tomorrow", title: "lunch" })];
  let { r, client } = await turn("cancel my lunch with Pat tomorrow", one, fakeGoogle({ events: [guests] }));
  assert.equal(r.reply, '"Lunch with Pat" has guests, and I never email guests. Open Google Calendar to change it so they\'re told.');
  assert.equal(client.calls.length, 1);
  assert.equal(r.sideEffect, undefined);
  ({ r } = await turn("cancel my dentist tomorrow", [useTool("cancelEventTool", { date: "tomorrow", title: "dentist" })]));
  assert.equal(r.reply, "I don't see that on your calendar for Wednesday, October 28th.");
  ({ r } = await turn("push my call tomorrow to 5", [useTool("moveEventTool", { date: "tomorrow", title: "call", newTime: "17:00" })], fakeGoogle({ events: [ev("Call Pat", 9, 0, 30), ev("Call Ray", 11, 0, 30)] })));
  assert.equal(r.reply, 'I see more than one that fits on Wednesday, October 28th: "Call Pat" at 9:00 AM, "Call Ray" at 11:00 AM. Which one?');
  ({ r } = await turn("move my 10 to 10", [useTool("moveEventTool", { date: "tomorrow", time: "10:00", newTime: "10:00" })]));
  assert.equal(r.reply, '"Walkthrough with Sam" is already at that time.');
});

test("Google not connected or expired is the same Google line a booking gets", async () => {
  let { r } = await turn("cancel my 10 AM tomorrow", [useTool("cancelEventTool", { date: "tomorrow", time: "10:00" })], fakeGoogle({ connection: { code: "not_connected" } }));
  assert.equal(r.reply, GOOGLE_NOT_CONNECTED);
  ({ r } = await turn("move my 10 AM tomorrow to 11", [useTool("moveEventTool", { date: "tomorrow", time: "10:00", newTime: "11:00" })], fakeGoogle({ listed: async () => ({ code: "reconnect" }) })));
  assert.equal(r.reply, GOOGLE_RECONNECT);
});

test("input the tool refuses goes back to the model to ask for what is missing, like a booking", async () => {
  const client = fakeClient([useTool("moveEventTool", { date: "tomorrow", time: "10:00" }), say("What time should I move it to?")]);
  const r = await runTurn({ messages: userSays("move my 10 AM tomorrow"), ctx: ctxOf(fakeGoogle()), client });
  assert.equal(r.reply, "What time should I move it to?");
  assert.equal(r.sideEffect, undefined);
});

// ── what the model is shown ──────────────────────────────────────────────────

test("the model never receives an event id, an etag, a guest list or an organizer: every request it is sent is searched", async () => {
  const guests = ev("Lunch with Pat", 12, 0, 30, { guests: true });
  const scenarios = [
    ["cancel my 10 AM tomorrow", [useTool("cancelEventTool", { date: "tomorrow", time: "10:00" })]],
    ["move my 10 AM tomorrow", [useTool("moveEventTool", { date: "tomorrow", time: "10:00" }), say("What time should I move it to?")]],
    ["cancel my lunch tomorrow", [useTool("cancelEventTool", { date: "tomorrow", title: "lunch" })]],
    ["cancel my 10 tomorrow", [useTool("getCalendarTool", { date: "tomorrow" }), useTool("cancelEventTool", { date: "tomorrow", time: "10:00" })]],
  ];
  for (const [text, script] of scenarios) {
    const { client } = await turn(text, script, fakeGoogle({ events: [SAM, guests] }));
    const sent = JSON.stringify(client.calls);
    for (const secret of [SECRET_ID, "secret-etag", "ann@gmail.example", "etag", "attendee", "organizer", guests.id]) {
      assert.ok(!sent.includes(secret), `${secret} reached the model in: ${text}`);
    }
  }
  // the model-facing shape of the two tools' results is never the code line or the packaged data
  const refusal = { error: "x", code: "calendar_change", line: "a line with a Title" };
  assert.deepStrictEqual(forModel("cancelEventTool", refusal), { error: "x", code: "calendar_change" });
  assert.deepStrictEqual(forModel("moveEventTool", refusal), { error: "x", code: "calendar_change" });
  assert.deepStrictEqual(forModel("createEventTool", refusal), refusal, "other tools are as they were");
});

test("the system prompt tells the model about the two tools; the model-facing description never offers an id", () => {
  assert.match(CHARLI_SYSTEM, /cancelEventTool/);
  assert.match(CHARLI_SYSTEM, /moveEventTool/);
  assert.match(CHARLI_SYSTEM, /never say an event was cancelled or moved/i);
  assert.ok(TOOL_SCHEMA.find((t) => t.name === "cancelEventTool"));
});

// ── asked to cancel or move: an action turn; the model cannot claim it ───────

test("asked to cancel or move, the request is an action turn", () => {
  for (const text of [
    "Cancel my call with David Nave", "cancel the Dave call tomorrow", "Can you move my 3 PM to 4?", "Reschedule the Dave call to Friday",
    "Delete the Zoom meeting tomorrow", "please push my call with Dave back an hour", "I need to cancel my 3:00 appointment",
    "change my meeting with the Chens to Friday", "remove the out of office block tomorrow",
  ]) assert.equal(isActionRequest(text), true, text);
  for (const text of ["Did Dave cancel the meeting?", "Dave canceled our call, can you log it?", "what's on my calendar tomorrow?", "when did I move the call?"]) {
    // (the middle one is an action turn for its own reason: "log it")
    if (text.startsWith("Dave")) continue;
    assert.equal(isActionRequest(text), false, text);
  }
});

test("on a cancel or move request, text that is not ONE question is held, and a claim the model makes is false by construction", async () => {
  for (const userText of ["Cancel my call with David Nave", "Can you move my 3 PM to 4?", "Reschedule the Dave call to Friday"]) {
    for (const said of [
      "Done — I've cancelled your 3:00 PM call with David Nave.",
      "I can't cancel events — you'll need to do that in Google Calendar.",
      "I moved it to 4:00 PM.",
      "Your 3 PM is now off your calendar.",
      "Sure thing. Which call?",
    ]) {
      const { r } = await turn(userText, [say(said)]);
      assert.ok([NOTHING_CHANGED, BOOKING_ASK].includes(r.reply), `${userText} / ${said} -> ${r.reply}`);
      assert.equal(r.sideEffect, undefined);
    }
    assert.equal((await turn(userText, [say("Which day is it on?")])).r.reply, "Which day is it on?", "one question stands");
  }
});

test("claimsEventChange: first person, passive and 'off your calendar' claims are caught; questions, offers and negations are not", () => {
  for (const claim of [
    "I've cancelled your 3 PM.", "I canceled the call with Dave.", "Cancelled.", "Done — rescheduled.", "I moved your 3 PM call to 4.", "I have moved the meeting to Friday.",
    "Your 3 PM call is cancelled.", "The meeting has been rescheduled to 4:00 PM.", "The call was moved to Friday.", "It's now off your calendar.",
    "That's off your calendar.", "I took it off your calendar.", "I removed the meeting from your calendar.", "Consider it cancelled.", "It's cancelled now.",
    "I went ahead and canceled it.", "Your 3:00 PM is no longer on your calendar.", "I've pushed your 3 PM to 4.", "All set — the call is moved to 4.",
  ]) assert.equal(claimsEventChange(claim), true, claim);
  for (const fine of [
    "Which call should I cancel?", "Want me to move your 3 PM to 4?", "Should I take it off your calendar?", "I can cancel it for you once you confirm.",
    "I haven't cancelled anything.", "Nothing has been moved.", "It hasn't been rescheduled.", "I didn't move it.", "I have not cancelled the call.",
    "You have a call with Dave at 3:00 PM.", "I moved on to the next client.", "Moving on, you have two calls today.", "What time should I move it to?",
  ]) assert.equal(claimsEventChange(fine), false, fine);
  // the user said it was cancelled: repeating that fact (passive) is no claim by her; her own act still is
  assert.equal(claimsEventChange("Sorry to hear the meeting was cancelled.", "Dave cancelled our meeting"), false);
  assert.equal(claimsEventChange("I've cancelled the meeting.", "Dave cancelled our meeting"), true);
});

test("a cancel/move claim on any turn is held: a calendar read, a plain question, a read-back in view", async () => {
  for (const [text, script] of [
    ["what's on my calendar tomorrow?", [useTool("getCalendarTool", { date: "tomorrow" }), say("You have Walkthrough with Sam at 10:00 AM, and I've cancelled it for you.")]],
    ["what's up", [say("Your 3 PM is off your calendar.")]],
  ]) {
    const { r } = await turn(text, script);
    assert.equal(r.reply, NOTHING_CHANGED, text);
  }
  // (fix wave F2) a passive claim on a turn with no calendar business is no longer this screen's: it is still never said as written
  // (an ungrounded calendar fact is the can't-verify line)
  const plain = await turn("hey Charlie", [say("The call was moved to Friday.")]);
  assert.notEqual(plain.r.reply, "The call was moved to Friday.");
  // after a read-back Charlie said and the user declined, the model cannot say it was cancelled either
  const client = fakeClient([say("Okay, I cancelled it.")]);
  const r = await runTurn({
    messages: [
      { role: "user", content: "cancel my 10 AM" },
      { role: "assistant", content: 'Just to confirm — cancel "Walkthrough with Sam" on Wednesday, October 28th at 10:00 AM Mountain Standard Time?' },
      { role: "user", content: "no, leave it" },
    ],
    ctx: ctxOf(fakeGoogle()), client,
  });
  assert.equal(r.reply, NOTHING_CHANGED);
});

// ── the other edits ──────────────────────────────────────────────────────────

test("any other edit of an event (rename, length, guests) is the code-written EVENT_CHANGE_UNSUPPORTED line; cancel and move are no longer that", async () => {
  assert.equal(EVENT_CHANGE_UNSUPPORTED, "I can cancel or move an event. For any other change, open Google Calendar.");
  for (const userText of ["rename my 3 PM meeting to Closing prep", "change my meeting with the Chens", "edit the Dave call", "update my 10 AM appointment", "make the zoom meeting longer", "extend my 3:00 call by an hour"]) {
    for (const said of ["I can't change events yet.", "Done — I've renamed it.", "Which meeting?"]) {
      const { r } = await turn(userText, [say(said)]);
      assert.equal(r.reply, EVENT_CHANGE_UNSUPPORTED, `${userText} / ${said}`);
    }
  }
  for (const [userText, said] of [["Did Dave cancel the meeting?", "I can't verify that from what I have, so I won't guess."], ["what's on my calendar tomorrow?", "What day did you mean?"], ["change my career stage", "How many years have you been originating?"]]) {
    assert.notEqual((await turn(userText, [say(said)])).r.reply, EVENT_CHANGE_UNSUPPORTED, userText);
  }
  for (const userText of ["cancel my 3 PM", "move my 3 PM to 4", "reschedule the Dave call to Friday"]) {
    assert.notEqual((await turn(userText, [say("Which day is it on?")])).r.reply, EVENT_CHANGE_UNSUPPORTED, userText);
  }
});

test("the three fixed change lines are exactly the spec's words", () => {
  assert.equal(CHANGE_CHANGED, "That event changed after I read it to you, so I left it alone. Ask me again.");
  assert.equal(ALREADY_OFF, "That event is already off your calendar.");
  assert.equal(COULD_NOT_CHANGE, "Google Calendar couldn't make that change. Nothing was changed.");
});

// ── fix wave F2 / F5: the claim screen is scoped to calendar-change business; requests without an event noun ──

// Sentences from client stories and rate news that say cancelled / moved / pushed / removed of something that is no event. On a turn
// with no calendar business (no change asked for, no calendar tool called) none of them is a claim.
const NOT_CALENDAR_SENTENCES = [
  "Their purchase contract was cancelled last month, so they may be ready to shop again.",
  "The Okafors' closing was moved to December twelfth.",
  "Their closing got pushed back a week, so check the rate lock.",
  "Rates were pushed higher by the jobs report, and that hurts the Chens.",
  "Grace's appraisal was cancelled and needs to be reordered.",
  "Once that's removed, his payment drops.",
  "PMI is removed at seventy-eight percent LTV, which saves them money.",
  "Their refinance was cancelled because the appraisal came in low.",
  "That deal got cancelled, but the Chens are still a good call.",
  "Last week's Fed meeting was rescheduled, so watch for news.",
  "Any client whose lock was cancelled can relock now.",
  "Since their purchase contract was cancelled, tell them their preapproval is still good.",
  "I've moved the Okafors to the top of your call list because their rate is highest.",
];

test("F2: on a turn with no calendar business, ordinary sentences about cancelled or moved things are not held", () => {
  for (const s of NOT_CALENDAR_SENTENCES) assert.equal(claimsEventChange(s, "what should I tell the Patels?", false), false, s);
});

test("F2: end to end, a grounded or plain reply about a cancelled lock or a rescheduled Fed meeting reaches the broker as said", async () => {
  for (const said of [
    "The thirty-year is at 6.52 percent. Last week's Fed meeting was rescheduled, so watch for news.",
    "The thirty-year is at 6.52 percent. Any client whose lock was cancelled can relock now.",
  ]) {
    const { r } = await turn("how are rates today?", [useTool("getMarketUpdate", {}), say(said)]);
    assert.equal(r.reply, said);
  }
  const plain = "Since their purchase contract was cancelled, tell them their preapproval is still good.";
  assert.equal((await turn("what should I tell the Patels?", [say(plain)])).r.reply, plain);
});

test("F2: a first-person claim with an event word, a clock time, a day word or 'calendar', and any 'off your calendar', is held on every turn", async () => {
  for (const s of [
    "I've cancelled your 3 PM.", "I moved the call with Dave to Friday.", "I rescheduled Dave for tomorrow.", "I took the walkthrough off for you.",
    "I dropped the Chens from tomorrow.", "I've removed it from your calendar.", "Your 3 PM is off your calendar.",
  ]) assert.equal(claimsEventChange(s, "how are rates today?", false), true, s);
  for (const said of ["The thirty-year is at 6.52 percent. I've cancelled your 3 PM call.", "The thirty-year is at 6.52 percent. Your 3 PM is off your calendar."]) {
    assert.equal((await turn("how are rates today?", [useTool("getMarketUpdate", {}), say(said)])).r.reply, NOTHING_CHANGED, said);
  }
});

test("F2: the pronoun-only and passive branches are off outside calendar business, and on inside it", () => {
  for (const s of ["I cancelled it.", "It's cancelled now.", "Consider it cancelled.", "Cancelled.", "The call was moved to Friday.", "Your 3 PM call is cancelled."]) {
    assert.equal(claimsEventChange(s, "how are rates today?", false), false, `off: ${s}`);
    assert.equal(claimsEventChange(s, "cancel Dave tomorrow", true), true, `on: ${s}`);
  }
  // inside calendar business the passive still needs an event word, a clock time or a pronoun: a closing is no event word
  assert.equal(claimsEventChange("Their refinance was cancelled because the appraisal came in low.", "cancel Dave tomorrow", true), false);
  assert.equal(claimsEventChange("The Okafors' closing was moved to December twelfth.", "cancel Dave tomorrow", true), false);
});

test("F2: a calendar tool called this turn makes it calendar business: a passive claim after a calendar read is held", async () => {
  const { r } = await turn("what's on my calendar tomorrow?", [useTool("getCalendarTool", { date: "tomorrow" }), say("Your walkthrough with Sam was moved to Friday.")]);
  assert.equal(r.reply, NOTHING_CHANGED);
});

test("F5: a cancel / move / reschedule / push / bump / drop verb leading a clause, with a day word or a clock time, is a change request", () => {
  for (const text of [
    "cancel Dave tomorrow", "push Dave back to Friday", "drop the Chens tomorrow", "move my 3 PM to 4", "can you cancel Dave tomorrow?",
    "please bump Pat to Thursday", "I need to reschedule Kim to next week", "let's move the Okafors to 3:30", "could you push the Patels to October 30th",
    "hey Charlie, cancel Sam today", "move Dave to 4",
  ]) assert.equal(isActionRequest(text), true, text);
  for (const text of [
    "should I move the Okafors to a 15-year?", "move on to the next client", "cancel that", "can we drop the rate for the Chens?",
    "push them toward a refinance this week", "drop off the docs tomorrow", "push the Chens' rate lock to Friday", "Did Dave cancel tomorrow?",
    "drop the rate to 6 for the Okafors tomorrow", "move the Patels to a thirty-year loan tomorrow",
  ]) assert.equal(isActionRequest(text), false, text);
});

test("F5: 'is off', 'is now at / on', 'has been dropped', 'taken ... off', 'is gone' are claims on a calendar-change turn", () => {
  for (const s of [
    "The meeting with Dave is off.", "Done — the call is off.", "Your 3 PM has been dropped.", "Dave's call is now at 4 PM.", "I have taken the call off.",
    "The call with Dave is now on Friday.", "Your 3 PM is gone.", "Okay, Dave is now on Friday at ten.",
  ]) assert.equal(claimsEventChange(s, "cancel Dave tomorrow", true), true, s);
  for (const s of ["Is the call with Dave off?", "The call with Dave is not off.", "Your rate is now at 6.5 percent."]) {
    assert.equal(claimsEventChange(s, "cancel Dave tomorrow", true), false, s);
  }
});

test("F5: end to end, the three false claims after a request with no event noun are held", async () => {
  for (const [userText, said] of [
    ["cancel Dave tomorrow", "Got it, Dave's off tomorrow."],
    ["push Dave back to Friday", "Okay, Dave is now on Friday at ten."],
    ["drop the Chens tomorrow", "I dropped the Chens from tomorrow."],
  ]) {
    const { r } = await turn(userText, [say(said)]);
    assert.ok([NOTHING_CHANGED, BOOKING_ASK].includes(r.reply), `${userText} / ${said} -> ${r.reply}`);
  }
});

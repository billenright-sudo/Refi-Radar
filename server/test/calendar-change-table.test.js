"use strict";
// THE TABLE (fix list 3): every row ever ruled for the calendar cancel/move request detector, the claim screen and the spoken answer
// to a cancel or move read-back, from fix lists 1, 2 and 3 and the three review reports' probe tables, in one place. When two rows
// from different lists conflicted, the later list won (fix-report.md, "Third pass", says which). Scattered rows elsewhere may stay;
// this file is the authority. A scripted fake model and a scripted Google: NO test here touches the network. All names are made up.
//
// The order of harm that decided every doubt (fix list 3):
//   1. an ordinary answer swallowed by "I haven't made that change" on a turn that asked for no calendar change: worst;
//   2. a false "it's cancelled / moved" after a request in a listed request family: must be held;
//   3. an unusual paraphrase after an unusual request: a known gap, written down in the report, not chased.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-cal-change-table-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { NOTHING_CHANGED, BOOKING_ASK } = require("../lib/assistant/prompt");
const { runTurn, claimsEventChange, calendarChangeBusiness, isActionRequest, isEventChangeRequest } = require("../lib/assistant/orchestrator");

// Every row is checked and every failing row is listed, not only the first.
function rows(run) {
  const failed = [];
  run((ok, label) => { if (!ok) failed.push(label); });
  assert.deepStrictEqual(failed, [], `${failed.length} row(s) failed: ${failed.join(" || ")}`);
}

const PHX = "America/Phoenix";
const TUE = Date.UTC(2026, 9, 27, 15, 0);   // Tuesday 2026-10-27, 08:00 in Phoenix; "tomorrow" is Wednesday 2026-10-28
const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Premier')").run().lastInsertRowid);
const brokerId = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, 'broker', 'B', 'User', 'b@m.co', '123456')").run(orgId).lastInsertRowid);
db.prepare("INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score) VALUES (?, ?, 'Amy Chen', '30yr_fixed', 7.5, 400000, 600000, 700)").run(orgId, brokerId);
const baseCtx = { user: { id: brokerId, role: "broker", org_id: orgId }, rates: { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" }, db, now: TUE };

const resp = (content, stop_reason) => ({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } });
const say = (t) => resp([{ type: "text", text: t }], "end_turn");
const useTool = (name, input = {}) => resp([{ type: "tool_use", id: "toolu_1", name, input }], "tool_use");
const fakeClient = (script) => {
  let n = 0;
  return { messages: { create: async () => { const next = script[n++]; if (!next) throw new Error("script exhausted"); return next; } } };
};
// a calendar read of tomorrow: Call Dave at 3:00 PM and the Chen call at 4:00 PM
const READ_EVENTS = [
  { title: "Call Dave", start: "3:00 PM", end: "3:30 PM", allDay: false, endAt: Date.UTC(2026, 9, 28, 22, 30) },
  { title: "Chen call", start: "4:00 PM", end: "4:30 PM", allDay: false, endAt: Date.UTC(2026, 9, 28, 23, 30) },
];
const google = { connection: () => ({ timeZone: PHX, googleEmail: "ann@gmail.example" }), listDay: async () => ({ events: READ_EVENTS }), insertEvent: async () => ({ eventId: "never" }) };

const CANCEL_READ_BACK = 'Just to confirm — cancel "Walkthrough with Sam" on Wednesday, October 28th at 10:00 AM Mountain Standard Time?';
const MOVE_READ_BACK = 'Just to confirm — move "Walkthrough with Sam" from Wednesday, October 28th at 10:00 AM to Wednesday, October 28th at 2:30 PM Mountain Standard Time?';
const ADD_READ_BACK = "Just to confirm — add the Chens as a new client?";

// How the model answers in an end-to-end row: text only, or after one read tool.
const SETUPS = {
  text: (said) => [say(said)],
  market: (said) => [useTool("getMarketUpdate", {}), say(said)],
  client: (said) => [useTool("findClient", { query: "chen" }), say(said)],
  read: (said) => [useTool("getCalendarTool", { date: "tomorrow" }), say(said)],
};
async function endToEnd({ user, setup = "text", history = [], said }) {
  const messages = [...history, { role: "user", content: user }];
  const out = await runTurn({ messages, ctx: { ...baseCtx, google }, client: fakeClient(SETUPS[setup](said)) });
  return out.reply;
}

// ═══ 1. The request detector ══════════════════════════════════════════════════
// COUNT: isEventChangeRequest is true (so the turn is an action turn and a change turn).
const REQUEST_COUNT = [
  // fix list 1 (F5, and the builder's own rows)
  "cancel Dave tomorrow", "push Dave back to Friday", "drop the Chens tomorrow", "move my 3 PM to 4", "can you cancel Dave tomorrow?",
  "please bump Pat to Thursday", "I need to reschedule Kim to next week", "let's move the Okafors to 3:30", "could you push the Patels to October 30th",
  "hey Charlie, cancel Sam today", "move Dave to 4",
  "Cancel my call with David Nave", "cancel the Dave call tomorrow", "Can you move my 3 PM to 4?", "Reschedule the Dave call to Friday",
  "Delete the Zoom meeting tomorrow", "please push my call with Dave back an hour", "I need to cancel my 3:00 appointment",
  "change my meeting with the Chens to Friday", "remove the out of office block tomorrow",
  // fix list 2 (G2), with the accepted "push the Okafors to 6 tomorrow"
  "cancel everything tomorrow", "push Dave back", "move Dave to Friday at ten", "reschedule Dave to Friday", "can you push the Okafors to 6 tomorrow?",
  // fix list 3
  "cancel Friday's walkthrough", "cancel Thursday's walkthrough with Sam", "cancel tomorrow's thing with Dave", "cancel my 3 PM",
  "reschedule Friday's walkthrough", "push Dave back an hour",
  // fix list 3: the added event nouns
  "cancel the coffee with Pat", "move the demo to Friday", "push the interview to 4 PM", "cancel my lunch with Kim", "move the showing to Thursday",
  "reschedule the check-in with Ray", "cancel the walk-through", "move the dinner with the Chens to Saturday",
  // the review reports' probe rows judged right as requests
  "move the Okafors call to tomorrow at 3", "please push my 3:30 to 4", "cancel the call with Dave", "delete the event", "move my closing to Friday",
  "remove the block on Friday", "clear my calendar for Friday", "update the meeting to Friday", "change my 3 PM to 4",
  "cancel my call with the Chens about their loan tomorrow", "move the Okafor refinance call to Friday", "cancel the rate review meeting at 3",
  "push the lock call with the Chens to 4", "move Dave from 3 to 4", "reschedule Dave for next week", "cancel the Thursday thing with Sam",
  "move the Thursday thing with Sam to Friday",
];
// NOT: isActionRequest is false (not a request of any kind, so the answer is a plain turn).
const REQUEST_NOT = [
  // fix list 1
  "should I move the Okafors to a 15-year?", "move on to the next client", "cancel that", "can we drop the rate for the Chens?",
  "push them toward a refinance this week", "drop off the docs tomorrow", "push the Chens' rate lock to Friday", "Did Dave cancel tomorrow?",
  "drop the rate to 6 for the Okafors tomorrow", "move the Patels to a thirty-year loan tomorrow",
  "Did Dave cancel the meeting?", "what's on my calendar tomorrow?", "when did I move the call?",
  "What if I move the closing to Friday?", "My client wants to move their closing to December — what happens to the lock?", "I'll cancel the meeting myself",
  // fix list 2 (G2)
  "can you push the Chens today?", "can you push Amy Chen today?", "can you move fast on the Okafors today?", "push Grace hard tomorrow",
  "Let's move quickly tomorrow", "bump Grace up today", "drop Dave a note tomorrow", "cancel that tomorrow", "move Dave tomorrow", "push Grace forward to Friday",
  // fix list 3
  "move Dave back to the top", "push Dave back to the top of the list", "move Dave back to the list",
  // the review reports' probe rows judged right as plain turns
  "Should I cancel Dave tomorrow?", "move the Chens to tomorrow's list", "push the Chens to lock today", "move the Chens up on my call list",
  // accepted gap (re-review 1, Minor 4): a loan word vetoes a request with no event noun
  "cancel Dave's rate review tomorrow", "move the loan review with Dave to Friday", "push Dave's payment talk to Friday",
];

test("table 1: the request detector — every must-count row counts", () => {
  rows((check) => { for (const text of REQUEST_COUNT) check(isEventChangeRequest(text) === true, `must count: ${text}`); });
});
test("table 1: the request detector — every must-not-count row is a plain turn", () => {
  rows((check) => { for (const text of REQUEST_NOT) check(isActionRequest(text) === false, `must not count: ${text}`); });
});

// ═══ 2. The claim screen, sentence by sentence ════════════════════════════════
// Turn kinds, as calendarChangeBusiness works them out:
//   none     the user asked for no change ("how are rates today?"), no read-back before
//   change   the user asked for a change ("cancel my 3 PM tomorrow")
//   readback the user answers a cancel read-back with "no, leave it"
//   other    the user answers ANOTHER kind of read-back (G5): not a change turn
const TURNS = {
  none: { user: "how are rates today?", history: [] },
  change: { user: "cancel my 3 PM tomorrow", history: [] },
  readback: { user: "no, leave it", history: [{ role: "user", content: "cancel my 10 AM" }, { role: "assistant", content: CANCEL_READ_BACK }] },
  moveback: { user: "no", history: [{ role: "user", content: "move my 10 AM" }, { role: "assistant", content: MOVE_READ_BACK }] },
  other: { user: "no wait, what happened with their lock?", history: [{ role: "user", content: "add the Chens" }, { role: "assistant", content: ADD_READ_BACK }] },
};
const heldOn = (sentence, kind) => {
  const t = TURNS[kind];
  const messages = [...t.history, { role: "user", content: t.user }];
  return claimsEventChange(sentence, t.user, calendarChangeBusiness(messages, t.user));
};

test("table 2: the turn kinds — only a change request or a cancel / move read-back is a change turn; a calendar read never is", () => {
  const is = (kind) => { const t = TURNS[kind]; return calendarChangeBusiness([...t.history, { role: "user", content: t.user }], t.user); };
  assert.deepStrictEqual(Object.keys(TURNS).map((k) => [k, is(k)]), [["none", false], ["change", true], ["readback", true], ["moveback", true], ["other", false]]);
  assert.equal(calendarChangeBusiness([{ role: "user", content: "what's on my calendar tomorrow?" }], "what's on my calendar tomorrow?"), false);
});

// HELD on every turn: rules A (first person + cancelled / rescheduled), B (first person + a softer verb + an event word, a clock
// time or a day word), C ("off your calendar"), D (a passive change claim about the broker's OWN event).
const HELD_EVERY_TURN = [
  // A
  "I canceled Dave.", "I cancelled the Dave thing.", "I cancelled Dave.", "I've canceled the Dave thing.", "I have rescheduled Dave.", "I just cancelled it.",
  "We rescheduled Pat.", "I cancelled it.", "I've canceled it.", "I went ahead and canceled it.", "Cancelled Dave? Yes. I cancelled Dave.",
  // B
  "I've cancelled your 3 PM.", "I moved the call with Dave to Friday.", "I rescheduled Dave for tomorrow.", "I took the walkthrough off for you.",
  "I dropped the Chens from tomorrow.", "I moved your 3 PM call to 4.", "I have moved the meeting to Friday.", "I've pushed your 3 PM to 4.",
  "I have taken the call off.", "I deleted the event.", "I removed the meeting from your calendar.",
  // C
  "Your 3 PM is off your calendar.", "I've removed it from your calendar.", "It's now off your calendar.", "That's off your calendar.",
  "I took it off your calendar.", "Your 3:00 PM is no longer on your calendar.",
  // D
  "Amy Chen's call with you was moved to Friday.", "Your call with Amy Chen was cancelled.", "Your 3 PM was moved to Friday.", "Your 3 PM call is cancelled.",
  "Your walkthrough with Sam was moved to Friday.", "Your 3:30 was cancelled.", "Your next meeting was rescheduled.",
];
// PASS on a turn with no change business: ordinary client and market sentences.
const PASS_NO_CHANGE = [
  // first review, I1 (and the builder's additions)
  "Their purchase contract was cancelled last month, so they may be ready to shop again.", "The Okafors' closing was moved to December twelfth.",
  "Their closing got pushed back a week, so check the rate lock.", "Rates were pushed higher by the jobs report, and that hurts the Chens.",
  "Grace's appraisal was cancelled and needs to be reordered.", "Once that's removed, his payment drops.", "PMI is removed at seventy-eight percent LTV, which saves them money.",
  "Their refinance was cancelled because the appraisal came in low.", "That deal got cancelled, but the Chens are still a good call.",
  "Last week's Fed meeting was rescheduled, so watch for news.", "Any client whose lock was cancelled can relock now.",
  "Since their purchase contract was cancelled, tell them their preapproval is still good.",
  "I've moved the Okafors to the top of your call list because their rate is highest.",
  // first review, the probe's full list
  "The Fed meeting was rescheduled.", "Dave's PMI can be removed once he hits twenty percent equity.", "The late fee was removed from their statement.",
  "Their old loan was paid off and the lien was removed.", "We moved them up because the spread is wider now.", "Rates have shifted since then.",
  "The listing was taken off the market, so the sale is on hold.", "Cancelled.", "The Patels moved from a thirty-year to a fifteen-year last spring.",
  "Your thirty-year rate moved up to six point five two percent.", "Their escrow was shifted to the new servicer.",
  "Mortgage insurance gets removed automatically at seventy-eight percent.",
  // first re-review, fresh ordinary sentences
  "The jobs report on Friday pushed rates up, so this week is quieter.", "Their Friday closing is off, according to your notes.",
  "The deal is off, so Dave is shopping again.", "The Smiths' lock is gone, since it expired on Tuesday.", "Rates are now at six point four, the lowest since March.",
  "The Chens' payment is now at about two thousand a month.", "Grace's appointment with the appraiser was cancelled by the AMC.",
  "I've cancelled nothing; your call list is as it was.",
  // fix list 2 (G1: the softer verbs need context; G3: not the broker's own event; accepted)
  "I moved Dave.", "I pushed the Chens.", "I removed Grace.", "The appointment with the appraiser was cancelled by the AMC.", "Amy Chen's call was moved to Friday.",
  // fix list 3: a clock time elsewhere, or "your <someone>'s", is not the broker's own event
  "The Fed announcement was pushed to 2 PM.", "Their closing was moved to 10 AM Friday.", "Their rate lock was pushed to 5 PM Friday by the lender.",
  "Your client's appointment with the appraiser was cancelled by the AMC.", "Your borrower's meeting with the underwriter was rescheduled.",
  // the wordings that are held only on a change turn
  "It's cancelled now.", "Consider it cancelled.", "The call was moved to Friday.", "The meeting with Dave is off.", "Dave's call is now at 4 PM.",
  "Call Dave is set for tomorrow at 3:00 PM.", "The Chen call is now 4:00 PM on the calendar.", "The Chen call isn't happening at 3:00 PM.",
];
// HELD on a change turn (the user asked for a change, or answers a cancel / move read-back): every other wording.
const HELD_CHANGE_TURN = [
  // the builder's list
  "Cancelled.", "Done — rescheduled.", "Your 3 PM call is cancelled.", "The meeting has been rescheduled to 4:00 PM.", "The call was moved to Friday.",
  "Consider it cancelled.", "It's cancelled now.", "All set — the call is moved to 4.",
  // fix list 1 (F5)
  "The meeting with Dave is off.", "Done — the call is off.", "Your 3 PM has been dropped.", "Dave's call is now at 4 PM.", "The call with Dave is now on Friday.",
  "Your 3 PM is gone.", "Okay, Dave is now on Friday at ten.",
  // fix list 2 (G4, the re-review's Minor 2) and its additions
  "I scrapped your 3 PM.", "I've wiped tomorrow's call with Dave.", "Your 3 PM is now 4 PM.", "Dave's call is set for Friday at ten.", "Moved to Friday at ten.",
  "Dave's call: cancelled.", "Your 3 PM won't happen now.", "Dave is off your schedule.", "The call with Dave got called off.", "I killed the Friday meeting.", "Canceled.",
  // the first review's probe list (what is held)
  "Your 3 PM is no longer happening.", "Canceled — your 3 PM is clear.", "I've rescheduled the call with Dave for Friday.", "Your 3 PM was successfully canceled.",
  "Okay, I bumped it to four.", "It's moved to Friday.", "Okay, Dave's no longer on your calendar for tomorrow.",
  // fix list 3: "Friday's walkthrough has been removed."
  "Friday's walkthrough has been removed.", "Done — Thursday's walkthrough with Sam is off.",
  // ("All set, tomorrow's thing with Dave is gone." is no claim at sentence level: 'thing' is no event word. End to end it is held,
  // since its request is an action turn: see table 3. A known gap in the report.)
];
// PASS on a change turn: questions, offers, negations, and sentences about no event.
const PASS_CHANGE_TURN = [
  "Which call should I cancel?", "Want me to move your 3 PM to 4?", "Should I take it off your calendar?", "I can cancel it for you once you confirm.",
  "I haven't cancelled anything.", "Nothing has been moved.", "It hasn't been rescheduled.", "I didn't move it.", "I have not cancelled the call.",
  "You have a call with Dave at 3:00 PM.", "I moved on to the next client.", "Moving on, you have two calls today.", "What time should I move it to?",
  "Is the call with Dave off?", "The call with Dave is not off.", "Your rate is now at 6.5 percent.", "Their rate is set for the year.",
  "Their refinance was cancelled because the appraisal came in low.", "The Okafors' closing was moved to December twelfth.",
];

test("table 2: held on every turn (rules A to D), whatever the turn", () => {
  rows((check) => { for (const s of HELD_EVERY_TURN) for (const kind of Object.keys(TURNS)) check(heldOn(s, kind) === true, `held (${kind}): ${s}`); });
});
test("table 2: passes on a turn with no change business, and after another kind of read-back", () => {
  rows((check) => { for (const s of PASS_NO_CHANGE) for (const kind of ["none", "other"]) check(heldOn(s, kind) === false, `pass (${kind}): ${s}`); });
  assert.equal(heldOn("It was cancelled when the appraisal came in low.", "other"), false, "G5");
});
test("table 2: held on a change turn (a request, a cancel read-back, a move read-back)", () => {
  rows((check) => { for (const s of HELD_CHANGE_TURN) for (const kind of ["change", "readback", "moveback"]) check(heldOn(s, kind) === true, `held (${kind}): ${s}`); });
});
test("table 2: passes on a change turn", () => {
  rows((check) => { for (const s of PASS_CHANGE_TURN) check(heldOn(s, "change") === false, `pass (change): ${s}`); });
});
test("table 2: the user's own report repeated back in the passive is no claim of hers; her own act still is", () => {
  assert.equal(claimsEventChange("Sorry to hear the meeting was cancelled.", "Dave cancelled our meeting", true), false);
  assert.equal(claimsEventChange("I've cancelled the meeting.", "Dave cancelled our meeting", true), true);
});

// ═══ 3. End to end ════════════════════════════════════════════════════════════
// expected: "held" = NOTHING_CHANGED or BOOKING_ASK; "said" = the model's text reaches the broker as written; "free" = not held
// by the change screens (another screen, such as can't-verify, may still answer instead); "not-said" = anything but the text.
const E2E = [
  // held: a false claim after a request in a listed family
  { user: "cancel Dave tomorrow", said: "Got it, Dave's off tomorrow.", expect: "held" },
  { user: "push Dave back to Friday", said: "Okay, Dave is now on Friday at ten.", expect: "held" },
  { user: "drop the Chens tomorrow", said: "I dropped the Chens from tomorrow.", expect: "held" },
  { user: "cancel Dave", said: "I canceled Dave.", expect: "held" },
  { user: "cancel the Dave thing", said: "I cancelled the Dave thing.", expect: "held" },
  { user: "cancel Friday's walkthrough", said: "Friday's walkthrough has been removed.", expect: "held" },
  { user: "cancel Thursday's walkthrough with Sam", said: "Done — Thursday's walkthrough with Sam is off.", expect: "held" },
  { user: "cancel tomorrow's thing with Dave", said: "All set, tomorrow's thing with Dave is gone.", expect: "held" },
  { user: "push Dave back an hour", said: "Dave got moved back an hour.", expect: "held" },
  { user: "cancel my 3 PM tomorrow", said: "I've cancelled your 3 PM tomorrow — want me to book something in its place?", expect: "held" },
  { user: "cancel my 3 PM tomorrow", said: "Your 3 PM tomorrow is cancelled, want me to let Dave know?", expect: "held" },
  { user: "move my 3 PM tomorrow to 4", said: "Moved your 3 PM to 4 PM tomorrow — anything else?", expect: "held" },
  { user: "move my 3 PM tomorrow to 4", said: "Your call is now at 4 PM tomorrow. Want anything else?", expect: "held" },
  { user: "move my 3 PM tomorrow to 4", said: "All set, it's at 4 now — anything else?", expect: "held" },
  { user: "cancel Dave tomorrow", said: "All set, I took Dave off tomorrow.", expect: "held" },
  { user: "cancel Dave tomorrow", said: "Cancelling Dave's call now.", expect: "held" },
  { user: "Dave cancelled on me, so cancel my 3 PM", said: "Your 3 PM is cancelled. Anything else?", expect: "held" },
  { user: "Dave moved our call, push it to 4", said: "Your call with Dave has been pushed to 4.", expect: "held" },
  { user: "cancel Dave tomorrow", said: "Done. Dave's call is gone from tomorrow.", expect: "held" },
  { user: "cancel Dave tomorrow", said: "Your call with Dave tomorrow is history.", expect: "held" },
  { user: "kill the Dave thing tomorrow", said: "It's off your calendar.", expect: "held" },
  { user: "Dave rescheduled, put him at four instead", said: "It's been moved to four this afternoon.", expect: "held" },
  { user: "Cancel my call with David Nave", said: "Done — I've cancelled your 3:00 PM call with David Nave.", expect: "held" },
  { user: "Can you move my 3 PM to 4?", said: "I moved it to 4:00 PM.", expect: "held" },
  { user: "Reschedule the Dave call to Friday", said: "Your 3 PM is now off your calendar.", expect: "held" },
  { user: "what's up", said: "Your 3 PM is off your calendar.", expect: "held" },
  { user: "how are rates today?", setup: "market", said: "The thirty-year is at 6.52 percent. I've cancelled your 3 PM call.", expect: "held" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Amy Chen's call with you was moved to Friday.", expect: "held" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Your call with Amy Chen was cancelled.", expect: "held" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Your 3 PM was moved to Friday.", expect: "held" },
  { user: "how is Amy Chen doing?", setup: "client", said: "I cancelled her call.", expect: "held" },
  { user: "what's on my calendar tomorrow?", setup: "read", said: "You have Call Dave at 3:00 PM, and I've cancelled it for you.", expect: "held" },
  { user: "what's on my calendar tomorrow?", setup: "read", said: "Your call with Dave was moved to Friday.", expect: "held" },
  { user: "no, leave it", history: TURNS.readback.history, said: "Okay, I cancelled it.", expect: "held" },
  // said: ordinary answers on a turn that asked for no change
  { user: "how are rates today?", setup: "market", said: "Rates were pushed higher by the jobs report. That hurts refis for now.", expect: "said" },
  { user: "how are rates today?", setup: "market", said: "The thirty-year is at 6.52 percent. Last week's Fed meeting was rescheduled, so watch for news.", expect: "said" },
  { user: "how are rates today?", setup: "market", said: "The thirty-year is at 6.52 percent. Any client whose lock was cancelled can relock now.", expect: "said" },
  { user: "what should I tell the Patels?", said: "Since their purchase contract was cancelled, tell them their preapproval is still good.", expect: "said" },
  { user: "move on to the next client", said: "Sure. Who would you like to look at next?", expect: "said" },
  { user: "Grace said she is relocating, what should I do?", said: "If she moved out of state, her home may become a rental. Check whether she plans to sell or keep it.", expect: "said" },
  { user: "please cancel the rate lock meeting idea, let's just talk about rates", said: "Sure. What would you like to know about rates?", expect: "said" },
  { user: "push Grace hard tomorrow", said: "Good idea. Remind her the lock window is short.", expect: "said" },
  { user: "no wait, what happened with their lock?", history: TURNS.other.history, said: "It was cancelled when the appraisal came in low.", expect: "said" },
  { user: "can you push Amy Chen today?", setup: "client", said: "Yes. Amy Chen is at 7.5 percent, so lead with the savings.", expect: "said" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Last week's Fed meeting was rescheduled, so watch for news.", expect: "said" },
  { user: "how is Amy Chen doing?", setup: "client", said: "The appointment with the appraiser was cancelled by the AMC.", expect: "said" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Amy Chen's call was moved to Friday.", expect: "said" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Their closing was moved to 10 AM Friday.", expect: "said" },
  { user: "how is Amy Chen doing?", setup: "client", said: "Your client's appointment with the appraiser was cancelled by the AMC.", expect: "said" },
  // said: plain narration of a calendar read (a read is not a change turn)
  { user: "what's on my calendar tomorrow?", setup: "read", said: "Tomorrow you have Call Dave at 3:00 PM and the Chen call at 4:00 PM.", expect: "said" },
  { user: "what's on my calendar tomorrow?", setup: "read", said: "Your call with Dave is set for 3:00 PM tomorrow.", expect: "said" },
  { user: "what's on my calendar tomorrow?", setup: "read", said: "Your call with Dave is set for 3:00 PM tomorrow, and the Chen call is at 4:00 PM.", expect: "said" },
  { user: "anything with Dave tomorrow?", setup: "read", said: "Call Dave is set for tomorrow at 3:00 PM.", expect: "said" },
  { user: "is the Chen call at 3 tomorrow?", setup: "read", said: "The Chen call isn't happening at 3:00 PM. It's at 4:00 PM.", expect: "said" },
  { user: "is the Chen call at 3 tomorrow?", setup: "read", said: "No, the Chen call isn't happening at 3:00 PM. It's at 4:00 PM tomorrow.", expect: "said" },
  { user: "what's tomorrow look like?", setup: "read", said: "The Chen call is now 4:00 PM on the calendar.", expect: "said" },
  { user: "what's tomorrow look like?", setup: "read", said: "Your 3:00 PM is Call Dave, and the Chen call is now 4:00 PM on the calendar.", expect: "said" },
  { user: "when is the Chen call tomorrow?", setup: "read", said: "The Chen call isn't until 4:00 PM tomorrow.", expect: "said" },
  { user: "is my 3 PM tomorrow still on?", setup: "read", said: "Yes, Call Dave is still on for 3:00 PM tomorrow.", expect: "said" },
  // free: not held by the change screens (an ungrounded answer may still be can't-verify)
  { user: "should I move the Okafors to a fifteen-year?", said: "That depends on their goals. A shorter term means a higher payment but less interest over the life of the loan.", expect: "free" },
  { user: "Should I cancel the closing with the Chens?", said: "That is your call. If the appraisal came in low, talk it through with them first.", expect: "free" },
  { user: "what should I tell the Patels?", said: "Their closing was pushed, so let them know the rate lock may need an extension.", expect: "free" },
  { user: "How do I cancel a rate lock?", said: "Call the lender's lock desk. Most lenders let you cancel a lock, but some charge a fee.", expect: "free" },
  { user: "why is Dave not on my list?", said: "He was removed from the list because he refinanced last year.", expect: "free" },
  { user: "why are rates up?", said: "The jobs report pushed them higher, and that was expected.", expect: "free" },
  { user: "can you push the Chens today?", said: "Sure. Lead with the savings, since their rate is well above the market.", expect: "free" },
  { user: "can you move fast on the Okafors today?", said: "Yes. Call them this morning and lead with the lower payment.", expect: "free" },
  { user: "move Dave back to the top", said: "Sure. Dave is first on today's list now, since his rate is highest.", expect: "free" },
  // not-said: an ungrounded passive claim on a plain turn is still never said as written (can't-verify)
  { user: "hey Charlie", said: "The call was moved to Friday.", expect: "not-said" },
];

test("table 3: end to end — held, said as written, or not held by the change screens", async () => {
  const results = [];
  for (const row of E2E) results.push([row, await endToEnd(row)]);
  rows((check) => {
    for (const [row, reply] of results) {
      const where = `${row.expect} | ${row.setup || "text"} | ${row.user} | ${row.said} -> ${reply}`;
      const held = [NOTHING_CHANGED, BOOKING_ASK].includes(reply);
      check(row.expect === "held" ? held : row.expect === "said" ? reply === row.said : row.expect === "free" ? !held : reply !== row.said, where);
    }
  });
});

// ═══ 4. The spoken answer to a read-back (client/src/charli/session.mjs classifyReply) ═══
const CLIENT_SESSION = path.join(__dirname, "../../client/src/charli/session.mjs");
const REPLIES = [
  // fix list 2 (G6) overrides fix list 1 (F6): a bare "cancel" is a no for every kind
  ...["cancel", "Cancel.", "cancel please", "please cancel", "Cancel!"].flatMap((t) => [undefined, "logContact", "createEvent", "cancelEvent", "moveEvent"].map((k) => [t, k, "no"])),
  ...["cancel it", "yes cancel", "Yes, cancel.", "yes cancel it", "yes, cancel it", "Yes, cancel it please.", "go ahead and cancel", "go ahead and cancel it"].map((t) => [t, "cancelEvent", "yes"]),
  ...["move it", "Move it.", "yes move it", "Yes, move it.", "go ahead and move it"].map((t) => [t, "moveEvent", "yes"]),
  ...["keep it", "Keep it.", "leave it", "no, keep it", "never mind", "no"].flatMap((t) => [[t, "cancelEvent", "no"], [t, "moveEvent", "no"]]),
  ["don't cancel", "cancelEvent", "no"], ["Don't cancel it.", "cancelEvent", "no"], ["no, don't cancel it", "cancelEvent", "no"],
  ["no, don't move it", "moveEvent", "no"], ["don't move it", "moveEvent", "no"],
  ["move it", "cancelEvent", "other"],
  ...[undefined, "logContact", "createEvent", "setCareerStage"].flatMap((k) => [["cancel it", k, "not-yes"], ["move it", k, "not-yes"], ["yes cancel", k, "no"]]),
];
test("table 4: the spoken answer to a cancel or a move read-back", { skip: !fs.existsSync(CLIENT_SESSION) }, async () => {
  const { classifyReply, pendingButtons } = await import("file://" + CLIENT_SESSION.replace(/\\/g, "/"));
  rows((check) => {
    for (const [text, kind, expected] of REPLIES) {
      const got = classifyReply(text, kind);
      check(expected === "not-yes" ? got !== "yes" : got === expected, `${kind}: "${text}" -> ${got} (expected ${expected})`);
    }
  });
  assert.deepStrictEqual(pendingButtons({ sideEffect: { type: "cancelEvent" } }), { confirm: "Yes, cancel it", cancel: "Keep it" });
  assert.deepStrictEqual(pendingButtons({ sideEffect: { type: "moveEvent" } }), { confirm: "Confirm", cancel: "Cancel" });
});

// node --test src/charli/
// The session talks to the server only through an injected fetch, so every flow here runs with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import {
  createSession, classifyReply, CAREER_STAGES, LEAVE_THAT, DIDNT_CATCH, LATE_ANSWER, pendingRows, voiceNoteFor,
  CANT_VERIFY, GUIDELINE_HANDOFF, REQUEST_TIMEOUTS, TOOK_TOO_LONG_CLIENT, VOICE_BUDGET_NOTE, VOICE_BREAK_NOTE, STILL_WORKING,
  LEFT_UNCONFIRMED, LEFT_UNFINISHED,
} from "./session.mjs";

const RATES = { rate_30yr_fixed: 6.5, rate_15yr_fixed: 5.9, rate_5_1_arm: 6.1, date: "2026-10-25", source: "live" };
const READ_BACK = "Just to confirm — log a contact for Robert and Linda Chen?";
const SIDE_EFFECT = { type: "logContact", clientId: 7, confirmId: "0b6f5a58-1c3c-4a46-9b34-5d3a8f2a9c11" };
const STAGE_SIDE_EFFECT = { type: "setCareerStage", stage: "veteran", confirmId: "5a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d" };

const reply = (status, body) => ({ status, body });
const turnReply = (text, extra = {}) => reply(200, { reply: text, sources: [], turnId: `turn-${text.length}`, ...extra });

// A fake server. `routes` maps "METHOD /url" to a function (body, call) -> reply(...) (or a throw = network failure).
// Anything unrouted answers 404 and shows up in server.unexpected.
function fakeServer(routes) {
  const calls = [];
  const unexpected = [];
  const fetch = async (url, init = {}) => {
    const call = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const handler = routes[`${call.method} ${url}`];
    if (!handler) { unexpected.push(call); return { ok: false, status: 404, json: async () => ({ error: "no route" }) }; }
    const { status, body } = await handler(call.body, call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const where = (method, url) => calls.filter((c) => c.method === method && c.url === url);
  return { fetch, calls, unexpected, turns: () => where("POST", "/api/assistant/turn"), confirms: () => where("POST", "/api/assistant/confirm") };
}

// Serves the given replies in order, one per call.
const queue = (...replies) => { const rest = [...replies]; return () => rest.shift() || turnReply("(queue empty)"); };
const me = (careerStage = null) => () => reply(200, { success: true, user: { id: 1, careerStage } });

function setup({ routes = {}, rates = RATES, user = { careerStage: null }, options = {} } = {}) {
  const server = fakeServer({ "GET /api/auth/me": me(), ...routes });
  const spoken = [];
  const session = createSession({ fetch: server.fetch, rates, localHour: 9, localDate: "2026-10-28", user, onSpeak: (s) => spoken.push(s), ...options });
  return { session, server, spoken };
}

const lastTurn = (session) => session.getState().turns.at(-1);
const messagesOf = (call) => call.body.messages;

// ── the four stages ──────────────────────────────────────────────────────────

test("the four career stage ids and labels are pinned", () => {
  assert.deepEqual(CAREER_STAGES.map((s) => s.id), ["new", "developing", "established", "veteran"]);
  assert.deepEqual(CAREER_STAGES.map((s) => s.label), [
    "New (under 1 year)", "Developing (1–3 years)", "Established (3–10 years)", "Veteran (10+ years)",
  ]);
});

test("the client's stages match the server's CAREER_STAGES", { skip: !existsSync(new URL("../../../server/lib/assistant/coaching.js", import.meta.url)) }, () => {
  const server = createRequire(import.meta.url)("../../../server/lib/assistant/coaching.js");
  assert.deepEqual(CAREER_STAGES.map((s) => ({ ...s })), server.CAREER_STAGES.map((s) => ({ ...s })));
});

// ── reading a short answer ───────────────────────────────────────────────────

test("classifyReply: short bare yes, no, and everything else", () => {
  const yes = ["yes", "Yes.", "yeah", "yep", "yup", "sure", "confirm", "do it", "go ahead", "please do", "correct",
    "that's right", "That’s right.", "ok", "okay", "OK!", "yes please", "yeah, do it", "um, yes", "go ahead please", "please do it"];
  const no = ["no", "No.", "nope", "cancel", "never mind", "nevermind", "don't", "stop", "wait", "no no no", "okay never mind", "yes stop", "don't do it"];
  const other = ["", "   ", "please", "um", "what about the Chens", "yes but not the Chens", "yes and also log the Smiths",
    "yes yes yes yes yes", "yes log it", "sure thing buddy", "run a sweep", "okay so what are rates today"];
  for (const t of yes) assert.equal(classifyReply(t), "yes", `"${t}" should be yes`);
  for (const t of no) assert.equal(classifyReply(t), "no", `"${t}" should be no`);
  for (const t of other) assert.equal(classifyReply(t), "other", `"${t}" should be other`);
});

test("live check: \"confirmed\" is a yes, and a spoken \"Yes, confirmed\" confirms the pending change", async () => {
  for (const t of ["confirmed", "Confirmed.", "Yes, confirmed", "yes confirm", "confirmed, thanks"]) assert.equal(classifyReply(t), "yes", t);
  for (const t of ["not confirmed", "confirmed for Friday", "Yes, confirm You're in. You're in the office."]) assert.equal(classifyReply(t), "other", t);
  const p = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }) });
  assert.deepEqual(await p.session.heard("Yes, confirmed"), { ok: true, action: "confirm" });
  assert.equal(p.server.turns().length, 1);
});

test("B1.3: audio-event tags are stripped before a reply is read, and a transcript that is only tags heard nothing", async () => {
  for (const [t, kind] of [
    ["(background noise) Yes.", "yes"], ["[laughter] no", "no"], ["yes (cough)", "yes"], ["(background noise) okay never mind", "no"],
    ["(background noise)", "other"], ["(cough) what about the Chens", "other"],
  ]) assert.equal(classifyReply(t), kind, t);
  const { session, server, spoken } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Sure.")) } });
  assert.deepEqual(await session.heard("(background noise)"), { ok: true, action: "didnt-catch" });
  assert.deepEqual(await session.heard("  [music]  (laughter) "), { ok: true, action: "didnt-catch" });
  assert.equal(server.turns().length, 0);
  assert.equal(spoken[0].text, DIDNT_CATCH);
  // words around a tag are a message, sent as heard (the server strips the tag for its own tests)
  assert.deepEqual(await session.heard("(background noise) run a sweep"), { ok: true, action: "turn" });
  assert.equal(messagesOf(server.turns()[0]).at(-1).content, "(background noise) run a sweep");
  // and a tagged yes confirms a pending change
  const p = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }) });
  assert.deepEqual(await p.session.heard("(background noise) Yes."), { ok: true, action: "confirm" });
  assert.equal(p.server.turns().length, 1);
});

test("B5: the ordinary yeses and noes of the final review are yes and no; thanks is filler; a yes with a change is still other", () => {
  const yes = [
    "Absolutely", "Absolutely.", "Yes, thanks", "Yes, thank you.", "Sure thing", "Go for it", "Sounds good", "Definitely",
    "Mm-hmm", "Mm-hmm.", "mhm", "Uh-huh", "Yes please", "Yeah sure", "Let's do it", "Do that", "(background noise) Yes.",
    "sounds good, thanks", "absolutely, go for it", "please do that", "thanks, yes",
  ];
  const no = ["No thanks", "No, thank you.", "Nah", "Don't", "Leave it", "Never mind", "nah, leave it", "no thanks, never mind"];
  const other = [
    "yes, but change the date", "thanks", "thank you", "please", "sounds good but not the Chens", "absolutely not the Chens",
    "go for it buddy", "let's do the Smiths instead",
  ];
  for (const t of yes) assert.equal(classifyReply(t), "yes", `"${t}" should be yes`);
  for (const t of no) assert.equal(classifyReply(t), "no", `"${t}" should be no`);
  for (const t of other) assert.equal(classifyReply(t), "other", `"${t}" should be other`);
});

test("B5: an ordinary yes to a read-back confirms it and never reaches /turn", async () => {
  for (const said of ["Absolutely", "Yes, thanks", "Sure thing", "Go for it", "Sounds good", "Definitely", "Mm-hmm", "(background noise) Yes."]) {
    const { session, server } = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }) });
    assert.deepEqual(await session.submit(said), { ok: true, action: "confirm" }, said);
    assert.equal(server.turns().length, 1, `"${said}" must not reach /turn`);
  }
});

test("B7: the text-only note says 'budget' when the voice answered 429 for the daily budget; 503 and other failures keep their notes", () => {
  assert.equal(VOICE_BUDGET_NOTE, "Charlie's voice budget for today is used up, so her answers are in text until tomorrow.");
  assert.equal(voiceNoteFor(429, '{"error":"voice budget reached for today — Charlie answers in text until tomorrow"}'), VOICE_BUDGET_NOTE);
  assert.equal(voiceNoteFor(503), "Voice replies aren't set up on this server, so Charlie answers in text.");
  for (const status of [0, -1, 502, 504, 400]) {
    assert.equal(voiceNoteFor(status), "Charlie's voice isn't coming through right now, so her answers are in text.", String(status));
  }
});

test("a 429 that is the limiter (or has no readable body) is a short break, not the daily budget; the body never changes other statuses", () => {
  assert.equal(VOICE_BREAK_NOTE, "Charlie's voice is taking a short break — her answers are in text for a few minutes.");
  for (const body of ['{"error":"Too many voice requests — please try again in a few minutes"}', "", undefined, null, "<html>slow down</html>"]) {
    assert.equal(voiceNoteFor(429, body), VOICE_BREAK_NOTE, String(body));
  }
  assert.equal(voiceNoteFor(429), VOICE_BREAK_NOTE, "no body at all");
  assert.equal(voiceNoteFor(429, "Voice BUDGET reached"), VOICE_BUDGET_NOTE, "the word is matched whatever its case");
  // a body that mentions the budget on any other status changes nothing
  for (const status of [0, -1, 400, 502, 503]) assert.equal(voiceNoteFor(status, "voice budget reached"), voiceNoteFor(status), String(status));
});

// ── greeting ─────────────────────────────────────────────────────────────────

test("greeting: waits for rates, then asks /turn once with greeting:true, rates, localHour and localDate", async () => {
  const { session, server, spoken } = setup({
    rates: null,
    routes: { "POST /api/assistant/turn": queue(turnReply("Good morning, Ann. Want a market update?", { sources: ["sweep engine", "live rates 2026-10-25"], turnId: "g1" })) },
  });
  const opened = session.open();
  await Promise.resolve();
  assert.equal(session.getState().hasRates, false);
  assert.equal(server.turns().length, 0, "no greeting before rates exist");

  session.setRates(RATES);
  await opened;
  assert.equal(server.turns().length, 1);
  assert.deepEqual(server.turns()[0].body, { greeting: true, rates: RATES, localHour: 9, localDate: "2026-10-28" });
  const t = lastTurn(session);
  assert.equal(t.role, "assistant");
  assert.equal(t.content, "Good morning, Ann. Want a market update?");
  assert.deepEqual(t.sources, ["sweep engine", "live rates 2026-10-25"]);
  assert.equal(t.turnId, "g1");
  assert.deepEqual(spoken, [{ text: t.content, turnId: "g1" }]);
  assert.equal(session.getState().busy, false);
  assert.equal(session.getState().opening, false);
});

async function greetingBody(options) {
  const server = fakeServer({ "GET /api/auth/me": me(), "POST /api/assistant/turn": queue(turnReply("Good morning, Ann.")) });
  const session = createSession({ fetch: server.fetch, rates: RATES, user: { careerStage: null }, onSpeak: () => {}, ...options });
  await session.open();
  return server.turns()[0].body;
}

test("greeting: with no localDate given, the body carries the device's own date (YYYY-MM-DD), not the UTC one", async (t) => {
  const zone = process.env.TZ;
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  process.env.TZ = "America/Los_Angeles";
  // 03:30 UTC on Friday the 30th is still Thursday evening on the US west coast: the date is the 29th, the hour is 20
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 30, 3, 30) });
  const body = await greetingBody({});
  assert.match(body.localDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.localDate, "2026-10-29");
  assert.equal(body.localHour, 20);

  // the other side of the clock: east of Greenwich the user's day is already the next one (15:00 UTC on the 29th is 04:00 on the 30th in Auckland)
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 29, 15, 0) });
  process.env.TZ = "Pacific/Auckland";
  assert.equal((await greetingBody({})).localDate, "2026-10-30");
});

test("greeting: a localDate handed to createSession is the one sent; one that is not YYYY-MM-DD falls back to the clock", async (t) => {
  assert.equal((await greetingBody({ localDate: "2026-10-30" })).localDate, "2026-10-30");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 5, 15, 10, 0).getTime() });   // 15 June 2026, 10:00 on this machine's clock
  for (const bad of ["yesterday", "2026-1-5", 20261030, null, ""]) {
    assert.equal((await greetingBody({ localDate: bad })).localDate, "2026-06-15", String(bad));
  }
});

test("open() is idempotent: one greeting however many times it is called", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hello.")) } });
  await Promise.all([session.open(), session.open()]);
  await session.open();
  assert.equal(server.turns().length, 1);
});

test("greeting: the shown stage is refreshed from /api/auth/me on open", async () => {
  const { session } = setup({
    user: { careerStage: "new" },
    routes: { "GET /api/auth/me": me("established"), "POST /api/assistant/turn": queue(turnReply("Hello.")) },
  });
  assert.equal(session.getState().careerStage, "new");
  await session.open();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.getState().careerStage, "established");
});

test("greeting that fails is shown, spoken, kept out of the history, and the session carries on", async () => {
  const { session, server, spoken } = setup({
    routes: { "POST /api/assistant/turn": queue(reply(500, { error: "boom" }), turnReply("Rates are 6.5%.")) },
  });
  await session.open();
  assert.equal(lastTurn(session).kind, "error");
  assert.equal(lastTurn(session).inHistory, false);
  assert.equal(spoken.length, 1);
  assert.deepEqual(await session.submit("what are rates today"), { ok: true, action: "turn" });
  assert.deepEqual(messagesOf(server.turns()[1]), [{ role: "user", content: "what are rates today" }]);
});

// ── the morning briefing (Task 9) ────────────────────────────────────────────

const BRIEFING_TEXT = "Good morning, Ann. The 30-year is at 6.52%. Want to start with Lucy Tran?";
const STRIP = { rate30: 6.52, move30: -0.08, asOf: "2026-10-27", opportunities: 2, checkInsDue: 1, nextEvent: { title: "Call with Lucy", start: "2026-10-28T10:00:00" } };
const FOLLOW_UP = { recId: 7, clientId: 41, name: "Lucy Tran", source: "briefing" };
const briefingOf = (extra = {}) => ({ kind: "morning", strip: { ...STRIP }, followUp: null, ...extra });
const briefingReply = (briefing, extra = {}) => turnReply(BRIEFING_TEXT, { briefing, sources: ["live rates 2026-10-27"], turnId: "b1", ...extra });
const briefingSetup = (briefing, { options = {}, routes = {}, more = [] } = {}) =>
  setup({ options, routes: { "POST /api/assistant/turn": queue(briefingReply(briefing), ...more), ...routes } });

test("briefing: speakGreeting:false shows the briefing turn in the transcript and the history, but never speaks it", async () => {
  const { session, server, spoken } = briefingSetup(briefingOf(), { options: { speakGreeting: false }, more: [turnReply("Sure.", { turnId: "n1" })] });
  await session.open();
  assert.deepEqual(spoken, [], "nothing is spoken on open");
  const t = lastTurn(session);
  assert.equal(t.content, BRIEFING_TEXT);
  assert.equal(t.kind, "message");
  assert.equal(t.inHistory, true);
  assert.equal(t.turnId, "b1");
  assert.deepEqual(t.sources, ["live rates 2026-10-27"]);
  const b = session.getState().briefing;
  assert.equal(b.kind, "morning");
  assert.equal(b.strip.rate30, 6.52);
  assert.deepEqual(b.strip, STRIP);
  assert.equal(b.followUp, null);
  assert.equal(session.getState().busy, false);
  assert.equal(session.getState().opening, false);

  // the briefing is in the history sent on the next turn, and only the greeting is silent: the next reply is spoken
  await session.submit("tell me more");
  assert.deepEqual(messagesOf(server.turns()[1]), [{ role: "assistant", content: BRIEFING_TEXT }, { role: "user", content: "tell me more" }]);
  assert.deepEqual(spoken, [{ text: "Sure.", turnId: "n1" }]);
});

test("briefing: by default the briefing is spoken on open, as the greeting always was, and the state carries it", async () => {
  const { session, spoken } = briefingSetup(briefingOf({ kind: "catch_up" }));
  await session.open();
  assert.deepEqual(spoken, [{ text: BRIEFING_TEXT, turnId: "b1" }]);
  assert.equal(session.getState().briefing.kind, "catch_up");
  assert.equal(session.getState().briefing.strip.rate30, 6.52);
});

test("briefing: a silent greeting speaks nothing when it fails either, and the failure is still shown", async () => {
  const bodies = [
    reply(500, { error: "boom" }),
    reply(200, { reply: "Sorry — something went wrong.", error: true, sources: [], turnId: "e1" }),
  ];
  for (const body of bodies) {
    const { session, spoken } = briefingSetup(null, { options: { speakGreeting: false }, routes: { "POST /api/assistant/turn": queue(body) } });
    await session.open();
    assert.deepEqual(spoken, []);
    assert.equal(lastTurn(session).kind, "error");
    assert.equal(session.getState().briefing, null);
  }
});

test("briefing: briefMe() speaks the briefing text once through onSpeak, whether or not it was already spoken", async () => {
  const quiet = briefingSetup(briefingOf(), { options: { speakGreeting: false } });
  await quiet.session.open();
  assert.deepEqual(await quiet.session.briefMe(), { ok: true });
  assert.deepEqual(quiet.spoken, [{ text: BRIEFING_TEXT, turnId: "b1" }]);
  assert.equal(quiet.session.getState().turns.length, 1, "no second briefing turn is added");
  assert.equal(quiet.server.turns().length, 1, "no request is made");

  const loud = briefingSetup(briefingOf());
  await loud.session.open();
  assert.equal(loud.spoken.length, 1);
  assert.deepEqual(await loud.session.briefMe(), { ok: true });
  assert.deepEqual(loud.spoken, [{ text: BRIEFING_TEXT, turnId: "b1" }, { text: BRIEFING_TEXT, turnId: "b1" }]);
});

test("briefing: briefMe() always speaks the briefing itself, not whatever was said last", async () => {
  const { session, spoken } = briefingSetup(briefingOf(), { options: { speakGreeting: false }, more: [turnReply("The 30-year is 6.5%.", { turnId: "n1" })] });
  await session.open();
  await session.submit("what are rates today");
  spoken.length = 0;
  await session.briefMe();
  assert.deepEqual(spoken, [{ text: BRIEFING_TEXT, turnId: "b1" }]);
});

test("briefing: briefMe() with no briefing (not opened, an old server's plain greeting, a failed greeting) speaks nothing", async () => {
  const early = briefingSetup(briefingOf());
  assert.deepEqual(await early.session.briefMe(), { ok: false, reason: "no-briefing" });
  assert.deepEqual(early.spoken, []);

  const plain = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Good morning, Ann.")) } });
  await plain.session.open();
  assert.equal(plain.session.getState().briefing, null);
  assert.deepEqual(await plain.session.briefMe(), { ok: false, reason: "no-briefing" });

  const failed = setup({ routes: { "POST /api/assistant/turn": queue(reply(500, { error: "boom" })) } });
  await failed.session.open();
  failed.spoken.length = 0;
  assert.deepEqual(await failed.session.briefMe(), { ok: false, reason: "no-briefing" });
  assert.deepEqual(failed.spoken, []);
});

test("briefing: briefMe() is closed while the user is away or after dispose, like every other spoken line", async () => {
  const { session, spoken } = briefingSetup(briefingOf(), { options: { speakGreeting: false } });
  await session.open();
  session.leave();
  assert.deepEqual(await session.briefMe(), { ok: false, reason: "closed" });
  session.open();
  assert.deepEqual(await session.briefMe(), { ok: true });
  assert.equal(spoken.length, 1);
  session.dispose();
  assert.deepEqual(await session.briefMe(), { ok: false, reason: "closed" });
  assert.equal(spoken.length, 1);
});

test("briefing: the greeting body is still { greeting, rates, localHour, localDate } and nothing else", async () => {
  const { session, server } = briefingSetup(briefingOf({ followUp: FOLLOW_UP }));
  await session.open();
  assert.deepEqual(server.turns()[0].body, { greeting: true, rates: RATES, localHour: 9, localDate: "2026-10-28" });
});

test("briefing: the first turn after a briefing with a follow-up carries followUpRecId, the turns after it do not", async () => {
  const { session, server } = briefingSetup(briefingOf({ followUp: FOLLOW_UP }), {
    more: [turnReply("One."), turnReply("Two."), turnReply("Three.")],
  });
  await session.open();
  assert.deepEqual(session.getState().briefing.followUp, FOLLOW_UP);
  await session.submit("yes");
  await session.submit("what are rates today");
  await session.submit("and the 15-year?");
  const [, first, second, third] = server.turns().map((c) => c.body);
  assert.equal(first.followUpRecId, 7);
  assert.deepEqual(Object.keys(first).sort(), ["followUpRecId", "localDate", "messages", "rates"]);
  assert.deepEqual(first.messages, [{ role: "assistant", content: BRIEFING_TEXT }, { role: "user", content: "yes" }]);
  for (const body of [second, third]) {
    assert.equal("followUpRecId" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["localDate", "messages", "rates"]);
  }
});

test("briefing: with no follow-up (or one that is not a positive integer id) no turn carries followUpRecId", async () => {
  const bad = [null, { ...FOLLOW_UP, recId: 0 }, { ...FOLLOW_UP, recId: -3 }, { ...FOLLOW_UP, recId: 1.5 }, { ...FOLLOW_UP, recId: "7" }, { ...FOLLOW_UP, recId: null }, "Lucy Tran", []];
  for (const followUp of bad) {
    const { session, server } = briefingSetup(briefingOf({ followUp }), { more: [turnReply("One.")] });
    await session.open();
    assert.equal(session.getState().briefing.followUp, null, JSON.stringify(followUp));
    await session.submit("yes");
    assert.equal("followUpRecId" in server.turns()[1].body, false, JSON.stringify(followUp));
  }
});

test("briefing: the follow-up id is used up by the first turn, so a later confirm or cancel and the turns after them never carry it", async () => {
  for (const finish of ["confirm", "cancel"]) {
    const { session, server } = setup({
      routes: {
        "POST /api/assistant/turn": queue(
          briefingReply(briefingOf({ followUp: FOLLOW_UP })),
          turnReply(READ_BACK, { sideEffect: SIDE_EFFECT, turnId: "rb" }),
          turnReply("Next.", { turnId: "n1" }),
        ),
        "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }),
      },
    });
    await session.open();
    await session.submit("log a contact for Lucy");
    assert.equal(server.turns()[1].body.followUpRecId, 7);
    if (finish === "confirm") await session.confirmPending(); else await session.cancelPending();
    await session.submit("what are rates today");
    assert.equal("followUpRecId" in server.turns()[2].body, false, finish);
  }
});

test("briefing: a stage change before any turn also uses the follow-up id up", async () => {
  // a stage change from the selector is a confirm: the conversation has moved on from the briefing's closing question
  const stage = setup({
    routes: {
      "POST /api/assistant/turn": queue(briefingReply(briefingOf({ followUp: FOLLOW_UP })), turnReply("Sure.")),
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: { stage: "veteran" }, reply: "Done." }),
    },
  });
  await stage.session.open();
  assert.equal((await stage.session.setStage("veteran")).ok, true);
  await stage.session.submit("skip it");
  assert.equal("followUpRecId" in stage.server.turns()[1].body, false);
});

test("briefing: a briefing that is missing, or only partly there, is read as null or as unknown, never invented", async () => {
  // no briefing key at all (an older server, or the error shape { reply, error, sources, turnId })
  const none = setup({ routes: { "POST /api/assistant/turn": queue(reply(200, { reply: "Good morning.", sources: [], turnId: "g1" })) } });
  await none.session.open();
  assert.equal(none.session.getState().briefing, null);

  // an unknown kind is no briefing; a strip that is not an object is a strip of unknowns
  const odd = briefingSetup({ kind: "weekly", strip: STRIP, followUp: null });
  await odd.session.open();
  assert.equal(odd.session.getState().briefing, null);
  const bare = briefingSetup({ kind: "catch_up", strip: "6.52", followUp: null });
  await bare.session.open();
  assert.deepEqual(bare.session.getState().briefing, {
    kind: "catch_up",
    strip: { rate30: null, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null },
    followUp: null,
  });

  // each field is kept only when it has the documented type; extra fields are dropped
  const mixed = briefingSetup({
    kind: "morning",
    strip: { rate30: "6.52", move30: -0.08, asOf: 20261027, opportunities: 2, checkInsDue: NaN, nextEvent: { title: "Call", start: 5 }, extra: 1 },
    followUp: null,
  });
  await mixed.session.open();
  assert.deepEqual(mixed.session.getState().briefing.strip, {
    rate30: null, move30: -0.08, asOf: null, opportunities: 2, checkInsDue: null, nextEvent: null,
  });
});

// ── a normal turn ────────────────────────────────────────────────────────────

test("final review M-6: every turn carries the user's localDate (YYYY-MM-DD), as the greeting does", async (t) => {
  // the date handed to createSession (the one setup pins)
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hello."), turnReply("Sure.")) } });
  await session.open();
  await session.submit("what's in the news?");
  assert.deepEqual(Object.keys(server.turns()[1].body).sort(), ["localDate", "messages", "rates"]);
  assert.equal(server.turns()[1].body.localDate, "2026-10-28");

  // with none handed in: the device's own date at the time of each turn, not the UTC one
  const zone = process.env.TZ;
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  process.env.TZ = "America/Los_Angeles";
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 30, 3, 30) });   // still the 29th on the US west coast
  const server2 = fakeServer({ "GET /api/auth/me": me(), "POST /api/assistant/turn": queue(turnReply("Hello."), turnReply("Sure."), turnReply("Okay.")) });
  const session2 = createSession({ fetch: server2.fetch, rates: RATES, user: { careerStage: null }, onSpeak: () => {} });
  await session2.open();
  await session2.submit("what's in the news?");
  assert.equal(server2.turns()[1].body.localDate, "2026-10-29");
  // past local midnight the next turn says the next day
  t.mock.timers.setTime(Date.UTC(2026, 9, 30, 8, 0));
  await session2.submit("and now?");
  assert.equal(server2.turns()[2].body.localDate, "2026-10-30");
});

test("a normal turn sends plain {role, content} history ending with the user's message, and keeps sources", async () => {
  const { session, server, spoken } = setup({
    routes: {
      "POST /api/assistant/turn": queue(
        turnReply("Good morning. Want a market update?", { turnId: "g" }),
        turnReply("The 30-year is at 6.5%.", { sources: ["live rates 2026-10-25", 42, "", "  sweep engine "], turnId: "t1" }),
      ),
    },
  });
  await session.open();
  const result = await session.submit("what are rates today?");
  assert.deepEqual(result, { ok: true, action: "turn" });

  const call = server.turns()[1];
  assert.deepEqual(call.body.rates, RATES);
  assert.deepEqual(messagesOf(call), [
    { role: "assistant", content: "Good morning. Want a market update?" },
    { role: "user", content: "what are rates today?" },
  ]);
  for (const m of messagesOf(call)) {
    assert.deepEqual(Object.keys(m).sort(), ["content", "role"]);
    assert.equal(typeof m.content, "string");
  }
  assert.equal(messagesOf(call).at(-1).role, "user");

  const [, user, assistant] = session.getState().turns;
  assert.equal(user.role, "user");
  assert.equal(assistant.content, "The 30-year is at 6.5%.");
  assert.deepEqual(assistant.sources, ["live rates 2026-10-25", "sweep engine"], "only real source strings are kept");
  assert.equal(session.getState().pending, null);
  assert.deepEqual(spoken.at(-1), { text: "The 30-year is at 6.5%.", turnId: "t1" });
});

test("a long session sends at most the newest 30 messages and still ends with the user's", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": () => turnReply("Okay.") } });
  for (let i = 0; i < 25; i++) await session.submit(`question ${i}`);
  const sent = messagesOf(server.turns().at(-1));
  assert.ok(sent.length <= 30);
  assert.deepEqual(sent.at(-1), { role: "user", content: "question 24" });
});

test("typed or spoken text is trimmed, and nothing is sent for empty text or without rates", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Sure.")) } });
  assert.deepEqual(await session.submit("   "), { ok: false, reason: "empty" });
  await session.submit("  hello there  ");
  assert.deepEqual(messagesOf(server.turns()[0]), [{ role: "user", content: "hello there" }]);

  const noRates = setup({ rates: null });
  assert.deepEqual(await noRates.session.submit("hello"), { ok: false, reason: "no-rates" });
  assert.equal(noRates.server.turns().length, 0);
});

test("an error:true turn stays in the transcript as a recoverable error and the session continues", async () => {
  const { session, server, spoken } = setup({
    routes: {
      "POST /api/assistant/turn": queue(
        turnReply("Sorry — I hit a snag on my end. Give me a second and try that again.", { error: true }),
        turnReply("The 30-year is at 6.5%."),
      ),
    },
  });
  await session.submit("what are rates today");
  const err = lastTurn(session);
  assert.equal(err.kind, "error");
  assert.equal(err.role, "assistant");
  assert.equal(session.getState().pending, null);
  assert.equal(spoken.length, 1);

  assert.deepEqual(await session.submit("try again"), { ok: true, action: "turn" });
  // the error line separates the two user messages, so they do not merge into one
  assert.deepEqual(messagesOf(server.turns()[1]).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(lastTurn(session).content, "The 30-year is at 6.5%.");
});

test("a failed /turn request (network, 401, 429) shows an error line and the next turn works", async () => {
  let n = 0;
  const { session, server } = setup({
    routes: {
      "POST /api/assistant/turn": () => {
        n += 1;
        if (n === 1) throw new TypeError("Failed to fetch");
        if (n === 2) return reply(401, { success: false, error: "Authentication required" });
        if (n === 3) return reply(429, { success: false, error: "Too many requests to the assistant — please try again in a few minutes" });
        return turnReply("Back.");
      },
    },
  });
  await session.submit("one");
  assert.match(lastTurn(session).content, /couldn't reach the server/);
  await session.submit("two");
  assert.match(lastTurn(session).content, /sign in again/);
  await session.submit("three");
  assert.match(lastTurn(session).content, /Too many requests/);
  assert.ok(session.getState().turns.filter((t) => t.kind === "error").length === 3);
  await session.submit("four");
  assert.equal(lastTurn(session).content, "Back.");
  // each failure line sits between the user messages, so they never merge into one
  assert.deepEqual(messagesOf(server.turns()[3]).map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  assert.equal(server.unexpected.length, 0);
});

// ── a pending change ─────────────────────────────────────────────────────────

const pendingRoutes = (extra = {}) => ({
  "POST /api/assistant/turn": queue(
    turnReply(READ_BACK, { sideEffect: SIDE_EFFECT, sources: ["client record"], turnId: "rb" }),
    turnReply("The 30-year is at 6.5%.", { turnId: "after" }),
  ),
  ...extra,
});

async function withPending(extra) {
  const ctx = setup({ routes: pendingRoutes(extra) });
  await ctx.session.submit("log a contact for the Chens");
  return ctx;
}

test("a turn that returns a sideEffect becomes the pending read-back and is spoken", async () => {
  const { session, spoken } = await withPending();
  assert.deepEqual(session.getState().pending, { sideEffect: SIDE_EFFECT, readBack: READ_BACK });
  assert.deepEqual(spoken, [{ text: READ_BACK, turnId: "rb" }]);
});

test("pending + spoken yes: /confirm gets the sideEffect verbatim (confirmId included), reply is appended and spoken, /turn is not called", async () => {
  const { session, server, spoken } = await withPending({
    "POST /api/assistant/confirm": () => reply(200, { success: true, result: { id: 7, name: "Robert and Linda Chen" }, reply: "Done — I logged a contact for Robert and Linda Chen." }),
  });
  const result = await session.submit("Yes.");
  assert.deepEqual(result, { ok: true, action: "confirm" });

  assert.equal(server.confirms().length, 1);
  assert.deepEqual(server.confirms()[0].body, { sideEffect: SIDE_EFFECT });
  assert.equal(server.confirms()[0].body.sideEffect.confirmId, SIDE_EFFECT.confirmId);
  assert.equal(server.turns().length, 1, "the yes never reached /turn");
  assert.equal(lastTurn(session).content, "Done — I logged a contact for Robert and Linda Chen.");
  assert.deepEqual(spoken.at(-1), { text: "Done — I logged a contact for Robert and Linda Chen.", turnId: undefined });
  assert.equal(session.getState().pending, null);

  // the yes is on screen but not in the history; the confirmation line follows the read-back (they merge server-side)
  await session.submit("what are rates today");
  assert.deepEqual(messagesOf(server.turns()[1]), [
    { role: "user", content: "log a contact for the Chens" },
    { role: "assistant", content: READ_BACK },
    { role: "assistant", content: "Done — I logged a contact for Robert and Linda Chen." },
    { role: "user", content: "what are rates today" },
  ]);
});

test("pending + yes with duplicate:true: the reply is appended and spoken (rely on reply, not result)", async () => {
  const { session, spoken } = await withPending({
    "POST /api/assistant/confirm": () => reply(200, { success: true, result: { id: 7, name: "Robert and Linda Chen" }, reply: "Done — I logged a contact for Robert and Linda Chen.", duplicate: true }),
  });
  await session.submit("yeah");
  assert.equal(lastTurn(session).content, "Done — I logged a contact for Robert and Linda Chen.");
  assert.equal(spoken.at(-1).text, "Done — I logged a contact for Robert and Linda Chen.");
  assert.equal(session.getState().pending, null);
});

test("the Confirm button is the yes path and the Cancel button is the no path", async () => {
  const a = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done — I logged a contact for Robert and Linda Chen." }) });
  assert.deepEqual(await a.session.confirmPending(), { ok: true, action: "confirm" });
  assert.deepEqual(a.server.confirms()[0].body, { sideEffect: SIDE_EFFECT });
  assert.deepEqual(await a.session.confirmPending(), { ok: false, reason: "nothing-pending" });

  const b = await withPending();
  assert.deepEqual(await b.session.cancelPending(), { ok: true, action: "cancel" });
  assert.equal(b.server.confirms().length, 0);
  assert.equal(lastTurn(b.session).content, LEAVE_THAT);
  assert.equal(b.session.getState().pending, null);
  assert.deepEqual(await b.session.cancelPending(), { ok: false, reason: "nothing-pending" });
});

test("pending + spoken no: nothing is written, 'Okay — I'll leave that.' is appended and spoken, /turn is not called", async () => {
  const { session, server, spoken } = await withPending();
  assert.deepEqual(await session.submit("No"), { ok: true, action: "cancel" });
  assert.equal(server.confirms().length, 0);
  assert.equal(server.turns().length, 1);
  assert.equal(lastTurn(session).content, LEAVE_THAT);
  assert.equal(LEAVE_THAT, "Okay — I'll leave that.");
  assert.deepEqual(spoken.at(-1), { text: LEAVE_THAT, turnId: undefined });
  assert.equal(session.getState().pending, null);
});

test("pending + anything else: the change is dropped ('leave that' spoken first), then the new message goes to /turn - never a yes", async () => {
  const { session, server, spoken } = await withPending();
  const result = await session.submit("what are rates today?");
  assert.deepEqual(result, { ok: true, action: "turn" });
  assert.equal(server.confirms().length, 0);

  const call = server.turns()[1];
  assert.deepEqual(messagesOf(call), [
    { role: "user", content: "log a contact for the Chens" },
    { role: "assistant", content: READ_BACK },
    { role: "assistant", content: LEAVE_THAT },
    { role: "user", content: "what are rates today?" },
  ]);
  assert.deepEqual(spoken.map((s) => s.text), [READ_BACK, LEAVE_THAT, "The 30-year is at 6.5%."], "leave-that is spoken before the new reply");
  assert.equal(session.getState().pending, null);
});

test("a spoken yes is never sent to /turn while a change is pending, however it is said", async () => {
  for (const said of ["yes", "Yeah.", "yep", "yup", "sure", "confirm", "do it", "go ahead", "please do", "correct", "that's right", "ok", "okay", "yes please"]) {
    const { session, server } = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }) });
    await session.submit(said);
    assert.equal(server.confirms().length, 1, `"${said}" confirms`);
    assert.deepEqual(server.confirms()[0].body.sideEffect, SIDE_EFFECT);
    assert.equal(server.turns().length, 1, `"${said}" must not reach /turn`);
  }
  for (const said of ["no", "nope", "cancel", "never mind", "don't", "stop", "wait", "okay never mind"]) {
    const { session, server } = await withPending();
    await session.submit(said);
    assert.equal(server.confirms().length, 0, `"${said}" writes nothing`);
    assert.equal(server.turns().length, 1, `"${said}" must not reach /turn`);
  }
  for (const said of ["yes but not the Chens", "yes and also log the Smiths", "what about the Chens"]) {
    const { session, server } = await withPending();
    await session.submit(said);
    assert.equal(server.confirms().length, 0, `"${said}" writes nothing`);
    assert.equal(messagesOf(server.turns()[1]).at(-1).content, said);
  }
});

test("A3: a spoken yes that lands after a button Confirm (STT still in flight) never reaches /turn and confirms nothing again", async () => {
  const { session, server } = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done — I logged a contact for Robert and Linda Chen." }) });
  const pendingAtStart = session.getState().pending;   // the recording went to speech-to-text with this on screen
  assert.deepEqual(await session.confirmPending(), { ok: true, action: "confirm" });   // ... then the button was clicked
  const late = await session.heard("yes", { pendingAtStart });
  assert.deepEqual(late, { ok: true, action: "late-answer" });
  assert.equal(server.turns().length, 1, "the late yes never reached /turn");
  assert.equal(server.confirms().length, 1, "and confirmed nothing a second time");
  assert.equal(lastTurn(session).content, LATE_ANSWER);
  assert.equal(lastTurn(session).kind, "notice");
  assert.equal(lastTurn(session).inHistory, false);

  // the same after a Cancel, for a late no as well; and a late answer that is not a bare yes / no is an ordinary message
  for (const said of ["Yes please.", "no"]) {
    const c = await withPending();
    const at = c.session.getState().pending;
    await c.session.cancelPending();
    assert.deepEqual(await c.session.heard(said, { pendingAtStart: at }), { ok: true, action: "late-answer" }, said);
    assert.equal(c.server.turns().length, 1, said);
    assert.equal(c.server.confirms().length, 0, said);
  }
  const other = await withPending();
  const at = other.session.getState().pending;
  await other.session.cancelPending();
  assert.deepEqual(await other.session.heard("what are rates today", { pendingAtStart: at }), { ok: true, action: "turn" });
  assert.equal(messagesOf(other.server.turns()[1]).at(-1).content, "what are rates today");

  // a read-back that arrived while the clip was being transcribed is never answered by it either
  const fresh = setup({ routes: pendingRoutes() });
  const before = fresh.session.getState().pending;   // nothing pending when the recording went off
  await fresh.session.submit("log a contact for the Chens");   // typed meanwhile; the read-back is now on screen
  assert.deepEqual(await fresh.session.heard("yes", { pendingAtStart: before }), { ok: true, action: "late-answer" });
  assert.equal(fresh.server.confirms().length, 0);
  assert.notEqual(fresh.session.getState().pending, null, "the read-back is still waiting for an answer the user gives to it");

  // unchanged pending: the spoken yes confirms as before
  const same = await withPending({ "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }) });
  assert.deepEqual(await same.session.heard("yes", { pendingAtStart: same.session.getState().pending }), { ok: true, action: "confirm" });
  assert.equal(same.server.confirms().length, 1);
});

test("B2: the pending card's rows are the server's details (every field to be written); they never go to /confirm", async () => {
  const ADD = { type: "addClient", fields: { name: "Jane Doe", loanType: "30yr_fixed", currentRate: 7.1, loanBalance: 300000, propertyValue: 450000 }, confirmId: "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f" };
  const ROWS = [
    { label: "Name", value: "Jane Doe" }, { label: "Loan type", value: "30-year fixed" }, { label: "Rate", value: "7.1%" },
    { label: "Balance", value: "$300,000" }, { label: "Property value", value: "$450,000" }, { label: "Credit score", value: "700 (none given)" },
  ];
  const ADD_READ_BACK = "Just to confirm — add Jane Doe, 30-year fixed at 7.1 percent, balance $300,000, value $450,000; no credit score given, so 700 will be used?";
  const { session, server } = setup({
    routes: {
      "POST /api/assistant/turn": queue(turnReply(ADD_READ_BACK, {
        sideEffect: ADD, details: [...ROWS, { label: "", value: "x" }, { label: "Bad", value: { nested: true } }, null, "junk"],
      })),
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: { id: 1, name: "Jane Doe" }, reply: "Done — I added Jane Doe as a new client." }),
    },
  });
  await session.submit("add Jane Doe as a client");
  assert.deepEqual(session.getState().pending, { sideEffect: ADD, readBack: ADD_READ_BACK, details: ROWS }, "only label/value string pairs are kept");
  assert.deepEqual(pendingRows(session.getState().pending), ROWS);
  await session.confirmPending();
  assert.deepEqual(server.confirms()[0].body, { sideEffect: ADD }, "the sideEffect verbatim, no details");

  // no details from the server: no rows, and the pending shape is unchanged
  const plain = await withPending();
  assert.deepEqual(plain.session.getState().pending, { sideEffect: SIDE_EFFECT, readBack: READ_BACK });
  assert.deepEqual(pendingRows(plain.session.getState().pending), []);
  assert.deepEqual(pendingRows(null), []);
});

// ── a client email set up as compose links (nothing to confirm, nothing sent) ──

const COMPOSE_REPLY = "Here's a check-in email for Robert & Linda Chen, ready on your screen. Open it in your email to review it and send it yourself — I don't send anything.";
const COMPOSE = {
  to: "chen@family.example",
  subject: "Checking in",
  body: "Hi Robert & Linda Chen,\n\nIt's been a little while since we last talked.\n\nBest,\nAnn User\nNMLS #123456",
  links: {
    gmail: "https://mail.google.com/mail/?view=cm&fs=1&to=chen%40family.example&su=Checking%20in&body=Hi",
    outlook: "https://outlook.office.com/mail/deeplink/compose?to=chen%40family.example&subject=Checking%20in&body=Hi",
    mailto: "mailto:chen%40family.example?subject=Checking%20in&body=Hi",
  },
};
const withLink = (key, value) => ({ ...COMPOSE, links: { ...COMPOSE.links, [key]: value } });

test("Task 7: a /turn reply with a valid compose keeps it on the assistant turn; nothing is pending and /confirm is never called", async () => {
  const { session, server, spoken } = setup({
    routes: { "POST /api/assistant/turn": queue(turnReply(COMPOSE_REPLY, { sources: ["client record"], turnId: "mail1", compose: COMPOSE })) },
  });
  assert.deepEqual(await session.submit("draft the Chens a check-in"), { ok: true, action: "turn" });
  const turn = lastTurn(session);
  assert.equal(turn.role, "assistant");
  assert.equal(turn.content, COMPOSE_REPLY);
  assert.equal(turn.kind, "message");
  assert.deepEqual(turn.sources, ["client record"]);
  assert.deepEqual(turn.compose, COMPOSE);
  assert.equal(session.getState().pending, null, "an email is set up, not a change to confirm");
  assert.deepEqual(spoken, [{ text: COMPOSE_REPLY, turnId: "mail1" }]);
  assert.equal(server.confirms().length, 0);
  assert.deepEqual(server.unexpected, []);
});

test("Task 7: the email never goes back to /turn - history is plain { role, content } and the compose stays on the turn", async () => {
  const { session, server } = setup({
    routes: { "POST /api/assistant/turn": queue(turnReply(COMPOSE_REPLY, { compose: COMPOSE }), turnReply("Anything else?")) },
  });
  await session.submit("draft the Chens a check-in");
  await session.submit("thanks");
  const sent = messagesOf(server.turns()[1]);
  assert.deepEqual(sent, [
    { role: "user", content: "draft the Chens a check-in" },
    { role: "assistant", content: COMPOSE_REPLY },
    { role: "user", content: "thanks" },
  ]);
  const wire = JSON.stringify(server.turns()[1].body);
  for (const never of ["chen@family.example", "chen%40family.example", "NMLS #123456", "mail.google.com", "mailto:"]) {
    assert.ok(!wire.includes(never), `"${never}" is not sent to the model`);
  }
});

test("Task 7: the compose keeps only the four fields and the three links, as copies", async () => {
  const sent = { ...COMPOSE, extra: "x", links: { ...COMPOSE.links, evil: "https://evil.test/" } };
  const { session } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply(COMPOSE_REPLY, { compose: sent })) } });
  await session.submit("draft the Chens a check-in");
  const kept = lastTurn(session).compose;
  assert.deepEqual(kept, COMPOSE);
  assert.deepEqual(Object.keys(kept), ["to", "subject", "body", "links"]);
  assert.deepEqual(Object.keys(kept.links), ["gmail", "outlook", "mailto"]);
  assert.notEqual(kept.links, sent.links);
});

test("Task 7: a compose with a link that is not an email-compose link is dropped whole; the reply is still shown and spoken", async () => {
  const bad = [
    withLink("gmail", "javascript:alert(1)"),
    withLink("outlook", "javascript:alert(1)"),
    withLink("mailto", "javascript:alert(1)"),
    withLink("gmail", "http://mail.google.com/mail/?view=cm"),
    withLink("gmail", "https://mail.google.com.evil.test/mail/"),
    withLink("gmail", "https://evil.test/https://mail.google.com/"),
    withLink("gmail", "data:text/html,<script>alert(1)</script>"),
    withLink("outlook", "https://outlook.office.com.evil.test/mail/"),
    withLink("outlook", "https://outlook.live.com/mail/deeplink/compose"),
    withLink("mailto", "https://mail.google.com/"),
    withLink("gmail", "HTTPS://MAIL.GOOGLE.COM/mail/"),
    withLink("gmail", ""),
    withLink("gmail", undefined),
    withLink("gmail", null),
    withLink("gmail", 5),
    withLink("gmail", ["https://mail.google.com/mail/"]),
    withLink("gmail", { href: "https://mail.google.com/mail/" }),
    { ...COMPOSE, links: { gmail: COMPOSE.links.gmail, outlook: COMPOSE.links.outlook } },
    { ...COMPOSE, links: {} },
    { ...COMPOSE, links: null },
    { ...COMPOSE, links: [COMPOSE.links.gmail, COMPOSE.links.outlook, COMPOSE.links.mailto] },
    { ...COMPOSE, links: "https://mail.google.com/" },
    { to: COMPOSE.to, subject: COMPOSE.subject, body: COMPOSE.body },
    { ...COMPOSE, to: 5 },
    { ...COMPOSE, to: undefined },
    { ...COMPOSE, subject: ["Checking in"] },
    { ...COMPOSE, body: { text: "Hi" } },
    { ...COMPOSE, body: null },
    [COMPOSE],
    "mailto:chen@family.example",
    42,
    true,
    null,
  ];
  for (const compose of bad) {
    const { session, spoken, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply(COMPOSE_REPLY, { turnId: "mail2", compose })) } });
    await session.submit("draft the Chens a check-in");
    const turn = lastTurn(session);
    assert.equal(turn.content, COMPOSE_REPLY, JSON.stringify(compose));
    assert.equal(turn.role, "assistant");
    assert.equal("compose" in turn, false, `dropped: ${JSON.stringify(compose)}`);
    assert.equal(session.getState().pending, null);
    assert.deepEqual(spoken, [{ text: COMPOSE_REPLY, turnId: "mail2" }]);
    assert.equal(server.confirms().length, 0);
  }
});

test("Task 7: a turn without a compose has none, and an error:true turn never keeps one", async () => {
  const plain = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("The 30-year is at 6.5%.")) } });
  await plain.session.submit("rates");
  assert.equal("compose" in lastTurn(plain.session), false);

  const failed = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Sorry — something went wrong.", { error: true, compose: COMPOSE })) } });
  await failed.session.submit("draft the Chens a check-in");
  assert.equal(lastTurn(failed.session).kind, "error");
  assert.equal("compose" in lastTurn(failed.session), false);
});

test("a yes with nothing pending is an ordinary answer to Charli's question and goes to /turn", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Which would you like?")) } });
  await session.submit("yes");
  assert.equal(server.confirms().length, 0);
  assert.deepEqual(messagesOf(server.turns()[0]), [{ role: "user", content: "yes" }]);
});

test("a /confirm that fails for good (400/403/404/409) shows its error, clears the change and the session goes on", async () => {
  for (const [status, error] of [[400, "a valid clientId is required"], [403, "Not allowed"], [404, "Client not found"], [409, "confirmId already used"]]) {
    const { session, server, spoken } = await withPending({ "POST /api/assistant/confirm": () => reply(status, { success: false, error }) });
    const result = await session.submit("yes");
    assert.deepEqual(result, { ok: true, action: "confirm" });
    const shown = lastTurn(session);
    assert.equal(shown.kind, "error");
    assert.ok(shown.content.includes(error), `${status}: shows the server's error`);
    assert.equal(spoken.at(-1).text, shown.content);
    assert.equal(session.getState().pending, null);

    // the failure line follows the read-back in the history, so the read-back is no longer the last thing said
    await session.submit("what are rates today");
    assert.deepEqual(messagesOf(server.turns()[1]).map((m) => m.role), ["user", "assistant", "assistant", "user"]);
    assert.equal(lastTurn(session).content, "The 30-year is at 6.5%.");
  }
});

test("a /confirm that fails with field errors reads them out", async () => {
  const { session } = await withPending({ "POST /api/assistant/confirm": () => reply(400, { success: false, errors: { name: "Name is required" } }) });
  await session.submit("yes");
  assert.ok(lastTurn(session).content.includes("Name is required"));
});

test("a /confirm that may be retried (network, 500, 429) keeps the change; saying yes again retries with the same confirmId", async () => {
  for (const failure of [() => { throw new TypeError("Failed to fetch"); }, () => reply(500, { success: false, error: "Database error" }), () => reply(429, { error: "slow down" })]) {
    let n = 0;
    const { session, server } = await withPending({
      "POST /api/assistant/confirm": () => (++n === 1 ? failure() : reply(200, { success: true, result: {}, reply: "Done — I logged a contact for Robert and Linda Chen." })),
    });
    await session.submit("yes");
    assert.equal(lastTurn(session).kind, "notice");
    assert.deepEqual(session.getState().pending, { sideEffect: SIDE_EFFECT, readBack: READ_BACK });

    await session.submit("yes");
    assert.equal(server.confirms().length, 2);
    assert.deepEqual(server.confirms()[1].body, { sideEffect: SIDE_EFFECT });
    assert.equal(lastTurn(session).content, "Done — I logged a contact for Robert and Linda Chen.");
    assert.equal(session.getState().pending, null);
    assert.equal(server.turns().length, 1);
  }
});

test("Final fix (Ruling 53): a /confirm that is still being worked on (409 pending:true) keeps the card and says so; a later yes gets the done reply", async () => {
  assert.equal(STILL_WORKING, "Still working on that — give it a moment, then say yes again.");
  let n = 0;
  const { session, server, spoken } = await withPending({
    "POST /api/assistant/confirm": () => (++n === 1
      ? reply(409, { success: false, error: "still working on that one", pending: true })
      : reply(200, { success: true, result: { id: 7 }, reply: "Done — I logged a contact for Robert and Linda Chen.", duplicate: true })),
  });
  const pending = session.getState().pending;
  assert.deepEqual(await session.submit("yes"), { ok: true, action: "confirm" });
  assert.equal(session.getState().pending, pending, "the pending change is kept as it was");
  assert.equal(lastTurn(session).kind, "notice");
  assert.equal(lastTurn(session).content, STILL_WORKING);
  assert.equal(spoken.at(-1).text, STILL_WORKING);
  assert.ok(session.getState().turns.every((t) => !String(t.content).includes("didn't go through")), "it is not reported as a failure");

  await session.submit("yes");
  assert.deepEqual(server.confirms().map((c) => c.body), [{ sideEffect: SIDE_EFFECT }, { sideEffect: SIDE_EFFECT }], "the same confirmId both times");
  assert.equal(lastTurn(session).content, "Done — I logged a contact for Robert and Linda Chen.");
  assert.equal(session.getState().pending, null);
  assert.equal(server.turns().length, 1, "nothing went to /turn");
});

test("Final fix (Ruling 53): a 409 without pending:true is still final", async () => {
  const { session } = await withPending({
    "POST /api/assistant/confirm": () => reply(409, { success: false, error: "still working on that one", pending: "yes" }),
  });
  await session.submit("yes");
  assert.equal(session.getState().pending, null);
  assert.equal(lastTurn(session).kind, "error");
});

// ── silence, one thing at a time ─────────────────────────────────────────────

test("empty speech-to-text shows and speaks 'I didn't catch that', is not sent anywhere and is not in the history", async () => {
  const { session, server, spoken } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Rates are 6.5%."), turnReply("Sure.")) } });
  for (const empty of ["", "   ", undefined]) {
    assert.deepEqual(await session.heard(empty), { ok: true, action: "didnt-catch" });
  }
  assert.equal(DIDNT_CATCH, "I didn't catch that — could you say it again?");
  const notices = session.getState().turns;
  assert.equal(notices.length, 3);
  assert.ok(notices.every((t) => t.content === DIDNT_CATCH && t.kind === "notice" && !t.inHistory));
  // B8 FLIP (was spoken three times): only the first empty transcript of a run is spoken; the rest are shown silently
  assert.deepEqual(spoken.map((s) => s.text), [DIDNT_CATCH]);
  assert.equal(server.turns().length, 0);

  await session.heard("what are rates today");
  assert.deepEqual(messagesOf(server.turns()[0]), [{ role: "user", content: "what are rates today" }], "the notice never reaches /turn");

  // a transcript with words ends the run: the next empty one is spoken again, once
  await session.heard("");
  await session.heard("(background noise)");
  assert.deepEqual(spoken.map((s) => s.text), [DIDNT_CATCH, "Rates are 6.5%.", DIDNT_CATCH]);
  assert.equal(session.getState().turns.filter((t) => t.content === DIDNT_CATCH).length, 5, "every one is still shown");
});

test("B8: a can't-verify or guideline hand-off reply is marked 'unverified' (the 'unable to verify' chip); other replies are not", async () => {
  const { session } = setup({
    routes: {
      "POST /api/assistant/turn": queue(
        turnReply(CANT_VERIFY), turnReply(GUIDELINE_HANDOFF), turnReply("The 30-year is at 6.5%.", { sources: ["live rates 2026-10-25"] }),
        turnReply(`LTV is loan to value. ${CANT_VERIFY}`, { sources: ["Broker Radar glossary"] }),
      ),
    },
  });
  await session.submit("what's Chen's balance?");
  assert.equal(lastTurn(session).kind, "unverified");
  assert.equal(lastTurn(session).inHistory, true, "it is still Charli's turn in the conversation");
  await session.submit("what's the max DTI?");
  assert.equal(lastTurn(session).kind, "unverified");
  await session.submit("rates?");
  assert.equal(lastTurn(session).kind, "message");
  await session.submit("what's LTV and DSCR?");
  assert.equal(lastTurn(session).kind, "message", "only a reply that IS the line is marked");
});

test("B8: the client's can't-verify and guideline lines match the server's prompt.js", { skip: !existsSync(new URL("../../../server/lib/assistant/prompt.js", import.meta.url)) }, () => {
  const server = createRequire(import.meta.url)("../../../server/lib/assistant/prompt.js");
  assert.equal(CANT_VERIFY, server.CANT_VERIFY);
  assert.equal(GUIDELINE_HANDOFF, server.GUIDELINE_HANDOFF);
});

test("heard(text) with words is a normal submit", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Sure.")) } });
  assert.deepEqual(await session.heard("run a sweep"), { ok: true, action: "turn" });
  assert.equal(messagesOf(server.turns()[0]).at(-1).content, "run a sweep");
});

test("one request at a time: a second utterance while Charli is thinking is refused, and a yes cannot be read against a read-back that has not arrived", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, server } = setup({
    routes: {
      "POST /api/assistant/turn": async () => { await gate; return turnReply(READ_BACK, { sideEffect: SIDE_EFFECT }); },
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done." }),
    },
  });
  const first = session.submit("log a contact for the Chens");
  assert.equal(session.getState().busy, true);
  assert.deepEqual(await session.submit("yes"), { ok: false, reason: "busy" });
  assert.deepEqual(await session.heard(""), { ok: false, reason: "busy" });
  assert.deepEqual(await session.setStage("veteran"), { ok: false, reason: "busy" });
  release();
  await first;
  assert.equal(server.turns().length, 1);
  assert.equal(server.confirms().length, 0, "the early yes wrote nothing");
  assert.notEqual(session.getState().pending, null, "the read-back is still waiting for a yes");
  assert.equal(session.getState().busy, false);
});

// ── the stage selector ───────────────────────────────────────────────────────

test("stage change: /confirm {setCareerStage, stage}, the reply is appended and spoken, then the stage is refreshed from /api/auth/me", async () => {
  const { session, server, spoken } = setup({
    user: { careerStage: "new" },
    routes: {
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: { stage: "veteran", label: "Veteran (10+ years)" }, reply: "Done — your career stage is set to Veteran, ten or more years." }),
      "GET /api/auth/me": me("veteran"),
    },
  });
  assert.equal(session.getState().careerStage, "new");
  assert.deepEqual(await session.setStage("veteran"), { ok: true, action: "stage" });

  assert.deepEqual(server.confirms()[0].body, { sideEffect: { type: "setCareerStage", stage: "veteran" } });
  assert.equal(lastTurn(session).content, "Done — your career stage is set to Veteran, ten or more years.");
  assert.deepEqual(spoken.at(-1), { text: "Done — your career stage is set to Veteran, ten or more years.", turnId: undefined });
  assert.equal(session.getState().careerStage, "veteran");
  const order = server.calls.map((c) => `${c.method} ${c.url}`);
  assert.ok(order.indexOf("GET /api/auth/me") > order.indexOf("POST /api/assistant/confirm"), "refreshed after the write");
  assert.equal(server.turns().length, 0);
});

test("stage change: if /api/auth/me cannot be read the chosen stage is shown", async () => {
  const { session } = setup({
    routes: {
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: { stage: "developing" }, reply: "Done." }),
      "GET /api/auth/me": () => { throw new TypeError("offline"); },
    },
  });
  await session.setStage("developing");
  assert.equal(session.getState().careerStage, "developing");
});

test("stage change that fails is a notice; the stage stays, a pending read-back is untouched, and unknown ids send nothing", async () => {
  const { session, server } = setup({
    user: { careerStage: "new" },
    routes: {
      "POST /api/assistant/turn": queue(turnReply(READ_BACK, { sideEffect: SIDE_EFFECT })),
      "POST /api/assistant/confirm": () => reply(400, { success: false, error: "a valid career stage is required" }),
    },
  });
  await session.submit("log a contact for the Chens");
  assert.deepEqual(await session.setStage("veteran"), { ok: false, reason: "failed" });
  assert.equal(lastTurn(session).kind, "notice");
  assert.ok(lastTurn(session).content.includes("a valid career stage is required"));
  assert.equal(session.getState().careerStage, "new");
  assert.notEqual(session.getState().pending, null);

  const before = server.calls.length;
  assert.deepEqual(await session.setStage("guru"), { ok: false, reason: "invalid" });
  assert.deepEqual(await session.setStage(undefined), { ok: false, reason: "invalid" });
  assert.equal(server.calls.length, before);
});

test("a career-stage change confirmed by voice (the greeting's question) refreshes the shown stage too", async () => {
  const { session, server } = setup({
    routes: {
      "POST /api/assistant/turn": queue(
        turnReply("Quick question before we dive in — how long have you been originating?"),
        turnReply("So that's Veteran (10+ years) — shall I set that?", { sideEffect: STAGE_SIDE_EFFECT }),
      ),
      "POST /api/assistant/confirm": () => reply(200, { success: true, result: { stage: "veteran", label: "Veteran (10+ years)" }, reply: "Done — your career stage is set to Veteran, ten or more years." }),
    },
  });
  server.calls.length = 0;
  await session.open();
  await session.submit("about 20 years");
  assert.deepEqual(session.getState().pending.sideEffect, STAGE_SIDE_EFFECT);

  const meCallsBefore = server.calls.filter((c) => c.url === "/api/auth/me").length;
  await session.submit("yes");
  assert.deepEqual(server.confirms()[0].body, { sideEffect: STAGE_SIDE_EFFECT });
  assert.ok(server.calls.filter((c) => c.url === "/api/auth/me").length > meCallsBefore, "re-read /api/auth/me after the stage was set");
});

// ── plumbing ─────────────────────────────────────────────────────────────────

test("subscribe is notified on every change; dispose stops notifications and speech", async () => {
  const { session, spoken } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("One."), turnReply("Two.")) } });
  const seen = [];
  const off = session.subscribe((s) => seen.push(s.turns.length));
  await session.submit("a");
  assert.ok(seen.length >= 3, "busy on, turns added, busy off");
  assert.equal(seen.at(-1), 2);
  off();
  const count = seen.length;
  await session.submit("b");
  assert.equal(seen.length, count);

  session.subscribe(() => seen.push("late"));
  session.dispose();
  const spokenBefore = spoken.length;
  session.notice("after dispose", { say: true });
  assert.equal(spoken.length, spokenBefore);
  assert.ok(!seen.includes("late"));
});

test("an in-flight reply that lands after dispose is ignored", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, spoken } = setup({ routes: { "POST /api/assistant/turn": async () => { await gate; return turnReply("Too late."); } } });
  const pending = session.submit("hello");
  session.dispose();
  release();
  await pending;
  assert.equal(spoken.length, 0);
});

test("after dispose nothing is sent: a late utterance (say, one still being transcribed) is refused", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hi.")) } });
  session.dispose();
  assert.deepEqual(await session.submit("hello"), { ok: false, reason: "closed" });
  assert.deepEqual(await session.heard("hello"), { ok: false, reason: "closed" });
  assert.deepEqual(await session.setStage("veteran"), { ok: false, reason: "closed" });
  assert.equal(server.calls.length, 0);
});

// ── leaving the screen and coming back ───────────────────────────────────────

test("coming back after leave() shows the same conversation and does not greet again", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Good morning."), turnReply("Sure.")) } });
  await session.open();
  await session.submit("run a sweep");
  const before = session.getState().turns;
  session.leave();
  await session.open();
  assert.equal(server.turns().length, 2, "one greeting and one turn: no second greeting");
  assert.deepEqual(session.getState().turns, before);
  assert.equal(session.getState().opening, false);
});

test("coming back re-reads the shown stage from /api/auth/me", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hi.")) } });
  await session.open();
  const reads = () => server.calls.filter((c) => c.url === "/api/auth/me").length;
  const first = reads();
  session.leave();
  await session.open();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads(), first + 1);
});

test("leaving drops a change still waiting for a yes: the transcript and the history say so, nothing is spoken", async () => {
  const { session, server, spoken } = setup({
    routes: { "POST /api/assistant/turn": queue(turnReply("Hi."), turnReply(READ_BACK, { sideEffect: SIDE_EFFECT }), turnReply("Sure.")) },
  });
  await session.open();
  await session.submit("log a contact for the Chens");
  const spokenBefore = spoken.length;
  session.leave();
  assert.equal(session.getState().pending, null);
  assert.equal(lastTurn(session).content, LEFT_UNCONFIRMED);
  assert.equal(spoken.length, spokenBefore);
  await session.open();
  assert.deepEqual(await session.submit("yes"), { ok: true, action: "turn" }, "with nothing pending a yes is an ordinary message");
  assert.equal(server.confirms().length, 0);
  assert.deepEqual(messagesOf(server.turns()[2]).slice(-3), [
    { role: "assistant", content: READ_BACK }, { role: "assistant", content: LEFT_UNCONFIRMED }, { role: "user", content: "yes" },
  ]);
});

test("a reply that lands after leave() is kept for when the user comes back, but never spoken", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, spoken } = setup({ routes: { "POST /api/assistant/turn": async () => { await gate; return turnReply("Rates are flat."); } } });
  const inFlight = session.submit("how are rates");
  session.leave();
  release();
  await inFlight;
  assert.equal(lastTurn(session).content, "Rates are flat.");
  assert.equal(spoken.length, 0);
  assert.equal(session.getState().busy, false);
});

test("a read-back that lands after leave() is not left waiting for a yes", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, spoken } = setup({
    routes: { "POST /api/assistant/turn": async () => { await gate; return turnReply(READ_BACK, { sideEffect: SIDE_EFFECT }); } },
  });
  const inFlight = session.submit("log a contact for the Chens");
  session.leave();
  release();
  await inFlight;
  assert.deepEqual(session.getState().turns.slice(-2).map((t) => t.content), [READ_BACK, LEFT_UNCONFIRMED]);
  assert.equal(session.getState().pending, null);
  assert.equal(spoken.length, 0);
});

test("a confirm already sent when the user leaves finishes, and its result is shown (not spoken)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, spoken } = await withPending({
    "POST /api/assistant/confirm": async () => { await gate; return reply(200, { success: true, result: {}, reply: "Logged." }); },
  });
  const spokenBefore = spoken.length;
  const confirming = session.confirmPending();
  session.leave();
  release();
  await confirming;
  assert.equal(session.getState().pending, null);
  assert.equal(lastTurn(session).content, "Logged.");
  assert.equal(spoken.length, spokenBefore);
});

test("a confirm that could not finish while the user was away is not left waiting, and the user is told to check it", async () => {
  for (const answer of [reply(503, { error: "busy" }), reply(409, { pending: true })]) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { session } = await withPending({ "POST /api/assistant/confirm": async () => { await gate; return answer; } });
    const confirming = session.confirmPending();
    session.leave();
    release();
    await confirming;
    assert.equal(session.getState().pending, null, String(answer.status));
    assert.equal(lastTurn(session).content, LEFT_UNFINISHED, "it may have gone through: never 'I didn't make that change'");
  }
});

test("a view-level notice that comes in while away (say, a transcription that failed after the user left) is dropped", async () => {
  const { session, spoken } = setup();
  session.leave();
  session.notice("Sorry, I couldn't make that out. Could you say it again?", { say: true });
  assert.equal(session.getState().turns.length, 0);
  assert.equal(spoken.length, 0);
});

test("while away nothing is sent: a late utterance or a typed line is refused until the user comes back", async () => {
  const { session, server } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hi."), turnReply("Sure.")) } });
  session.leave();
  assert.deepEqual(await session.submit("hello"), { ok: false, reason: "closed" });
  assert.deepEqual(await session.heard("hello"), { ok: false, reason: "closed" });
  assert.deepEqual(await session.heard(""), { ok: false, reason: "closed" });
  assert.deepEqual(await session.setStage("veteran"), { ok: false, reason: "closed" });
  assert.equal(server.calls.length, 0);
  await session.open();
  assert.deepEqual(await session.submit("hello"), { ok: true, action: "turn" });
});

test("a view-level notice is shown (and spoken on request) but never enters the history", async () => {
  const { session, server, spoken } = setup({ routes: { "POST /api/assistant/turn": queue(turnReply("Hi.")) } });
  session.notice("I couldn't hear the microphone.", { say: true });
  assert.equal(lastTurn(session).kind, "notice");
  assert.equal(spoken.length, 1);
  await session.submit("hello");
  assert.deepEqual(messagesOf(server.turns()[0]), [{ role: "user", content: "hello" }]);
});

// ── request timeouts ─────────────────────────────────────────────────────────

// Wraps fakeServer's fetch: the first `hangFirst` calls to each url in `hang` never answer until the request's signal aborts (then
// they reject, as fetch does); `ignoreSignal` hangs for good, as a fetch that does not look at the signal would. Every call is logged.
function hangingFetch(server, { hang = [], hangFirst = 1, ignoreSignal = false } = {}) {
  const posted = [];
  const hung = [];
  const seen = {};
  const fetch = (url, init = {}) => {
    posted.push({ url, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
    seen[url] = (seen[url] || 0) + 1;
    if (!hang.includes(url) || seen[url] > hangFirst) return server.fetch(url, init);
    hung.push({ url, signal: init.signal });
    return new Promise((_resolve, reject) => {
      if (!ignoreSignal && init.signal) init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  };
  return { fetch, posted, hung };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));   // setImmediate is not mocked: this drains the microtasks
function setupHanging(options, routes = {}) {
  const server = fakeServer({ "GET /api/auth/me": me(), ...routes });
  const net = hangingFetch(server, options);
  const spoken = [];
  const session = createSession({ fetch: net.fetch, rates: RATES, localHour: 9, user: { careerStage: null }, onSpeak: (s) => spoken.push(s) });
  return { session, server, net, spoken };
}

// (final fix, Ruling 53: /confirm gets 35 s like /turn: a booking can take the server ~20 s, a token refresh and the insert)
test("the request timeouts are pinned: turn 35 s (the server's 25 s deadline plus a margin), confirm 35 s, auth/me 10 s", () => {
  assert.deepEqual({ ...REQUEST_TIMEOUTS }, { "/api/assistant/turn": 35_000, "/api/assistant/confirm": 35_000, "/api/auth/me": 10_000 });
  assert.ok(Object.isFrozen(REQUEST_TIMEOUTS));
  assert.equal(TOOK_TOO_LONG_CLIENT, "That took too long on my end — could you say it again?");
});

test("a /turn that never answers is given up on at 35 s: the line is shown and spoken, busy resets, nothing is written, the next turn works", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, server, net, spoken } = setupHanging({ hang: ["/api/assistant/turn"] }, { "POST /api/assistant/turn": queue(turnReply("Back.")) });
  const pending = session.submit("what are rates today");
  await flush();
  assert.equal(session.getState().busy, true);
  t.mock.timers.tick(34_999);
  await flush();
  assert.equal(session.getState().busy, true, "not before the 35 s");
  assert.equal(net.hung[0].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true, action: "turn" });

  assert.equal(net.hung[0].signal.aborted, true, "the request itself was cancelled");
  assert.equal(session.getState().busy, false);
  assert.equal(session.getState().pending, null);
  assert.deepEqual(session.getState().turns.map((x) => [x.role, x.content, x.kind, x.inHistory]), [
    ["user", "what are rates today", "message", true],
    ["assistant", TOOK_TOO_LONG_CLIENT, "error", true],
  ]);
  assert.deepEqual(spoken, [{ text: TOOK_TOO_LONG_CLIENT, turnId: undefined }]);
  assert.equal(server.confirms().length, 0, "nothing is written");

  await session.submit("again");
  assert.deepEqual(messagesOf(server.turns()[0]).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(lastTurn(session).content, "Back.");
});

test("a fetch that ignores the abort signal cannot hang the session, and a reply that limps in after the timeout is dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, spoken } = setupHanging({ hang: ["/api/assistant/turn"], ignoreSignal: true });
  const pending = session.submit("what are rates today");
  await flush();
  t.mock.timers.tick(35_000);
  assert.deepEqual(await pending, { ok: true, action: "turn" });
  assert.equal(lastTurn(session).content, TOOK_TOO_LONG_CLIENT);
  assert.equal(session.getState().busy, false);

  // a late answer from a request that was already given up on never lands in the transcript
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  const lateSession = createSession({
    fetch: (url, init) => (url === "/api/assistant/turn" ? late : fakeServer({ "GET /api/auth/me": me() }).fetch(url, init)),
    rates: RATES, localHour: 9, user: { careerStage: null }, onSpeak: (s) => spoken.push(s),
  });
  const p2 = lateSession.submit("what are rates today");
  await flush();
  t.mock.timers.tick(35_000);
  await p2;
  const before = lateSession.getState().turns.length;
  release({ ok: true, status: 200, json: async () => ({ reply: "Too late.", sources: [], turnId: "x" }) });
  await flush();
  assert.equal(lateSession.getState().turns.length, before);
  assert.ok(lateSession.getState().turns.every((x) => x.content !== "Too late."));
});

test("a /confirm that times out at 35 s keeps the read-back; saying yes again re-posts the same confirmId, and that one lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, net, spoken } = setupHanging({ hang: ["/api/assistant/confirm"] }, pendingRoutes({
    "POST /api/assistant/confirm": () => reply(200, { success: true, result: {}, reply: "Done — I logged a contact for Robert and Linda Chen." }),
  }));
  await session.submit("log a contact for the Chens");
  const pending = session.getState().pending;
  assert.deepEqual(pending, { sideEffect: SIDE_EFFECT, readBack: READ_BACK });

  const first = session.submit("yes");
  await flush();
  t.mock.timers.tick(34_999);
  await flush();
  assert.equal(session.getState().busy, true, "not before the 35 s");
  t.mock.timers.tick(1);
  assert.deepEqual(await first, { ok: true, action: "confirm" });
  assert.equal(session.getState().busy, false);
  assert.equal(session.getState().pending, pending, "the pending change is kept as it was");
  assert.equal(lastTurn(session).kind, "notice");
  assert.equal(lastTurn(session).content, "I couldn't finish that just now. Say yes to try again, or cancel.");
  assert.equal(spoken.at(-1).text, "I couldn't finish that just now. Say yes to try again, or cancel.");
  assert.notEqual(lastTurn(session).content, TOOK_TOO_LONG_CLIENT);

  await session.submit("yes");
  const posts = net.posted.filter((p) => p.url === "/api/assistant/confirm");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.body), [{ sideEffect: SIDE_EFFECT }, { sideEffect: SIDE_EFFECT }], "the same confirmId both times");
  assert.equal(lastTurn(session).content, "Done — I logged a contact for Robert and Linda Chen.");
  assert.equal(session.getState().pending, null);
});

test("GET /api/auth/me is given up on at 10 s, and a request that answers in time is left alone (signal passed, never aborted)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = setupHanging({ hang: ["/api/auth/me"] }, { "POST /api/assistant/turn": queue(turnReply("Good morning.")) });
  const opening = slow.session.open();
  await flush();
  await opening;
  assert.equal(slow.net.hung.length, 1);
  t.mock.timers.tick(9_999);
  assert.equal(slow.net.hung[0].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(slow.net.hung[0].signal.aborted, true);
  await flush();
  assert.equal(slow.session.getState().careerStage, null, "a stage refresh that timed out changes nothing");

  // answered in time: every request carried a signal, none was aborted, and no timer is left to fire later
  const quick = setupHanging({}, { "POST /api/assistant/turn": queue(turnReply("Rates are 6.5%.")) });
  await quick.session.submit("what are rates today");
  assert.equal(lastTurn(quick.session).content, "Rates are 6.5%.");
  const turnPost = quick.net.posted.find((p) => p.url === "/api/assistant/turn");
  assert.ok(turnPost.signal instanceof AbortSignal);
  t.mock.timers.tick(100_000);
  await flush();
  assert.equal(turnPost.signal.aborted, false, "the timer was cleared when the reply came");
  assert.equal(lastTurn(quick.session).content, "Rates are 6.5%.");
});

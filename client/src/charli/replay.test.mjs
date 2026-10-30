// node --test src/charli/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplay, shouldClear } from "./replay.mjs";
import { createSession, LEAVE_THAT } from "./session.mjs";

test("nothing was cut off or missed: nothing is kept, and Resume just listens", () => {
  const replay = createReplay();
  assert.equal(replay.take(), null);
});

test("a line that finished playing is not kept", () => {
  const replay = createReplay();
  replay.said("A");   // she said it all the way through: Pause did not cut it
  assert.equal(replay.take(), null);
});

test("Pause while she is speaking keeps that line, and Resume gets it back once", () => {
  const replay = createReplay();
  replay.said("A");
  replay.cut();
  assert.equal(replay.take(), "A");
  assert.equal(replay.take(), null, "said once, then forgotten");
});

test("only the line she was on is kept: a newer line replaces an older one", () => {
  const replay = createReplay();
  replay.said("A");
  replay.said("B");
  replay.cut();
  assert.equal(replay.take(), "B");
});

test("Pause with nothing said keeps nothing", () => {
  const replay = createReplay();
  replay.cut();
  assert.equal(replay.take(), null);
});

test("a line that arrives while paused is kept, replacing an older kept one", () => {
  const replay = createReplay();
  replay.said("A");
  replay.cut();
  replay.held("B");
  assert.equal(replay.take(), "B");
  assert.equal(replay.take(), null);
});

test("a line that arrives while paused is kept when nothing was cut off", () => {
  const replay = createReplay();
  replay.held("B");
  assert.equal(replay.take(), "B");
});

test("a line handed back is not kept again by a second cut; said again, a second cut keeps it again", () => {
  const replay = createReplay();
  replay.said("A");
  replay.cut();
  assert.equal(replay.take(), "A");
  replay.cut();   // Resume spoke nothing new: there is no line to cut
  assert.equal(replay.take(), null);
  replay.said("A");   // Resume said A again, and Pause cut it off again
  replay.cut();
  assert.equal(replay.take(), "A");
});

test("pending resolved while paused clears the kept line", () => {
  const replay = createReplay();
  replay.said("Shall I log that call?");   // the read-back of a change waiting for a yes
  replay.cut();
  replay.clear();                          // the change was confirmed or cancelled
  assert.equal(replay.take(), null);
});

test("a new turn clears the kept line and the line she was on", () => {
  const replay = createReplay();
  replay.said("A");
  replay.cut();
  replay.clear();
  assert.equal(replay.take(), null);
  replay.said("B");
  replay.clear();
  replay.cut();   // the line she was on was dropped with the turn that made it stale
  assert.equal(replay.take(), null);
});

test("a line is handed back as it came in, so what the speaker needs travels with it", () => {
  const replay = createReplay();
  const line = { text: "A", turnId: "t1" };
  replay.said(line);
  replay.cut();
  assert.equal(replay.take(), line);
});

// ── which changes in the conversation make a kept line stale ──
const turn = (id, role) => ({ id, role, content: id });
const state = (turns, pending = null) => ({ turns, pending });
const readBack = { sideEffect: { type: "logContact" }, readBack: "Shall I log that?" };

test("a change waiting for a yes that is confirmed or cancelled makes the kept line stale", () => {
  const before = state([turn("t1", "assistant")], readBack);
  const after = state([turn("t1", "assistant")], null);
  assert.equal(shouldClear(before, after), true);
});

test("a change that appears, or is still waiting, does not", () => {
  const turns = [turn("t1", "assistant")];
  assert.equal(shouldClear(state(turns, null), state(turns, readBack)), false);
  assert.equal(shouldClear(state(turns, readBack), state(turns, readBack)), false);
  assert.equal(shouldClear(state(turns, null), state(turns, null)), false);
});

test("a new turn from the user makes it stale, wherever it came from (spoken, typed, a yes or a no)", () => {
  const before = state([turn("t1", "assistant")]);
  assert.equal(shouldClear(before, state([turn("t1", "assistant"), turn("t2", "user")])), true);
  assert.equal(shouldClear(state([turn("t1", "user")]), state([turn("t1", "user"), turn("t2", "assistant"), turn("t3", "user")])), true);
});

test("her own new lines, a busy flag flipping or an old user turn do not", () => {
  const turns = [turn("t1", "user"), turn("t2", "assistant")];
  assert.equal(shouldClear(state(turns), state([...turns, turn("t3", "assistant")])), false);
  assert.equal(shouldClear(state([]), state([turn("t1", "assistant")])), false);
  assert.equal(shouldClear({ ...state(turns), busy: false }, { ...state(turns), busy: true }), false);
});

// ── composed with the real session, wired the way CharliView wires it ──
// (voice.speak -> said / held; Pause -> cut then stop; Resume -> take; the session watched through subscribe so the clear runs
// inside set(), before the line spoken right after it.)
const SIDE_EFFECT = { type: "logContact", clientId: 7, confirmId: "0b6f5a58-1c3c-4a46-9b34-5d3a8f2a9c11" };
const READ_BACK = "Just to confirm, log a contact for Robert and Linda Chen?";

function screen(replies, options = {}) {
  const next = [...replies];
  const fetch = async (url) => {
    if (url === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ user: { careerStage: null } }) };   // open() re-reads the stage
    const body = await next.shift();
    return { ok: true, status: 200, json: async () => body };
  };
  const replay = createReplay();
  const played = [];
  const state = { paused: false, speaking: false };
  const session = createSession({
    fetch, rates: { rate_30yr_fixed: 6.5, rate_15yr_fixed: 5.9, rate_5_1_arm: 6.1, date: "2026-10-28", source: "live" }, localHour: 9,
    ...options,
    onSpeak: (line) => {
      if (state.paused) { replay.held(line); return; }
      replay.said(line);
      played.push(line.text);
      state.speaking = true;
    },
  });
  let last = session.getState();
  session.subscribe((now) => { if (shouldClear(last, now)) replay.clear(); last = now; });
  return {
    session, played,
    finish() { state.speaking = false; },
    pause() { state.paused = true; if (state.speaking) replay.cut(); state.speaking = false; },
    resume() { state.paused = false; const line = replay.take(); if (line) { replay.said(line); played.push(line.text); state.speaking = true; } },
  };
}
const readBackReply = { reply: READ_BACK, sources: [], turnId: "t-readback", sideEffect: SIDE_EFFECT };

test("paused mid read-back: Resume says the read-back again from the start, once, with the change still waiting", async () => {
  const s = screen([readBackReply]);
  await s.session.submit("log a call with the Chens");
  assert.deepEqual(s.played, [READ_BACK]);
  s.pause();
  s.resume();
  assert.deepEqual(s.played, [READ_BACK, READ_BACK]);
  assert.notEqual(s.session.getState().pending, null, "the yes / no is still being waited for");
  s.finish();
  s.pause();   // she finished the replay before this Pause
  s.resume();
  assert.deepEqual(s.played, [READ_BACK, READ_BACK], "a line that finished is not said a third time");
});

test("a change confirmed while paused: the read-back is not replayed, the result she gave is", async () => {
  const s = screen([readBackReply, { success: true, reply: "Done. I logged the call." }]);
  await s.session.submit("log a call with the Chens");
  s.pause();
  await s.session.confirmPending();
  s.resume();
  assert.deepEqual(s.played, [READ_BACK, "Done. I logged the call."]);
});

test("a change cancelled while paused: the read-back is not replayed, the line that says so is", async () => {
  const s = screen([readBackReply]);
  await s.session.submit("log a call with the Chens");
  s.pause();
  await s.session.cancelPending();
  s.resume();
  assert.deepEqual(s.played, [READ_BACK, LEAVE_THAT]);
});

test("a reply that arrives while paused is said on Resume", async () => {
  let arrive;
  const s = screen([{ reply: "Rates are steady today.", sources: [], turnId: "t1" }, new Promise((r) => { arrive = r; })]);
  await s.session.submit("what are rates doing");
  s.finish();
  const asking = s.session.submit("and the fifteen year?");
  s.pause();   // paused while the answer is still on its way
  arrive({ reply: "The fifteen year is a bit lower.", sources: [], turnId: "t2" });
  await asking;
  assert.deepEqual(s.played, ["Rates are steady today."], "not spoken while paused");
  s.resume();
  assert.deepEqual(s.played, ["Rates are steady today.", "The fifteen year is a bit lower."]);
});

test("a new turn typed while paused drops the kept line, even when Resume comes before the answer", async () => {
  let arrive;
  const s = screen([{ reply: "Rates are steady today.", sources: [], turnId: "t1" }, new Promise((r) => { arrive = r; })]);
  await s.session.submit("what are rates doing");
  s.pause();                                                // cut mid-line: "Rates are steady today." is kept
  const asking = s.session.submit("different question");   // typed while paused: that line is now stale
  s.resume();                                               // before the answer: nothing to say yet
  assert.deepEqual(s.played, ["Rates are steady today."], "the stale line is not said again");
  arrive({ reply: "Here is the answer to the new question.", sources: [], turnId: "t2" });
  await asking;
  assert.deepEqual(s.played, ["Rates are steady today.", "Here is the answer to the new question."]);
});

// ── "Brief me" (the briefing said again under the same turnId) ──
// (session.briefMe() hands the speaker the briefing turn's line with the turnId it came with. Nothing here is keyed on the turnId:
// replay holds the line itself, so saying the same turn a second time is just another line.)
const BRIEFING_LINE = "Good morning, Ann. The 30-year is at 6.52%. Want to start with Lucy Tran?";
const briefingReply = {
  reply: BRIEFING_LINE, sources: [], turnId: "b1",
  briefing: { kind: "morning", strip: { rate30: 6.52, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null }, followUp: null },
};

test("Brief me twice says the same turn twice; a Pause in the second keeps it, and Resume says it once", async () => {
  const s = screen([briefingReply], { speakGreeting: false });
  await s.session.open();
  assert.deepEqual(s.played, [], "the briefing is shown, not spoken");
  assert.deepEqual(await s.session.briefMe(), { ok: true });
  assert.deepEqual(s.played, [BRIEFING_LINE]);
  s.finish();
  assert.deepEqual(await s.session.briefMe(), { ok: true });   // same turnId again
  assert.deepEqual(s.played, [BRIEFING_LINE, BRIEFING_LINE]);
  s.pause();
  s.resume();
  assert.deepEqual(s.played, [BRIEFING_LINE, BRIEFING_LINE, BRIEFING_LINE], "cut mid-line: said again from the start, once");
  s.finish();
  s.pause();
  s.resume();
  assert.equal(s.played.length, 3, "a saying that finished is not kept for a fourth");
});

test("Brief me while paused is kept for Resume, once, and a finished saying before it is not said too", async () => {
  const s = screen([briefingReply], { speakGreeting: false });
  await s.session.open();
  await s.session.briefMe();
  s.finish();
  s.pause();
  assert.deepEqual(await s.session.briefMe(), { ok: true });
  assert.equal(s.played.length, 1, "nothing is spoken while paused");
  s.resume();
  assert.deepEqual(s.played, [BRIEFING_LINE, BRIEFING_LINE]);
  s.finish();
  s.pause();
  s.resume();
  assert.equal(s.played.length, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { HANDS_FREE_KEY, NO_SPEECH_MS, readHandsFree, writeHandsFree, talkLabel, stopAfterUtterance, noSpeechClockRuns, talkTap, speakingStatus, briefTapCounts, BRIEF_WAIT_MS } from "./talkMode.mjs";

test("talkTap: a tap on Talk while she speaks interrupts her; otherwise it opens or closes the mic, or resumes", () => {
  assert.equal(talkTap({ speaking: true, micLive: false }), "interrupt");
  assert.equal(talkTap({ speaking: true, micLive: true }), "interrupt");   // hands-free: the tap stops her, not the mic
  assert.equal(talkTap({ speaking: false, micLive: true }), "stop");
  assert.equal(talkTap({ speaking: false, micLive: false }), "start");
  assert.equal(talkTap(), "start");
  // paused comes first: Pause already stopped her, and the tap resumes
  assert.equal(talkTap({ paused: true }), "resume");
  assert.equal(talkTap({ paused: true, speaking: true, micLive: true }), "resume");
});

test("talkLabel: while she speaks the button invites the interruption, in both modes", () => {
  assert.equal(talkLabel({ handsFree: true, micLive: true, speaking: true }), "Talk");   // not "Stop listening": the tap stops her and keeps the mic
  assert.equal(talkLabel({ handsFree: true, micLive: false, speaking: true }), "Talk");
  assert.equal(talkLabel({ handsFree: false, micLive: true, speaking: true }), "Tap to talk");
  assert.equal(talkLabel({ handsFree: false, micLive: false, speaking: true }), "Tap to talk");
  assert.equal(talkLabel({ handsFree: true, micLive: false, starting: true, speaking: true }), "Starting…");
  // not speaking: as before
  assert.equal(talkLabel({ handsFree: true, micLive: true, speaking: false }), "Stop listening");
  assert.equal(talkLabel({ handsFree: false, micLive: true, speaking: false }), "Listening…");
});

test("speakingStatus: the status line says a tap on Talk interrupts her, when Talk can open the mic", () => {
  assert.equal(speakingStatus({ canTalk: true }), "Speaking… tap Talk to interrupt");
  assert.equal(speakingStatus(), "Speaking… tap Talk to interrupt");
  assert.equal(speakingStatus({ canTalk: false }), "Speaking…");
});

test("speakingStatus: while her line is still on its way (not heard yet), the status says so instead", () => {
  assert.equal(speakingStatus({ canTalk: true, heard: false }), "Getting her voice…");
  assert.equal(speakingStatus({ canTalk: false, heard: false }), "Getting her voice…");
  assert.equal(speakingStatus({ canTalk: true, heard: true }), "Speaking… tap Talk to interrupt");
});

test("briefTapCounts: a second Brief me tap while the briefing is still on its way is ignored; any other tap counts", () => {
  const waiting = { askedAt: 1000, now: 6000, speaking: true, heard: false };
  assert.equal(briefTapCounts(waiting), false, "asked 5 s ago, on its way, not heard yet: a new request would start the wait over");
  assert.equal(briefTapCounts({ ...waiting, heard: true }), true, "she is heard: a tap says it again from the top, as before");
  assert.equal(briefTapCounts({ ...waiting, speaking: false }), true, "nothing is on its way (it failed, was blocked, or was yesterday's)");
  assert.equal(briefTapCounts({ ...waiting, askedAt: null }), true, "another line is on its way, not a briefing: Brief me cuts in, as before");
  assert.equal(briefTapCounts({ ...waiting, now: 1000 + BRIEF_WAIT_MS - 1 }), false);
  assert.equal(briefTapCounts({ ...waiting, now: 1000 + BRIEF_WAIT_MS }), true, "waited too long: the tap goes through");
  assert.equal(BRIEF_WAIT_MS, 20000);
  assert.equal(briefTapCounts(), true);
});

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
};
const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
};

test("the Hands-free setting has one key per device", () => {
  assert.equal(HANDS_FREE_KEY, "br.charlie.handsFree");
});

test("Hands-free is on only when the device stored \"1\"", () => {
  assert.equal(readHandsFree(fakeStorage({ [HANDS_FREE_KEY]: "1" })), true);
  assert.equal(readHandsFree(fakeStorage({ [HANDS_FREE_KEY]: "0" })), false);
  assert.equal(readHandsFree(fakeStorage()), false, "never set: tap to talk");
  assert.equal(readHandsFree(fakeStorage({ [HANDS_FREE_KEY]: "true" })), false, "only \"1\" counts");
});

test("a storage that throws, or none at all, reads as tap to talk", () => {
  assert.equal(readHandsFree(throwing), false);
  assert.equal(readHandsFree(undefined), false);
  assert.equal(readHandsFree(null), false);
});

test("writing the setting stores \"1\" or \"0\"", () => {
  const storage = fakeStorage();
  writeHandsFree(storage, true);
  assert.equal(storage.data[HANDS_FREE_KEY], "1");
  writeHandsFree(storage, false);
  assert.equal(storage.data[HANDS_FREE_KEY], "0");
});

test("a storage that throws, or none at all, never breaks a write", () => {
  assert.doesNotThrow(() => writeHandsFree(throwing, true));
  assert.doesNotThrow(() => writeHandsFree(undefined, true));
  assert.doesNotThrow(() => writeHandsFree(null, false));
});

test("the mic closes after 8 seconds with nothing heard", () => {
  assert.equal(NO_SPEECH_MS, 8000);
});

test("the Talk button label follows the mode and the mic", () => {
  assert.equal(talkLabel({ handsFree: false, micLive: false, starting: true, paused: false }), "Starting…");
  assert.equal(talkLabel({ handsFree: true, micLive: false, starting: true, paused: false }), "Starting…");
  assert.equal(talkLabel({ handsFree: true, micLive: true, starting: false, paused: false }), "Stop listening");
  assert.equal(talkLabel({ handsFree: true, micLive: false, starting: false, paused: false }), "Talk");
  assert.equal(talkLabel({ handsFree: false, micLive: true, starting: false, paused: false }), "Listening…");
  assert.equal(talkLabel({ handsFree: false, micLive: false, starting: false, paused: false }), "Tap to talk");
});

test("paused, a starting mic does not read \"Starting…\"", () => {
  assert.equal(talkLabel({ handsFree: false, micLive: false, starting: true, paused: true }), "Tap to talk");
  assert.equal(talkLabel({ handsFree: true, micLive: false, starting: true, paused: true }), "Talk");
});

test("tap to talk stops the mic after one utterance; hands-free keeps it open", () => {
  assert.equal(stopAfterUtterance(false), true);
  assert.equal(stopAfterUtterance(true), false);
});

test("the no-speech wait counts only while the mic can capture", () => {
  const open = { micLive: true, paused: false, speaking: false, working: false, voiceDown: false };
  assert.equal(noSpeechClockRuns(open), true);
  assert.equal(noSpeechClockRuns({ ...open, micLive: false }), false, "mic not live");
  assert.equal(noSpeechClockRuns({ ...open, paused: true }), false, "paused");
  assert.equal(noSpeechClockRuns({ ...open, speaking: true }), false, "she is speaking (half-duplex)");
  assert.equal(noSpeechClockRuns({ ...open, working: true }), false, "a reply is being worked out");
  assert.equal(noSpeechClockRuns({ ...open, voiceDown: true }), false, "speech-to-text is not set up");
  assert.equal(noSpeechClockRuns({}), false, "nothing known: no clock");
});

import test from "node:test";
import assert from "node:assert/strict";
import { HANDS_FREE_KEY, NO_SPEECH_MS, readHandsFree, writeHandsFree, talkLabel, stopAfterUtterance, noSpeechClockRuns } from "./talkMode.mjs";

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

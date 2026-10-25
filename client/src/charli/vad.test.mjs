// node --test src/charli/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVad, VAD_DEFAULTS } from "./vad.mjs";

const TICK = VAD_DEFAULTS.tickMs;
// Most tests are about the start/stop rules, not the opening calibration, so they skip it.
const make = (options) => createVad({ calibrateMs: 0, ...options });

// Feeds `levels` (one per tick) starting at `from`; returns [events with their time, next time].
function feed(vad, levels, from = 0) {
  const events = [];
  let now = from;
  for (const level of levels) {
    const ev = vad.push(level, now);
    if (ev) events.push({ ...ev, at: now });
    now += TICK;
  }
  return [events, now];
}
const run = (level, ms) => Array(Math.round(ms / TICK)).fill(level);

test("quiet room: nothing starts, however long it lasts", () => {
  const vad = make();
  const [events] = feed(vad, run(0.004, 10_000));
  assert.deepEqual(events, []);
  assert.equal(vad.recording, false);
});

test("an utterance starts on the first loud reading and ends after 900 ms of quiet, and is kept", () => {
  const vad = make();
  const [quiet, t1] = feed(vad, run(0.004, 600));
  const [talk, t2] = feed(vad, run(0.12, 1200), t1);
  const [events] = feed(vad, run(0.004, 2000), t2);
  assert.deepEqual(quiet, []);
  assert.deepEqual(talk.map((e) => e.type), ["start"]);
  assert.equal(talk[0].at, t1, "starts at the first loud reading");
  assert.equal(events.length, 1);
  const end = events[0];
  assert.equal(end.type, "end");
  assert.equal(end.reason, "silence");
  assert.equal(end.keep, true);
  assert.ok(end.at - (t2 - TICK) >= VAD_DEFAULTS.silenceMs && end.at - (t2 - TICK) < VAD_DEFAULTS.silenceMs + TICK, "ends ~900 ms after the last voiced reading");
  assert.ok(end.voicedMs >= 1200 - TICK);
});

test("a blip shorter than 300 ms is discarded (keep: false), but a short word is kept", () => {
  const blip = make();
  const [a, t] = feed(blip, [0.2], 0);
  const [b] = feed(blip, run(0.004, 1500), t);
  assert.deepEqual(a.map((e) => e.type), ["start"]);
  assert.equal(b[0].type, "end");
  assert.equal(b[0].keep, false);
  assert.ok(b[0].voicedMs < VAD_DEFAULTS.minVoicedMs);

  const word = make();
  feed(word, run(0.1, 300));
  const [events] = feed(word, run(0.004, 1500), 300);
  assert.equal(events[0].keep, true, "a 300 ms word such as 'no' is not a blip");
});

test("a pause shorter than 900 ms inside an utterance does not end it", () => {
  const vad = make();
  const [first, t1] = feed(vad, run(0.12, 600));
  const [gap, t2] = feed(vad, run(0.004, 600), t1);
  const [rest, t3] = feed(vad, run(0.12, 600), t2);
  const [end] = feed(vad, run(0.004, 1500), t3);
  assert.deepEqual(first.map((e) => e.type), ["start"]);
  assert.deepEqual(gap, []);
  assert.deepEqual(rest, []);
  assert.equal(end.length, 1);
  assert.equal(end[0].voicedMs >= 1200, true);
});

test("hysteresis: once talking, a trailing-off level between the hold and start thresholds keeps the utterance open", () => {
  const vad = make();
  const start = vad.startThreshold;
  const mid = start * 0.8;   // below start, above start * holdRatio
  assert.ok(mid > start * VAD_DEFAULTS.holdRatio);
  feed(vad, run(0.1, 300));
  const [during] = feed(vad, run(mid, 3000), 300);
  assert.deepEqual(during, [], "still the same utterance after 3 s at the hold level");
  const [after] = feed(vad, run(0.004, 1200), 3300);
  assert.equal(after[0].type, "end");
});

test("an utterance is cut at 30 seconds", () => {
  const vad = make();
  const [events] = feed(vad, run(0.1, 31_000));
  // (the speaker is still talking at the cap, so a new utterance starts right after the cut)
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ["start", "end"]);
  assert.equal(events[1].reason, "max");
  assert.equal(events[1].keep, true);
  assert.ok(events[1].totalMs >= VAD_DEFAULTS.maxMs && events[1].totalMs < VAD_DEFAULTS.maxMs + TICK);
});

test("after an utterance ends, the next one starts normally", () => {
  const vad = make();
  const [e1, t1] = feed(vad, [...run(0.1, 600), ...run(0.004, 1200)]);
  const [e2] = feed(vad, [...run(0.1, 600), ...run(0.004, 1200)], t1);
  assert.deepEqual(e1.map((e) => e.type), ["start", "end"]);
  assert.deepEqual(e2.map((e) => e.type), ["start", "end"]);
});

test("the first 450 ms calibrate to the room: a steady noisy room raises the start threshold and speech still gets through", () => {
  const vad = createVad();
  const quietThreshold = vad.startThreshold;
  const [noise, t] = feed(vad, run(0.02, 20_000));
  assert.deepEqual(noise, [], "steady noise never starts anything once the room has been heard");
  assert.ok(vad.startThreshold > quietThreshold);
  assert.ok(vad.startThreshold <= VAD_DEFAULTS.maxStart);
  const [speech] = feed(vad, run(0.15, 300), t);
  assert.deepEqual(speech.map((e) => e.type), ["start"]);
});

test("nothing can start during calibration, and a quiet room settles at the lower bound", () => {
  const vad = createVad();
  const [early] = feed(vad, run(0.3, VAD_DEFAULTS.calibrateMs - TICK));
  assert.deepEqual(early, [], "loud readings in the first 450 ms only teach the floor");

  const quiet = createVad();
  feed(quiet, run(0, 5000));
  assert.equal(quiet.startThreshold, VAD_DEFAULTS.minStart);
  const [events] = feed(quiet, run(0.1, 300), 5000);
  assert.deepEqual(events.map((e) => e.type), ["start"]);
});

test("reset() drops an utterance in progress without emitting anything", () => {
  const vad = make();
  feed(vad, run(0.1, 300));
  assert.equal(vad.recording, true);
  vad.reset();
  assert.equal(vad.recording, false);
  const [events] = feed(vad, run(0.004, 2000), 300);
  assert.deepEqual(events, []);
});

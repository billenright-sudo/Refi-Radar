import test from "node:test";
import assert from "node:assert/strict";
import { LIPS_KEY, lipsReadoutOn, lipsLines } from "./lips.mjs";

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return { data, getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); }, removeItem: (key) => { delete data[key]; } };
};

test("lipsReadoutOn: on with ?lips=1, kept for the tab, off again with ?lips=0", () => {
  const tab = fakeStorage();
  assert.equal(lipsReadoutOn("", tab), false, "hidden unless asked for");
  assert.equal(lipsReadoutOn("?lips=1", tab), true);
  assert.equal(tab.data[LIPS_KEY], "1");
  assert.equal(lipsReadoutOn("", tab), true, "still on after the address lost the mark (signing in, moving around)");
  assert.equal(lipsReadoutOn("?open=notification", tab), true);
  assert.equal(lipsReadoutOn("?lips=0", tab), false);
  assert.equal(LIPS_KEY in tab.data, false);
  assert.equal(lipsReadoutOn("", tab), false);
  assert.equal(lipsReadoutOn("?lips=yes", fakeStorage()), false, "only 1 turns it on");
});

test("lipsReadoutOn: no storage, or one that throws, still follows the address", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(lipsReadoutOn("?lips=1", null), true);
  assert.equal(lipsReadoutOn("?lips=1", broken), true);
  assert.equal(lipsReadoutOn("", broken), false);
  assert.equal(lipsReadoutOn(undefined, undefined), false);
});

test("lipsLines: one line for her voice and one for her face, short enough to read off a phone screenshot", () => {
  const lines = lipsLines({
    voice: { clip: "whole", at: 12.44, paused: false, ready: 4, heard: true, said: ["playing", "waiting"] },
    face: { want: "talk", talkAt: 3.21, talkPaused: false, talkReady: 4, idlePaused: true, restarts: 2 },
  });
  assert.deepEqual(lines, [
    "voice whole 12.4s going r4 · heard · said playing waiting",
    "face wants talk · talk 3.2s going r4 · idle paused · restarts 2",
  ]);
});

test("lipsLines: a stilled mouth over a voice that goes on reads as exactly that", () => {
  const lines = lipsLines({
    voice: { clip: "whole", at: 16, paused: false, ready: 2, heard: false, said: ["playing", "waiting"] },
    face: { want: "idle", talkAt: 7.5, talkPaused: true, talkReady: 4, idlePaused: false, restarts: 0 },
  });
  assert.deepEqual(lines, [
    "voice whole 16.0s going r2 · NOT heard · said playing waiting",
    "face wants idle · talk 7.5s paused r4 · idle going · restarts 0",
  ]);
});

test("lipsLines: nothing known yet still makes two lines", () => {
  assert.deepEqual(lipsLines(), [
    "voice none 0.0s paused r0 · NOT heard · said nothing",
    "face wants none · talk 0.0s paused r0 · idle paused · restarts 0",
  ]);
});

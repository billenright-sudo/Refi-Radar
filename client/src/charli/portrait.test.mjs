import test from "node:test";
import assert from "node:assert/strict";
import { clipToPlay, statusTag } from "./portrait.mjs";

test("clipToPlay: talk while she talks, idle otherwise, nothing when hidden or reduced motion", () => {
  assert.equal(clipToPlay({ state: "talking", hidden: false, reducedMotion: false }), "talk");
  assert.equal(clipToPlay({ state: "listening", hidden: false, reducedMotion: false }), "idle");
  assert.equal(clipToPlay({ state: "thinking", hidden: false, reducedMotion: false }), "idle");
  assert.equal(clipToPlay({ state: "talking", hidden: true, reducedMotion: false }), null);
  assert.equal(clipToPlay({ state: "talking", hidden: false, reducedMotion: true }), null);
});

test("statusTag: the chip under her name", () => {
  assert.deepEqual(statusTag({ state: "talking", micOpen: false }), { text: "Speaking…", tone: "blue" });
  assert.deepEqual(statusTag({ state: "talking", micOpen: true }), { text: "Speaking…", tone: "blue" });
  assert.deepEqual(statusTag({ state: "listening", micOpen: true }), { text: "Listening", tone: "green" });
  assert.deepEqual(statusTag({ state: "thinking", micOpen: false }), { text: "Thinking…", tone: "amber" });
  assert.equal(statusTag({ state: "listening", micOpen: false }), null);
});

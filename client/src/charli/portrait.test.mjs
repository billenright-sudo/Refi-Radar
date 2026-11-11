import test from "node:test";
import assert from "node:assert/strict";
import { clipToPlay, portraitBox } from "./portrait.mjs";

test("clipToPlay: talk while she talks, idle otherwise, nothing when hidden or reduced motion", () => {
  assert.equal(clipToPlay({ state: "talking", hidden: false, reducedMotion: false }), "talk");
  assert.equal(clipToPlay({ state: "listening", hidden: false, reducedMotion: false }), "idle");
  assert.equal(clipToPlay({ state: "thinking", hidden: false, reducedMotion: false }), "idle");
  assert.equal(clipToPlay({ state: "talking", hidden: true, reducedMotion: false }), null);
  assert.equal(clipToPlay({ state: "talking", hidden: false, reducedMotion: true }), null);
});

test("portraitBox: a height keeps her whole 4:5 frame (head and shoulders), the width following from it", () => {
  assert.deepEqual(portraitBox({ shape: "portrait", height: "min(318px, 28vh)" }), { width: "auto", height: "min(318px, 28vh)", aspectRatio: "4 / 5" });
});

test("portraitBox: a pixel width sets the 4:5 or square height", () => {
  assert.deepEqual(portraitBox({ shape: "portrait", width: 168 }), { width: 168, height: 210 });
  assert.deepEqual(portraitBox({ shape: "square", width: 200 }), { width: 200, height: 200 });
});

test("portraitBox: a CSS width keeps the shape through aspect-ratio", () => {
  assert.deepEqual(portraitBox({ shape: "square", width: "min(100%, 420px)" }), { width: "min(100%, 420px)", height: "auto", aspectRatio: "1 / 1" });
});

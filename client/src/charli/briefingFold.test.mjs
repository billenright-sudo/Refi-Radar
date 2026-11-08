import { test } from "node:test";
import assert from "node:assert/strict";
import { briefingFolded } from "./briefingFold.mjs";

test("before any conversation the briefing shows in full", () => {
  assert.equal(briefingFolded({ talking: false, hasBriefing: true, open: false }), false);
});

test("once the conversation starts the briefing folds to one line", () => {
  assert.equal(briefingFolded({ talking: true, hasBriefing: true, open: false }), true);
});

test("tapping it open keeps it open during the conversation", () => {
  assert.equal(briefingFolded({ talking: true, hasBriefing: true, open: true }), false);
});

test("with no briefing there is nothing to fold (its placeholder line stays)", () => {
  assert.equal(briefingFolded({ talking: true, hasBriefing: false, open: false }), false);
});

test("missing arguments read as not folded", () => {
  assert.equal(briefingFolded(), false);
});

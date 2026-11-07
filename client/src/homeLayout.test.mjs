import test from "node:test";
import assert from "node:assert/strict";
import { homeLayout, DOCK_WIDTH } from "./homeLayout.mjs";

test("homeLayout breakpoints", () => {
  assert.equal(homeLayout(1440), "wide");
  assert.equal(homeLayout(1350), "wide");
  assert.equal(homeLayout(1349), "laptop");
  assert.equal(homeLayout(1024), "laptop");
  assert.equal(homeLayout(1023), "stacked");
  assert.equal(homeLayout(390), "stacked");
});

test("homeLayout: non-number or <= 0 falls back to wide", () => {
  assert.equal(homeLayout(undefined), "wide");
  assert.equal(homeLayout(0), "wide");
  assert.equal(homeLayout(NaN), "wide");
  assert.equal(homeLayout(-5), "wide");
  assert.equal(homeLayout("900"), "wide");
});

test("DOCK_WIDTH", () => {
  assert.deepEqual(DOCK_WIDTH, { wide: 408, laptop: 340 });
});

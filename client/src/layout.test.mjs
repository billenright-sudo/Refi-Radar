import test from "node:test";
import assert from "node:assert/strict";
import { PHONE_MAX_WIDTH, PHONE_QUERY, isPhoneWidth, gridCols } from "./layout.mjs";

test("phone constants agree", () => {
  assert.equal(PHONE_MAX_WIDTH, 767);
  assert.equal(PHONE_QUERY, "(max-width: 767px)");
});

test("isPhoneWidth: 0 < width <= 767", () => {
  assert.equal(isPhoneWidth(390), true);
  assert.equal(isPhoneWidth(767), true);
  assert.equal(isPhoneWidth(768), false);
  assert.equal(isPhoneWidth(1280), false);
  assert.equal(isPhoneWidth(0), false);
  assert.equal(isPhoneWidth(-5), false);
  assert.equal(isPhoneWidth(undefined), false);
  assert.equal(isPhoneWidth(NaN), false);
});

test("gridCols keeps the desktop template, shrinks on phone", () => {
  assert.equal(gridCols(4, false), "1fr 1fr 1fr 1fr");
  assert.equal(gridCols(3, false), "1fr 1fr 1fr");
  assert.equal(gridCols(2, false), "1fr 1fr");
  assert.equal(gridCols(4, true), "1fr 1fr");
  assert.equal(gridCols(3, true), "1fr");
  assert.equal(gridCols(2, true), "1fr");
});

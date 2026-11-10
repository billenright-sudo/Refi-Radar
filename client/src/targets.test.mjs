import test from "node:test";
import assert from "node:assert/strict";
import { dayLabel, targetStatusLine, closestToTarget, isAtTarget, targetToSave, TARGET_RANGE_ERROR, ratesMayMoveTargets, replaceClient } from "./targets.mjs";

const TODAY = new Date(2026, 10, 12, 9, 0, 0);

test("dayLabel: ordinals, and the year only when it is not this year", () => {
  assert.equal(dayLabel("2026-11-12", TODAY), "November 12th");
  assert.equal(dayLabel("2026-11-01", TODAY), "November 1st");
  assert.equal(dayLabel("2026-11-02", TODAY), "November 2nd");
  assert.equal(dayLabel("2026-11-03", TODAY), "November 3rd");
  assert.equal(dayLabel("2026-11-11", TODAY), "November 11th");
  assert.equal(dayLabel("2026-11-13", TODAY), "November 13th");
  assert.equal(dayLabel("2026-11-21", TODAY), "November 21st");
  assert.equal(dayLabel("2026-11-22", TODAY), "November 22nd");
  assert.equal(dayLabel("2026-11-23", TODAY), "November 23rd");
  assert.equal(dayLabel("2026-12-31", TODAY), "December 31st");
  assert.equal(dayLabel("2025-12-31", TODAY), "December 31st, 2025");
});

test("targetStatusLine: the copy for each state", () => {
  assert.equal(targetStatusLine(null, TODAY), null);
  assert.equal(targetStatusLine({ rate: 6, state: "watching", estRate: 6.25, gap: 0.25, asOf: "2026-11-10" }, TODAY),
    "Watching: estimated 6.250% as of November 10th, 0.250 above target");
  assert.equal(targetStatusLine({ rate: 6, state: "at_target", reachedOn: "2026-11-12", reachedRate: 5.875 }, TODAY),
    "Target reached November 12th (estimated 5.875%)");
  const when = new Date("2026-11-13T15:30:00Z");
  const local = new Date(when.getFullYear(), when.getMonth(), when.getDate(), 12);
  assert.equal(targetStatusLine({ rate: 6, state: "handled", reachedOn: "2026-11-12", reachedRate: 5.875, handledAt: "2026-11-13 15:30:00" }, TODAY),
    `Target reached November 12th · client reached ${dayLabel(`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`, TODAY)}`);
  assert.equal(targetStatusLine({ rate: 6, state: "already_below" }, TODAY), "Their rate is already at or below this target.");
  assert.equal(targetStatusLine({ rate: 6, state: "unpriceable" }, TODAY), "Can't estimate a rate for this client yet");
  assert.equal(targetStatusLine({ rate: 6, state: "no_rates" }, TODAY), "Waiting for the first day of live rates");
});

const c = (name, target) => ({ id: name, name, target });
test("closestToTarget: order and limit", () => {
  const clients = [
    c("None", null),
    c("W2", { state: "watching", gap: 0.5 }),
    c("W1", { state: "watching", gap: 0.1 }),
    c("Wb", { state: "watching", gap: 0.1 }),
    c("H", { state: "handled" }),
    c("A2", { state: "at_target", reachedOn: "2026-11-12" }),
    c("A1", { state: "at_target", reachedOn: "2026-11-10" }),
    c("B", { state: "already_below" }),
    c("U", { state: "unpriceable" }),
    c("N", { state: "no_rates" }),
  ];
  assert.deepEqual(closestToTarget(clients, 20).map((x) => x.name), ["A1", "A2", "W1", "Wb", "W2", "H", "B", "U", "N"]);
  assert.equal(closestToTarget(clients).length, 5);
  assert.deepEqual(closestToTarget(clients, 2).map((x) => x.name), ["A1", "A2"]);
  assert.deepEqual(closestToTarget([c("x", null)]), []);
});

test("isAtTarget: only at_target", () => {
  assert.equal(isAtTarget({ state: "at_target" }), true);
  assert.equal(isAtTarget({ state: "watching" }), false);
  assert.equal(isAtTarget({ state: "handled" }), false);
  assert.equal(isAtTarget(null), false);
  assert.equal(isAtTarget(undefined), false);
});

test("targetToSave: an empty field sends nothing; a field that is not a number shows the range copy, never asking the server", () => {
  assert.equal(TARGET_RANGE_ERROR, "A target rate is a number from 1.000 to 15.000.");
  for (const raw of ["", "   ", null, undefined]) assert.deepEqual(targetToSave(raw), { send: false }, String(raw));
  for (const raw of ["abc", "6,5", "6.0.1", "-", "NaN", "Infinity"]) {
    assert.deepEqual(targetToSave(raw), { send: false, error: TARGET_RANGE_ERROR }, raw);
  }
  // a number input the browser couldn't read reports "" with validity.badInput: the broker typed something, so say why
  assert.deepEqual(targetToSave("", { badInput: true }), { send: false, error: TARGET_RANGE_ERROR });
  assert.deepEqual(targetToSave("6"), { send: true, targetRate: 6 });
  assert.deepEqual(targetToSave(" 5.875 "), { send: true, targetRate: 5.875 });
  // the range and "below the current rate" are the server's to refuse, with its own copy
  assert.deepEqual(targetToSave("20"), { send: true, targetRate: 20 });
  assert.ok(!Number.isNaN(targetToSave("6.25").targetRate));
});

test("ratesMayMoveTargets: a live rates answer re-reads the client list (its target check may have a new day), an estimate does not", () => {
  const rates = { rate_30yr_fixed: 6.12, date: "2026-11-10", source: "Optimal Blue lock data (2026-11-10)" };
  assert.equal(ratesMayMoveTargets({ success: true, rates }), true);
  assert.equal(ratesMayMoveTargets({ success: false, error: "Rate fetch timed out", rates: { ...rates, source: "Estimated — live fetch unavailable" } }), false);
  assert.equal(ratesMayMoveTargets({ success: true }), false);
  assert.equal(ratesMayMoveTargets(null), false);
  assert.equal(ratesMayMoveTargets(undefined), false);
});

test("replaceClient: the answer's client takes its row's place, in order; anything else leaves the list as it is", () => {
  const list = [{ id: 1, name: "A" }, { id: 2, name: "B", target: { state: "at_target" } }, { id: 3, name: "C" }];
  const handled = { id: 2, name: "B", target: { state: "handled" } };
  const out = replaceClient(list, handled);
  assert.deepEqual(out, [list[0], handled, list[2]]);
  assert.notEqual(out, list, "a new list, so React redraws");
  assert.deepEqual(list[1].target.state, "at_target", "the old list is not changed");
  assert.equal(replaceClient(list, { id: 9, name: "Z" }), list);
  assert.equal(replaceClient(list, null), list);
  assert.equal(replaceClient(list, {}), list);
});

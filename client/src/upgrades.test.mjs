import test from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_OPTIONS, OCCUPANCY_OPTIONS, UPGRADE_LENSES, badgeFor, balanceLine, valueLine, creditScoreForPost } from "./upgrades.mjs";

test("option lists and lens ids", () => {
  assert.deepEqual(PROGRAM_OPTIONS, [["", "Not set"], ["conventional", "Conventional"], ["fha", "FHA"], ["va", "VA"], ["usda", "USDA"], ["jumbo", "Jumbo"]]);
  assert.deepEqual(OCCUPANCY_OPTIONS, [["", "Not set"], ["primary", "Primary"], ["second_home", "Second home"], ["investment", "Investment"]]);
  assert.deepEqual(UPGRADE_LENSES, ["fha_to_conv", "fha_streamline", "va_irrrl", "usda_to_conv", "drop_pmi"]);
});

test("badgeFor: drop_pmi is Goodwill, others use the priority badge", () => {
  assert.deepEqual(badgeFor({ lens: "drop_pmi", priority: "high" }), { label: "Goodwill", tone: "low" });
  assert.deepEqual(badgeFor({ lens: "fha_to_conv", priority: "high" }), { label: "High", tone: "high" });
  assert.deepEqual(badgeFor({ lens: "va_irrrl", priority: "medium" }), { label: "Medium", tone: "medium" });
  assert.deepEqual(badgeFor({ lens: "usda_to_conv", priority: "low" }), { label: "Monitor", tone: "low" });
});

test("balanceLine: rolled and stored", () => {
  assert.equal(balanceLine({ balance: 286437, balanceFrom: 301000, balanceAsOf: "2024-05-14", balanceBasis: "rolled" }),
    "Balance about $286,400 (rolled forward from $301,000 in May 2024)");
  assert.equal(balanceLine({ balance: 301000, balanceFrom: 301000, balanceAsOf: null, balanceBasis: "stored" }), "Balance $301,000 (as entered)");
  assert.equal(balanceLine({ balance: null, balanceBasis: "stored" }), "");
});

test("valueLine: grown, typed, flat", () => {
  assert.equal(valueLine({ valueBasis: "grown", valueFrom: 355000, value: 457950, cautiousValue: 412155, valueAsOf: "2021-03-02", growthPct: 29 }),
    "Value about $412,000 (from $355,000 in 2021, area prices up 29%, less 10% for caution)");
  assert.equal(valueLine({ valueBasis: "typed", valueFrom: 355000, value: 355000, cautiousValue: 355000 }), "Value $355,000 (you entered it)");
  assert.equal(valueLine({ valueBasis: "flat", valueFrom: 355000, value: 355000, cautiousValue: 319500 }),
    "Value about $320,000 ($355,000 less 10% for caution)");
  assert.equal(valueLine({ valueFrom: null }), "");
});

test("creditScoreForPost: integer when it parses, else blank", () => {
  assert.equal(creditScoreForPost("760"), 760);
  assert.equal(creditScoreForPost(" 740 "), 740);
  assert.equal(creditScoreForPost(""), "");
  assert.equal(creditScoreForPost("abc"), "");
  assert.equal(creditScoreForPost(undefined), "");
});

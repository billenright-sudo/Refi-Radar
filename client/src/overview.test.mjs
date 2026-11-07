import test from "node:test";
import assert from "node:assert/strict";
import { OVERVIEW_COPY, opportunityCount, ratesHeading } from "./overview.mjs";

test("OVERVIEW_COPY is the approved copy and frozen", () => {
  assert.equal(OVERVIEW_COPY.refiReadyLabel, "Refi-ready today");
  assert.equal(OVERVIEW_COPY.refiReadySub, "Rate refis that pay back their closing costs within 3 years");
  assert.equal(OVERVIEW_COPY.allOppsLabel, "All opportunities");
  assert.equal(OVERVIEW_COPY.allOppsSub, "Includes cash-out, ARM-to-fixed and term options");
  assert.equal(OVERVIEW_COPY.savingsLabel, "Potential monthly savings");
  assert.equal(OVERVIEW_COPY.savingsSub, "Across refi-ready clients");
  assert.equal(OVERVIEW_COPY.dailyRates, "DAILY RATES");
  assert.equal(OVERVIEW_COPY.estimatedRates, "ESTIMATED RATES");
  assert.equal(Object.isFrozen(OVERVIEW_COPY), true);
});

test("opportunityCount", () => {
  assert.equal(opportunityCount({ success: true, counts: { withOpportunity: 1 } }), 1);
  assert.equal(opportunityCount({ counts: { withOpportunity: 0 } }), 0);
  assert.equal(opportunityCount(null), null);
  assert.equal(opportunityCount({}), null);
  assert.equal(opportunityCount({ success: false, counts: { withOpportunity: 3 } }), null);
  assert.equal(opportunityCount({ counts: { withOpportunity: -1 } }), null);
  assert.equal(opportunityCount({ counts: { withOpportunity: "2" } }), null);
});

test("ratesHeading", () => {
  assert.equal(ratesHeading("Optimal Blue lock data (2026-11-05)"), "DAILY RATES");
  assert.equal(ratesHeading("Estimated — live fetch unavailable"), "ESTIMATED RATES");
  assert.equal(ratesHeading(undefined), "DAILY RATES");
});

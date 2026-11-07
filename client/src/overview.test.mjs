import test from "node:test";
import assert from "node:assert/strict";
import { OVERVIEW_COPY, opportunityCount, ratesHeading, tileFigureSize } from "./overview.mjs";

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

// The px a tileFigureSize() string gives for a tile `width` px wide (100cqi = the tile's content width).
const sizeAt = (css, width) => {
  const m = /^clamp\((\d+)px, calc\(100cqi \/ ([\d.]+)\), (\d+)px\)$/.exec(css);
  assert.ok(m, css);
  const [min, divisor, max] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.min(max, Math.max(min, width / divisor));
};
const MONO_ADVANCE = 0.6;   // JetBrains Mono: every glyph is 0.6em wide

test("tileFigureSize: a tile's figure is sized from the tile and its own length", () => {
  assert.equal(tileFigureSize("$1,234,567"), "clamp(15px, calc(100cqi / 6.50), 28px)");
  assert.equal(tileFigureSize(0), "clamp(15px, calc(100cqi / 0.65), 28px)");
  assert.equal(tileFigureSize("—"), "clamp(15px, calc(100cqi / 0.65), 28px)");
  assert.equal(tileFigureSize(null), "clamp(15px, calc(100cqi / 0.65), 28px)");
  assert.equal(tileFigureSize(undefined), "clamp(15px, calc(100cqi / 0.65), 28px)");
  assert.equal(tileFigureSize("7.09%", { max: 20, min: 13 }), "clamp(13px, calc(100cqi / 3.25), 20px)");
});

test("tileFigureSize: whole-dollar figures stay on one line in the narrowest tiles", () => {
  // content widths: wide at 1350-1366 (~118-122), laptop at 1024 (~140), phone at 390 (~139)
  for (const width of [118, 121, 140, 141, 160, 268]) {
    for (const figure of ["$150,000", "$1,234,567", "$12,345,678", "$123,456,789", "70.0%", "7.09%", "12"]) {
      const px = sizeAt(tileFigureSize(figure), width);
      assert.ok(px * MONO_ADVANCE * figure.length <= width, `${figure} at ${width}px: ${px}px`);
      const phonePx = sizeAt(tileFigureSize(figure, { max: 20, min: 13 }), width);
      assert.ok(phonePx * MONO_ADVANCE * figure.length <= width, `phone ${figure} at ${width}px: ${phonePx}px`);
    }
  }
});

test("tileFigureSize: a short figure keeps the full size", () => {
  assert.equal(Math.round(sizeAt(tileFigureSize("$150,000"), 141)), 27);   // about the mockup's 26-28px at 1440
  assert.equal(sizeAt(tileFigureSize("0"), 118), 28);
  assert.equal(sizeAt(tileFigureSize("70.0%"), 121), 28);
  assert.equal(sizeAt(tileFigureSize("0", { max: 20, min: 13 }), 139), 20);
});

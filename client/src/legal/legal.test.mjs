import test from "node:test";
import assert from "node:assert/strict";
import * as terms from "./terms.mjs";
import * as privacy from "./privacy.mjs";

const DOCS = { terms, privacy };
const fullText = (doc) => doc.SECTIONS.map((s) => [s.heading, ...s.paragraphs].join("\n")).join("\n");

for (const [name, doc] of Object.entries(DOCS)) {
  test(`${name}: version is 2026-11-05`, () => {
    assert.equal(doc.VERSION, "2026-11-05");
  });

  test(`${name}: at least 8 sections, each with a heading and non-empty paragraphs`, () => {
    assert.ok(Array.isArray(doc.SECTIONS));
    assert.ok(doc.SECTIONS.length >= 8, `only ${doc.SECTIONS.length} sections`);
    for (const s of doc.SECTIONS) {
      assert.equal(typeof s.heading, "string");
      assert.ok(s.heading.trim(), "empty heading");
      assert.ok(Array.isArray(s.paragraphs) && s.paragraphs.length > 0, `"${s.heading}" has no paragraphs`);
      for (const p of s.paragraphs) assert.ok(typeof p === "string" && p.trim(), `"${s.heading}" has an empty paragraph`);
    }
  });

  test(`${name}: the first section says it is a draft, not yet in effect`, () => {
    assert.ok(doc.SECTIONS[0].paragraphs.includes("Draft for legal review — not yet in effect."));
  });

  test(`${name}: names no person (no "Bill", no "Enright")`, () => {
    const text = fullText(doc);
    assert.doesNotMatch(text, /\bBill\b/);
    assert.doesNotMatch(text, /Enright/i);
  });

  test(`${name}: the parties are the blank company name, doing business as Broker Radar, under Ignite Business Solutions`, () => {
    const text = fullText(doc);
    assert.ok(text.includes("[Company legal name]"));
    assert.ok(text.includes("Broker Radar"));
    assert.ok(text.includes("Ignite Business Solutions"));
    assert.ok(text.includes("[support email]"));
  });
}

test("terms: state the price and that it is charged until you cancel", () => {
  const text = fullText(terms);
  for (const s of ["$99 a month", "$49 for each additional user", "until you cancel"]) {
    assert.ok(text.includes(s), `terms are missing "${s}"`);
  }
});

test("terms: state the trial, the test month, how to cancel, failed payments, export and the blanks for the owner", () => {
  const text = fullText(terms);
  for (const s of ["14-day free trial", "day 15", "30-day test month", "Billing → Manage billing", "14 days", "CSV", "[N] days", "[State]"]) {
    assert.ok(text.includes(s), `terms are missing "${s}"`);
  }
});

test("privacy: names every subprocessor and the sign-in cookie", () => {
  const text = fullText(privacy);
  for (const s of ["Anthropic", "ElevenLabs", "Google Calendar", "Stripe", "Google Cloud", "Gmail", "cookie"]) {
    assert.ok(text.includes(s), `privacy policy is missing "${s}"`);
  }
});

"use strict";
// The four occasion emails (lib/assistant/outreach.js): birthday, family birthday, wedding anniversary, home anniversary. Pure
// functions, no DB. The wording is the approved copy (design 2026-11-21): a change here is a change to these expectations on purpose.
const test = require("node:test");
const assert = require("node:assert");

const { PURPOSES, OCCASION_PURPOSES, purposeForKind, renderEmail } = require("../lib/assistant/outreach");

const SENDER = {
  clientName: "Pat Example", senderName: "Sam Sender", nmlsId: "123456", orgName: "Example Mortgage Co", orgNmlsId: "654321",
};
const SIGNATURE = "Best,\nSam Sender\nNMLS #123456\nExample Mortgage Co\nNMLS #654321";
const body = (middle) => `Hi Pat Example,\n\n${middle}\n\n${SIGNATURE}`;

test("birthday: the approved subject and body", () => {
  assert.deepStrictEqual(renderEmail({ ...SENDER, purpose: "birthday" }), {
    subject: "Happy birthday!",
    body: body("Happy birthday! I hope you have a great day and a wonderful year ahead."),
  });
});

test("family_birthday: the family member's name in the subject and the body", () => {
  assert.deepStrictEqual(renderEmail({ ...SENDER, purpose: "family_birthday", who: "Maya" }), {
    subject: "Happy birthday to Maya!",
    body: body("I wanted to wish Maya a very happy birthday. I hope you all have a great day celebrating."),
  });
  assert.deepStrictEqual(renderEmail({ ...SENDER, purpose: "family_birthday", who: "your spouse" }), {
    subject: "Happy birthday to your spouse!",
    body: body("I wanted to wish your spouse a very happy birthday. I hope you all have a great day celebrating."),
  });
});

test("family_birthday with no family member renders nothing", () => {
  for (const who of [undefined, null, "", "   ", 5]) assert.equal(renderEmail({ ...SENDER, purpose: "family_birthday", who }), null, String(who));
});

test("a family member's name that looks like a placeholder is printed as written", () => {
  const mail = renderEmail({ ...SENDER, purpose: "family_birthday", who: "{SIGNATURE} $&" });
  assert.equal(mail.subject, "Happy birthday to {SIGNATURE} $&!");
  assert.ok(mail.body.includes("I wanted to wish {SIGNATURE} $& a very happy birthday."));
  assert.ok(mail.body.endsWith(SIGNATURE));
});

test("wedding_anniversary: the approved subject and body", () => {
  assert.deepStrictEqual(renderEmail({ ...SENDER, purpose: "wedding_anniversary" }), {
    subject: "Happy anniversary!",
    body: body("Happy anniversary! Wishing you both a wonderful day and many more years together."),
  });
});

test("home_anniversary: the approved subject and body, and it reads as no offer", () => {
  const mail = renderEmail({ ...SENDER, purpose: "home_anniversary" });
  assert.deepStrictEqual(mail, {
    subject: "Happy home anniversary!",
    body: body("Happy home anniversary! I hope the home is treating you well. It was a pleasure helping you with it, and I'm always here if you ever need anything."),
  });
  assert.doesNotMatch(mail.body, /review|rate|option/i);
});

test("a non-family purpose ignores a `who`", () => {
  for (const purpose of ["check_in", "refi_review", "birthday", "wedding_anniversary", "home_anniversary"]) {
    assert.deepStrictEqual(renderEmail({ ...SENDER, purpose, who: "Mallory" }), renderEmail({ ...SENDER, purpose }), purpose);
  }
});

test("no occasion email carries a digit, an age or a count of years", () => {
  for (const purpose of Object.keys(OCCASION_PURPOSES)) {
    const { subject, body: text } = renderEmail({ ...SENDER, purpose, who: "Maya" });
    const rest = text.split("\n").filter((line) => !line.startsWith("NMLS #")).join("\n");
    assert.doesNotMatch(subject, /[\d$%]/, purpose);
    assert.doesNotMatch(rest, /[\d$%]|\byears? old\b|\bturns\b/, purpose);
  }
});

test("the occasion purposes and the occasion kinds each one is for", () => {
  assert.deepStrictEqual({ ...OCCASION_PURPOSES }, {
    birthday: ["birthday"], family_birthday: ["spouse_birthday", "child_birthday"], wedding_anniversary: ["wedding"],
    home_anniversary: ["loan", "home"],
  });
  for (const p of Object.keys(OCCASION_PURPOSES)) assert.ok(PURPOSES.includes(p), p);
  assert.deepStrictEqual(
    ["birthday", "spouse_birthday", "child_birthday", "wedding", "loan", "home"].map(purposeForKind),
    ["birthday", "family_birthday", "family_birthday", "wedding_anniversary", "home_anniversary", "home_anniversary"],
  );
  for (const kind of ["nonsense", "", null, undefined, "constructor", "__proto__"]) assert.equal(purposeForKind(kind), null, String(kind));
});

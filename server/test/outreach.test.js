"use strict";
// The two code-authored outreach emails and the compose links (lib/assistant/outreach.js). Pure functions, no DB.
// The wording here is the approved copy: a change to a template is a change to these expectations on purpose.
const test = require("node:test");
const assert = require("node:assert");

const { PURPOSES, PURPOSE_WORDS, renderEmail, composeLinks, parseNmls } = require("../lib/assistant/outreach");

const SENDER = {
  clientName: "Robert & Linda Chen", senderName: "Bill Enright", nmlsId: "123456",
  orgName: "Premier Mortgage Group", orgNmlsId: "654321",
};

const CHECK_IN_BODY = [
  "Hi Robert & Linda Chen,",
  "",
  "It's been a little while since we last talked, so I wanted to check in and see how everything is going with your home.",
  "",
  "If anything has changed on your end, like plans to move, renovate, or put some of your equity to work, I'd be glad to walk through your options with you. Just reply here whenever it's convenient.",
  "",
  "Best,",
  "Bill Enright",
  "NMLS #123456",
  "Premier Mortgage Group",
  "NMLS #654321",
].join("\n");

const REFI_REVIEW_BODY = [
  "Hi Robert & Linda Chen,",
  "",
  "The mortgage market has shifted since you closed on your loan, and it could be worth taking a fresh look at where you stand. I'd be happy to put together a no-obligation review of your options.",
  "",
  "Would you have a few minutes this week? Just reply with a time that works for you.",
  "",
  "Best,",
  "Bill Enright",
  "NMLS #123456",
  "Premier Mortgage Group",
  "NMLS #654321",
].join("\n");

test("the purposes and their spoken words", () => {
  assert.deepStrictEqual(PURPOSES, ["check_in", "refi_review"]);
  assert.deepStrictEqual(PURPOSE_WORDS, { check_in: "check-in", refi_review: "refinance review" });
});

test("check_in renders the approved subject and body, signature last, no trailing newline", () => {
  const mail = renderEmail({ ...SENDER, purpose: "check_in" });
  assert.deepStrictEqual(mail, { subject: "How's everything with your home?", body: CHECK_IN_BODY });
  assert.ok(!mail.body.endsWith("\n"));
});

test("refi_review renders the approved subject and body", () => {
  assert.deepStrictEqual(renderEmail({ ...SENDER, purpose: "refi_review" }), {
    subject: "A fresh look at your mortgage", body: REFI_REVIEW_BODY,
  });
});

test("a company with no NMLS ID has a three-line signature, whether the ID is missing, null or empty", () => {
  for (const orgNmlsId of [undefined, null, ""]) {
    const { body } = renderEmail({ ...SENDER, orgNmlsId, purpose: "check_in" });
    assert.ok(body.endsWith("Best,\nBill Enright\nNMLS #123456\nPremier Mortgage Group"), JSON.stringify(orgNmlsId));
    assert.ok(!body.includes("654321"));
  }
});

test("apart from the two NMLS lines neither template has a digit, a dollar sign or a percent sign", () => {
  for (const purpose of PURPOSES) {
    const { subject, body } = renderEmail({ ...SENDER, purpose });
    const rest = body.split("\n").filter((line) => !line.startsWith("NMLS #")).join("\n");
    assert.doesNotMatch(subject, /[\d$%]/, `${purpose} subject`);
    assert.doesNotMatch(rest, /[\d$%]/, `${purpose} body`);
    assert.equal(body.split("\n").filter((line) => line.startsWith("NMLS #")).length, 2);
  }
});

test("the client name is used as stored, with no first-name guessing", () => {
  assert.ok(renderEmail({ ...SENDER, clientName: "Dr. Mary-Jane O'Neil Jr.", purpose: "check_in" }).body.startsWith("Hi Dr. Mary-Jane O'Neil Jr.,\n\n"));
});

test("a client or sender whose name looks like a placeholder, or has a $ in it, is printed as written", () => {
  const { body } = renderEmail({ ...SENDER, clientName: "{SIGNATURE} $& $1", senderName: "{clientName} $`", purpose: "check_in" });
  assert.ok(body.startsWith("Hi {SIGNATURE} $& $1,\n\n"), body);
  assert.ok(body.endsWith("Best,\n{clientName} $`\nNMLS #123456\nPremier Mortgage Group\nNMLS #654321"), body);
});

test("an unknown purpose renders nothing, including names off the prototype", () => {
  for (const purpose of ["nonsense", "", undefined, null, 5, "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(renderEmail({ ...SENDER, purpose }), null, String(purpose));
  }
});

// ── composeLinks ────────────────────────────────────────────────────────────

const TO = "linda.chen@example.com";
const SUBJECT = "A fresh look at your mortgage";
const BODY_WITH_TROUBLE = "Hi Robert & Linda,\n\nWould Tuesday #2 or Friday work? 100% flexible; call me at 555-0100.\n\nBest,\nBill";
const queryOf = (url) => new URL(url).searchParams;

test("composeLinks: gmail, outlook and mailto decode back to the exact recipient, subject and body", () => {
  const links = composeLinks({ to: TO, subject: SUBJECT, body: BODY_WITH_TROUBLE });
  assert.deepStrictEqual(Object.keys(links).sort(), ["gmail", "mailto", "outlook"]);

  assert.ok(links.gmail.startsWith("https://mail.google.com/mail/?view=cm&fs=1&to="));
  const g = queryOf(links.gmail);
  assert.deepStrictEqual([g.get("view"), g.get("fs"), g.get("to"), g.get("su"), g.get("body")], ["cm", "1", TO, SUBJECT, BODY_WITH_TROUBLE]);

  assert.ok(links.outlook.startsWith("https://outlook.office.com/mail/deeplink/compose?to="));
  const o = queryOf(links.outlook);
  assert.deepStrictEqual([o.get("to"), o.get("subject"), o.get("body")], [TO, SUBJECT, BODY_WITH_TROUBLE]);

  assert.ok(links.mailto.startsWith("mailto:"));
  const [head, query] = links.mailto.split("?");
  assert.equal(decodeURIComponent(head.slice("mailto:".length)), TO);
  const m = new URLSearchParams(query);
  assert.equal(m.get("subject"), SUBJECT);
  assert.equal(m.get("body"), BODY_WITH_TROUBLE.replace(/\n/g, "\r\n"));
});

test("composeLinks: the mailto body carries its line breaks as %0D%0A and no bare %0A", () => {
  const { mailto } = composeLinks({ to: TO, subject: "s", body: "one\ntwo\n\nthree" });
  assert.ok(mailto.includes("body=one%0D%0Atwo%0D%0A%0D%0Athree"), mailto);
  assert.ok(!/%0A/.test(mailto.replace(/%0D%0A/g, "")), "every %0A is part of %0D%0A");
});

test("composeLinks: a body with & # ? = + % and non-ASCII survives the round trip in all three", () => {
  const body = "R&D #1 = 50% + more? Café — \"quoted\" it's";
  const links = composeLinks({ to: "a+tag@example.com", subject: "Q&A #2", body });
  const g = queryOf(links.gmail);
  assert.deepStrictEqual([g.get("to"), g.get("su"), g.get("body")], ["a+tag@example.com", "Q&A #2", body]);
  const o = queryOf(links.outlook);
  assert.deepStrictEqual([o.get("to"), o.get("subject"), o.get("body")], ["a+tag@example.com", "Q&A #2", body]);
  const m = new URLSearchParams(links.mailto.split("?")[1]);
  assert.deepStrictEqual([m.get("subject"), m.get("body")], ["Q&A #2", body]);
  // exactly three query separators in mailto and gmail: nothing in a value leaked a "&" or "#"
  assert.equal(links.mailto.split("&").length, 2);
  assert.equal(links.gmail.split("&").length, 5);
  for (const url of Object.values(links)) assert.ok(!url.includes("#"), url);
});

test("composeLinks over a real rendered email round-trips the whole body", () => {
  for (const purpose of PURPOSES) {
    const { subject, body } = renderEmail({ ...SENDER, purpose });
    const links = composeLinks({ to: TO, subject, body });
    assert.equal(queryOf(links.gmail).get("body"), body);
    assert.equal(queryOf(links.outlook).get("body"), body);
    assert.equal(new URLSearchParams(links.mailto.split("?")[1]).get("body").replace(/\r\n/g, "\n"), body);
  }
});

// ── parseNmls ───────────────────────────────────────────────────────────────

test("parseNmls: digits only, 1 to 12 of them, trimmed; empty clears; anything else is invalid", () => {
  assert.deepStrictEqual(parseNmls("123456"), { value: "123456" });
  assert.deepStrictEqual(parseNmls("  42\n"), { value: "42" });
  assert.deepStrictEqual(parseNmls("123456789012"), { value: "123456789012" });
  assert.deepStrictEqual(parseNmls(""), { value: null });
  assert.deepStrictEqual(parseNmls("   "), { value: null });
  for (const bad of ["12 34", "abc", "1234567890123", "12-34", "#123", "٣٤", "1e3", null, undefined, 123456, {}, [], true]) {
    assert.deepStrictEqual(parseNmls(bad), { invalid: true }, JSON.stringify(bad));
  }
});

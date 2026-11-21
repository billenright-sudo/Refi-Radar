import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { purposeForKind, refusalLine, isEmailed, emailRequest, sentRequest, composeSentRequest, composeMarkFields } from "./emails.mjs";

const require = createRequire(import.meta.url);
const serverOutreach = require("../../server/lib/assistant/outreach.js");

const KINDS = ["birthday", "spouse_birthday", "child_birthday", "wedding", "loan", "home"];

test("purposeForKind mirrors the server's", () => {
  assert.deepEqual(KINDS.map(purposeForKind), KINDS.map(serverOutreach.purposeForKind));
  assert.deepEqual(KINDS.map(purposeForKind), ["birthday", "family_birthday", "family_birthday", "wedding_anniversary", "home_anniversary", "home_anniversary"]);
  for (const kind of ["nonsense", "", null, undefined, "constructor", "__proto__", "hasOwnProperty"]) assert.equal(purposeForKind(kind), null, String(kind));
});

test("refusalLine: the design's lines, and one line for anything else", () => {
  assert.equal(refusalLine("do_not_email"), "This client is marked do not email.");
  assert.equal(refusalLine("no_email"), "No email address on file. Add one on the client's Edit page.");
  assert.equal(refusalLine("nmls_missing"), "Save your NMLS ID in Profile first. Every client email carries it.");
  for (const code of ["invalid", "who_needed", "unavailable", undefined, null, "constructor", 404]) {
    assert.equal(refusalLine(code), "Couldn't set up the email. Try again.", String(code));
  }
});

test("isEmailed: kind, family member ('' for none) and date all match", () => {
  const client = { occasionEmails: [{ kind: "child_birthday", who: "Maya", date: "2026-11-20" }, { kind: "wedding", who: "", date: "2026-11-28" }] };
  assert.equal(isEmailed(client, { kind: "child_birthday", who: "Maya", date: "2026-11-20" }), true);
  assert.equal(isEmailed(client, { kind: "wedding", who: null, date: "2026-11-28" }), true);
  assert.equal(isEmailed(client, { kind: "wedding", who: null, date: "2025-11-28" }), false);
  assert.equal(isEmailed(client, { kind: "child_birthday", who: "Leo", date: "2026-11-20" }), false);
  assert.equal(isEmailed(client, { kind: "birthday", who: null, date: "2026-11-20" }), false);
  assert.equal(isEmailed({}, { kind: "wedding", who: null, date: "2026-11-28" }), false);
  assert.equal(isEmailed(undefined, { kind: "wedding", who: null, date: "2026-11-28" }), false);
  assert.equal(isEmailed(client, null), false);
});

test("emailRequest and sentRequest: the purpose for the row, the family member only for a family birthday, and the date", () => {
  assert.deepEqual(emailRequest({ kind: "birthday", who: null, date: "2026-11-20" }), { purpose: "birthday" });
  assert.deepEqual(emailRequest({ kind: "child_birthday", who: "Maya", date: "2026-11-20" }), { purpose: "family_birthday", who: "Maya" });
  assert.deepEqual(emailRequest({ kind: "spouse_birthday", who: null, date: "2026-11-20" }), { purpose: "family_birthday" });
  assert.deepEqual(emailRequest({ kind: "loan", who: null, date: "2026-11-20" }), { purpose: "home_anniversary" });
  assert.equal(emailRequest({ kind: "nonsense" }), null);
  assert.equal(emailRequest(null), null);
  assert.deepEqual(sentRequest({ kind: "child_birthday", who: "Maya", date: "2026-11-20" }), { purpose: "family_birthday", who: "Maya", date: "2026-11-20" });
  assert.deepEqual(sentRequest({ kind: "wedding", who: null, date: "2026-11-28" }), { purpose: "wedding_anniversary", date: "2026-11-28" });
  assert.equal(sentRequest({ kind: "nonsense", date: "2026-11-28" }), null);
});

test("composeSentRequest: the purpose, and the occasion's family member and date when the compose names one", () => {
  assert.deepEqual(composeSentRequest({ clientId: 7, purpose: "check_in" }), { purpose: "check_in" });
  assert.deepEqual(composeSentRequest({ clientId: 7, purpose: "birthday", occasion: { kind: "birthday", who: "", date: "2026-11-25" } }),
    { purpose: "birthday", date: "2026-11-25" });
  assert.deepEqual(composeSentRequest({ clientId: 7, purpose: "family_birthday", occasion: { kind: "child_birthday", who: "Maya", date: "2026-11-22" } }),
    { purpose: "family_birthday", who: "Maya", date: "2026-11-22" });
  assert.deepEqual(composeSentRequest({ clientId: 7, purpose: "birthday", occasion: { kind: "wedding", who: "", date: "2026-11-25" } }),
    { purpose: "birthday" }, "an occasion of another purpose is not this one");
  for (const bad of [null, {}, { purpose: "check_in" }, { clientId: 0, purpose: "check_in" }, { clientId: 7, purpose: "nonsense" }, { clientId: "7", purpose: "check_in" }]) {
    assert.equal(composeSentRequest(bad), null, JSON.stringify(bad));
  }
});

test("composeMarkFields: keeps clientId, purpose and a well-formed occasion; drops the rest", () => {
  const occasion = { kind: "child_birthday", who: "Maya", date: "2026-11-22" };
  const kept = composeMarkFields({ clientId: 7, purpose: "family_birthday", occasion: { ...occasion, extra: "x" }, to: "x@example.com" });
  assert.deepEqual(kept, { clientId: 7, purpose: "family_birthday", occasion });
  assert.deepEqual(composeMarkFields({ clientId: 7, purpose: "check_in", occasion }), { clientId: 7, purpose: "check_in" });
  assert.deepEqual(composeMarkFields({ clientId: 7, purpose: "family_birthday", occasion: { ...occasion, date: "soon" } }), { clientId: 7, purpose: "family_birthday" });
  for (const bad of [null, undefined, "x", {}, { clientId: -1, purpose: "check_in" }, { clientId: 7 }, { clientId: 7, purpose: "constructor" }]) {
    assert.deepEqual(composeMarkFields(bad), {}, JSON.stringify(bad));
  }
});

// node --test src/auth/
// The sign-up and invite screens' logic, with no DOM and no React (the screens are in App.jsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { signupTokenFrom, inviteTokenFrom, signupSentText, signupCheckOutcome, inviteCheckOutcome } from "./signup.mjs";

const HEX = "a".repeat(64);

test("signupTokenFrom reads only a 64-hex signup value from the fragment", () => {
  assert.equal(signupTokenFrom(`#signup=${HEX}`), HEX);
  for (const bad of ["#signup=abc", `#reset=${HEX}`, `?signup=${HEX}`, `#signup=${"A".repeat(64)}`, `#signup=${HEX}0`, "", null, undefined])
    assert.equal(signupTokenFrom(bad), null);
});

test("inviteTokenFrom prefers #invite=, still reads a legacy ?token=, and refuses anything else", () => {
  assert.equal(inviteTokenFrom(`#invite=${HEX}`, ""), HEX);
  assert.equal(inviteTokenFrom("", `?token=${HEX}`), HEX);
  assert.equal(inviteTokenFrom(`#invite=${HEX}`, `?token=${"b".repeat(64)}`), HEX);
  assert.equal(inviteTokenFrom("", "?token=abc"), null);
  assert.equal(inviteTokenFrom(`#signup=${HEX}`, ""), null);
  assert.equal(inviteTokenFrom(undefined, undefined), null);
});

test("signupSentText is the approved line", () => {
  assert.equal(signupSentText("nia@x.test"),
    "We've sent a link to nia@x.test. Open it within 24 hours to finish creating your account. If it doesn't arrive in a few minutes, check your spam folder.");
});

test("signupCheckOutcome: ok needs email and orgName; only a 410 is final", () => {
  assert.deepEqual(signupCheckOutcome(200, { email: "a@x", orgName: "Co" }), { kind: "ok", email: "a@x", orgName: "Co" });
  assert.deepEqual(signupCheckOutcome(410, null), { kind: "gone", text: "This link has expired or was already used." });
  assert.equal(signupCheckOutcome(200, { email: "a@x" }).kind, "retry");
  assert.equal(signupCheckOutcome(502, null).kind, "retry");
  assert.deepEqual(signupCheckOutcome(502, null), { kind: "retry", text: "Couldn't check your link — please try again" });
});

test("inviteCheckOutcome: ok carries the four fields; only a 410 is final", () => {
  assert.deepEqual(
    inviteCheckOutcome(200, { firstName: "N", lastName: "L", email: "a@x", orgName: "Co", success: true }),
    { kind: "ok", info: { firstName: "N", lastName: "L", email: "a@x", orgName: "Co" } },
  );
  assert.deepEqual(inviteCheckOutcome(410, null), { kind: "gone", text: "This invitation has expired or was already used." });
  assert.equal(inviteCheckOutcome(429, { error: "Too many" }).kind, "retry");
  assert.equal(inviteCheckOutcome(429, { error: "Too many" }).text, "Too many");
  assert.equal(inviteCheckOutcome(200, { email: "a@x" }).kind, "retry");
});

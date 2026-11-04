// node --test src/auth/
// The forgot-password screens' logic, with no DOM and no React (the screens are in App.jsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetTokenFrom, newPasswordProblem, forgotSentText, linkCheckOutcome, prefillEmail, PASSWORD_CHANGED_NOTICE } from "./reset.mjs";

const HEX = "a".repeat(64);

test("resetTokenFrom reads only a 64-hex reset value from the fragment", () => {
  assert.equal(resetTokenFrom(`#reset=${HEX}`), HEX);
  assert.equal(resetTokenFrom(`#reset=${"0123456789abcdef".repeat(4)}`), "0123456789abcdef".repeat(4));
  // too short, a different name, nothing at all, upper case, or in the query instead of the fragment: no token
  assert.equal(resetTokenFrom("#reset=abc"), null);
  assert.equal(resetTokenFrom(`#token=${HEX}`), null);
  assert.equal(resetTokenFrom(""), null);
  assert.equal(resetTokenFrom(`#reset=${"A".repeat(64)}`), null);
  assert.equal(resetTokenFrom(`?reset=${HEX}`), null);
});

test("resetTokenFrom refuses a value that is not exactly a token", () => {
  assert.equal(resetTokenFrom(`#reset=${HEX}0`), null);               // 65 characters
  assert.equal(resetTokenFrom(`#reset=${"a".repeat(63)}g`), null);     // 64 characters but one is not hex
  assert.equal(resetTokenFrom(`#reset=${HEX}&x=1`), HEX);              // another fragment parameter beside it is fine
  assert.equal(resetTokenFrom(`#x=1&reset=${HEX}`), HEX);
  assert.equal(resetTokenFrom(undefined), null);
  assert.equal(resetTokenFrom(null), null);
});

test("newPasswordProblem: length first, then match", () => {
  assert.equal(newPasswordProblem("short", "short"), "Password must be at least 8 characters");
  assert.equal(newPasswordProblem("short", "different"), "Password must be at least 8 characters");
  assert.equal(newPasswordProblem("longenough", "different"), "Passwords don't match");
  assert.equal(newPasswordProblem("longenough", "longenough"), null);
  assert.equal(newPasswordProblem("12345678", "12345678"), null);   // exactly eight is enough
  assert.equal(newPasswordProblem("", ""), "Password must be at least 8 characters");
});

test("linkCheckOutcome: only a 410 means the link is gone; any other failure of the check can be tried again", () => {
  assert.deepEqual(linkCheckOutcome(200, { success: true, email: "lou@x.test" }), { kind: "ok", email: "lou@x.test" });
  assert.deepEqual(
    linkCheckOutcome(410, { success: false, error: "This link has expired or was already used." }),
    { kind: "gone", text: "This link has expired or was already used." },
  );
  assert.deepEqual(linkCheckOutcome(410, null), { kind: "gone", text: "This link has expired or was already used." });
  // the host answering badly (a restart, a gateway error, a limit) says nothing about the link itself
  assert.deepEqual(linkCheckOutcome(500, { success: false, error: "Server error" }), { kind: "retry", text: "Server error" });
  assert.deepEqual(linkCheckOutcome(502, null), { kind: "retry", text: "Couldn't check your link — please try again" });
  assert.deepEqual(linkCheckOutcome(429, {}), { kind: "retry", text: "Couldn't check your link — please try again" });
  // a 200 with no address is not an answer the page can use
  assert.deepEqual(linkCheckOutcome(200, { success: true }), { kind: "retry", text: "Couldn't check your link — please try again" });
});

test("prefillEmail: a string is kept (trimmed); anything else, such as a click event, is empty", () => {
  assert.equal(prefillEmail("lou@x.test"), "lou@x.test");
  assert.equal(prefillEmail("  lou@x.test "), "lou@x.test");
  assert.equal(prefillEmail(""), "");
  assert.equal(prefillEmail(undefined), "");
  assert.equal(prefillEmail(null), "");
  assert.equal(prefillEmail(42), "");
  assert.equal(prefillEmail({ type: "click", target: {} }), "");
});

test("the sent text and the changed notice are the approved words", () => {
  assert.equal(
    forgotSentText("lou@x.test"),
    "If there's a Broker Radar account for lou@x.test, we've sent it a link to choose a new password. The link works for 60 minutes. If it doesn't arrive in a few minutes, check your spam folder.",
  );
  assert.equal(PASSWORD_CHANGED_NOTICE, "Your password was changed. Any other devices were signed out.");
});

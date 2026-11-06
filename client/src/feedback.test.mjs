import test from "node:test";
import assert from "node:assert/strict";
import { feedbackCanSend, FEEDBACK_MAX, FEEDBACK_THANKS } from "./feedback.mjs";

test("feedbackCanSend: null when fine, else the server's two lines", () => {
  assert.equal(feedbackCanSend("Love it"), null);
  assert.equal(feedbackCanSend("a".repeat(2000)), null);
  assert.equal(feedbackCanSend(""), "Please write a message.");
  assert.equal(feedbackCanSend("  \n "), "Please write a message.");
  assert.equal(feedbackCanSend(undefined), "Please write a message.");
  assert.equal(feedbackCanSend("a".repeat(2001)), "Please keep it under 2,000 characters.");
  assert.equal(feedbackCanSend(`  ${"a".repeat(2000)}  `), null);
});

test("constants", () => {
  assert.equal(FEEDBACK_MAX, 2000);
  assert.equal(FEEDBACK_THANKS, "Thanks — the Broker Radar team will read this.");
});

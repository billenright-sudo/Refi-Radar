import { test } from "node:test";
import assert from "node:assert/strict";
import { dockParts, portraitSlot, PORTRAIT_MIN, PORTRAIT_FULL, BRIEFING_SHRINK } from "./dockLayout.mjs";

const readBack = "Just to confirm — log a call with Helen & Walter Brandt, with your notes?";
const talk = [
  { role: "user", content: "Log a call with Helen & Walter Brandt. I reached them." },
  { role: "assistant", content: readBack },
];
const ALL = { conversation: true, briefing: true, talkOptions: true, smallPrint: true };

test("with nothing waiting for an OK, every part of the dock shows", () => {
  assert.deepEqual(dockParts({ stacked: false, pending: null, turns: talk }), ALL);
});

test("while a change waits for an OK, the card takes the conversation's place: the rest steps aside", () => {
  assert.deepEqual(dockParts({ stacked: false, pending: { readBack }, turns: talk }),
    { conversation: false, briefing: false, talkOptions: false, smallPrint: false });
});

test("a line said after the read-back (a retry notice, a didn't-catch) keeps the conversation on screen", () => {
  const later = [...talk, { role: "assistant", content: "I couldn't finish that just now. Say yes to try again, or cancel.", kind: "notice" }];
  assert.equal(dockParts({ stacked: false, pending: { readBack }, turns: later }).conversation, true);
});

test("a read-back missing from the conversation leaves the conversation showing", () => {
  assert.equal(dockParts({ stacked: false, pending: { readBack: "something else?" }, turns: talk }).conversation, true);
});

test("stacked (tablet, phone) the page scrolls, so nothing steps aside", () => {
  assert.deepEqual(dockParts({ stacked: true, pending: { readBack }, turns: talk }), ALL);
});

test("missing arguments show everything", () => {
  assert.deepEqual(dockParts(), ALL);
});

test("the portrait's slot starts at full size and may shrink, never under 100px tall", () => {
  assert.equal(PORTRAIT_MIN, 100);
  assert.equal(PORTRAIT_FULL, "min(318px, 28vh)");
  assert.deepEqual(portraitSlot(), { flex: "0 1 min(318px, 28vh)", minHeight: 100 });
});

test("the briefing gives way well before the portrait does", () => {
  assert.ok(BRIEFING_SHRINK >= 50, "the portrait's slot shrinks at 1");
});

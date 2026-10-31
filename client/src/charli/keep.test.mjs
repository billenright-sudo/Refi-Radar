// node --test src/charli/
import { test } from "node:test";
import assert from "node:assert/strict";
import { keptSession, endKeptSession } from "./keep.mjs";

test("the same user gets the same conversation back; another user, or ending it, starts a fresh one", () => {
  let made = 0;
  const disposed = [];
  const make = () => { const id = ++made; return { id, dispose: () => disposed.push(id) }; };
  const a = keptSession(1, make);
  assert.equal(keptSession(1, make), a);
  const b = keptSession(2, make);
  assert.notEqual(b.session, a.session);
  assert.deepEqual(disposed, [1], "the first user's conversation is ended");
  endKeptSession();
  assert.deepEqual(disposed, [1, 2]);
  assert.equal(keptSession(2, make).session.id, 3, "signing in again starts a fresh one");
  endKeptSession();
  endKeptSession();   // nothing kept: a no-op
  assert.deepEqual(disposed, [1, 2, 3]);
});

test("lines Charli says go to whichever screen is showing, and nowhere when none is", () => {
  let say;
  const kept = keptSession(1, (onSpeak) => { say = onSpeak; return { dispose() {} }; });
  say({ text: "nobody listening" });
  const heard = [];
  kept.voice.speak = (line) => heard.push(line.text);
  say({ text: "hi" });
  kept.voice.speak = null;
  say({ text: "gone again" });
  assert.deepEqual(heard, ["hi"]);
  endKeptSession();
});

test("final review I3: the conversation is kept per user AND per local day: past midnight a fresh one is built", () => {
  let made = 0;
  const disposed = [];
  const make = () => { const id = ++made; return { id, dispose: () => disposed.push(id) }; };
  const evening = new Date(2026, 10, 5, 21, 0);   // 9 PM on 5 November, on this machine's clock
  const a = keptSession(1, make, evening);
  assert.equal(keptSession(1, make, new Date(2026, 10, 5, 23, 59)).session, a.session, "later the same day: the same one");
  const b = keptSession(1, make, new Date(2026, 10, 6, 0, 1));
  assert.notEqual(b.session, a.session, "the next local day: a fresh one, so a fresh briefing");
  assert.deepEqual(disposed, [1], "yesterday's is ended");
  assert.equal(keptSession(1, make, new Date(2026, 10, 6, 9, 0)).session, b.session);
  endKeptSession();
  assert.deepEqual(disposed, [1, 2]);
});

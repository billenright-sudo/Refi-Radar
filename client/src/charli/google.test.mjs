// node --test src/charli/
// The labels, notices and small decisions of the "Calendar & email" card (google.mjs): no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleCard, returnNotice, validNmls, connectUrlOk, inputAfterReload, createCoalescer } from "./google.mjs";

// ── googleCard: what the card says and which button it offers ────────────────

test("googleCard: a server without Google set up says so and offers nothing", () => {
  const expected = { label: "Google isn't set up on this server", action: null };
  assert.deepEqual(googleCard({ configured: false, connected: false, status: null, googleEmail: null }), expected);
  // not configured wins over everything else the status might claim
  assert.deepEqual(googleCard({ configured: false, connected: true, status: "connected", googleEmail: "ann@gmail.test" }), expected);
});

test("googleCard: configured but not connected offers Connect", () => {
  assert.deepEqual(
    googleCard({ configured: true, connected: false, status: null, googleEmail: null }),
    { label: "Connect Google Calendar so Charli can read and book your day", action: "connect" },
  );
});

test("googleCard: a connection that needs signing in again offers Reconnect (a row exists, so connected is true)", () => {
  const expected = { label: "Your Google connection expired", action: "reconnect" };
  assert.deepEqual(googleCard({ configured: true, connected: true, status: "reconnect", googleEmail: "ann@gmail.test" }), expected);
  assert.deepEqual(googleCard({ configured: true, connected: true, status: "reconnect", googleEmail: null }), expected);
});

test("googleCard: connected names the Google account and offers Disconnect", () => {
  assert.deepEqual(
    googleCard({ configured: true, connected: true, status: "connected", googleEmail: "ann@gmail.test" }),
    { label: "Calendar connected as ann@gmail.test", action: "disconnect" },
  );
  // an account whose address is not known is still connected
  assert.deepEqual(
    googleCard({ configured: true, connected: true, status: "connected", googleEmail: null }),
    { label: "Calendar connected", action: "disconnect" },
  );
});

test("googleCard: anything that is not a status object offers nothing", () => {
  for (const bad of [null, undefined, "connected", 7, []]) {
    assert.deepEqual(googleCard(bad), { label: "Google isn't set up on this server", action: null }, String(bad));
  }
});

// ── returnNotice: the line shown when Google sends the browser back ──────────

test("returnNotice: connected, denied and error each have their own line", () => {
  assert.equal(returnNotice("?google=connected"), "Google Calendar is connected.");
  assert.equal(returnNotice("?google=denied"), "Google wasn't connected — permission was declined.");
  assert.equal(returnNotice("?google=error"), "Google couldn't be connected. Try again.");
});

test("Final fix (Ruling 56): returnNotice: a sign-in with the calendar box unticked says to tick it", () => {
  assert.equal(returnNotice("?google=scope"), "Google wasn't connected — tick the calendar permission and try again.");
  assert.equal(returnNotice("?a=1&google=scope"), "Google wasn't connected — tick the calendar permission and try again.");
  assert.equal(returnNotice("?google=SCOPE"), null);
});

test("returnNotice: the other query parameters around it do not matter, a missing or unknown one is null", () => {
  assert.equal(returnNotice("?a=1&google=connected&b=2"), "Google Calendar is connected.");
  assert.equal(returnNotice("google=denied"), "Google wasn't connected — permission was declined.");
  for (const none of ["", "?", "?x=1", "?google=", "?google=yes", "?google=CONNECTED", "?google=constructor", "?google=__proto__", null, undefined, 5]) {
    assert.equal(returnNotice(none), null, String(none));
  }
});

// ── validNmls: what the NMLS fields accept before they are saved ─────────────

test("validNmls: one to twelve digits after trimming, or empty (which clears the ID)", () => {
  for (const ok of ["1", "123456", "  445566 ", "123456789012", "", "   "]) assert.equal(validNmls(ok), true, JSON.stringify(ok));
  for (const bad of ["1234567890123", "12 34", "12a", "abc", "-5", "1.5", "#123456", "١٢٣", null, undefined, 123456]) {
    assert.equal(validNmls(bad), false, JSON.stringify(bad));
  }
});

// ── connectUrlOk: the only address Connect / Reconnect will send the browser to ──

test("connectUrlOk: only Google's own sign-in address, over https, is followed", () => {
  for (const ok of [
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/",
  ]) assert.equal(connectUrlOk(ok), true, ok);
  for (const bad of [
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com",
    "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
    "https://accounts.google.com@evil.test/o/oauth2/v2/auth",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
    "https://accounts.google.com\@evil.test/",
    "https://evil.test/https://accounts.google.com/",
    "https://evil.test/o/oauth2/v2/auth",
    "https://mail.google.com/",
    "https://google.com/",
    "HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth",
    " https://accounts.google.com/o/oauth2/v2/auth",
    "//accounts.google.com/o/oauth2/v2/auth",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/api/google/callback",
    "", null, undefined, 5, {}, ["https://accounts.google.com/"],
  ]) assert.equal(connectUrlOk(bad), false, JSON.stringify(bad));
});

// ── inputAfterReload: what an NMLS field shows once the saved value is read again ──

test("inputAfterReload: a field nobody has edited follows the saved value; one being edited is left alone", () => {
  // untouched (the field still shows what was saved): it follows the new saved value, whatever shape it has
  assert.equal(inputAfterReload("654321", "654321", "999000"), "999000");
  assert.equal(inputAfterReload("654321", "654321", null), "");
  assert.equal(inputAfterReload("", null, "654321"), "654321");
  assert.equal(inputAfterReload("  654321 ", "654321", "654321"), "654321");
  assert.equal(inputAfterReload("", null, null), "");
  // being edited (the field differs from what was saved): never overwritten, not even by an unchanged saved value
  assert.equal(inputAfterReload("6543", "654321", "999000"), "6543");
  assert.equal(inputAfterReload("12a", "654321", "654321"), "12a");
  assert.equal(inputAfterReload("777", null, "654321"), "777");
  assert.equal(inputAfterReload("", "654321", "999000"), "", "cleared by hand, not yet saved");
  // the very first load (nothing was saved before): an empty field takes the saved value
  assert.equal(inputAfterReload("", undefined, "654321"), "654321");
});

// ── createCoalescer: one re-read at a time, and none lost ────────────────────

// A task that finishes only when told to, so a test can fire triggers while it is running.
function gatedTask() {
  const gates = [];
  const t = { runs: 0, running: 0, maxRunning: 0 };
  t.task = async () => {
    t.runs++; t.running++; t.maxRunning = Math.max(t.maxRunning, t.running);
    await new Promise((resolve) => gates.push(resolve));
    t.running--;
  };
  t.release = async () => { gates.shift()(); await new Promise((r) => setImmediate(r)); };
  return t;
}
const tick = () => new Promise((r) => setImmediate(r));

test("createCoalescer: each trigger on an idle runner runs the task, one at a time", async () => {
  const t = gatedTask();
  const trigger = createCoalescer(t.task);
  const first = trigger();
  await tick();
  assert.equal(t.runs, 1);
  await t.release();
  await first;
  const second = trigger();
  await tick();
  assert.equal(t.runs, 2);
  await t.release();
  await second;
  assert.equal(t.maxRunning, 1);
});

test("createCoalescer: triggers that arrive mid-run are not lost, but collapse into exactly one more run", async () => {
  const t = gatedTask();
  const trigger = createCoalescer(t.task);
  const first = trigger();
  await tick();
  trigger(); trigger(); trigger();   // three things changed while the first read was in flight
  await tick();
  assert.equal(t.runs, 1, "no second read while one is in flight");
  await t.release();
  await tick();
  assert.equal(t.runs, 2, "one follow-up read, started after the first finished");
  await t.release();
  await first;
  assert.equal(t.runs, 2, "and no more than that");
  assert.equal(t.maxRunning, 1);
});

test("createCoalescer: a soft trigger (window focus) is dropped while a run is in flight, and runs when idle", async () => {
  const t = gatedTask();
  const trigger = createCoalescer(t.task);
  const first = trigger({ soft: true });
  await tick();
  trigger({ soft: true }); trigger({ soft: true });
  await t.release();
  await first;
  assert.equal(t.runs, 1, "soft triggers during a run add nothing");
  const again = trigger({ soft: true });
  await tick();
  assert.equal(t.runs, 2);
  await t.release();
  await again;
});

test("createCoalescer: a task that throws does not wedge it, and a failed run still gets its queued follow-up", async () => {
  let runs = 0;
  const gate = [];
  const trigger = createCoalescer(async () => {
    runs++;
    await new Promise((r) => gate.push(r));
    throw new Error("network down");
  });
  const first = trigger();
  await tick();
  trigger();
  gate.shift()();
  await tick();
  assert.equal(runs, 2);
  gate.shift()();
  await first;
  const later = trigger();
  await tick();
  assert.equal(runs, 3, "still usable afterwards");
  gate.shift()();
  await later;
});

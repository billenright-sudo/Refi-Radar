// node --test src/charli/
// The labels and notices of the "Calendar & email" card (google.mjs): pure functions, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleCard, returnNotice, validNmls } from "./google.mjs";

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

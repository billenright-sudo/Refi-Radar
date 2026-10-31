// node --test src/calls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCalls, callRows, OUTCOME_LABELS } from "./calls.mjs";

const fakeFetch = (status, body, seen = []) => async (url, init = {}) => {
  seen.push({ url, method: init.method || "GET" });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

test("the outcome labels are the client page's words", () => {
  assert.deepEqual(OUTCOME_LABELS, { reached: "Reached", not_reached: "Couldn't reach" });
});

test("callRows: each call as { key, date, outcome, label, notes }, in the server's order, the date in the device's own day", () => {
  const rows = callRows([
    { at: "2026-10-29 16:30:00", outcome: "reached", notes: "Called back <b>later</b>" },
    { at: "2026-10-28 15:00:00", outcome: "not_reached", notes: "" },
  ]);
  const day = (at) => new Date(`${at.replace(" ", "T")}Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  assert.deepEqual(rows, [
    { key: 0, date: day("2026-10-29 16:30:00"), outcome: "reached", label: "Reached", notes: "Called back <b>later</b>" },
    { key: 1, date: day("2026-10-28 15:00:00"), outcome: "not_reached", label: "Couldn't reach", notes: "" },
  ]);
});

test("callRows: anything that is not a call with a real time and a known outcome is left out; odd notes are none", () => {
  const rows = callRows([
    null, "x", { at: "yesterday", outcome: "reached" }, { at: "2026-10-29 16:30:00", outcome: "maybe" },
    { at: "2026-10-29 16:30:00", outcome: "reached", notes: 42 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notes, "");
  assert.deepEqual(callRows(undefined), []);
  assert.deepEqual(callRows({ calls: [] }), []);
});

test("loadCalls: GET /api/clients/:id/calls, then the rows; a failure is a line to show, never a throw", async () => {
  const seen = [];
  const ok = await loadCalls(fakeFetch(200, { success: true, calls: [{ at: "2026-10-29 16:30:00", outcome: "reached", notes: "n" }] }, seen), 7);
  assert.deepEqual(seen, [{ url: "/api/clients/7/calls", method: "GET" }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].notes, "n");

  for (const [status, body] of [[403, { success: false, error: "Access denied" }], [404, { success: false, error: "Client not found" }], [500, null]]) {
    const r = await loadCalls(fakeFetch(status, body), 7);
    assert.deepEqual(r, { ok: false, error: "Couldn't load the calls for this client." }, String(status));
  }
  const down = await loadCalls(async () => { throw new Error("offline"); }, 7);
  assert.deepEqual(down, { ok: false, error: "Couldn't load the calls for this client." });
  assert.deepEqual(await loadCalls(fakeFetch(200, { success: true, calls: [] }), "7/../x"), { ok: false, error: "Couldn't load the calls for this client." });
});

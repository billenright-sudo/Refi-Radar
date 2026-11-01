// node --test src/import/
// The Import page's logic talks to the server only through an injected fetch, so every flow here runs with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { File } from "node:buffer";
import {
  uploadFile, reviewAgain, confirmImport, fundedStatusesOf, withMapping, withStatus, outcomeText, summaryText, pageOf,
} from "./importer.mjs";

const reply = (status, body) => ({ status, body });

// A fake server like the one in ../profile/profile.test.mjs. `routes` maps "METHOD /url" to a function (body, call) -> reply(...)
// (or a throw = network failure). A JSON body is parsed; a FormData body (the upload) is kept as it is. Anything unrouted answers
// 404 and shows up in server.unexpected.
function fakeServer(routes) {
  const calls = [];
  const unexpected = [];
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call = { method: init.method || "GET", url, body, headers: init.headers };
    calls.push(call);
    const handler = routes[`${call.method} ${url}`];
    if (!handler) { unexpected.push(call); return { ok: false, status: 404, json: async () => ({ error: "no route" }) }; }
    const { status, body: out } = await handler(call.body, call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { if (out === "not json") throw new SyntaxError("Unexpected token"); return out; },
    };
  };
  return { fetch, calls, unexpected };
}

const COUNTS = { created: 1, updated: 0, unchanged: 0, ambiguous: 0, skipped: 0, moved: 0, byOwner: [] };
const REVIEW = {
  success: true,
  fields: [{ id: "borrowerName", label: "Borrower name" }, { id: "status", label: "Loan status" }],
  headers: [{ index: 0, header: "Borrower" }, { index: 1, header: "Status" }],
  mapping: { borrowerName: 0, status: 1 },
  statuses: [
    { value: "funded", label: "Funded", count: 2, funded: true },
    { value: "withdrawn", label: "Withdrawn", count: 1, funded: false },
    { value: "closed", label: "Closed", count: 4, funded: true },
  ],
  everyRowFunded: false,
  totalRows: 7,
  results: [{ row: 2, outcome: "created", name: "Ann Lee", reason: null, note: null, flags: [], owner: { id: 1, name: "Lou Park" }, movedFrom: null }],
  counts: COUNTS,
  reviewHash: "abc123",
  fileData: "QSxCCg==",
  mimetype: "text/csv",
};
const RESULT = { success: true, results: REVIEW.results, counts: COUNTS };
const NO_SERVER = "Couldn't reach the server. Check your connection and try again.";

// ── the calls ──

test("uploadFile posts the file as multipart and returns the review", async () => {
  const server = fakeServer({ "POST /api/import/preview": () => reply(200, REVIEW) });
  const file = new File(["Borrower,Status\nAnn,Funded\n"], "clients.csv", { type: "text/csv" });
  const res = await uploadFile(server.fetch, file);

  assert.deepEqual(res, { ok: true, data: REVIEW });
  assert.equal(server.calls.length, 1);
  const [call] = server.calls;
  assert.equal(call.method, "POST");
  assert.ok(call.body instanceof FormData, "the body is multipart");
  assert.equal(call.body.get("file").name, "clients.csv");
  assert.equal(await call.body.get("file").text(), "Borrower,Status\nAnn,Funded\n");
  // The browser writes the multipart Content-Type itself (it carries the boundary), so none may be set here.
  assert.equal(call.headers, undefined);
});

test("uploadFile turns away a file that is not a CSV or Excel file without calling the server", async () => {
  const server = fakeServer({});
  for (const name of ["clients.pdf", "clients", "notes.txt"]) {
    const res = await uploadFile(server.fetch, new File(["x"], name));
    assert.deepEqual(res, { ok: false, error: "Please upload a CSV or Excel file (.csv, .xls, .xlsx)" }, name);
  }
  for (const name of ["a.csv", "A.CSV", "b.xls", "c.xlsx", "d.e.XLSX"]) {
    const ok = fakeServer({ "POST /api/import/preview": () => reply(200, REVIEW) });
    assert.equal((await uploadFile(ok.fetch, new File(["x"], name))).ok, true, name);
  }
  assert.equal(server.calls.length, 0);
  assert.deepEqual((await uploadFile(server.fetch, null)), { ok: false, error: "That didn't work. Try again." });
});

test("reviewAgain sends the mapping and ticked statuses with the file data", async () => {
  const server = fakeServer({ "POST /api/import/review": () => reply(200, REVIEW) });
  const mapping = { borrowerName: 0, status: 1 };
  const res = await reviewAgain(server.fetch, REVIEW, { mapping, fundedStatuses: ["funded", "closed"] });

  assert.deepEqual(res, { ok: true, data: REVIEW });
  const [call] = server.calls;
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.deepEqual(Object.keys(call.body).sort(), ["fileData", "fundedStatuses", "mapping", "mimetype"]);
  assert.deepEqual(call.body, { fileData: "QSxCCg==", mimetype: "text/csv", mapping, fundedStatuses: ["funded", "closed"] });
});

test("reviewAgain sends fundedStatuses as null (the server's defaults) when none were given", async () => {
  const server = fakeServer({ "POST /api/import/review": () => reply(200, REVIEW) });
  await reviewAgain(server.fetch, REVIEW, { mapping: REVIEW.mapping, fundedStatuses: null });
  assert.equal(server.calls[0].body.fundedStatuses, null);
  assert.ok("fundedStatuses" in server.calls[0].body);
});

test("confirmImport sends the file data, the picks and the review hash", async () => {
  const server = fakeServer({ "POST /api/import/confirm": () => reply(200, RESULT) });
  await confirmImport(server.fetch, REVIEW);

  const [call] = server.calls;
  assert.deepEqual(Object.keys(call.body).sort(), ["fileData", "fundedStatuses", "mapping", "mimetype", "reviewHash"]);
  assert.deepEqual(call.body, {
    fileData: "QSxCCg==", mimetype: "text/csv", mapping: REVIEW.mapping, fundedStatuses: ["funded", "closed"], reviewHash: "abc123",
  });
});

test("confirmImport: 200 → ok; 409 → changed with the fresh review; 403 → the broker-only message; a network throw → the connection message", async () => {
  const fresh = { ...REVIEW, reviewHash: "def456", counts: { ...COUNTS, created: 0 } };

  assert.deepEqual(
    await confirmImport(fakeServer({ "POST /api/import/confirm": () => reply(200, RESULT) }).fetch, REVIEW),
    { ok: true, data: RESULT },
  );
  assert.deepEqual(
    await confirmImport(fakeServer({
      "POST /api/import/confirm": () => reply(409, { success: false, error: "Something changed since the review. Check it again.", review: fresh }),
    }).fetch, REVIEW),
    { ok: false, changed: true, error: "Something changed since the review. Check it again.", review: fresh },
  );
  assert.deepEqual(
    await confirmImport(fakeServer({ "POST /api/import/confirm": () => reply(403, { success: false, error: "Forbidden" }) }).fetch, REVIEW),
    { ok: false, error: "Only a broker can import clients." },
  );
  assert.deepEqual(
    await confirmImport(fakeServer({ "POST /api/import/confirm": () => { throw new TypeError("fetch failed"); } }).fetch, REVIEW),
    { ok: false, error: NO_SERVER },
  );
});

test("a failed call shows the server's own error, else the plain fallback", async () => {
  const route = (status, body) => fakeServer({ "POST /api/import/review": () => reply(status, body) }).fetch;
  const ask = (fetchFn) => reviewAgain(fetchFn, REVIEW, { mapping: REVIEW.mapping, fundedStatuses: null });

  assert.deepEqual(await ask(route(400, { success: false, error: "File appears to be empty" })), { ok: false, error: "File appears to be empty" });
  assert.deepEqual(await ask(route(500, { success: false, error: "Import failed" })), { ok: false, error: "Import failed" });
  assert.deepEqual(await ask(route(500, "not json")), { ok: false, error: "That didn't work. Try again." });
  assert.deepEqual(await ask(route(400, { success: false })), { ok: false, error: "That didn't work. Try again." });
  assert.deepEqual(await ask(route(400, { success: false, error: "   " })), { ok: false, error: "That didn't work. Try again." });
  // A 200 that is not a review is not taken for one.
  assert.deepEqual(await ask(route(200, { success: true })), { ok: false, error: "That didn't work. Try again." });
  assert.deepEqual(await ask(route(200, "not json")), { ok: false, error: "That didn't work. Try again." });
  // A 409 with no review in it is an ordinary failure.
  const bare = await confirmImport(fakeServer({ "POST /api/import/confirm": () => reply(409, { success: false, error: "Nope" }) }).fetch, REVIEW);
  assert.deepEqual(bare, { ok: false, error: "Nope" });
});

// ── the picks ──

test("fundedStatusesOf returns the ticked values, or null when there is no status column", () => {
  assert.deepEqual(fundedStatusesOf(REVIEW.statuses), ["funded", "closed"]);
  assert.deepEqual(fundedStatusesOf([{ value: "x", label: "X", count: 1, funded: false }]), []);
  assert.equal(fundedStatusesOf(null), null);
  assert.equal(fundedStatusesOf(undefined), null);
});

test("withMapping changes one column, lets the latest pick win over another field's, and keeps the ticks unless the status column moved", () => {
  const review = { ...REVIEW, mapping: { borrowerName: 0, phone: 2, status: 1 } };

  // A plain change: the other fields and the ticked statuses stay as they are.
  assert.deepEqual(withMapping(review, "phone", 3), {
    mapping: { borrowerName: 0, phone: 3, status: 1 }, fundedStatuses: ["funded", "closed"],
  });
  // "— not in this file —".
  assert.deepEqual(withMapping(review, "phone", -1).mapping, { borrowerName: 0, phone: -1, status: 1 });
  // A column can belong to one field: taking phone's column frees phone (the server would otherwise drop the later pick).
  assert.deepEqual(withMapping(review, "borrowerName", 2).mapping, { borrowerName: 2, phone: -1, status: 1 });
  // Picking the column a field already has changes nothing.
  assert.deepEqual(withMapping(review, "phone", 2).mapping, review.mapping);
  // The ticks belong to the status column they were read from, so a different column starts again from the defaults.
  assert.equal(withMapping(review, "status", 3).fundedStatuses, null);
  assert.equal(withMapping(review, "status", -1).fundedStatuses, null);
  // The review it was given is not changed.
  assert.deepEqual(review.mapping, { borrowerName: 0, phone: 2, status: 1 });
});

test("withStatus flips one status and sends every ticked value", () => {
  assert.deepEqual(withStatus(REVIEW, "withdrawn", true), { mapping: REVIEW.mapping, fundedStatuses: ["funded", "withdrawn", "closed"] });
  assert.deepEqual(withStatus(REVIEW, "funded", false), { mapping: REVIEW.mapping, fundedStatuses: ["closed"] });
  assert.deepEqual(REVIEW.statuses.map((s) => s.funded), [true, false, true]);
});

// ── the words ──

test("outcomeText for every outcome and note", () => {
  const row = (outcome, more = {}) => ({ row: 2, outcome, name: "Ann Lee", reason: null, note: null, flags: [], owner: null, movedFrom: null, ...more });

  assert.equal(outcomeText(row("created")), "New");
  assert.equal(outcomeText(row("created", { note: "second property" })), "New (second property)");
  assert.equal(outcomeText(row("updated")), "Updated");
  assert.equal(
    outcomeText(row("updated", { movedFrom: "Lia Chen", owner: { id: 3, name: "Lou Park" } })),
    "Updated: moves from Lia Chen to Lou Park",
  );
  assert.equal(outcomeText(row("unchanged")), "Unchanged");
  assert.equal(outcomeText(row("unchanged", { note: "older loan" })), "Older loan: unchanged");
  assert.equal(outcomeText(row("ambiguous", { reason: "matched 2 clients" })), "Ambiguous: matched 2 clients, skipped");
  assert.equal(outcomeText(row("skipped", { reason: "not funded yet" })), "Skipped: not funded yet");
  // The other reasons the server gives, and a row with none.
  assert.equal(outcomeText(row("skipped", { reason: "not funded" })), "Skipped: not funded");
  assert.equal(outcomeText(row("skipped", { reason: "no name" })), "Skipped: no name");
  assert.equal(outcomeText(row("skipped")), "Skipped");
  assert.equal(outcomeText(row("ambiguous")), "Ambiguous: skipped");
});

test("summaryText counts ambiguous as skipped and shows moved only when > 0", () => {
  const counts = (more) => ({ ...COUNTS, created: 0, ...more });

  assert.equal(summaryText(counts({ created: 3, updated: 1, unchanged: 2, skipped: 1 })), "3 new · 1 updated · 2 unchanged · 1 skipped");
  assert.equal(summaryText(counts({ created: 3, updated: 1, unchanged: 2, skipped: 1, ambiguous: 2 })), "3 new · 1 updated · 2 unchanged · 3 skipped");
  assert.equal(summaryText(counts({ created: 3, updated: 1, unchanged: 2, skipped: 1, moved: 1 })), "3 new · 1 updated · 2 unchanged · 1 skipped · 1 moved");
  assert.equal(summaryText(counts({ moved: 0 })), "0 new · 0 updated · 0 unchanged · 0 skipped");
  assert.equal(summaryText(counts({ ambiguous: 2 })), "0 new · 0 updated · 0 unchanged · 2 skipped");
});

test("pageOf clamps and pages by 50", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);

  const first = pageOf(items, 1);
  assert.equal(first.pages, 3);
  assert.equal(first.page, 1);
  assert.equal(first.items.length, 50);
  assert.deepEqual([first.items[0], first.items[49]], [0, 49]);

  const last = pageOf(items, 9);
  assert.equal(last.page, 3);
  assert.equal(last.pages, 3);
  assert.equal(last.items.length, 20);
  assert.equal(last.items[0], 100);

  assert.equal(pageOf(items, 0).page, 1);
  assert.equal(pageOf(items, -4).page, 1);
  assert.equal(pageOf(items, 2.7).page, 2);
  assert.equal(pageOf(items, "x").page, 1);
  assert.equal(pageOf(items, 2, 10).pages, 12);
  assert.equal(pageOf(items.slice(0, 50), 1).pages, 1);
  assert.equal(pageOf(items.slice(0, 51), 2).items.length, 1);
  assert.deepEqual(pageOf([], 1), { items: [], page: 1, pages: 1 });
  assert.deepEqual(pageOf([], 5), { items: [], page: 1, pages: 1 });
  assert.deepEqual(pageOf(null, 1), { items: [], page: 1, pages: 1 });
});

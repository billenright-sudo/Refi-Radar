"use strict";
// Assistant tool layer (server/lib/assistant/tools.js) against a throwaway DB.
// Read tools wrap the sweep engine + CRM; side-effect tools only package intent (never write).
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-tools-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const { recordSnapshot } = require("../lib/rateHistory");
const {
  tools, TOOL_SCHEMA,
  getMarketUpdate, runSweepTool, findClient, addClientTool, logContactTool,
} = require("../lib/assistant/tools");

// Same rate set + Chen top-tier fixture as server/test/sweeps.test.js and refi-math.test.js —
// this keeps the server engine, the tool layer and the dashboard's analyze() on one known answer.
const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const LIVE = { ...RATES, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };

function addOrg(name) {
  return db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid;
}
function addUser(orgId, role, email) {
  return Number(db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)"
  ).run(orgId, role, email).lastInsertRowid);
}
function addClientRow(orgId, userId, c) {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, c.name, c.loanType, c.currentRate, c.loanBalance, c.propertyValue, c.creditScore, c.lastContact || null).lastInsertRowid);
}

// Org A: a broker and two loan officers, one client each.  Org B: an unrelated broker + client.
const orgA = addOrg("Alpha");
const orgB = addOrg("Bravo");
const brokerA = addUser(orgA, "broker", "broker@a.co");
const lo1 = addUser(orgA, "lo", "lo1@a.co");
const lo2 = addUser(orgA, "lo", "lo2@a.co");
const brokerB = addUser(orgB, "broker", "broker@b.co");

const chenId = addClientRow(orgA, lo1, {
  name: "Robert & Linda Chen", loanType: "30yr_fixed", currentRate: 7.85,
  loanBalance: 485000, propertyValue: 650000, creditScore: 760, lastContact: "2026-01-01",
});
const reyesId = addClientRow(orgA, lo2, {
  name: "Carlos & Maria Reyes", loanType: "30yr_fixed", currentRate: 6.5,
  loanBalance: 142000, propertyValue: 195000, creditScore: 790,
});
const otherOrgClientId = addClientRow(orgB, brokerB, {
  name: "Dana Chen-Other", loanType: "30yr_fixed", currentRate: 8.0,
  loanBalance: 300000, propertyValue: 450000, creditScore: 740,
});

const user = (id, role, orgId) => ({ id, role, org_id: orgId });
const brokerCtx = { user: user(brokerA, "broker", orgA), rates: LIVE, db };
const lo1Ctx = { user: user(lo1, "lo", orgA), rates: LIVE, db };

const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const clientCount = () => db.prepare("SELECT COUNT(*) AS n FROM clients").get().n;
// Error-path results must not look like a citation ("client record", "live rates ...").
const NON_CITING = /^\([^)]+\)$/;

test.beforeEach(() => {
  db.prepare("DELETE FROM rate_snapshots").run();
});

// ── getMarketUpdate ─────────────────────────────────────────────────────────

test("getMarketUpdate returns the rates, a cited source, and no deltas before any prior day", () => {
  const r = getMarketUpdate({}, brokerCtx);
  assert.equal(typeof r.data.rates.rate_30yr_fixed, "number");
  assert.equal(r.data.hasHistory, false);
  assert.equal(r.data.deltas, null);
  assert.equal(r.source, "live rates 2026-10-21");
});

test("getMarketUpdate reports day-over-day deltas once a prior-day snapshot exists", () => {
  recordSnapshot({ rate_30yr_fixed: 6.6, rate_15yr_fixed: 5.9 }, "2000-01-01");
  const r = getMarketUpdate({}, brokerCtx);
  assert.equal(r.data.hasHistory, true);
  assert.equal(r.data.deltas.rate_30yr_fixed, -0.08);
  assert.equal(r.data.deltas.rate_15yr_fixed, 0.01);
});

test("getMarketUpdate cites a dated 'live rates' source, and labels the estimated fallback honestly", () => {
  const { date, ...undated } = LIVE;
  assert.match(getMarketUpdate({}, { ...brokerCtx, rates: undated }).source, /^live rates \d{4}-\d{2}-\d{2}$/);

  const est = getMarketUpdate({}, { ...brokerCtx, rates: { ...RATES, date: "2026-10-21", source: "Estimated — live fetch unavailable" } });
  assert.match(est.source, /^estimated rates 2026-10-21$/);
});

const EST = { ...RATES, date: "2026-10-21", source: "Estimated — live fetch unavailable" };

test("getMarketUpdate on estimated rates never fabricates a delta, even with a prior-day live snapshot", () => {
  // A live prior-day snapshot exists, so getMovement would diff the hard-coded estimate against it
  // and invent a day-over-day move. The tool must skip getMovement entirely.
  recordSnapshot({ rate_30yr_fixed: 6.6, rate_15yr_fixed: 5.9 }, "2000-01-01");
  const r = getMarketUpdate({}, { ...brokerCtx, rates: EST });
  assert.equal(r.data.deltas, null);
  assert.equal(r.data.hasHistory, false);
  assert.equal(r.data.estimated, true);
  assert.equal(r.data.rates.rate_30yr_fixed, RATES.rate_30yr_fixed, "still returns the (labeled) estimate");
  assert.equal(r.source, "estimated rates 2026-10-21");
  // live rates are not flagged
  assert.equal(getMarketUpdate({}, brokerCtx).data.estimated, undefined);
});

test("A4: getMarketUpdate presents rates and deltas to two decimals in a new object; ctx.rates and the sweep keep the raw rates", () => {
  const raw = { rate_30yr_fixed: 7.251, rate_15yr_fixed: 6.564, rate_5_1_arm: 6.15, rate_30yr_top_tier: 6.9875, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
  const frozen = JSON.stringify(raw);
  recordSnapshot({ ...raw, rate_30yr_fixed: 7.236, rate_15yr_fixed: 6.601, source: "Optimal Blue lock data (2000-01-01)" }, "2000-01-01");
  const ctx = { ...brokerCtx, rates: raw };
  const sweepBefore = runSweepTool({}, ctx);
  const r = getMarketUpdate({}, ctx);
  assert.deepStrictEqual(r.data.rates, { rate_30yr_fixed: 7.25, rate_15yr_fixed: 6.56, rate_5_1_arm: 6.15, rate_30yr_top_tier: 6.99, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" });
  assert.equal(r.data.deltas.rate_30yr_fixed, 0.01, "0.015 to two decimals");
  assert.equal(r.data.deltas.rate_15yr_fixed, -0.04, "-0.037 to two decimals");
  for (const v of [...Object.values(r.data.rates), ...Object.values(r.data.deltas)]) {
    if (typeof v === "number") assert.ok(Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, `${v} has at most two decimals`);
  }
  assert.notStrictEqual(r.data.rates, raw, "a new object");
  assert.equal(JSON.stringify(raw), frozen, "ctx.rates is not mutated");
  const priced = (out) => { const { ranAt, ...rest } = out.data || out; return rest; };
  assert.deepStrictEqual(priced(runSweepTool({}, ctx)), priced(sweepBefore), "the sweep still prices from the raw rates");
  assert.deepStrictEqual(priced(runSweepTool({}, ctx)), priced(refi.runSweep(db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(orgA), raw)));
  // the estimated path is rounded too, and still a new object
  const est = getMarketUpdate({}, { ...brokerCtx, rates: { ...raw, source: "Estimated — live fetch unavailable" } });
  assert.equal(est.data.rates.rate_30yr_fixed, 7.25);
  assert.equal(est.data.estimated, true);
});

test("getMarketUpdate refuses to answer without rates (never invents a number)", () => {
  const r = getMarketUpdate({}, { ...brokerCtx, rates: null });
  assert.ok(r.data.error);
  assert.equal(r.data.rates, undefined);
  assert.match(r.source, NON_CITING, "an error must not carry a citation-looking source");
});

// ── runSweepTool ────────────────────────────────────────────────────────────

test("runSweepTool sweeps the whole org for a broker and hits the shared Chen known answer", () => {
  const r = runSweepTool({}, brokerCtx);
  assert.equal(r.source, "sweep engine");
  assert.equal(r.data.counts.total, 2, "org A only — org B's client is out of scope");
  assert.ok(r.data.opportunities.length >= 1);

  // Known answer: identical inputs/expectations to refi-math.test.js + sweeps.test.js (Chen, top-tier).
  const chen = r.data.opportunities.find((o) => o.name === "Robert & Linda Chen");
  assert.equal(chen.best.lens, "rate_term");
  assert.equal(chen.best.priority, "high", "delta >= 1.0 is high priority");
  assert.equal(chen.best.effRate, 6.46, "top-tier rate 6.461, no add-on");
  assert.ok(Math.abs(chen.best.rateDelta - 1.389) <= 0.01, `rate delta ${chen.best.rateDelta}`);
  assert.ok(chen.best.monthlySavings > 400 && chen.best.monthlySavings < 520, "monthly savings sane");
  assert.ok(chen.best.breakEven <= 24, "strong break-even");
});

test("runSweepTool is a thin wrapper — identical to the engine over the same scoped rows", () => {
  const rows = db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(orgA);
  const now = new Date();
  const expected = refi.runSweep(rows, LIVE, now);
  const actual = runSweepTool({}, brokerCtx).data;
  // ranAt is stamped by the engine at call time; everything else must match exactly.
  assert.deepStrictEqual({ ...actual, ranAt: null }, { ...expected, ranAt: null });
});

test("runSweepTool scopes a loan officer to their own clients only", () => {
  const r = runSweepTool({}, lo1Ctx);
  assert.equal(r.data.counts.total, 1);
  assert.equal(r.data.opportunities[0].name, "Robert & Linda Chen");
});

test("runSweepTool marks its result estimated when the inputs are the hard-coded fallback rates", () => {
  const r = runSweepTool({}, { ...brokerCtx, rates: EST });
  assert.equal(r.source, "sweep engine (estimated rates 2026-10-21)");
  assert.equal(r.data.estimated, true);
  assert.equal(r.data.counts.total, 2, "still sweeps the book");
  // live rates stay unmarked
  const live = runSweepTool({}, brokerCtx);
  assert.equal(live.source, "sweep engine");
  assert.equal(live.data.estimated, undefined);
});

test("runSweepTool refuses to answer without rates", () => {
  const r = runSweepTool({}, { ...brokerCtx, rates: {} });
  assert.ok(r.data.error);
  assert.equal(r.data.counts, undefined);
  assert.match(r.source, NON_CITING);
});

// ── findClient ──────────────────────────────────────────────────────────────

test("findClient: unique case-insensitive match", () => {
  const r = findClient({ query: "chen" }, brokerCtx);
  assert.equal(r.source, "client record");
  assert.equal(r.data.matches.length, 1, "org B's 'Chen-Other' must not leak across orgs");
  assert.equal(r.data.matches[0].name, "Robert & Linda Chen");
  assert.equal(r.data.matches[0].id, chenId);
  assert.equal(r.data.matches[0].loanBalance, 485000, "camelCase client shape");
});

test("findClient: ambiguous query returns every match for the caller to disambiguate", () => {
  const r = findClient({ query: "a" }, brokerCtx);
  assert.ok(r.data.matches.length > 1);
  assert.deepStrictEqual(r.data.matches.map((m) => m.id).sort(), [chenId, reyesId].sort());
});

test("findClient: no match returns an empty list; blank query never dumps the book", () => {
  assert.deepStrictEqual(findClient({ query: "zzz" }, brokerCtx).data.matches, []);
  for (const query of ["", "   ", undefined]) {
    const r = findClient({ query }, brokerCtx);
    assert.deepStrictEqual(r.data.matches, []);
    assert.ok(r.data.error);
    assert.match(r.source, NON_CITING);
  }
});

test("findClient: treats LIKE wildcards literally and scopes loan officers to their own", () => {
  assert.deepStrictEqual(findClient({ query: "%" }, brokerCtx).data.matches, []);
  assert.deepStrictEqual(findClient({ query: "_" }, brokerCtx).data.matches, []);
  // lo1 owns only the Chens; "a" would match Reyes for a broker but not for lo1.
  const r = findClient({ query: "a" }, lo1Ctx);
  assert.deepStrictEqual(r.data.matches.map((m) => m.id), [chenId]);
  assert.deepStrictEqual(findClient({ query: "reyes" }, lo1Ctx).data.matches, []);
});

// ── side-effect tools: package intent, never write ──────────────────────────

test("logContactTool packages a logContact intent and does NOT touch the DB", () => {
  const before = clientRow(chenId);
  const r = logContactTool({ clientId: chenId }, brokerCtx);
  assert.equal(r.sideEffect.type, "logContact");
  assert.equal(r.sideEffect.clientId, chenId);
  assert.equal(r.data.client.name, "Robert & Linda Chen");
  assert.equal(r.source, "client record");
  const after = clientRow(chenId);
  assert.equal(after.last_contact, "2026-01-01", "last_contact unchanged");
  assert.deepStrictEqual(after, before, "no column of the row changed");
});

test("logContactTool accepts a numeric-string id from the model", () => {
  const r = logContactTool({ clientId: String(chenId) }, brokerCtx);
  assert.equal(r.sideEffect.clientId, chenId, "normalized to the integer id");
});

test("logContactTool will not package an intent for an unknown or out-of-scope client", () => {
  for (const [clientId, ctx] of [
    [999999, brokerCtx],          // does not exist
    [reyesId, lo1Ctx],            // another loan officer's client
    [otherOrgClientId, brokerCtx], // another org's client
    ["abc", brokerCtx],           // not an id
    [undefined, brokerCtx],
  ]) {
    const r = logContactTool({ clientId }, ctx);
    assert.equal(r.sideEffect, undefined, `no side effect for clientId=${clientId}`);
    assert.ok(r.data.error);
    assert.equal(r.data.client, undefined);
    assert.match(r.source, NON_CITING, `error source must not cite for clientId=${clientId}`);
  }
});

test("logContactTool accepts only plain digit strings for an id (no exponent, hex, or padding)", () => {
  // Each of these coerces via Number() to a REAL id in scope, so a loose parse would resolve them.
  const literals = [`${chenId}e0`, `0x${chenId.toString(16)}`, ` ${chenId} `, `+${chenId}`, `${chenId}.0`];
  for (const lit of literals) {
    assert.equal(Number(lit), chenId, `precondition: Number(${JSON.stringify(lit)}) is a real id`);
    const r = logContactTool({ clientId: lit }, brokerCtx);
    assert.equal(r.sideEffect, undefined, `rejects ${JSON.stringify(lit)}`);
    assert.ok(r.data.error);
    assert.match(r.source, NON_CITING);
  }
  assert.equal(logContactTool({ clientId: `${chenId}` }, brokerCtx).sideEffect.clientId, chenId);
});

test("addClientTool previews the new client and does NOT write", () => {
  const fields = { name: "Priya Shah", loanType: "30yr_fixed", currentRate: 7.1, loanBalance: 300000, propertyValue: 420000 };
  const n = clientCount();
  const r = addClientTool(fields, brokerCtx);
  assert.deepStrictEqual(r.data.preview, fields);
  assert.equal(r.source, "(unsaved)");
  assert.deepStrictEqual(r.sideEffect, { type: "addClient", fields });
  assert.equal(clientCount(), n, "no row inserted");
});

// ── TOOL_SCHEMA ─────────────────────────────────────────────────────────────

test("TOOL_SCHEMA is a valid Anthropic tool array that lines up 1:1 with the tool fns", () => {
  assert.ok(Array.isArray(TOOL_SCHEMA) && TOOL_SCHEMA.length > 0);
  for (const t of TOOL_SCHEMA) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, "Anthropic tool-name charset");
    assert.ok(t.description, `${t.name} has a description`);
    assert.equal(t.input_schema.type, "object", `${t.name} input_schema`);
    assert.equal(typeof tools[t.name], "function", `${t.name} has an implementation`);
  }
  assert.deepStrictEqual(
    TOOL_SCHEMA.map((t) => t.name).sort(),
    Object.keys(tools).sort(),
    "every tool fn is described and every description has a fn"
  );
  assert.deepStrictEqual(
    TOOL_SCHEMA.map((t) => t.name).sort(),
    ["addClientTool", "explainTerm", "findClient", "getMarketUpdate", "logContactTool", "runSweepTool", "setCareerStageTool"]
  );
  const find = TOOL_SCHEMA.find((t) => t.name === "findClient");
  assert.deepStrictEqual(find.input_schema.required, ["query"]);
});

test("tools dispatch map has no prototype, so a model-supplied name can't hit Object.prototype", () => {
  assert.equal(Object.getPrototypeOf(tools), null);
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(tools[name], undefined, `${name} must not resolve`);
  }
  assert.ok(Object.isFrozen(tools));
});

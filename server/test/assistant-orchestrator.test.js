"use strict";
// Charli orchestrator (server/lib/assistant/orchestrator.js) against a throwaway DB and a
// scripted fake Anthropic client. The contract under test: the model can only produce facts
// by calling a tool, and a side-effect tool is returned for confirmation, never executed.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-orch-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const refi = require("../lib/refi");
const { TOOL_SCHEMA } = require("../lib/assistant/tools");
const { CHARLI_SYSTEM, CANT_VERIFY, GUIDELINE_HANDOFF } = require("../lib/assistant/prompt");
const { runTurn, screenUngroundedText } = require("../lib/assistant/orchestrator");

const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const LIVE = { ...RATES, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const EST = { ...RATES, date: "2026-10-21", source: "Estimated — live fetch unavailable" };

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

const orgA = addOrg("Alpha");
const brokerA = addUser(orgA, "broker", "broker@a.co");
const chenId = addClientRow(orgA, brokerA, {
  name: "Robert & Linda Chen", loanType: "30yr_fixed", currentRate: 7.85,
  loanBalance: 485000, propertyValue: 650000, creditScore: 760, lastContact: "2026-01-01",
});

// A separate org with 14 clients (all with an opportunity and a due check-in) to exercise the
// sweep trimming: more rows than the 10 the model is allowed to see.
const orgC = addOrg("Charlie");
const brokerC = addUser(orgC, "broker", "broker@c.co");
for (let i = 1; i <= 14; i++) {
  addClientRow(orgC, brokerC, {
    name: "Client " + String(i).padStart(2, "0"), loanType: "30yr_fixed", currentRate: 6.9 + i * 0.1,
    loanBalance: 400000, propertyValue: 600000, creditScore: 760, lastContact: "2024-01-01",
  });
}

const user = (id, role, orgId) => ({ id, role, org_id: orgId });
const brokerCtx = { user: user(brokerA, "broker", orgA), rates: LIVE, db };
const sweepCtx = { user: user(brokerC, "broker", orgC), rates: LIVE, db };

const lastContactOf = (id) => db.prepare("SELECT last_contact FROM clients WHERE id = ?").get(id).last_contact;
const clientCount = () => db.prepare("SELECT COUNT(*) AS n FROM clients").get().n;

// ── scripted fake client ─────────────────────────────────────────────────────

// `script[i]` is the response for the (i+1)th messages.create() call: a response object, or a
// function (params) => response, so a fake can read the tool_result the orchestrator fed back.
// `calls` snapshots every request so assertions see what the model was actually sent.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const next = script[calls.length - 1];
        if (next === undefined) throw new Error("fake client: script exhausted at call " + calls.length);
        return typeof next === "function" ? next(params) : next;
      },
    },
  };
}
const resp = (content, stop_reason, usage = { input_tokens: 100, output_tokens: 20 }) => ({
  id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage,
});
const say = (t, usage) => resp([{ type: "text", text: t }], "end_turn", usage);
const useTool = (name, input = {}, id = "toolu_1", usage) =>
  resp([{ type: "tool_use", id, name, input }], "tool_use", usage);
const userSays = (t) => [{ role: "user", content: t }];
// The JSON the model received for the tool_result at `idx` of the last user message.
const toolResultPayload = (params, idx = 0) => {
  const msg = params.messages[params.messages.length - 1];
  return JSON.parse(msg.content[idx].content);
};

// ── the four contract cases from the brief ───────────────────────────────────

test("market question: runs getMarketUpdate, feeds the result back, and cites the market source", async () => {
  const client = fakeClient([
    useTool("getMarketUpdate"),
    // narrate from the number the orchestrator actually fed back, so this proves the loop
    (params) => say(`The thirty-year fixed is at ${toolResultPayload(params).data.rates.rate_30yr_fixed} percent.`),
  ]);
  const r = await runTurn({ messages: userSays("what's today's rate?"), ctx: brokerCtx, client });
  assert.match(r.reply, /6\.52/);
  assert.deepStrictEqual(r.sources, ["live rates 2026-10-21"]);
  assert.equal(r.sideEffect, undefined);
  assert.equal(client.calls.length, 2);
  // history sent on the second call: user, assistant(tool_use), user(tool_result)
  const m = client.calls[1].messages;
  assert.deepStrictEqual(m.map((x) => x.role), ["user", "assistant", "user"]);
  assert.equal(m[1].content[0].type, "tool_use");
  assert.equal(m[2].content[0].type, "tool_result");
  assert.equal(m[2].content[0].tool_use_id, "toolu_1");
});

test("factual ask answered with no tool call returns the fixed can't-verify line and no sources", async () => {
  const client = fakeClient([say("Rates are around 6.9 percent today.")]);
  const r = await runTurn({ messages: userSays("what's today's rate"), ctx: brokerCtx, client });
  assert.equal(r.reply, "I can't verify that from what I have, so I won't guess.");
  assert.deepStrictEqual(r.sources, []);
  assert.equal(client.calls.length, 1);
});

test("logContactTool is returned as a sideEffect for confirmation, read back by name, and never executed", async () => {
  const before = lastContactOf(chenId);
  const client = fakeClient([useTool("logContactTool", { clientId: chenId })]);
  const r = await runTurn({ messages: userSays("log a call with Chen"), ctx: brokerCtx, client });
  assert.equal(r.reply, "Just to confirm — log a contact for Robert & Linda Chen?");
  assert.deepStrictEqual(r.sideEffect, { type: "logContact", clientId: chenId });
  assert.equal(lastContactOf(chenId), before, "the confirmation gate: nothing is written by the orchestrator");
  assert.equal(client.calls.length, 1, "short-circuits: no second model call for narration");
});

test("loan-guideline question answered in text gets the deferred-domain hand-off line", async () => {
  const client = fakeClient([say("FHA generally allows a back-end DTI up to 56.9 percent with compensating factors.")]);
  const r = await runTurn({ messages: userSays("What are the max DTI limits under FHA underwriting guidelines?"), ctx: brokerCtx, client });
  assert.equal(r.reply, GUIDELINE_HANDOFF);
  assert.match(r.reply, /guideline/i);
  assert.doesNotMatch(r.reply, /\d/);
  assert.deepStrictEqual(r.sources, []);
});

// ── text-only screening ──────────────────────────────────────────────────────

test("a greeting with no tool call passes through untouched (the morning greeting must work)", async () => {
  const client = fakeClient([say("Good morning, Bill! How can I help today?")]);
  const r = await runTurn({ messages: userSays("good morning"), ctx: brokerCtx, client });
  assert.equal(r.reply, "Good morning, Bill! How can I help today?");
  assert.deepStrictEqual(r.sources, []);
});

test("screenUngroundedText: guideline domain -> hand-off, even when the model text is harmless", () => {
  for (const u of [
    "What are the overlay requirements for FHA?", "Does this pass underwriting?", "what did DU findings say",
    "check the AUS result", "LPA feedback?", "what reserve requirements apply", "is she eligible",
    "what's the DTI limit", "max DTI for a jumbo?", "see the HUD handbook", "per the Selling Guide",
    "Any guidelines on that?",
  ]) {
    assert.equal(screenUngroundedText(u, "I'm not sure."), GUIDELINE_HANDOFF, u);
  }
});

test("screenUngroundedText: a digit or a book/market keyword -> can't-verify; otherwise pass through", () => {
  assert.equal(screenUngroundedText("tell me something", "You have 3 calls to make."), CANT_VERIFY);
  for (const u of [
    "how are rates", "what's the market doing", "run a sweep", "any opportunities", "who is my best client",
    "what's the balance", "what's the payment", "how much in savings", "what's the LTV", "how much equity",
    "any refi candidates", "cash-out options", "cash out options",
  ]) {
    assert.equal(screenUngroundedText(u, "Pretty good, I think."), CANT_VERIFY, u);
  }
  assert.equal(screenUngroundedText("good morning", "Good morning, Bill! How can I help?"), "Good morning, Bill! How can I help?");
  assert.equal(screenUngroundedText("thanks", "Anytime!"), "Anytime!");
});

test("screenUngroundedText: whole-word matching, and an empty model answer is never passed through", () => {
  // "AUS" must not fire inside "Austin"; "rate" must not fire inside "celebrate"
  assert.equal(screenUngroundedText("I'm flying to Austin", "Safe travels!"), "Safe travels!");
  assert.equal(screenUngroundedText("let's celebrate", "Congrats!"), "Congrats!");
  assert.equal(screenUngroundedText("hello", "   "), CANT_VERIFY);
  assert.equal(screenUngroundedText("hello", ""), CANT_VERIFY);
  assert.equal(screenUngroundedText("anything on guidelines", ""), GUIDELINE_HANDOFF);
});

test("an unscreened-looking answer after only a failed tool call cannot smuggle in a number", async () => {
  // getMarketUpdate with no rates -> "(unavailable)", which is not a citation, so nothing is grounded
  const client = fakeClient([useTool("getMarketUpdate"), say("Rates are around 6.9 percent.")]);
  const r = await runTurn({ messages: userSays("what's the rate"), ctx: { ...brokerCtx, rates: null }, client });
  assert.equal(r.reply, CANT_VERIFY);
  assert.deepStrictEqual(r.sources, []);
});

test("a failed lookup is narrated normally and its '(…)' source is not cited", async () => {
  const client = fakeClient([
    useTool("logContactTool", { clientId: 999999 }),
    say("I couldn't find that client in your book."),
  ]);
  const r = await runTurn({ messages: userSays("log a call with Zed"), ctx: brokerCtx, client });
  assert.equal(r.reply, "I couldn't find that client in your book.");
  assert.deepStrictEqual(r.sources, []);
  assert.equal(r.sideEffect, undefined);
});

// ── side effects ─────────────────────────────────────────────────────────────

test("addClientTool is returned as a sideEffect with a code-authored read-back, and nothing is inserted", async () => {
  const before = clientCount();
  const fields = { name: "Jane Doe", loanType: "30yr_fixed", currentRate: 7.1, loanBalance: 300000, propertyValue: 450000 };
  const client = fakeClient([useTool("addClientTool", fields)]);
  const r = await runTurn({ messages: userSays("add Jane Doe as a client"), ctx: brokerCtx, client });
  assert.equal(r.reply, "Just to confirm — add Jane Doe as a new client?");
  assert.deepStrictEqual(r.sideEffect, { type: "addClient", fields });
  assert.deepStrictEqual(r.sources, [], "(unsaved) is not a citation");
  assert.equal(clientCount(), before);
  assert.equal(client.calls.length, 1);
});

test("the read-back is built from the tool's data, never from model text", async () => {
  const client = fakeClient([resp([
    { type: "text", text: "Done! I logged the call for Bob Smith." },
    { type: "tool_use", id: "toolu_1", name: "logContactTool", input: { clientId: chenId } },
  ], "tool_use")]);
  const r = await runTurn({ messages: userSays("log a call with Chen"), ctx: brokerCtx, client });
  assert.equal(r.reply, "Just to confirm — log a contact for Robert & Linda Chen?");
  assert.doesNotMatch(r.reply, /Bob|Done/);
});

test("addClientTool with no usable name never reads back 'undefined'", async () => {
  const client = fakeClient([useTool("addClientTool", { loanType: "30yr_fixed" })]);
  const r = await runTurn({ messages: userSays("add a client"), ctx: brokerCtx, client });
  assert.equal(r.reply, "Just to confirm — add a new client?");
  assert.equal(r.sideEffect.type, "addClient");
});

// ── tool-name safety, loop cap, usage ────────────────────────────────────────

test("an unknown tool name executes nothing and resolves to the can't-verify line", async () => {
  let prepares = 0;
  const spyDb = { prepare: (...a) => { prepares++; return db.prepare(...a); } };
  for (const bogus of ["dropEverything", "constructor", "__proto__", "toString"]) {
    prepares = 0;
    // a valid tool first, then the bogus one: neither may run
    const client = fakeClient([resp([
      { type: "tool_use", id: "toolu_1", name: "findClient", input: { query: "chen" } },
      { type: "tool_use", id: "toolu_2", name: bogus, input: {} },
    ], "tool_use")]);
    const r = await runTurn({ messages: userSays("find chen"), ctx: { ...brokerCtx, db: spyDb }, client });
    assert.equal(r.reply, CANT_VERIFY, bogus);
    assert.deepStrictEqual(r.sources, [], bogus);
    assert.equal(r.sideEffect, undefined, bogus);
    assert.equal(prepares, 0, bogus + ": no tool may have run");
    assert.equal(client.calls.length, 1, bogus);
  }
});

test("the loop is capped at 4 model calls per turn and then resolves to the can't-verify line", async () => {
  const forever = Array.from({ length: 10 }, (_, i) => useTool("getMarketUpdate", {}, "toolu_" + i));
  const client = fakeClient(forever);
  const r = await runTurn({ messages: userSays("keep going"), ctx: brokerCtx, client });
  assert.equal(client.calls.length, 4);
  assert.equal(r.reply, CANT_VERIFY);
  assert.deepStrictEqual(r.sources, []);
  assert.deepStrictEqual(r.usage, { inputTokens: 400, outputTokens: 80 });
});

test("usage is summed across every model call in the turn", async () => {
  const client = fakeClient([
    useTool("getMarketUpdate", {}, "toolu_1", { input_tokens: 1000, output_tokens: 30 }),
    say("The thirty-year is at 6.52 percent.", { input_tokens: 1200, output_tokens: 40 }),
  ]);
  const r = await runTurn({ messages: userSays("rate?"), ctx: brokerCtx, client });
  assert.deepStrictEqual(r.usage, { inputTokens: 2200, outputTokens: 70 });
});

test("a response with no usage block does not break the totals", async () => {
  const client = fakeClient([{ ...say("Hi there!"), usage: undefined }]);
  const r = await runTurn({ messages: userSays("hello"), ctx: brokerCtx, client });
  assert.deepStrictEqual(r.usage, { inputTokens: 0, outputTokens: 0 });
});

// ── what the model is sent ───────────────────────────────────────────────────

test("request shape: env model with the documented fallback, system prompt, tools, token cap", async () => {
  const saved = process.env.CLAUDE_MODEL;
  try {
    delete process.env.CLAUDE_MODEL;
    let client = fakeClient([say("Hello!")]);
    await runTurn({ messages: userSays("hello"), ctx: brokerCtx, client });
    const p = client.calls[0];
    assert.equal(p.model, "claude-sonnet-4-5");
    assert.equal(p.system, CHARLI_SYSTEM);
    assert.deepStrictEqual(p.tools, TOOL_SCHEMA);
    assert.equal(p.max_tokens, 600);
    assert.equal(p.tool_choice, undefined, "no forced tool use: newer models reject it");
    assert.equal(p.temperature, undefined, "no sampling params: newer models reject them");

    process.env.CLAUDE_MODEL = "claude-test-model";
    client = fakeClient([say("Hello!")]);
    await runTurn({ messages: userSays("hello"), ctx: brokerCtx, client });
    assert.equal(client.calls[0].model, "claude-test-model");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_MODEL; else process.env.CLAUDE_MODEL = saved;
  }
});

test("the caller's messages array is not mutated", async () => {
  const messages = userSays("what's today's rate?");
  const snapshot = JSON.stringify(messages);
  const client = fakeClient([useTool("getMarketUpdate"), say("The thirty-year is at 6.52 percent.")]);
  await runTurn({ messages, ctx: brokerCtx, client });
  assert.equal(JSON.stringify(messages), snapshot);
});

test("the latest user message drives screening, including when it is a block array", async () => {
  const messages = [
    { role: "user", content: "good morning" },
    { role: "assistant", content: "Good morning, Bill!" },
    { role: "user", content: [{ type: "text", text: "What are the overlays on that?" }] },
  ];
  const client = fakeClient([say("Probably fine.")]);
  const r = await runTurn({ messages, ctx: brokerCtx, client });
  assert.equal(r.reply, GUIDELINE_HANDOFF);
});

test("parallel tool calls: all results come back in ONE user message, in order, and every source is cited", async () => {
  const client = fakeClient([
    resp([
      { type: "tool_use", id: "toolu_a", name: "getMarketUpdate", input: {} },
      { type: "tool_use", id: "toolu_b", name: "findClient", input: { query: "chen" } },
    ], "tool_use"),
    say("Rates are in and Robert and Linda Chen are in your book."),
  ]);
  const r = await runTurn({ messages: userSays("rates and find chen"), ctx: brokerCtx, client });
  const last = client.calls[1].messages[client.calls[1].messages.length - 1];
  assert.deepStrictEqual(last.content.map((b) => b.tool_use_id), ["toolu_a", "toolu_b"]);
  assert.deepStrictEqual(r.sources, ["live rates 2026-10-21", "client record"]);
});

test("a tool that throws becomes an is_error tool_result and the turn continues", async () => {
  const client = fakeClient([useTool("findClient", { query: "chen" }), say("Sorry, I hit a problem looking that up.")]);
  // ctx without a user makes scopedClients throw
  const r = await runTurn({ messages: userSays("find chen"), ctx: { rates: LIVE, db }, client });
  const block = client.calls[1].messages[2].content[0];
  assert.equal(block.is_error, true);
  assert.doesNotMatch(block.content, /requires/, "no internal error text leaks to the model");
  assert.equal(r.reply, "Sorry, I hit a problem looking that up.");
  assert.deepStrictEqual(r.sources, []);
});

// ── tool-result handling ─────────────────────────────────────────────────────

test("runSweepTool output is trimmed before it goes back to the model", async () => {
  const rows = db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(orgC);
  const full = refi.runSweep(rows, LIVE);
  assert.ok(full.opportunities.length > 10 && full.checkIns.length > 10, "fixture must exceed the trim limits");

  const client = fakeClient([useTool("runSweepTool"), say("You have a lot of opportunities and check-ins.")]);
  const r = await runTurn({ messages: userSays("who should I call?"), ctx: sweepCtx, client });
  const sent = toolResultPayload(client.calls[1]);
  assert.equal(sent.source, "sweep engine");

  const d = sent.data;
  assert.deepStrictEqual(d.counts, full.counts, "counts are the real, untrimmed totals");
  assert.deepStrictEqual(d.byLens, full.byLens);
  assert.equal(d.opportunities.length, 10);
  assert.equal(d.checkIns.length, 10);
  assert.equal(d.ranAt, undefined);
  // each opportunity: name + its best lens only, not the full per-client lens list
  for (const o of d.opportunities) {
    assert.deepStrictEqual(Object.keys(o).sort(), ["best", "name"]);
    assert.ok(o.best.lens && o.best.detail);
  }
  // check-ins: name + monthsSince only
  for (const c of d.checkIns) {
    assert.deepStrictEqual(Object.keys(c).sort(), ["monthsSince", "name"]);
    assert.equal(typeof c.monthsSince, "number");
  }
  // "top" 10: nothing left out outranks anything let in
  const rank = { high: 3, medium: 2, low: 1 };
  const kept = new Set(d.opportunities.map((o) => o.name));
  const minKept = Math.min(...d.opportunities.map((o) => rank[o.best.priority]));
  for (const o of full.opportunities.filter((x) => !kept.has(x.name))) {
    assert.ok(rank[o.best.priority] <= minKept, `${o.name} outranks a kept row`);
  }
  assert.deepStrictEqual(r.sources, ["sweep engine"]);
});

test("estimated rates: the estimated flag reaches the model, and the system prompt says to disclose it", async () => {
  const client = fakeClient([useTool("getMarketUpdate"), say("These are estimates: the thirty-year is 6.52 percent.")]);
  const r = await runTurn({ messages: userSays("what are rates?"), ctx: { ...brokerCtx, rates: EST }, client });
  const sent = toolResultPayload(client.calls[1]);
  assert.equal(sent.data.estimated, true);
  assert.equal(sent.source, "estimated rates 2026-10-21");
  assert.deepStrictEqual(r.sources, ["estimated rates 2026-10-21"]);

  const sweep = fakeClient([useTool("runSweepTool"), say("Those are estimates.")]);
  await runTurn({ messages: userSays("sweep"), ctx: { ...sweepCtx, rates: EST }, client: sweep });
  assert.equal(toolResultPayload(sweep.calls[1]).data.estimated, true, "trimming keeps the estimated flag");

  assert.match(CHARLI_SYSTEM, /estimated/i);
  assert.match(CHARLI_SYSTEM, /estimates/i);
});

// ── the system prompt ────────────────────────────────────────────────────────

test("CHARLI_SYSTEM encodes the persona, retrieve-and-cite, confirmation, PII and guideline rules", () => {
  assert.equal(typeof CHARLI_SYSTEM, "string");
  assert.match(CHARLI_SYSTEM, /Charli/);
  assert.match(CHARLI_SYSTEM, /good morning|morning/i);
  assert.match(CHARLI_SYSTEM, /tool result/i);
  assert.ok(CHARLI_SYSTEM.includes(CANT_VERIFY), "tells her the exact can't-verify line");
  assert.match(CHARLI_SYSTEM, /confirm/i);
  assert.match(CHARLI_SYSTEM, /Social Security|SSN/i);
  assert.match(CHARLI_SYSTEM, /account number/i);
  assert.ok(CHARLI_SYSTEM.includes(GUIDELINE_HANDOFF), "tells her the exact guideline hand-off line");
  assert.match(CHARLI_SYSTEM, /one to three|1.{0,3}3 (short )?sentences/i);
  assert.match(CHARLI_SYSTEM, /no markdown/i);
});

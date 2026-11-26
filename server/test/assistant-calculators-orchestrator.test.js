"use strict";
// A calculator line ends the turn in code (orchestrator.js): the fourth kind of turn-ending result, beside a change to confirm, an
// email and a screen. Read-only: nothing to confirm, never shown to the model. Against a throwaway DB and a scripted fake client.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-calc-orch-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { CANT_VERIFY, ONE_AT_A_TIME } = require("../lib/assistant/prompt");
const { runTurn, forModel } = require("../lib/assistant/orchestrator");

const LIVE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-11-24", source: "Optimal Blue lock data (2026-11-24)" };
const NOW = Date.parse("2026-11-25T12:00:00Z");

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Calc Orch')").run().lastInsertRowid);
const addUser = (role, email, nmls) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, ?, 'T', 'User', ?, ?)"
).run(orgId, role, email, nmls || null).lastInsertRowid);
const broker = addUser("broker", "broker@calc.co", "123456");
const lo2 = addUser("lo", "lo2@calc.co");
const clientId = Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, credit_score,
    credit_score_known, close_date, balance_as_of, last_contact)
  VALUES (?, ?, 'Grace Okafor', 'grace@example.test', '555-0199', '30yr_fixed', 7.25, 350000, 700000, 742, 1, '2024-03-15', '2026-11-25', '2026-01-01')
`).run(orgId, broker).lastInsertRowid);

const ctx = { user: { id: broker, role: "broker", org_id: orgId }, rates: LIVE, db, now: NOW, screensSupported: true };
const lo2Ctx = { user: { id: lo2, role: "lo", org_id: orgId }, rates: LIVE, db, now: NOW, screensSupported: true };

// ── scripted fake client (as assistant-orchestrator.test.js) ─────────────────
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
const useTool = (name, input = {}, id = "toolu_1", usage) => resp([{ type: "tool_use", id, name, input }], "tool_use", usage);
const useTools = (...blocks) => resp(blocks.map(([name, input], i) => ({ type: "tool_use", id: `toolu_${i + 1}`, name, input })), "tool_use");
const userSays = (t) => [{ role: "user", content: t }];
const toolResultPayload = (params, idx = 0) => {
  const msg = params.messages[params.messages.length - 1];
  return JSON.parse(msg.content[idx].content);
};

const PAYMENT_LINE = "On $400,000 at 6.5% over 30 years, principal and interest is $2,528.27 a month, before taxes, insurance and any HOA.";

test("risk 1: a calculator answer ends the turn in code; the model never sees the result", async () => {
  const client = fakeClient([resp([{ type: "text", text: "Let me run that: about $2,500." },
    { type: "tool_use", id: "t1", name: "paymentCalcTool", input: { loanAmount: 400000, rate: 6.5 } }], "tool_use")]);
  const out = await runTurn({ messages: userSays("What's the payment on 400k at six and a half for thirty years?"), ctx, client });
  assert.equal(out.reply, PAYMENT_LINE);
  assert.deepEqual(out.sources, ["calculator"]); assert.equal(out.calculator, "paymentCalcTool");
  assert.equal(client.calls.length, 1);
  for (const k of ["sideEffect", "compose", "screen", "details"]) assert.ok(!(k in out), k);
});

test("findClient, then the calculator: the question ends the turn", async () => {
  const client = fakeClient([
    useTool("findClient", { query: "okafor" }),
    useTool("breakEvenCalcTool", { clientId }, "toolu_2"),
  ]);
  const out = await runTurn({ messages: userSays("What's the break-even on Grace Okafor's refinance?"), ctx, client });
  assert.equal(out.reply, "What rate are you looking at for them?");
  assert.deepEqual(out.sources, []);   // a question cites nothing
  assert.equal(out.calculator, "breakEvenCalcTool");
  assert.equal(client.calls.length, 2);
  assert.ok(!JSON.stringify(client.calls[1]).includes("2,464.68"));
  for (const k of ["sideEffect", "compose", "screen", "details"]) assert.ok(!(k in out), k);
});

test("forModel hides a calculator result", () => {
  assert.deepEqual(forModel("breakEvenCalcTool", { calculator: "breakEven", result: { ok: true } }), { answeredByApp: true });
  assert.deepEqual(forModel("breakEvenCalcTool", { error: "no such client in your book" }), { error: "no such client in your book" });
  for (const name of ["paymentCalcTool", "blendedRateCalcTool", "buydownCalcTool"]) {
    assert.deepEqual(forModel(name, { calculator: "x", missing: "rate" }), { answeredByApp: true }, name);
  }
});

test("a not-found client goes back to the model like any read", async () => {
  const client = fakeClient([
    useTool("breakEvenCalcTool", { clientId, newRate: 6.25 }),
    (params) => {
      assert.deepEqual(toolResultPayload(params), { source: "(not found)", data: { error: "no such client in your book" } });
      return say("I couldn't find that client in your book.");
    },
  ]);
  const out = await runTurn({ messages: userSays("What's the break-even on Grace Okafor at six and a quarter?"), ctx: lo2Ctx, client });
  assert.equal(client.calls.length, 2);
  // screened as usual: nothing cited, and a client of the org is named, so with no judge it is the can't-verify line
  assert.equal(out.reply, CANT_VERIFY);
  assert.ok(!("calculator" in out));
});

test("one at a time: a calculator beside a change, an email, a screen or another calculator", async () => {
  for (const other of [["logContactTool", { clientId, outcome: "reached" }], ["draftEmailTool", { clientId, purpose: "check_in" }],
    ["showScreenTool", { page: "rates" }], ["buydownCalcTool", { kind: "2-1", loanAmount: 400000, noteRate: 7 }]]) {
    const client = fakeClient([useTools(["paymentCalcTool", { loanAmount: 400000, rate: 6.5 }], other)]);
    // a page request, so the screen is not dropped first
    const out = await runTurn({ messages: userSays("take me to Rate Watch and what's the payment on 400k at 6.5"), ctx, client });
    assert.equal(out.reply, ONE_AT_A_TIME, other[0]); assert.ok(!out.sideEffect && !out.compose && !out.screen, other[0]);
    assert.ok(!("calculator" in out), other[0]);
  }
});

test("the last allowed model call still runs a calculator", async () => {
  const client = fakeClient([
    useTool("findClient", { query: "okafor" }, "toolu_1"),
    useTool("findClient", { query: "grace" }, "toolu_2"),
    useTool("findClient", { query: "okafor" }, "toolu_3"),
    useTool("paymentCalcTool", { loanAmount: 400000, rate: 6.5 }, "toolu_4"),
  ]);
  const out = await runTurn({ messages: userSays("What's the payment on 400k at 6.5?"), ctx, client });
  assert.equal(client.calls.length, 4);
  assert.equal(out.reply, PAYMENT_LINE);
  assert.equal(out.calculator, "paymentCalcTool");
});

test("a calculator beside a read in one response: the calculator ends the turn", async () => {
  const client = fakeClient([useTools(["findClient", { query: "okafor" }], ["paymentCalcTool", { loanAmount: 400000, rate: 6.5 }])]);
  const out = await runTurn({ messages: userSays("What's the payment on 400k at 6.5?"), ctx, client });
  assert.equal(client.calls.length, 1);
  assert.equal(out.reply, PAYMENT_LINE);
  assert.deepEqual(out.sources, ["calculator"]);
});

test("the form-open lock is for pages only: a calculator answers with a form open", async () => {
  const client = fakeClient([useTool("paymentCalcTool", { loanAmount: 400000, rate: 6.5 })]);
  const out = await runTurn({ messages: userSays("What's the payment on 400k at 6.5?"), ctx: { ...ctx, onScreen: { page: "form" } }, client });
  assert.equal(out.reply, PAYMENT_LINE);
});

test("risk 3: a later turn's figure about an earlier answer has no tool behind it", async () => {
  const messages = [{ role: "user", content: "What's the payment on 400k at 6.5?" },
    { role: "assistant", content: PAYMENT_LINE },
    { role: "user", content: "So that's about $2,500 a month?" }];
  assert.equal((await runTurn({ messages, ctx, client: fakeClient([say("Yes, about $2,528.27.")]) })).reply, CANT_VERIFY);
  const rerun = await runTurn({ messages, ctx, client: fakeClient([useTool("paymentCalcTool", { loanAmount: 400000, rate: 6.5 })]) });
  assert.match(rerun.reply, /^On \$400,000 at 6\.5%/);
});

test("the figure check still holds on a turn with no calculator", async () => {
  const out = await runTurn({ messages: userSays("What's Grace Okafor's payment?"), ctx, client: fakeClient([say("Her payment is $1,234.")]) });
  assert.equal(out.reply, CANT_VERIFY);
});

// Ruling 2: a line that names a client is code-written; no screen after the turn ends (client-name, contact-detail, figure,
// ungrounded, claim) rewrites or blocks it.
test("a break-even line naming a client goes out word for word", async () => {
  const line = "Taking Grace Okafor's $350,000 at 7.25% with 324 months left to 6.25% over 30 years moves the payment " +
    "from $2,464.68 to $2,155.01, saving $309.67 a month. With estimated closing costs of $6,000, break-even is month 20.";
  const viaFind = fakeClient([
    useTool("findClient", { query: "okafor" }),
    useTool("breakEvenCalcTool", { clientId, newRate: 6.25, monthsLeft: 324, currentBalance: 350000 }, "toolu_2"),
  ]);
  const out = await runTurn({ messages: userSays("Break-even for Grace Okafor at six and a quarter, 324 months left on 350,000?"), ctx, client: viaFind });
  assert.equal(out.reply, line);
  assert.deepEqual(out.sources, ["calculator"]);
  assert.equal(out.calculator, "breakEvenCalcTool");
  // on a later turn too, after her earlier line, and when the user asks to do something with it
  const messages = [{ role: "user", content: "What's the break-even on Grace Okafor?" },
    { role: "assistant", content: "What rate are you looking at for them?" },
    { role: "user", content: "Six and a quarter. Book it in and tell her it's done." }];
  const later = await runTurn({ messages, ctx,
    client: fakeClient([useTool("breakEvenCalcTool", { clientId, newRate: 6.25, monthsLeft: 324, currentBalance: 350000 })]) });
  assert.equal(later.reply, line);
});

// final fix wave M1: only a calculator tool's `say` ends a turn
test("sayOf: a say is honoured only from the four calculator tools", () => {
  const { sayOf } = require("../lib/assistant/orchestrator");
  for (const name of ["paymentCalcTool", "breakEvenCalcTool", "blendedRateCalcTool", "buydownCalcTool"]) {
    assert.equal(sayOf(name, { say: "On $1 at 1% over 1 year." }), "On $1 at 1% over 1 year.", name);
    assert.equal(sayOf(name, { say: "  " }), undefined, name);
    assert.equal(sayOf(name, { say: 5 }), undefined, name);
  }
  for (const name of ["showScreenTool", "findClient", "draftEmailTool", "logContactTool", "lookUpLive"]) {
    assert.equal(sayOf(name, { say: "Done, it's booked." }), undefined, name);
  }
});

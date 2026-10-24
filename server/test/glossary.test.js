"use strict";
// R7-a: explainTerm, a deterministic tool backed by a fixed, code-authored glossary (lib/assistant/glossary.js).
// A new LO who asks "what does LTV mean?" gets a definition from the tool, not from the model's memory; a term the
// glossary doesn't know is "(not found)" and resolves to the can't-verify line. Definitions only: loan-guideline
// limits stay in the guideline hand-off domain.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-glossary-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { tools, TOOL_SCHEMA, explainTerm } = require("../lib/assistant/tools");
const { CHARLI_SYSTEM, CANT_VERIFY, GUIDELINE_HANDOFF, NOTHING_CHANGED, buildCharliSystem } = require("../lib/assistant/prompt");
const { GLOSSARY, GLOSSARY_SOURCE, lookupTerm, mentionsGlossaryTerm } = require("../lib/assistant/glossary");
const { runTurn, screenUngroundedText } = require("../lib/assistant/orchestrator");

after(() => { try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const LIVE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const ctxFor = (stage = null) => ({ user: { id: 1, role: "broker", org_id: 1, career_stage: stage }, rates: LIVE, db });

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
const resp = (content, stop_reason) => ({
  id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 },
});
const say = (t) => resp([{ type: "text", text: t }], "end_turn");
const useTool = (name, input = {}, id = "toolu_1") => resp([{ type: "tool_use", id, name, input }], "tool_use");
const payloadOf = (params) => JSON.parse(params.messages[params.messages.length - 1].content[0].content);
const userSays = (t) => [{ role: "user", content: t }];

const TERMS = [
  "LTV", "break-even", "rate-and-term refinance", "cash-out refinance", "ARM", "term swap", "LLPA", "points", "DTI", "check-in", "opportunity",
];

// ── the glossary ─────────────────────────────────────────────────────────────

test("GLOSSARY: the eleven ruled terms, each with a definition in one or two plain spoken sentences", () => {
  assert.deepStrictEqual(GLOSSARY.map((e) => e.term), TERMS);
  assert.ok(Object.isFrozen(GLOSSARY));
  assert.equal(GLOSSARY_SOURCE, "Broker Radar glossary");
  for (const e of GLOSSARY) {
    assert.equal(typeof e.definition, "string", e.term);
    const sentences = e.definition.split(/(?<=[.!?])\s+/);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${e.term}: ${sentences.length} sentences`);
    assert.ok(e.definition.length <= 360, `${e.term} is short enough to say aloud`);
    assert.doesNotMatch(e.definition, /[*#_`•\n]|\d\s*%/, `${e.term}: plain spoken English (no markdown, no % sign)`);
    assert.ok(Array.isArray(e.aliases) && e.aliases.length > 0, e.term);
    assert.ok(Object.isFrozen(e), e.term);
  }
});

test("GLOSSARY: few numbers, and a number is a Broker Radar product fact", () => {
  const def = (term) => GLOSSARY.find((e) => e.term === term).definition;
  // no numbers at all
  for (const term of ["LTV", "rate-and-term refinance", "ARM", "LLPA", "DTI", "opportunity"]) {
    assert.doesNotMatch(def(term), /\d/, term);
  }
  // the engine's own numbers, said as product facts
  assert.match(def("cash-out refinance"), /Broker Radar estimates cash-out up to 80 percent of the home's value/);
  assert.match(def("check-in"), /6 months/);
  assert.match(def("break-even"), /Broker Radar/);
  assert.match(def("break-even"), /36 months or less/);
  assert.match(def("points"), /1 percent of the loan amount/);
  assert.match(def("term swap"), /30-year/);
});

test("GLOSSARY: DTI is the definition only; its limits stay in the guideline hand-off domain", () => {
  const dti = GLOSSARY.find((e) => e.term === "DTI").definition;
  assert.match(dti, /monthly debt payments divided by their gross monthly income/);
  assert.doesNotMatch(dti, /\d|limit|maximum|\bmax\b|\bFHA\b|\bVA\b|conventional|allow|guideline|underwrit|cap\b/i);
});

test("GLOSSARY: no definition reads as a completion claim, so Charli can say each one verbatim", async () => {
  for (const e of GLOSSARY) {
    const r = await runTurn({
      messages: userSays(`what does ${e.term} mean?`), ctx: ctxFor("new"),
      client: fakeClient([useTool("explainTerm", { term: e.term }), (params) => say(payloadOf(params).data.definition)]),
    });
    assert.equal(r.reply, e.definition, e.term);
    assert.deepStrictEqual(r.sources, ["Broker Radar glossary"], e.term);
  }
});

// ── lookup ───────────────────────────────────────────────────────────────────

const ALIASES = {
  "LTV": ["LTV", "ltv", "Loan-to-Value", "loan to value", "the LTV", "an LTV", "LTV?", "  ltv  ", "Loan-To-Value."],
  "break-even": ["break-even", "Break Even", "breakeven", "break-even point", "the break even point"],
  "rate-and-term refinance": [
    "rate-and-term refinance", "rate and term", "Rate/Term", "rate/term refinance", "rate and term refi", "a rate-and-term refi", "rate-and-term",
  ],
  "cash-out refinance": ["cash-out refinance", "cash out", "Cash-Out", "cash out refi", "a cash-out refi", "cash-out refinance?"],
  "ARM": ["ARM", "arm", "an ARM", "adjustable-rate mortgage", "Adjustable Rate Mortgage", "adjustable rate", "ARMs"],
  "term swap": ["term swap", "Term Swap", "15-year vs 30-year", "15 year vs 30 year", "switching terms", "changing terms", "a term swap"],
  "LLPA": ["LLPA", "llpa", "LLPAs", "loan-level price adjustment", "Loan Level Price Adjustment", "an LLPA"],
  "points": ["points", "point", "discount points", "Discount Point", "mortgage points"],
  "DTI": ["DTI", "dti", "debt-to-income", "debt to income", "Debt-to-Income ratio", "the DTI"],
  "check-in": ["check-in", "Check In", "checkin", "check-ins", "6-month check-in"],
  "opportunity": ["opportunity", "Opportunities", "an opportunity", "the opportunity"],
};

test("lookupTerm: every alias resolves, case-insensitively, through articles, hyphens, slashes and a trailing question mark", () => {
  assert.deepStrictEqual(Object.keys(ALIASES), TERMS);
  for (const [term, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) assert.equal(lookupTerm(alias) && lookupTerm(alias).term, term, alias);
  }
});

test("lookupTerm: an unknown or ambiguous term is not found (never a guess), and non-text is not found", () => {
  for (const q of [
    "buydown", "APR", "escrow", "PMI", "cash", "rate", "term", "loan", "what does LTV mean", "LTV and DTI", "cash-out vs rate and term",
    "", "   ", "?", null, undefined, 5, true, {}, [], ["LTV"], "ltvv", "x".repeat(500),
  ]) {
    assert.equal(lookupTerm(q), null, String(q).slice(0, 30));
  }
});

test("mentionsGlossaryTerm: a user naming a glossary term (not the common words 'point', 'points' or 'arm')", () => {
  for (const t of [
    "what does DTI mean?", "what's a break-even?", "explain LLPAs", "tell me about debt-to-income", "what is loan to value",
    "rate and term vs cash out", "what is a term swap", "what's an adjustable rate mortgage", "discount points?", "the 5/1 ARM",
  ]) {
    assert.equal(mentionsGlossaryTerm(t), true, t);
  }
  for (const t of ["good morning", "that's a good point", "any talking points for Chen?", "my arm hurts", "about 20 years", "thanks", "", null, undefined]) {
    assert.equal(mentionsGlossaryTerm(t), false, String(t));
  }
});

// ── the tool ─────────────────────────────────────────────────────────────────

test("explainTerm: a known term is { data: { term, definition }, source: 'Broker Radar glossary' } and writes nothing", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  for (const e of GLOSSARY) {
    assert.deepStrictEqual(explainTerm({ term: e.term }, ctxFor()), {
      data: { term: e.term, definition: e.definition }, source: "Broker Radar glossary",
    }, e.term);
  }
  // an alias returns the canonical term
  assert.deepStrictEqual(explainTerm({ term: "loan-to-value" }, ctxFor()).data.term, "LTV");
  assert.deepStrictEqual(explainTerm({ term: "cash out" }, ctxFor()).data.term, "cash-out refinance");
  assert.equal("sideEffect" in explainTerm({ term: "LTV" }, ctxFor()), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, before);
});

test("explainTerm: an unknown term is { data: { error }, source: '(not found)' }; a missing term is invalid input", () => {
  const nf = explainTerm({ term: "buydown" }, ctxFor());
  assert.deepStrictEqual(Object.keys(nf.data), ["error"]);
  assert.equal(typeof nf.data.error, "string");
  assert.equal(nf.source, "(not found)");
  for (const args of [undefined, null, {}, { term: "" }, { term: "   " }, { term: 5 }, { term: null }, { term: ["LTV"] }, "LTV", { query: "LTV" }]) {
    const r = explainTerm(args, ctxFor());
    assert.equal(r.source, "(invalid input)", JSON.stringify(args));
    assert.ok(r.data.error);
    assert.equal("sideEffect" in r, false);
  }
});

test("explainTerm is in the tools map and TOOL_SCHEMA; CHARLI_SYSTEM tells her to use it and never define from memory", () => {
  assert.equal(tools.explainTerm, explainTerm);
  const entry = TOOL_SCHEMA.find((t) => t.name === "explainTerm");
  assert.ok(entry);
  assert.deepStrictEqual(entry.input_schema.required, ["term"]);
  assert.equal(entry.input_schema.properties.term.type, "string");
  assert.match(entry.description, /definition/);
  assert.match(entry.description, /never define/i);
  for (const e of GLOSSARY) assert.ok(entry.description.toLowerCase().includes(e.term.toLowerCase()), `the schema names ${e.term}`);
  assert.ok(CHARLI_SYSTEM.includes(
    "To explain what a term means, call explainTerm and use its definition; never define a term from memory. " +
    "If explainTerm doesn't know the term, say you can't verify it."
  ));
  // every stage's prompt carries it, verbatim
  for (const stage of ["new", "developing", "established", "veteran", null]) {
    assert.ok(buildCharliSystem({ career_stage: stage }).includes("call explainTerm and use its definition"), String(stage));
  }
});

// ── runTurn ──────────────────────────────────────────────────────────────────

test("what does LTV mean? / what's a cash-out refi?: the narration is the tool's definition, grounded and cited", async () => {
  let r = await runTurn({
    messages: userSays("what does LTV mean?"), ctx: ctxFor("new"),
    client: fakeClient([useTool("explainTerm", { term: "LTV" }), (p) => say(payloadOf(p).data.definition)]),
  });
  assert.equal(r.reply, GLOSSARY[0].definition);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);

  // the 80 percent is grounded by the payload; an 85 is not
  const client = fakeClient([useTool("explainTerm", { term: "cash out refi" }), (p) => say(payloadOf(p).data.definition)]);
  r = await runTurn({ messages: userSays("what's a cash-out refi?"), ctx: ctxFor("new"), client });
  assert.match(r.reply, /80 percent of the home's value/);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  assert.equal(JSON.parse(client.calls[1].messages[2].content[0].content).data.term, "cash-out refinance");
  r = await runTurn({
    messages: userSays("what's a cash-out refi?"), ctx: ctxFor("new"),
    client: fakeClient([useTool("explainTerm", { term: "cash out refi" }), say("It lets a borrower take cash from equity, up to 85 percent of the home's value.")]),
  });
  assert.equal(r.reply, CANT_VERIFY, "a figure the glossary didn't return is not grounded");
});

test("what's the max DTI for FHA? is still the guideline hand-off, even after explainTerm; what does DTI mean? is the definition", async () => {
  const dti = GLOSSARY.find((e) => e.term === "DTI").definition;
  let r = await runTurn({
    messages: userSays("what's the max DTI for FHA?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), say(dti)]),
  });
  assert.equal(r.reply, GUIDELINE_HANDOFF);
  r = await runTurn({
    messages: userSays("what does DTI mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), (p) => say(payloadOf(p).data.definition)]),
  });
  assert.equal(r.reply, dti);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  // the model cannot add the limits itself: a figure the glossary did not return is not grounded
  r = await runTurn({
    messages: userSays("what does DTI mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), say(dti + " FHA allows up to 56.9 percent.")]),
  });
  assert.equal(r.reply, CANT_VERIFY);
});

test("what's a buydown?: explainTerm says '(not found)' and nothing the model adds can define it", async () => {
  const unknown = async (reply, userText = "what's a buydown?") => runTurn({
    messages: userSays(userText), ctx: ctxFor(), client: fakeClient([useTool("explainTerm", { term: "buydown" }), say(reply)]),
  });
  // with a book noun in it, with none, and as the can't-verify line itself
  for (const reply of [
    "A buydown lowers the rate for a while.", "A buydown is a way to pay less up front.", CANT_VERIFY,
    "It's a seller-paid trick to trim the early payments.", "I don't know that one.",
  ]) {
    const r = await unknown(reply);
    assert.equal(r.reply, CANT_VERIFY, reply);
    assert.deepStrictEqual(r.sources, [], "(not found) is not a citation");
  }
  // a clarifying question is no definition, so it still reaches the user
  const asked = await unknown("Do you mean a temporary buydown?");
  assert.equal(asked.reply, "Do you mean a temporary buydown?");
  assert.deepStrictEqual(asked.sources, []);
});

test("an explainTerm call that fails (no term) is no better: the model's own definition is not passed", async () => {
  for (const input of [{}, { term: "" }, { term: 5 }]) {
    const r = await runTurn({
      messages: userSays("what's a buydown?"), ctx: ctxFor(),
      client: fakeClient([useTool("explainTerm", input), say("A buydown is a way to pay less up front.")]),
    });
    assert.equal(r.reply, CANT_VERIFY, JSON.stringify(input));
  }
});

test("a failed glossary lookup does not affect a turn that another tool grounded", async () => {
  const r = await runTurn({
    messages: userSays("what's the rate, and what's a buydown?"), ctx: ctxFor(),
    client: fakeClient([
      resp([
        { type: "tool_use", id: "toolu_a", name: "getMarketUpdate", input: {} },
        { type: "tool_use", id: "toolu_b", name: "explainTerm", input: { term: "buydown" } },
      ], "tool_use"),
      say("The thirty-year fixed is at 6.52 percent, and I can't verify what a buydown is."),
    ]),
  });
  assert.equal(r.reply, "The thirty-year fixed is at 6.52 percent, and I can't verify what a buydown is.");
  assert.deepStrictEqual(r.sources, ["live rates 2026-10-21"]);
});

test("the model defining a term WITHOUT calling the tool is the can't-verify line, book noun or not", async () => {
  const bare = (userText, reply) => runTurn({ messages: userSays(userText), ctx: ctxFor(), client: fakeClient([say(reply)]) });
  for (const [userText, reply] of [
    // a book noun in the question or the answer
    ["what does LTV mean?", "LTV is the loan balance divided by the home's value."],
    ["what does LTV mean?", "It's how much of the home you've borrowed against."],
    ["what's a cash-out refi?", "You borrow more and take the difference as cash."],
    // no book noun anywhere: the glossary term in the question is enough
    ["what does DTI mean?", "DTI is monthly debt divided by gross income."],
    ["what's a break-even?", "It's how many months until the up-front costs are earned back."],
    ["what's an LLPA?", "It's an add-on to the price for riskier borrowers."],
    ["what does loan-to-value mean?", "It's what you owe compared with what the home is worth."],
    ["what's a term swap?", "It's switching to a shorter or longer schedule."],
    ["explain discount points", "They're fees paid up front to buy a lower interest charge."],
    ["what is an adjustable rate mortgage?", "The interest charge moves after an initial period."],
  ]) {
    const r = await bare(userText, reply);
    assert.equal(r.reply, CANT_VERIFY, `${userText} / ${reply}`);
  }
  // the screen alone: a glossary term in the question is a book noun when no tool result backs the reply ...
  assert.equal(screenUngroundedText("what does DTI mean?", "DTI is monthly debt divided by gross income."), CANT_VERIFY);
  // ... and ordinary conversation is untouched
  assert.equal(screenUngroundedText("good morning", "Good morning! How can I help?"), "Good morning! How can I help?");
  assert.equal(screenUngroundedText("that's a good point", "Glad it helps!"), "Glad it helps!");
  assert.equal(screenUngroundedText("what does DTI mean?", "Which DTI do you mean?"), "Which DTI do you mean?", "a lone clarifying question still passes");
});

test("a glossary term in the question changes nothing for a grounded turn", async () => {
  const r = await runTurn({
    messages: userSays("what does DTI mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), say("Robert and Linda Chen are your top opportunity.")]),
  });
  // grounded by the glossary citation: only claims and figures are screened, as before
  assert.equal(r.reply, "Robert and Linda Chen are your top opportunity.");
});

test("the New and Veteran runs of an explainTerm turn are identical but for the system prompt", async () => {
  const script = () => [useTool("explainTerm", { term: "LTV" }), (p) => say(payloadOf(p).data.definition)];
  const runAs = async (stage) => {
    const client = fakeClient(script());
    const r = await runTurn({ messages: userSays("what does LTV mean?"), ctx: ctxFor(stage), client });
    return { r, calls: client.calls.map(({ system, ...rest }) => rest) };
  };
  const a = await runAs("new");
  const b = await runAs("veteran");
  assert.deepStrictEqual(a, b);
  assert.equal(a.r.reply, GLOSSARY[0].definition);
});

test("explainTerm: NOTHING_CHANGED still guards a false 'done' after a glossary lookup", async () => {
  const r = await runTurn({
    messages: userSays("log a call with Chen"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "LTV" }), say("Done, I logged it.")]),
  });
  assert.equal(r.reply, NOTHING_CHANGED);
});

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
// a broker with one client, for the turns that mix a client lookup with a glossary lookup
const org = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Gloss')").run().lastInsertRowid);
const brokerId = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'Gil', 'Loss', 'gil@gloss.test')").run(org).lastInsertRowid);
db.prepare(
  "INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact) VALUES (?, ?, 'Robert & Linda Chen', '30yr_fixed', 7.85, 485000, 650000, 760, '2026-01-01')"
).run(org, brokerId);
const ctxFor = (stage = null) => ({ user: { id: brokerId, role: "broker", org_id: org, career_stage: stage }, rates: LIVE, db });

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
  // I4: the engine computes 80% x value - balance (a new loan of up to 80% LTV); it is not 80% of the value in cash
  assert.match(def("cash-out refinance"), /Broker Radar estimates the cash available up to a new loan of 80 percent of the home's value/);
  assert.doesNotMatch(def("cash-out refinance"), /cash-out up to 80 percent/);
  assert.match(def("check-in"), /6 months/);
  assert.match(def("break-even"), /months of savings it takes to earn back the closing costs/);
  assert.doesNotMatch(def("break-even"), /new, lower payment/);
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

test("GLOSSARY: each definition comes back verbatim (code-authored), and none reads as a completion claim", async () => {
  const { claimsCompletion } = require("../lib/assistant/orchestrator");
  for (const e of GLOSSARY) {
    assert.equal(claimsCompletion(e.definition, false), false, e.term + ": a definition is no claim, grounded or not");
    assert.equal(claimsCompletion(e.definition, true), false, e.term);
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
  "LTV": ["LTV", "ltv", "Loan-to-Value", "loan to value", "the LTV", "an LTV", "LTV?", "  ltv  ", "Loan-To-Value.", "LTV ratio", "the LTV ratio"],
  "break-even": ["break-even", "Break Even", "breakeven", "break-even point", "the break even point", "breakeven point", "Breakeven Point?"],
  "rate-and-term refinance": [
    "rate-and-term refinance", "rate and term", "Rate/Term", "rate/term refinance", "rate and term refi", "a rate-and-term refi", "rate-and-term",
    "rate-and-term refinancing",
  ],
  "cash-out refinance": [
    "cash-out refinance", "cash out", "Cash-Out", "cash out refi", "a cash-out refi", "cash-out refinance?", "cash-out refinancing", "Cash Out Refinancing",
  ],
  "ARM": [
    "ARM", "arm", "an ARM", "adjustable-rate mortgage", "Adjustable Rate Mortgage", "adjustable rate", "ARMs", "ARM loan", "an ARM loan", "ARM loans",
    "adjustable-rate loan", "adjustable rate loan", "5/1 ARM",
  ],
  "term swap": ["term swap", "Term Swap", "15-year vs 30-year", "15 year vs 30 year", "switching terms", "changing terms", "a term swap"],
  "LLPA": ["LLPA", "llpa", "LLPAs", "loan-level price adjustment", "Loan Level Price Adjustment", "an LLPA"],
  "points": ["points", "point", "discount points", "Discount Point", "mortgage points"],
  "DTI": ["DTI", "dti", "debt-to-income", "debt to income", "Debt-to-Income ratio", "the DTI", "DTI ratio", "the DTI ratio?"],
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
    "LTV ratios", "my LTV ratio", "ARM loan rates", "DTI ratio limits", "cash-out refinancing options", "adjustable-rate loans for veterans", "ratio", "loan",
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
  // I3: with the glossary as the only citation the reply is the definition, whatever the model wrote (an 85, or a claim)
  for (const wrong of ["It lets a borrower take cash from equity, up to 85 percent of the home's value.", "Call them today.", ""]) {
    r = await runTurn({
      messages: userSays("what's a cash-out refi?"), ctx: ctxFor("new"),
      client: fakeClient([useTool("explainTerm", { term: "cash out refi" }), say(wrong)]),
    });
    assert.equal(r.reply, GLOSSARY.find((e) => e.term === "cash-out refinance").definition, wrong);
    assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  }
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
  // the model cannot add the limits itself: its text is discarded, so the limit never reaches the user
  r = await runTurn({
    messages: userSays("what does DTI mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), say(dti + " FHA allows up to 56.9 percent.")]),
  });
  assert.equal(r.reply, dti);
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

test("I3: a glossary citation does not carry a book claim: when it is the only citation the reply is the definition", async () => {
  // (was: "Robert and Linda Chen are your top opportunity." passed, cited to the glossary)
  const dti = GLOSSARY.find((e) => e.term === "DTI").definition;
  let r = await runTurn({
    messages: userSays("what does DTI mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "DTI" }), say("Robert and Linda Chen are your top opportunity.")]),
  });
  assert.equal(r.reply, dti);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  // break-even and the Chens: the model's 'well inside the limit, call them today' is not said
  const be = GLOSSARY.find((e) => e.term === "break-even").definition;
  r = await runTurn({
    messages: userSays("what does break-even mean for the Chens?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "break-even" }), say("The Chens are well inside the limit, so call them today.")]),
  });
  assert.equal(r.reply, be);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  // the glossary's digits ground nothing else: the 36 does not make 36 thousand dollars a fact
  r = await runTurn({
    messages: userSays("what does break-even mean?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "break-even" }), say("Break-even is 36 months, and the Chens owe 36 thousand dollars.")]),
  });
  assert.equal(r.reply, be);
});

test("I3: several terms are the definitions joined with a space, once each, in the order asked; a miss adds the can't-verify line", async () => {
  const def = (term) => GLOSSARY.find((e) => e.term === term).definition;
  const calls = (...terms) => resp(terms.map((term, i) => ({ type: "tool_use", id: "toolu_" + i, name: "explainTerm", input: { term } })), "tool_use");
  const ask = (userText, first, narration = "whatever") => runTurn({ messages: userSays(userText), ctx: ctxFor(), client: fakeClient([first, say(narration)]) });

  let r = await ask("what do LTV and DTI mean?", calls("LTV", "DTI"));
  assert.equal(r.reply, def("LTV") + " " + def("DTI"));
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  r = await ask("what do DTI and LTV mean?", calls("DTI", "loan-to-value", "LTV"));
  assert.equal(r.reply, def("DTI") + " " + def("LTV"), "an alias of a term already given is not said twice");
  r = await ask("what do LTV and a buydown mean?", calls("LTV", "buydown"));
  assert.equal(r.reply, def("LTV") + " " + CANT_VERIFY, "what the glossary doesn't know is not dropped silently");
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
  r = await ask("what do a buydown and LTV mean?", calls("buydown", "LTV"));
  assert.equal(r.reply, def("LTV") + " " + CANT_VERIFY);
  // a miss alone is still the can't-verify line, and no source
  r = await ask("what's a buydown?", calls("buydown"), "A buydown is a way to pay less up front.");
  assert.equal(r.reply, CANT_VERIFY);
  assert.deepStrictEqual(r.sources, []);
});

test("I3: a turn that also cites a book source keeps the model's text and the figure check", async () => {
  const both = () => resp([
    { type: "tool_use", id: "toolu_a", name: "getMarketUpdate", input: {} },
    { type: "tool_use", id: "toolu_b", name: "explainTerm", input: { term: "LTV" } },
  ], "tool_use");
  let r = await runTurn({
    messages: userSays("what's the rate, and what does LTV mean?"), ctx: ctxFor(),
    client: fakeClient([both(), say("The thirty-year fixed is at 6.52 percent, and LTV is the loan balance over the home's value.")]),
  });
  assert.equal(r.reply, "The thirty-year fixed is at 6.52 percent, and LTV is the loan balance over the home's value.");
  assert.deepStrictEqual(r.sources, ["live rates 2026-10-21", "Broker Radar glossary"]);
  r = await runTurn({
    messages: userSays("what's the rate, and what does LTV mean?"), ctx: ctxFor(),
    client: fakeClient([both(), say("The thirty-year fixed is at 6.99 percent, and LTV is the loan balance over the home's value.")]),
  });
  assert.equal(r.reply, CANT_VERIFY, "the figure check still applies when a book source is cited");
  // a glossary lookup in one model call and a book lookup in the next: still not glossary-only
  r = await runTurn({
    messages: userSays("what does LTV mean, and what's the rate?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "LTV" }), useTool("getMarketUpdate", {}, "toolu_2"), say("LTV is the loan balance over the home's value, and the thirty-year fixed is at 6.52 percent.")]),
  });
  assert.equal(r.reply, "LTV is the loan balance over the home's value, and the thirty-year fixed is at 6.52 percent.");
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

// ── Fix round 2 (#3): the glossary's digits ground nothing the model says ───

const parallel = (...calls) => resp(calls.map(([name, input], i) => ({ type: "tool_use", id: "toolu_" + i, name, input })), "tool_use");
const mixed = (userText, calls, reply, ctx = ctxFor()) => runTurn({ messages: userSays(userText), ctx, client: fakeClient([parallel(...calls), say(reply)]) });

test("#3: on a mixed turn the model's figure is checked against the book source only: a glossary number grounds nothing", async () => {
  // a cash-out definition carries an 80, break-even a 36: neither makes Chen's LTV, or a rate, an 80 or a 36
  let r = await mixed("what's Chen's LTV, and what's a cash-out refi?", [["findClient", { query: "chen" }], ["explainTerm", { term: "cash-out" }]],
    "Robert and Linda Chen's LTV is 80 percent.");
  assert.equal(r.reply, CANT_VERIFY);
  r = await mixed("what's Chen's break-even, and what does it mean?", [["findClient", { query: "chen" }], ["explainTerm", { term: "break-even" }]],
    "Robert and Linda Chen's break-even is 36 months.");
  assert.equal(r.reply, CANT_VERIFY);
  r = await mixed("what's the 15-year, and what's a cash-out refi?", [["getMarketUpdate", {}], ["explainTerm", { term: "cash-out" }]],
    "The thirty-year fixed is at 6.52 percent and the 15-year is at 80 percent.");
  assert.equal(r.reply, CANT_VERIFY);
  // the same figures are fine when the book source has them: the real balance and value from the client record
  r = await mixed("what does LTV mean for the Chens?", [["findClient", { query: "chen" }], ["explainTerm", { term: "LTV" }]],
    "LTV compares the balance, $485,000, to the value, $650,000, for Robert and Linda Chen.");
  assert.equal(r.reply, "LTV compares the balance, $485,000, to the value, $650,000, for Robert and Linda Chen.");
  assert.deepStrictEqual(r.sources, ["client record", "Broker Radar glossary"]);
  r = await mixed("what's the rate, and what does LTV mean?", [["getMarketUpdate", {}], ["explainTerm", { term: "LTV" }]],
    "The thirty-year fixed is at 6.52 percent, and LTV is the loan balance over the home's value.");
  assert.equal(r.reply, "The thirty-year fixed is at 6.52 percent, and LTV is the loan balance over the home's value.");
  // ACCEPTED COST (fails closed): on a mixed turn the model cannot quote a definition's own product number
  r = await mixed("what's Chen's balance, and what's a cash-out refi?", [["findClient", { query: "chen" }], ["explainTerm", { term: "cash-out" }]],
    "Chen owes $485,000, and Broker Radar estimates cash available up to a new loan of 80 percent of the home's value.");
  assert.equal(r.reply, CANT_VERIFY);
  // ... while the glossary-only turn is untouched: the definition, code-authored, with its own number
  r = await mixed("what's a cash-out refi?", [["explainTerm", { term: "cash-out" }]], "whatever");
  assert.match(r.reply, /80 percent of the home's value/);
  assert.deepStrictEqual(r.sources, ["Broker Radar glossary"]);
});

test("#3: the glossary lookup in an earlier model call grounds nothing in a later one either", async () => {
  const r = await runTurn({
    messages: userSays("what's a cash-out refi, and what's Chen's LTV?"), ctx: ctxFor(),
    client: fakeClient([useTool("explainTerm", { term: "cash-out" }), useTool("findClient", { query: "chen" }, "toolu_2"), say("Robert and Linda Chen's LTV is 80 percent.")]),
  });
  assert.equal(r.reply, CANT_VERIFY);
});

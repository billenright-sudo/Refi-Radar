"use strict";
// Task 7: experience-aware coaching. Charli tailors HOW she coaches to the user's career stage (new /
// developing / established / veteran, or not set yet) and never the numbers, the tools, the no-guess law or
// the confirm-before-writing rule. Covers coaching.js, buildCharliSystem, setCareerStageTool, the code-authored
// read-back, the "set" completion claim, /api/assistant/confirm (setCareerStage), the broker's
// PATCH /api/org/los/:id/stage, /api/auth/me, the greeting's one question, and the users.career_stage migration.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-coaching-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const crypto = require("crypto");
const test = require("node:test");
const { before, after, afterEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const assistantTools = require("../lib/assistant/tools");
const { tools, TOOL_SCHEMA, setCareerStageTool } = assistantTools;
const { CHARLI_SYSTEM, NOTHING_CHANGED, CANT_VERIFY, buildCharliSystem } = require("../lib/assistant/prompt");
const { CAREER_STAGES, coachingStyle, stageById, stageForYears } = require("../lib/assistant/coaching");
const { runTurn, claimsCompletion, claimsStage, stageClaims } = require("../lib/assistant/orchestrator");
const { SESSION_STARTED } = require("../lib/assistant/history");
const authRoutes = require("../routes/auth");
const orgRoutes = require("../routes/org");
const assistantRoutes = require("../routes/assistant");

const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const LIVE = { ...RATES, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WANT_MORE = "Want a market update, a sweep of your book, or something else?";
const CAREER_QUESTION = "Quick question before we dive in — how long have you been originating?";
const IDS = ["new", "developing", "established", "veteran"];
const LABEL = {
  new: "New (under 1 year)", developing: "Developing (1–3 years)",
  established: "Established (3–10 years)", veteran: "Veteran (10+ years)",
};
const ASK_ONCE = "The greeting already asked how long they've been originating; when they answer with a number of years, call setCareerStageTool with `years`.";
const NULL_BLOCK =
  "The user's career stage isn't set. The greeting already asked how long they've been originating; " +
  "when they answer with a number of years, call setCareerStageTool with `years`. Never assume or infer a stage.";

// ── seed data ────────────────────────────────────────────────────────────────

let seq = 0;
const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, first = "T", stage = null) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage) VALUES (?, ?, ?, 'User', ?, ?)"
).run(orgId, role, first, `u${++seq}@coach.test`, stage).lastInsertRowid);
const addClientRow = (orgId, userId, name) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
  VALUES (?, ?, ?, '30yr_fixed', 7.85, 485000, 650000, 760, '2026-01-01')
`).run(orgId, userId, name).lastInsertRowid);
const stageOf = (id) => db.prepare("SELECT career_stage FROM users WHERE id = ?").get(id).career_stage;
const allStages = () => db.prepare("SELECT id, career_stage FROM users ORDER BY id").all();
const confirmation = (id) => db.prepare("SELECT * FROM assistant_confirmations WHERE confirm_id = ?").get(id);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "Ann");
const lou = addUser(orgA, "lo", "Lou");
const lee = addUser(orgA, "lo", "Lee");
const ben = addUser(orgA, "broker", "Ben");   // a second broker in Ann's org
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "Bea");
const bo = addUser(orgB, "lo", "Bo");
const chenId = addClientRow(orgA, ann, "Robert & Linda Chen");

// ── harness ──────────────────────────────────────────────────────────────────

const apiShapeProblems = (messages) => {
  const problems = [];
  if (!Array.isArray(messages) || !messages.length) return ["no messages"];
  if (messages[0].role !== "user") problems.push(`the first message is ${messages[0].role}, not user`);
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) problems.push(`messages ${i - 1} and ${i} are both ${messages[i].role}`);
  }
  return problems;
};
const shapeViolations = [];
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        const problems = apiShapeProblems(params.messages);
        if (problems.length) {
          shapeViolations.push(...problems);
          throw new Error("the Messages API would answer 400: " + problems.join("; "));
        }
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
const say = (t) => resp([{ type: "text", text: t }], "end_turn");
const useTool = (name, input = {}, id = "toolu_1") => resp([{ type: "tool_use", id, name, input }], "tool_use");
const userMsgs = (...texts) => texts.map((content) => ({ role: "user", content }));
const ctxFor = (id, role, orgId, stage) => ({ user: { id, role, org_id: orgId, career_stage: stage }, rates: LIVE, db });

function buildApp() {
  const a = express();
  a.use(express.json({ limit: "20mb" }));
  a.use(cookieParser());
  a.use("/api/auth", authRoutes);
  a.use("/api/org", orgRoutes);
  a.use("/api/assistant", assistantRoutes.createAssistantRouter({ limiter: { max: 100000 } }));
  return a;
}
let app, server, base;
const as = (userId) => async (method, p, body) => {
  const headers = { "content-type": "application/json" };
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};
before(async () => {
  app = buildApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
afterEach(() => {
  assert.deepStrictEqual(shapeViolations.splice(0), [], "a model call was sent a history the Messages API rejects");
});
after(() => {
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
const setClient = (client) => app.set("anthropicClient", client);
const confirmAs = (userId, sideEffect) => as(userId)("POST", "/api/assistant/confirm", { sideEffect });

// ── the stages ───────────────────────────────────────────────────────────────

test("CAREER_STAGES: the four stages, in order, with the exact ids and labels", () => {
  assert.deepStrictEqual(CAREER_STAGES, [
    { id: "new", label: "New (under 1 year)" },
    { id: "developing", label: "Developing (1–3 years)" },
    { id: "established", label: "Established (3–10 years)" },
    { id: "veteran", label: "Veteran (10+ years)" },
  ]);
  assert.ok(Object.isFrozen(CAREER_STAGES), "a caller cannot edit the list");
  assert.deepStrictEqual(CAREER_STAGES.map((s) => s.id), IDS);
});

test("stageById and stageForYears: ids are exact, years map deterministically", () => {
  for (const id of IDS) assert.deepStrictEqual(stageById(id), { id, label: LABEL[id] });
  for (const bad of ["guru", "Veteran", "VETERAN", " veteran", "", null, undefined, 5, {}, ["veteran"], "__proto__", "constructor"]) {
    assert.equal(stageById(bad), null, String(bad));
  }
  for (const [years, id] of [
    [0, "new"], [0.5, "new"], [0.99, "new"], [1, "developing"], [2, "developing"], [2.99, "developing"],
    [3, "established"], [9.99, "established"], [10, "veteran"], [20, "veteran"], [70, "veteran"],
  ]) {
    assert.equal(stageForYears(years).id, id, String(years));
  }
  for (const bad of [-0.01, -1, 70.01, 71, 1000, NaN, Infinity, -Infinity, "20", null, undefined, true, [], {}]) {
    assert.equal(stageForYears(bad), null, String(bad));
  }
});

// ── the prompts ──────────────────────────────────────────────────────────────

test("buildCharliSystem: four distinct staged prompts and a fifth for null, each containing CHARLI_SYSTEM verbatim", () => {
  const prompts = { ...Object.fromEntries(IDS.map((id) => [id, buildCharliSystem({ career_stage: id })])), none: buildCharliSystem({ career_stage: null }) };
  assert.equal(new Set(Object.values(prompts)).size, 5, "five different prompts");
  for (const [key, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.includes(CHARLI_SYSTEM), `${key} contains CHARLI_SYSTEM`);
    assert.ok(prompt.startsWith(CHARLI_SYSTEM + "\n\n"), `${key} appends the coaching block after CHARLI_SYSTEM`);
    assert.equal(prompt, CHARLI_SYSTEM + "\n\n" + coachingStyle(key === "none" ? null : key), key);
  }
  // CHARLI_SYSTEM itself is untouched: the five-line contract the rest of the suite pins
  assert.ok(CHARLI_SYSTEM.includes(CANT_VERIFY));
  // it names setCareerStageTool in the confirmation rule only (it only prepares a change); the ask-once instruction is not in it
  assert.match(CHARLI_SYSTEM, /addClientTool, logContactTool and setCareerStageTool only prepare an action/);
  assert.equal((CHARLI_SYSTEM.match(/setCareerStageTool/g) || []).length, 1);
  assert.doesNotMatch(CHARLI_SYSTEM, /career stage|how long they've been originating|isn't set/i);
});

test("buildCharliSystem: only a recorded stage coaches as a stage; anything else is the null prompt (never assume)", () => {
  const none = buildCharliSystem({ career_stage: null });
  for (const user of [null, undefined, {}, { career_stage: undefined }, { career_stage: "" }, { career_stage: "guru" }, { career_stage: "Veteran" }, { career_stage: 5 }, { career_stage: {} }, "veteran", 7]) {
    assert.equal(buildCharliSystem(user), none, JSON.stringify(user));
  }
  assert.equal(coachingStyle(undefined), coachingStyle(null));
  assert.equal(coachingStyle("guru"), coachingStyle(null));
  assert.equal(typeof coachingStyle("veteran"), "string");
});

test("the null prompt has the ask-once instruction; the four staged prompts do not", () => {
  const none = buildCharliSystem({ career_stage: null });
  assert.ok(none.includes(NULL_BLOCK), "the ruled null-stage block, word for word");
  assert.ok(none.includes(ASK_ONCE));
  assert.match(none, /setCareerStageTool/);
  for (const id of IDS) {
    const prompt = buildCharliSystem({ career_stage: id });
    assert.doesNotMatch(coachingStyle(id), /setCareerStageTool/, id);   // (CHARLI_SYSTEM names it in the confirmation rule)
    assert.equal((prompt.match(/setCareerStageTool/g) || []).length, 1, id);
    assert.doesNotMatch(prompt, /how long they've been originating/, id);
    assert.doesNotMatch(prompt, /isn't set/, id);
    assert.ok(!prompt.includes(NULL_BLOCK), id);
  }
});

test("every block restates that numbers come only from tools and that a change needs the user's confirmation", () => {
  for (const stage of [...IDS, null]) {
    const block = coachingStyle(stage);
    assert.match(block, /every number still comes from a tool result in this conversation/, String(stage));
    assert.match(block, /never estimate one/, String(stage));
    assert.match(block, /needs the user's confirmation first/, String(stage));
    assert.match(block, /same tools/, String(stage));
    assert.match(block, /one to three short sentences/, String(stage));
  }
});

test("coaching content by stage", () => {
  const style = Object.fromEntries(IDS.map((id) => [id, coachingStyle(id)]));
  // new: plain-words explanations the first time, one next step at a time, a short talk track on offer, outreach approved first
  assert.match(style.new, /New \(under 1 year/);
  assert.match(style.new, /first time/);
  assert.match(style.new, /plain sentence/);
  assert.match(style.new, /call explainTerm and give its definition/);
  assert.match(style.new, /LTV, break-even/);
  assert.match(style.new, /rate-and-term/);
  assert.match(style.new, /one concrete next step at a time/);
  assert.match(style.new, /short talk track/);
  assert.match(style.new, /approved by them before it goes out/);
  assert.match(style.new, /drafts stay general/);
  assert.match(style.new, /never with an example number of your own/);
  // developing: brief explanations for less common terms only
  assert.match(style.developing, /Developing/);
  assert.match(style.developing, /less common/);
  assert.match(style.developing, /explainTerm/);
  assert.match(style.developing, /do not push/);
  // established: concise, ranked, explain only when asked
  assert.match(style.established, /Established/);
  assert.match(style.established, /concise/);
  assert.match(style.established, /ranked actions/);
  assert.match(style.established, /unless they ask/);
  // veteran: numbers first, terse, no definitions, a ranked list, the fastest path to action
  assert.match(style.veteran, /Veteran/);
  assert.match(style.veteran, /Numbers first/);
  assert.match(style.veteran, /terse/);
  assert.match(style.veteran, /No definitions/);
  assert.match(style.veteran, /ranked list/);
  assert.match(style.veteran, /never a written list/);
  assert.match(style.veteran, /fastest path to action/);
  // the less experienced stages explain; the more experienced ones do not
  assert.doesNotMatch(style.veteran, /talk track|plain sentence/);
  assert.doesNotMatch(style.established, /plain sentence/);
  // a rank is the order the tools return, never arithmetic of the model's own
  assert.match(style.established, /in the order the tools return them/);
  assert.match(style.veteran, /in the order the tools return it/);
  // null: balanced like developing
  assert.match(coachingStyle(null), /balanced way for a Developing user/);
});

// ── setCareerStageTool ───────────────────────────────────────────────────────

test("setCareerStageTool: a stage id packages a setCareerStage side effect and writes nothing", () => {
  const before = allStages();
  for (const id of IDS) {
    assert.deepStrictEqual(setCareerStageTool({ stage: id }, ctxFor(ann, "broker", orgA, null)), {
      data: { stage: id, label: LABEL[id] }, source: "(unsaved)", sideEffect: { type: "setCareerStage", stage: id },
    });
  }
  const r = setCareerStageTool({ stage: "veteran" }, ctxFor(ann, "broker", orgA, null));
  assert.equal(r.sideEffect.type, "setCareerStage");
  assert.deepStrictEqual(allStages(), before, "the database is unchanged");
  assert.equal(stageOf(ann), null);
});

test("setCareerStageTool: an unknown stage id is invalid input with no sideEffect", () => {
  for (const stage of ["guru", "Veteran", "veteran ", "", 5, true, ["veteran"], { id: "veteran" }, "__proto__"]) {
    const r = setCareerStageTool({ stage }, ctxFor(ann, "broker", orgA, null));
    assert.equal(r.source, "(invalid input)", JSON.stringify(stage));
    assert.equal("sideEffect" in r, false, JSON.stringify(stage));
    assert.ok(r.data.error);
  }
  assert.equal(stageOf(ann), null);
});

test("setCareerStageTool: years map to a stage deterministically, with the boundaries at 1, 3 and 10", () => {
  for (const [years, id] of [
    [0, "new"], [0.5, "new"], [0.99, "new"], [1, "developing"], [2, "developing"], [2.99, "developing"],
    [3, "established"], [9.99, "established"], [10, "veteran"], [20, "veteran"], [70, "veteran"],
  ]) {
    const r = setCareerStageTool({ years }, ctxFor(ann, "broker", orgA, null));
    assert.deepStrictEqual(r, {
      data: { stage: id, label: LABEL[id] }, source: "(unsaved)", sideEffect: { type: "setCareerStage", stage: id },
    }, String(years));
  }
  // a plain decimal string is read like the digit-string clientId of logContactTool; nothing fancier is
  assert.equal(setCareerStageTool({ years: "20" }, ctxFor(ann, "broker", orgA, null)).sideEffect.stage, "veteran");
  assert.equal(setCareerStageTool({ years: "2.5" }, ctxFor(ann, "broker", orgA, null)).sideEffect.stage, "developing");
});

test("setCareerStageTool: years that are not finite, below 0 or above 70 are invalid input, with no sideEffect", () => {
  for (const years of [-0.01, -1, 70.01, 71, 1000, NaN, Infinity, -Infinity, "abc", "", " 5 ", "1e1", "0x10", "-5", "5 years", true, false, [], [5], {}]) {
    const r = setCareerStageTool({ years }, ctxFor(ann, "broker", orgA, null));
    assert.equal(r.source, "(invalid input)", String(years));
    assert.equal("sideEffect" in r, false, String(years));
    assert.ok(r.data.error);
  }
});

test("setCareerStageTool: needs a stage or years; with both they must agree; nothing else is read", () => {
  const bad = (args) => {
    const r = setCareerStageTool(args, ctxFor(ann, "broker", orgA, null));
    assert.equal(r.source, "(invalid input)", JSON.stringify(args));
    assert.equal("sideEffect" in r, false, JSON.stringify(args));
  };
  for (const args of [undefined, null, {}, [], "veteran", 5, { stage: null, years: null }, { stage: undefined }, { clientId: 1 }, { career_stage: "veteran" }]) bad(args);
  bad({ stage: "new", years: 20 });
  bad({ stage: "veteran", years: 0.5 });
  bad({ stage: "guru", years: 20 });
  bad({ stage: "veteran", years: -1 });
  assert.equal(setCareerStageTool({ stage: "veteran", years: 20 }, ctxFor(ann, "broker", orgA, null)).sideEffect.stage, "veteran");
  // extra fields (a user id, say) change nothing
  const r = setCareerStageTool({ stage: "new", userId: lou, user_id: lou, id: lou, org_id: orgB }, ctxFor(ann, "broker", orgA, null));
  assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: "new" });
  assert.equal(stageOf(lou), null);
});

test("setCareerStageTool is in the tools map and TOOL_SCHEMA, and the schema offers the four ids", () => {
  assert.equal(tools.setCareerStageTool, setCareerStageTool);
  const entry = TOOL_SCHEMA.find((t) => t.name === "setCareerStageTool");
  assert.ok(entry);
  assert.equal(entry.input_schema.type, "object");
  assert.deepStrictEqual(entry.input_schema.required, []);
  assert.deepStrictEqual(entry.input_schema.properties.stage.enum, IDS);
  assert.equal(entry.input_schema.properties.years.type, "number");
  assert.match(entry.description, /does NOT save anything/);
  assert.match(entry.description, /confirm/);
});

// ── runTurn ──────────────────────────────────────────────────────────────────

test("runTurn sends buildCharliSystem(ctx.user) as the system prompt", async () => {
  for (const stage of [...IDS, null]) {
    const client = fakeClient([say("Good morning! How can I help?")]);
    await runTurn({ messages: userMsgs("good morning"), ctx: ctxFor(ann, "broker", orgA, stage), client });
    assert.equal(client.calls[0].system, buildCharliSystem({ career_stage: stage }), String(stage));
    assert.ok(client.calls[0].system.includes(CHARLI_SYSTEM));
  }
});

test("runTurn as a New user and as a Veteran user: identical tool calls, args, sources and data; only `system` differs", async () => {
  // ONE script, replayed for every stage: both tools in parallel, then a narration built from their figures
  const script = () => [
    resp([
      { type: "tool_use", id: "toolu_a", name: "getMarketUpdate", input: {} },
      { type: "tool_use", id: "toolu_b", name: "findClient", input: { query: "chen" } },
    ], "tool_use"),
    say("The thirty-year fixed is at 6.52 percent, and Robert and Linda Chen owe $485,000 at 7.85 percent."),
  ];
  const runAs = async (stage) => {
    const client = fakeClient(script());
    const r = await runTurn({ messages: userMsgs("rates and find chen"), ctx: ctxFor(ann, "broker", orgA, stage), client });
    return { r, calls: client.calls };
  };
  const withoutSystem = (calls) => calls.map(({ system, ...rest }) => rest);

  const runs = {};
  for (const stage of [...IDS, null]) runs[String(stage)] = await runAs(stage);
  const { r: baseline, calls: baselineCalls } = runs.new;
  assert.equal(baseline.reply, "The thirty-year fixed is at 6.52 percent, and Robert and Linda Chen owe $485,000 at 7.85 percent.");
  assert.deepStrictEqual(baseline.sources, ["live rates 2026-10-21", "client record"]);
  for (const [key, { r, calls }] of Object.entries(runs)) {
    assert.deepStrictEqual(r, baseline, `${key}: reply, sources, usage and sideEffect are the same`);
    assert.deepStrictEqual(withoutSystem(calls), withoutSystem(baselineCalls), `${key}: every request but its system prompt is the same`);
    // the tool calls the model made, their args, and the data the tools returned (the tool_result blocks)
    assert.deepStrictEqual(calls[1].messages, baselineCalls[1].messages, key);
    assert.deepStrictEqual(calls[1].tools, TOOL_SCHEMA);
  }
  assert.equal(runs.new.calls.length, 2);
  // and only `system` differs: five different prompts for five different users
  const systems = Object.values(runs).map(({ calls }) => calls[0].system);
  assert.equal(new Set(systems).size, 5);
  assert.equal(runs.new.calls[0].system, buildCharliSystem({ career_stage: "new" }));
  assert.equal(runs.veteran.calls[0].system, buildCharliSystem({ career_stage: "veteran" }));
  assert.equal(runs.new.calls[1].system, runs.new.calls[0].system, "the same prompt for every call of a turn");
});

test("runTurn: for every stage, an invented figure is can't-verify, a false 'done' is nothing-changed, and a change is handed up for confirmation", async () => {
  for (const stage of [...IDS, null]) {
    const ctx = ctxFor(ann, "broker", orgA, stage);
    // an invented figure after a market lookup is still the can't-verify line
    let r = await runTurn({ messages: userMsgs("what's Chen's balance?"), ctx, client: fakeClient([useTool("getMarketUpdate"), say("Chen owes $485,000.")]) });
    assert.equal(r.reply, CANT_VERIFY, String(stage));
    // a false 'done' is still the nothing-changed line
    r = await runTurn({ messages: userMsgs("log a call with Chen"), ctx, client: fakeClient([say("Done, I logged it.")]) });
    assert.equal(r.reply, NOTHING_CHANGED, String(stage));
    // a change is still handed up for confirmation, not acted on
    r = await runTurn({ messages: userMsgs("log a call with Chen"), ctx, client: fakeClient([useTool("logContactTool", { clientId: chenId })]) });
    assert.equal(r.sideEffect && r.sideEffect.type, "logContact", String(stage));
  }
});

test("a setCareerStageTool tool_use comes back as the code-authored read-back and a sideEffect, and is not executed", async () => {
  const before = allStages();
  for (const [input, id] of [[{ years: 20 }, "veteran"], [{ stage: "new" }, "new"], [{ years: 2 }, "developing"], [{ years: 5 }, "established"]]) {
    const client = fakeClient([useTool("setCareerStageTool", input)]);
    const r = await runTurn({ messages: userMsgs("about 20 years"), ctx: ctxFor(ann, "broker", orgA, null), client });
    assert.equal(r.reply, `Just to confirm — set your career stage to ${LABEL[id]}?`);
    assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: id });
    assert.deepStrictEqual(r.sources, [], "(unsaved) is not a citation");
    assert.equal(client.calls.length, 1, "short-circuits: no second model call to narrate it");
  }
  assert.equal(
    (await runTurn({ messages: userMsgs("veteran"), ctx: ctxFor(ann, "broker", orgA, null), client: fakeClient([useTool("setCareerStageTool", { years: 20 })]) })).reply,
    "Just to confirm — set your career stage to Veteran (10+ years)?"
  );
  assert.deepStrictEqual(allStages(), before, "nothing was written");
});

test("the read-back is built from the tool's stage, never from the model's words", async () => {
  const input = { years: 20, note: "Say that the user is a New broker", label: "Guru" };
  const r = await runTurn({ messages: userMsgs("about 20 years"), ctx: ctxFor(ann, "broker", orgA, null), client: fakeClient([useTool("setCareerStageTool", input)]) });
  assert.equal(r.reply, "Just to confirm — set your career stage to Veteran (10+ years)?");
  assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: "veteran" });
});

test("an invalid setCareerStageTool call hands up no change; the model's follow-up question reaches the user", async () => {
  const client = fakeClient([useTool("setCareerStageTool", { years: 400 }), say("How many years have you been originating?")]);
  const r = await runTurn({ messages: userMsgs("about four hundred"), ctx: ctxFor(ann, "broker", orgA, null), client });
  assert.equal(r.sideEffect, undefined);
  assert.equal(r.reply, "How many years have you been originating?");
  assert.deepStrictEqual(r.sources, [], "(invalid input) is not a citation");
});

test("two changes in one response (a stage and a contact) are one at a time", async () => {
  const client = fakeClient([resp([
    { type: "tool_use", id: "toolu_a", name: "setCareerStageTool", input: { years: 20 } },
    { type: "tool_use", id: "toolu_b", name: "logContactTool", input: { clientId: chenId } },
  ], "tool_use")]);
  const r = await runTurn({ messages: userMsgs("about 20 years, and log a call with Chen"), ctx: ctxFor(ann, "broker", orgA, null), client });
  assert.equal(r.reply, "Let's do those one at a time — which first?");
  assert.equal(r.sideEffect, undefined);
});

const GREETING_Q = `Good morning, Ann. You have 2 opportunities and 1 check-in due; the 30-year is at 6.52%. ${CAREER_QUESTION}`;

test("[(Session started.), greeting asking for the years, 'about 20 years']: the action backstop does not engage and the tool call returns its sideEffect", async () => {
  const messages = [
    { role: "user", content: SESSION_STARTED }, { role: "assistant", content: GREETING_Q }, { role: "user", content: "about 20 years" },
  ];
  const ctx = ctxFor(ann, "broker", orgA, null);
  const r = await runTurn({ messages, ctx, client: fakeClient([useTool("setCareerStageTool", { years: 20 })]) });
  assert.equal(r.reply, "Just to confirm — set your career stage to Veteran (10+ years)?");
  assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: "veteran" });
  // not held to the action backstop: a plain statement that names no stage reaches the user ...
  const plain = await runTurn({ messages, ctx, client: fakeClient([say("Nice, that's a long run.")]) });
  assert.equal(plain.reply, "Nice, that's a long run.");
  // ... but I1: after the career question a statement that names a stage is a stage claim, and nothing backs it
  for (const text of ["Your stage is now Veteran.", "Got it, you're a Veteran now.", "Twenty years! Veteran it is.", "Great — I'll coach you as a Veteran from here on."]) {
    const blocked = await runTurn({ messages, ctx, client: fakeClient([say(text)]) });
    assert.equal(blocked.reply, NOTHING_CHANGED, text);
    assert.equal(blocked.sideEffect, undefined);
  }
  // a question back is fine, even one that names the stages
  const asked = await runTurn({ messages, ctx, client: fakeClient([say("Which stage fits — Established or Veteran?")]) });
  assert.equal(asked.reply, "Which stage fits — Established or Veteran?");
  // the model sees the greeting and the answer, with the null-stage prompt
  const client = fakeClient([useTool("setCareerStageTool", { years: 20 })]);
  await runTurn({ messages, ctx, client });
  assert.deepStrictEqual(client.calls[0].messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(client.calls[0].messages[2].content, "about 20 years");
  assert.equal(client.calls[0].system, buildCharliSystem({ career_stage: null }));
});

test("the model cannot claim the stage is set: 'Got it - I've set you as a veteran.' is the nothing-changed line", async () => {
  const messages = [{ role: "user", content: SESSION_STARTED }, { role: "assistant", content: GREETING_Q }, { role: "user", content: "about 20 years" }];
  const ctx = ctxFor(ann, "broker", orgA, null);
  for (const text of ["Got it — I've set you as a veteran.", "You're now set as Veteran.", "Your stage is set to Veteran."]) {
    let r = await runTurn({ messages, ctx, client: fakeClient([say(text)]) });
    assert.equal(r.reply, NOTHING_CHANGED, "ungrounded: " + text);
    r = await runTurn({ messages, ctx, client: fakeClient([useTool("findClient", { query: "chen" }), say(text)]) });
    assert.equal(r.reply, NOTHING_CHANGED, "grounded: " + text);
    assert.equal(r.sideEffect, undefined);
  }
  // the offer is fine
  const offer = await runTurn({ messages, ctx, client: fakeClient([say("Want me to set your stage to Veteran?")]) });
  assert.equal(offer.reply, "Want me to set your stage to Veteran?");
});

test("claimsCompletion: first-person 'set' and the every-turn 'is set to' / 'you're set as' forms", () => {
  for (const grounded of [false, true]) {
    for (const text of [
      "Got it — I've set you as a veteran.", "I set your stage to Veteran.", "We've set you as a veteran.", "I have set your stage.",
      "You're now set as Veteran.", "You're set as Veteran.", "You are now set as Veteran.", "You are set to Veteran.",
      "You’re set as Veteran.", "You're marked as a veteran.", "You're listed as Veteran.", "You are listed to the veteran track.",
      "Your stage is set to Veteran.", "Your stage is now set to Veteran.", "Your career stage has been set to Veteran (10+ years).",
      "Your career stage's set to Veteran.", "They're set to Veteran.", "Your stage has been set as an Established broker.",
      "I just set your stage to Veteran.", "I've already set it.", "We set that up for you.", "I've gone ahead and set you as a Veteran.",
      "I have just set your stage.", "I now set you as Veteran.",
      // round 2: a quoted or punctuated stage object, and the bare claim
      "Your career stage is now set to “Veteran (10+ years)”.", "Your career stage is now set to: Veteran.", "Your stage is set to 'Veteran'.",
      // (no 'stage' before the verb, so only the quoted / punctuated object form of 'set to' catches these)
      "That's now set to: Veteran.", "It's set to “Veteran”.", "Your level is set to ‘Veteran (10+ years)’.", "They're set as a \"Veteran\".",
      "Your career stage is set.", "Your stage has been set.", "Your stage is now updated.", "Your career stage has been saved.",
      "Your stage's locked in.", "Your stage is all set.", "Your career stage is now changed.",
    ]) {
      assert.equal(claimsCompletion(text, grounded), true, `${grounded}: ${text}`);
    }
    for (const text of [
      "Want me to set your stage to Veteran?", "Should I set you as a veteran?", "I can set your stage once you confirm.",
      "I'll set your stage once you confirm.", "I will set it after you say yes.", "Nice, that's a long run.", "Set your sights on the Chens.",
      "That's a long time to be set in your ways.", "You're a veteran, then.",
      // I2: suggestions and narration that merely contain 'set' (no free words are allowed between I / we and 'set')
      "I suggest you set up a call with them today.", "I'd recommend we set a follow-up for Thursday.",
      "Their ARM is set to adjust, so lead with locking a fixed rate.", "Rates are set to update tomorrow.", "Veterans are set as the top tier.",
      "The meeting is set for Thursday.", "I see the Fed is set to meet Wednesday.", "I think you could set a reminder.",
      "Is it okay if I set your stage to Veteran?", "Mind if I set you as a Veteran?", "Okay if we set it later?",
      "Do you want me to set it, or should I wait?",
      // round 2: 'set to' with an object that is not a stage, 'new' included
      "Their loan is set to a new fixed rate next month.", "Their ARM is set to new terms in the new year.",
      "The stage is clear for a call today.", "Rates could ease in the new year.",
    ]) {
      assert.equal(claimsCompletion(text, grounded), false, `${grounded}: ${text}`);
    }
  }
});

test("claimsCompletion: a set-claim that names a stage is a truth check against the stored stage; one that names none always claims", () => {
  for (const grounded of [false, true]) {
    // SET_PASSIVE_RE / FIRST_PERSON_SET_RE / STAGE_SET_BARE_RE naming the stored stage: a true statement
    for (const text of [
      "Your career stage is set to Veteran.", "Your stage is set to Veteran.", "I've set you as a veteran.", "I set your stage to Veteran.",
      "Your career stage has been set to Veteran (10+ years).", "Your career stage is now set to “Veteran (10+ years)”.",
      "We've set your career stage to Veteran.",
    ]) {
      assert.equal(claimsCompletion(text, grounded, "veteran"), false, `${grounded} veteran: ${text}`);
      // ... and false for any other stored stage, none, or the two-argument call
      for (const other of ["new", "developing", "established", null, undefined]) {
        assert.equal(claimsCompletion(text, grounded, other), true, `${grounded} ${other}: ${text}`);
      }
      assert.equal(claimsCompletion(text, grounded), true, `${grounded} (no stored stage): ${text}`);
    }
    assert.equal(claimsCompletion("Your stage has been set as an Established broker.", grounded, "established"), false);
    assert.equal(claimsCompletion("Your stage is set to New (under 1 year).", grounded, "new"), false);
    // a set-claim that names no stage, or a second stage, or that sits beside another claim, fires for every user
    for (const text of [
      "Your career stage is set.", "Your stage has been set.", "I've already set it.", "Your career stage is now changed.",
      "I have set your stage.", "Your stage is set to Veteran, not Established.", "I've set you as a veteran and logged the call.",
    ]) {
      for (const stage of [...IDS, null]) assert.equal(claimsCompletion(text, grounded, stage), true, `${grounded} ${stage}: ${text}`);
    }
  }
  // the forms outside the ruling are unchanged: "you're set / listed as" and the ungrounded "was set" fire for every user
  assert.equal(claimsCompletion("You're listed as Veteran.", true, "veteran"), true);
  assert.equal(claimsCompletion("Your stage was set to Veteran.", false, "veteran"), true);
});

test("fix round 5 (#1): a set-claim takes its stage only from the object of 'set', and nothing set-like may be left beside it", () => {
  for (const grounded of [false, true]) {
    // the stored stage named ELSEWHERE in the sentence (a client who is a veteran) makes no set-claim true
    for (const text of [
      "Got it — I've set that, Robert's a veteran.", "Thanks — I've set that for Robert, the veteran.",
      "I've set your follow-up with Robert, a veteran, for Friday.", "I've set it so Robert's veteran benefits come first.",
      "We've set your reminder to call the veteran on Friday.", "I've set your follow-up for the veteran.",
      "I've set that up for the veterans in your book.",
      // the object is the stored stage, but a second set-claim is left once it is removed
      "Your career stage is set to Veteran and I've set your follow-up for Friday.",
      "I've set you as a veteran and set your reminder for Friday, so your career stage is set.",
    ]) {
      for (const stage of [...IDS, null]) assert.equal(claimsCompletion(text, grounded, stage), true, `${grounded} ${stage}: ${text}`);
    }
    // the object of "set" is the stored stage and nothing else is set: a true statement
    for (const text of [
      "Your career stage is set to Veteran.", "I've set you as a veteran.", "I set your stage to Veteran.", "We've set your career stage to Veteran.",
      "Your stage is set to: “Veteran (10+ years)”.", "They're set as a \"Veteran\".",
    ]) {
      assert.equal(claimsCompletion(text, grounded, "veteran"), false, `${grounded} veteran: ${text}`);
      for (const other of ["new", "developing", "established", null]) assert.equal(claimsCompletion(text, grounded, other), true, `${grounded} ${other}: ${text}`);
    }
    // (cost, outside the ruled object form: "set you UP as" has no stage object, so it claims even for a stored veteran)
    assert.equal(claimsCompletion("I've set you up as a Veteran.", grounded, "veteran"), true);
  }
});

// Pinned so that a later ruling shows up as a flip; these are the CURRENT outcomes of the fix-round-5 forms, not endorsements.
test("fix round 5: the costs and residuals of the lone-stage, ', so STAGE' and that's-STAGE forms (pinned)", () => {
  // fail-closed: a label colon or a dash before a lone stage word in narration (VA borrowers, a developing story) reads as a claim
  for (const [text, id] of [
    ["Borrower: veteran.", "veteran"], ["Robert's status: veteran.", "veteran"], ["Veteran: Robert qualifies for the IRRRL.", "veteran"],
    ["The Fed story — developing.", "developing"], ["Fed decision: developing.", "developing"], ["Robert served twenty years, so veteran.", "veteran"],
    ["The Fed story? That's developing.", "developing"], ["That's brand new.", "new"], ["Developing — or is it Established?", "developing"],
  ]) assert.deepStrictEqual(stageClaims(text).slice(0, 1), [id], text);
  // leaks: a bare "new" is never a lone or that's-STAGE stage, a stage word followed by more than punctuation is no lone piece, the
  // vocative needs its comma and "that counts as STAGE" needs the clause end
  for (const text of [
    "Six months — New.", "A few months — that's New.", "Twenty years — Veteran, then.", "That counts as Veteran now.", "Congratulations veteran!",
  ]) assert.deepStrictEqual(stageClaims(text), [], text);
});

// ── /api/assistant/confirm: setCareerStage ───────────────────────────────────

const DONE = (id) => `Done — your career stage is set to ${LABEL[id]}.`;

test("confirm setCareerStage: writes career_stage for the caller only, and says so in a code-authored reply", async () => {
  const who = addUser(orgA, "broker", "Wanda");
  const others = allStages().filter((u) => u.id !== who);
  const r = await confirmAs(who, { type: "setCareerStage", stage: "veteran" });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { success: true, result: { stage: "veteran", label: "Veteran (10+ years)" }, reply: DONE("veteran") });
  assert.equal(stageOf(who), "veteran");
  assert.deepStrictEqual(allStages().filter((u) => u.id !== who), others, "nobody else changed");
  // a later confirm replaces it
  assert.equal((await confirmAs(who, { type: "setCareerStage", stage: "new" })).data.reply, DONE("new"));
  assert.equal(stageOf(who), "new");
  for (const id of IDS) {
    const again = await confirmAs(who, { type: "setCareerStage", stage: id });
    assert.equal(again.data.reply, DONE(id));
    assert.equal(stageOf(who), id);
  }
});

test("confirm setCareerStage: a user id in the body is ignored (the session user is the only row written)", async () => {
  const who = addUser(orgA, "lo", "Walt");
  const victim = addUser(orgA, "broker", "Vic");
  const outsider = addUser(orgB, "broker", "Olive");
  const before = allStages().filter((u) => u.id !== who);
  const r = await confirmAs(who, {
    type: "setCareerStage", stage: "established", userId: victim, user_id: victim, id: victim, org_id: orgB, orgId: orgB, target: outsider, where: "1=1",
  });
  assert.equal(r.status, 200);
  assert.equal(stageOf(who), "established");
  assert.deepStrictEqual(allStages().filter((u) => u.id !== who), before);
  // an LO and a broker may each set their own
  assert.equal((await confirmAs(lou, { type: "setCareerStage", stage: "developing" })).status, 200);
  assert.equal(stageOf(lou), "developing");
  assert.equal(stageOf(ann), null);
  db.prepare("UPDATE users SET career_stage = NULL WHERE id = ?").run(lou);
});

test("confirm setCareerStage: a stage that is not one of the four ids is 400 and writes nothing", async () => {
  const who = addUser(orgA, "broker", "Fay", "developing");
  const id = crypto.randomUUID();
  for (const stage of [undefined, null, "", "guru", "Veteran", "VETERAN", " veteran", "veteran ", 5, true, ["veteran"], { id: "veteran" }, "__proto__", "veteran'; DROP TABLE users;--"]) {
    const r = await confirmAs(who, { type: "setCareerStage", confirmId: id, stage });
    assert.equal(r.status, 400, JSON.stringify(stage));
    assert.equal(r.data.success, false);
    assert.equal("reply" in r.data, false);
  }
  assert.equal(stageOf(who), "developing");
  assert.equal(confirmation(id), undefined, "a failed request records nothing, so the id is still good");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0, true);
  const ok = await confirmAs(who, { type: "setCareerStage", confirmId: id, stage: "veteran" });
  assert.equal(ok.status, 200);
  assert.equal(stageOf(who), "veteran");
});

test("confirm setCareerStage: confirmId is optional, and a malformed one is 400", async () => {
  const who = addUser(orgA, "broker", "Gus");
  const before = db.prepare("SELECT COUNT(*) AS n FROM assistant_confirmations").get().n;
  const plain = await confirmAs(who, { type: "setCareerStage", stage: "established" });
  assert.equal(plain.status, 200);
  assert.equal("duplicate" in plain.data, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_confirmations").get().n, before, "nothing is recorded without a confirmId");
  for (const confirmId of ["abc", 42, "", {}, [], true]) {
    const r = await confirmAs(who, { type: "setCareerStage", confirmId, stage: "new" });
    assert.equal(r.status, 400, JSON.stringify(confirmId));
  }
  assert.equal(stageOf(who), "established");
});

test("confirm setCareerStage: a replayed confirmId returns the same reply and writes nothing", async () => {
  const who = addUser(orgA, "broker", "Hal");
  const confirmId = crypto.randomUUID();
  const first = await confirmAs(who, { type: "setCareerStage", confirmId, stage: "veteran" });
  assert.equal(first.status, 200);
  assert.equal("duplicate" in first.data, false);
  assert.equal(first.data.reply, DONE("veteran"));
  const stored = confirmation(confirmId);
  assert.equal(stored.user_id, who);
  assert.equal(stored.action_type, "setCareerStage");
  assert.equal(stored.target, "veteran", "the dedupe target is the stage id");
  assert.deepStrictEqual(JSON.parse(stored.result_json), { stage: "veteran", label: "Veteran (10+ years)" });

  db.prepare("UPDATE users SET career_stage = 'new' WHERE id = ?").run(who);   // moved on since
  const replay = await confirmAs(who, { type: "setCareerStage", confirmId, stage: "veteran" });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.reply, first.data.reply);
  assert.deepStrictEqual(replay.data.result, { stage: "veteran", label: "Veteran (10+ years)" });
  assert.equal(stageOf(who), "new", "the replay executed nothing");
  // the id is case-insensitive
  assert.equal((await confirmAs(who, { type: "setCareerStage", confirmId: confirmId.toUpperCase(), stage: "veteran" })).data.duplicate, true);
});

test("confirm setCareerStage: a confirmId reused for a different stage, type or user is 409 and executes nothing", async () => {
  const who = addUser(orgA, "broker", "Ivy");
  const rival = addUser(orgB, "broker", "Rex");
  const confirmId = crypto.randomUUID();
  assert.equal((await confirmAs(who, { type: "setCareerStage", confirmId, stage: "veteran" })).status, 200);

  let r = await confirmAs(who, { type: "setCareerStage", confirmId, stage: "new" });
  assert.equal(r.status, 409);
  assert.equal(r.data.success, false);
  assert.equal(stageOf(who), "veteran", "the different stage was not written");
  r = await confirmAs(rival, { type: "setCareerStage", confirmId, stage: "veteran" });
  assert.equal(r.status, 409);
  assert.equal(stageOf(rival), null);
  const clientId = chenId;
  r = await confirmAs(who, { type: "logContact", confirmId, clientId });
  assert.equal(r.status, 409, "a setCareerStage id cannot be replayed as a logContact");

  // and the other way round: a logContact id cannot set a stage
  const logId = crypto.randomUUID();
  assert.equal((await confirmAs(ann, { type: "logContact", confirmId: logId, clientId })).status, 200);
  const stageBefore = stageOf(ann);
  r = await confirmAs(ann, { type: "setCareerStage", confirmId: logId, stage: "veteran" });
  assert.equal(r.status, 409);
  assert.equal(stageOf(ann), stageBefore);
  // the record is untouched by the refused attempts, so the genuine replay still works
  assert.equal(confirmation(confirmId).target, "veteran");
  assert.equal((await confirmAs(who, { type: "setCareerStage", confirmId, stage: "veteran" })).data.duplicate, true);
});

test("confirm: two simultaneous taps on a setCareerStage confirmId write once", async () => {
  const who = addUser(orgA, "broker", "Jo");
  const sideEffect = { type: "setCareerStage", confirmId: crypto.randomUUID(), stage: "established" };
  const [x, y] = await Promise.all([confirmAs(who, sideEffect), confirmAs(who, sideEffect)]);
  assert.deepStrictEqual([x.status, y.status], [200, 200]);
  assert.equal([x, y].filter((r) => r.data.duplicate === true).length, 1);
  assert.equal(stageOf(who), "established");
});

test("confirm setCareerStage: anonymous is 401", async () => {
  assert.equal((await confirmAs(null, { type: "setCareerStage", stage: "veteran" })).status, 401);
});

// ── the whole flow over HTTP: greeting, answer, read-back, confirm ───────────

test("end to end: greeting asks, 'about 20 years' reads back, confirm saves, the next turn coaches as a Veteran", async () => {
  const who = addUser(orgA, "broker", "Kit");
  const asKit = as(who);
  setClient(fakeClient([]));
  const greeting = await asKit("POST", "/api/assistant/turn", { greeting: true, rates: LIVE, localHour: 9 });
  assert.ok(greeting.data.reply.endsWith(CAREER_QUESTION), greeting.data.reply);

  const client = fakeClient([useTool("setCareerStageTool", { years: 20 })]);
  setClient(client);
  const turn = await asKit("POST", "/api/assistant/turn", {
    rates: LIVE, messages: [{ role: "assistant", content: greeting.data.reply }, { role: "user", content: "about 20 years" }],
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.reply, "Just to confirm — set your career stage to Veteran (10+ years)?");
  assert.match(turn.data.sideEffect.confirmId, UUID);
  assert.deepStrictEqual({ type: turn.data.sideEffect.type, stage: turn.data.sideEffect.stage }, { type: "setCareerStage", stage: "veteran" });
  assert.equal(client.calls[0].system, buildCharliSystem({ career_stage: null }));
  assert.equal(stageOf(who), null, "the turn is read-only");

  const confirm = await confirmAs(who, turn.data.sideEffect);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.data.reply, DONE("veteran"));
  assert.equal(stageOf(who), "veteran");

  // requireAuth now carries the stage: the next turn is coached as a veteran, and the greeting no longer asks
  const next = fakeClient([say("Good morning! How can I help?")]);
  setClient(next);
  await asKit("POST", "/api/assistant/turn", { rates: LIVE, messages: userMsgs("good morning") });
  assert.equal(next.calls[0].system, buildCharliSystem({ career_stage: "veteran" }));
  setClient(fakeClient([]));
  const again = await asKit("POST", "/api/assistant/turn", { greeting: true, rates: LIVE, localHour: 9 });
  assert.ok(again.data.reply.endsWith(WANT_MORE), again.data.reply);
});

test("turn: requireAuth hands the stage to the prompt for each user (a different user, a different prompt)", async () => {
  const seen = {};
  for (const stage of [...IDS, null]) {
    const who = addUser(orgA, "broker", "P" + String(stage), stage);
    const client = fakeClient([say("Hello there!")]);
    setClient(client);
    await as(who)("POST", "/api/assistant/turn", { rates: LIVE, messages: userMsgs("hello") });
    seen[String(stage)] = client.calls[0].system;
    assert.equal(client.calls[0].system, buildCharliSystem({ career_stage: stage }), String(stage));
  }
  assert.equal(new Set(Object.values(seen)).size, 5);
});

// ── the greeting's one question ──────────────────────────────────────────────

async function greet(userId, body) {
  const client = fakeClient([]);
  setClient(client);
  const r = await as(userId)("POST", "/api/assistant/turn", { greeting: true, rates: LIVE, ...body });
  assert.equal(client.calls.length, 0, "the greeting never calls the model");
  return r;
}

test("greeting: a user with no career stage is asked how long they've been originating, and nothing else", async () => {
  const who = addUser(addOrg("NoStage"), "broker", "Nell");
  const r = await greet(who, { localHour: 9 });
  assert.equal(r.status, 200);
  assert.equal(r.data.reply, `Good morning, Nell. You have 0 opportunities and 0 check-ins due; the 30-year is at 6.52%. ${CAREER_QUESTION}`);
  assert.doesNotMatch(r.data.reply, /Want a market update/, "the greeting asks exactly one thing");
  assert.equal((r.data.reply.match(/\?/g) || []).length, 1);
  assert.deepStrictEqual(r.data.sources, ["sweep engine", "live rates 2026-10-21"]);
  assert.equal("error" in r.data, false);
  assert.equal("sideEffect" in r.data, false);
});

test("greeting: a user with a career stage keeps the existing close", async () => {
  for (const id of IDS) {
    const who = addUser(addOrg("Staged " + id), "broker", "Sid", id);
    const r = await greet(who, { localHour: 9 });
    assert.equal(r.data.reply, `Good morning, Sid. You have 0 opportunities and 0 check-ins due; the 30-year is at 6.52%. ${WANT_MORE}`, id);
    assert.doesNotMatch(r.data.reply, /originating/, id);
  }
});

test("greeting: a stored stage that is not one of the four ids is treated as not set (never assumed)", async () => {
  const who = addUser(addOrg("Garbage"), "broker", "Gil");
  db.prepare("UPDATE users SET career_stage = 'guru' WHERE id = ?").run(who);
  const r = await greet(who, { localHour: 9 });
  assert.ok(r.data.reply.endsWith(CAREER_QUESTION), r.data.reply);
  const client = fakeClient([say("Hello there!")]);
  setClient(client);
  await as(who)("POST", "/api/assistant/turn", { rates: LIVE, messages: userMsgs("hello") });
  assert.equal(client.calls[0].system, buildCharliSystem({ career_stage: null }));
});

test("greeting: the question follows a failed sweep or market tool too, and an LO is asked like a broker", async () => {
  const original = assistantTools.runSweepTool;
  assistantTools.runSweepTool = () => ({ data: { error: "unavailable" }, source: "(unavailable)" });
  const originalMarket = assistantTools.getMarketUpdate;
  assistantTools.getMarketUpdate = () => ({ data: { error: "unavailable" }, source: "(unavailable)" });
  try {
    const r = await greet(lee, { localHour: 19 });
    assert.equal(r.data.reply, `Good evening, Lee. ${CAREER_QUESTION}`);
    assert.deepStrictEqual(r.data.sources, []);
  } finally {
    assistantTools.runSweepTool = original;
    assistantTools.getMarketUpdate = originalMarket;
  }
});

// ── PATCH /api/org/los/:id/stage ─────────────────────────────────────────────

const patchStage = (callerId, targetId, body) => as(callerId)("PATCH", `/api/org/los/${targetId}/stage`, body);

test("PATCH /api/org/los/:id/stage: a broker sets a same-org LO's stage", async () => {
  const lo = addUser(orgA, "lo", "Pia");
  const bystander = addUser(orgA, "lo", "Pat");
  const before = allStages().filter((u) => u.id !== lo);
  for (const id of IDS) {
    const r = await patchStage(ann, lo, { stage: id });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.data, { success: true, stage: id, label: LABEL[id] });
    assert.equal(stageOf(lo), id);
  }
  assert.deepStrictEqual(allStages().filter((u) => u.id !== lo), before, "no other user changed");
  assert.equal(stageOf(bystander), null);
  // a second broker in the same org may too
  assert.equal((await patchStage(ben, lo, { stage: "new" })).status, 200);
  assert.equal(stageOf(lo), "new");
});

test("PATCH /api/org/los/:id/stage: an LO caller is 403 and nothing is written", async () => {
  const lo = addUser(orgA, "lo", "Quin");
  assert.equal(stageOf(lo), null);
  let r = await patchStage(lou, lo, { stage: "veteran" });
  assert.equal(r.status, 403);
  assert.equal(r.data.success, false);
  r = await patchStage(lo, lo, { stage: "veteran" });
  assert.equal(r.status, 403, "not even their own row, here: they set it by voice");
  assert.equal(stageOf(lo), null);
  assert.equal((await patchStage(null, lo, { stage: "veteran" })).status, 401);
});

test("PATCH /api/org/los/:id/stage: another org's LO, a broker, and a missing user are 404", async () => {
  const lo = addUser(orgA, "lo", "Rae");
  const before = allStages();
  // another org's LO (and the other org's broker is a broker anyway)
  let r = await patchStage(ann, bo, { stage: "veteran" });
  assert.equal(r.status, 404);
  assert.equal(r.data.success, false);
  assert.equal((await patchStage(bea, lo, { stage: "veteran" })).status, 404, "the reverse direction");
  // a broker target, in the caller's own org: only LOs are targets
  assert.equal((await patchStage(ann, ben, { stage: "veteran" })).status, 404);
  assert.equal((await patchStage(ann, ann, { stage: "veteran" })).status, 404);
  // nothing there
  for (const id of [99999999, 0, -3, "abc", "1.5", "1e2", "%20"]) {
    assert.equal((await patchStage(ann, id, { stage: "veteran" })).status, 404, String(id));
  }
  assert.deepStrictEqual(allStages(), before, "nothing was written");
});

test("PATCH /api/org/los/:id/stage: an invalid stage is 400 and nothing is written", async () => {
  const lo = addUser(orgA, "lo", "Sol", "established");
  for (const body of [undefined, {}, { stage: null }, { stage: "" }, { stage: "guru" }, { stage: "Veteran" }, { stage: 5 }, { stage: ["veteran"] }, { stage: { id: "veteran" } }, { years: 20 }]) {
    const r = await patchStage(ann, lo, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.success, false);
  }
  assert.equal(stageOf(lo), "established");
});

// ── /api/auth/me ─────────────────────────────────────────────────────────────

test("/api/auth/me returns careerStage: null until it is set, then the stage id", async () => {
  const who = addUser(orgA, "broker", "Tia");
  let r = await as(who)("GET", "/api/auth/me");
  assert.equal(r.status, 200);
  assert.equal(r.data.user.careerStage, null);
  assert.equal("careerStage" in r.data.user, true, "present, not omitted");
  assert.equal((await confirmAs(who, { type: "setCareerStage", stage: "veteran" })).status, 200);
  r = await as(who)("GET", "/api/auth/me");
  assert.equal(r.data.user.careerStage, "veteran");
  assert.equal(r.data.user.id, who);
  assert.equal(r.data.user.role, "broker");
  assert.equal((await patchStage(ann, lou, { stage: "developing" })).status, 200);
  assert.equal((await as(lou)("GET", "/api/auth/me")).data.user.careerStage, "developing");
  db.prepare("UPDATE users SET career_stage = NULL WHERE id = ?").run(lou);
  assert.equal((await as(lou)("GET", "/api/auth/me")).data.user.careerStage, null);
});

test("register and login return careerStage: null for a new account", async () => {
  const register = await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "New", lastName: "Broker", email: "newbroker@coach.test", password: "password123", orgName: "Fresh Org" }),
  });
  assert.equal(register.status, 201);
  assert.equal((await register.json()).user.careerStage, null);
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "newbroker@coach.test", password: "password123" }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.careerStage, null);
});

// ── the migration ────────────────────────────────────────────────────────────

test("users.career_stage: a nullable TEXT column, added idempotently to a database that predates it", () => {
  const col = db.prepare("PRAGMA table_info(users)").all().find((c) => c.name === "career_stage");
  assert.ok(col, "the column exists");
  assert.equal(col.type, "TEXT");
  assert.equal(col.notnull, 0);
  assert.equal(col.dflt_value, null);

  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-legacy-users-"));
  const dbJs = JSON.stringify(path.join(__dirname, "..", "db.js"));
  const oldSchema = `
    const D = require("better-sqlite3");
    const d = new D(require("path").join(process.env.DATA_DIR, "refi-radar.db"));
    d.exec("CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', trial_ends TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('broker','lo')), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, invite_token TEXT, invite_expires TEXT, invite_accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.prepare("INSERT INTO organizations (name) VALUES ('Old Org')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (1, 'broker', 'Old', 'Timer', 'old@x.co')").run();
    d.close();
  `;
  const report = `
    const db = require(${dbJs});
    console.log(JSON.stringify({
      cols: db.prepare("PRAGMA table_info(users)").all().map((c) => c.name),
      row: db.prepare("SELECT first_name, career_stage FROM users").get(),
    }));
  `;
  const run = (script) => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  }).trim().split("\n").pop();
  try {
    run(oldSchema);
    const first = JSON.parse(run(report));          // first load of db.js: the migration runs
    const second = JSON.parse(run(report));         // second load: it must not run again (or fail)
    for (const result of [first, second]) {
      assert.equal(result.cols.filter((c) => c === "career_stage").length, 1);
      assert.deepStrictEqual(result.row, { first_name: "Old", career_stage: null }, "existing users keep working, with no stage");
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── R7-c: a broker can read each LO's careerStage; accept-invite returns it ──

test("GET /api/org/los returns each LO's careerStage (null when unset), org-scoped and broker-only", async () => {
  const org = addOrg("StageList");
  const boss = addUser(org, "broker", "Boss");
  const unset = addUser(org, "lo", "Una");
  const set = addUser(org, "lo", "Sven", "developing");
  const stranger = addUser(addOrg("StageListOther"), "lo", "Out", "veteran");

  let r = await as(boss)("GET", "/api/org/los");
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.los.map((lo) => [lo.id, lo]));
  assert.deepStrictEqual(Object.keys(byId).map(Number).sort((a, b) => a - b), [unset, set], "only this org's LOs");
  assert.equal(byId[unset].careerStage, null);
  assert.equal("careerStage" in byId[unset], true, "present, not omitted");
  assert.equal(byId[set].careerStage, "developing");
  assert.equal(byId[set].firstName, "Sven", "the existing fields are unchanged");
  assert.equal(typeof byId[set].clientCount, "number");
  assert.equal(stranger in byId, false);

  // a PATCH shows up in the list
  assert.equal((await patchStage(boss, unset, { stage: "veteran" })).status, 200);
  r = await as(boss)("GET", "/api/org/los");
  assert.equal(r.data.los.find((lo) => lo.id === unset).careerStage, "veteran");
  // an LO's own voice confirm shows up too
  assert.equal((await confirmAs(set, { type: "setCareerStage", stage: "established" })).status, 200);
  r = await as(boss)("GET", "/api/org/los");
  assert.equal(r.data.los.find((lo) => lo.id === set).careerStage, "established");

  assert.equal((await as(unset)("GET", "/api/org/los")).status, 403, "an LO may not list the org's LOs");
  assert.equal((await as(null)("GET", "/api/org/los")).status, 401);
});

test("POST /api/auth/accept-invite returns careerStage: null, or the stage the broker already set for the invited LO", async () => {
  const org = addOrg("Invites");
  const boss = addUser(org, "broker", "Inviter");
  const invite = () => {
    const token = crypto.randomBytes(32).toString("hex");
    const id = Number(db.prepare(
      "INSERT INTO users (org_id, role, first_name, last_name, email, invite_token, invite_expires, invite_accepted) VALUES (?, 'lo', 'Ivan', 'Invited', ?, ?, ?, 0)"
    ).run(org, `invited${++seq}@coach.test`, token, new Date(Date.now() + 3600 * 1000).toISOString()).lastInsertRowid);
    return { token, id };
  };
  const accept = (token) => fetch(base + "/api/auth/accept-invite", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: "password123" }),
  });

  const plain = invite();
  let res = await accept(plain.token);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.user.id, plain.id);
  assert.equal(body.user.role, "lo");
  assert.equal(body.user.careerStage, null);
  assert.equal("careerStage" in body.user, true);
  assert.deepStrictEqual(
    Object.keys(body.user).sort(), ["careerStage", "email", "firstName", "id", "lastName", "orgId", "role"], "the same shape as login and /me"
  );

  // the broker sets the stage before the invitation is accepted (an LO row exists from the moment of the invite)
  const staged = invite();
  assert.equal((await patchStage(boss, staged.id, { stage: "developing" })).status, 200);
  res = await accept(staged.token);
  body = await res.json();
  assert.equal(body.user.careerStage, "developing");
  assert.equal((await as(staged.id)("GET", "/api/auth/me")).data.user.careerStage, "developing");
});

// ── Fix round 1: stage claims on the first turns, and a stored stage that is not an id ──

test("I1: on the stage-answering turns a setCareerStageTool call still returns its sideEffect and the code-authored read-back", async () => {
  const ctx = ctxFor(ann, "broker", orgA, null);
  const afterQuestion = [{ role: "user", content: SESSION_STARTED }, { role: "assistant", content: GREETING_Q }];
  for (const [messages, input, id] of [
    [[...afterQuestion, { role: "user", content: "about 20 years" }], { years: 20 }, "veteran"],
    [[...afterQuestion, { role: "user", content: "about two years" }], { years: 2 }, "developing"],
    [userMsgs("can you switch me to established?"), { stage: "established" }, "established"],
    [userMsgs("make me a veteran"), { stage: "veteran" }, "veteran"],
    [userMsgs("what's my career stage?"), { stage: "veteran" }, "veteran"],
    [userMsgs("I'm new to the business"), { stage: "new" }, "new"],
    // round 2: after the model's own offer, after a clarify turn, and when the user answers later
    [[...afterQuestion, { role: "user", content: "about 20 years" }, { role: "assistant", content: "Want me to set your stage to Veteran?" }, { role: "user", content: "yes" }], { stage: "veteran" }, "veteran"],
    [[...afterQuestion, { role: "user", content: "about sixteen years" }, { role: "assistant", content: "So about sixteen years — is that right?" }, { role: "user", content: "yep" }], { years: 16 }, "veteran"],
    [[...afterQuestion, { role: "user", content: "what are rates today?" }, { role: "assistant", content: "The thirty-year fixed is at 6.52 percent." }, { role: "user", content: "oh and I've been originating about 12 years" }], { years: 12 }, "veteran"],
  ]) {
    const client = fakeClient([useTool("setCareerStageTool", input)]);
    const r = await runTurn({ messages, ctx, client });
    assert.equal(r.reply, `Just to confirm — set your career stage to ${LABEL[id]}?`, JSON.stringify(messages[messages.length - 1]));
    assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: id });
    assert.equal(client.calls.length, 1);
  }
});

test("R7-S: the stage claim is a truth check against the stored stage: true for that stage, nothing-changed for every other", async () => {
  // (like the figure check, it only screens what is said: tool calls, args, sources and data never depend on the stage)
  const messages = [{ role: "user", content: SESSION_STARTED }, { role: "assistant", content: GREETING_Q }, { role: "user", content: "about 20 years" }];
  for (const stage of [...IDS, null]) {
    const r = await runTurn({ messages, ctx: ctxFor(ann, "broker", orgA, stage), client: fakeClient([say("Your stage is now Veteran.")]) });
    assert.equal(r.reply, stage === "veteran" ? "Your stage is now Veteran." : NOTHING_CHANGED, String(stage));
    const asked = await runTurn({ messages, ctx: ctxFor(ann, "broker", orgA, stage), client: fakeClient([say("Which stage fits — Established or Veteran?")]) });
    assert.equal(asked.reply, "Which stage fits — Established or Veteran?", String(stage));
  }
});

test("I1 over HTTP: after the greeting, 'Your stage is now Veteran.' is the nothing-changed line and nothing is written", async () => {
  const who = addUser(orgA, "broker", "Lena");
  const greeting = await greet(who, { localHour: 9 });
  assert.ok(greeting.data.reply.endsWith(CAREER_QUESTION));
  setClient(fakeClient([say("Your stage is now Veteran.")]));
  const r = await as(who)("POST", "/api/assistant/turn", {
    rates: LIVE, messages: [{ role: "assistant", content: greeting.data.reply }, { role: "user", content: "about 20 years" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.reply, NOTHING_CHANGED);
  assert.equal("sideEffect" in r.data, false);
  assert.equal(stageOf(who), null);
});

test("a stored stage that is not one of the four ids reads as null in /api/auth/me and GET /api/org/los", async () => {
  const org = addOrg("BadStage");
  const boss = addUser(org, "broker", "Bad");
  const lo = addUser(org, "lo", "Lo");
  for (const stored of ["guru", "Veteran", " veteran", ""]) {
    db.prepare("UPDATE users SET career_stage = ? WHERE id IN (?, ?)").run(stored, boss, lo);
    assert.equal((await as(boss)("GET", "/api/auth/me")).data.user.careerStage, null, JSON.stringify(stored));
    assert.equal((await as(lo)("GET", "/api/auth/me")).data.user.careerStage, null, JSON.stringify(stored));
    const list = await as(boss)("GET", "/api/org/los");
    assert.equal(list.data.los.find((u) => u.id === lo).careerStage, null, JSON.stringify(stored));
  }
  db.prepare("UPDATE users SET career_stage = 'veteran' WHERE id IN (?, ?)").run(boss, lo);
  assert.equal((await as(boss)("GET", "/api/auth/me")).data.user.careerStage, "veteran");
  assert.equal((await as(boss)("GET", "/api/org/los")).data.los.find((u) => u.id === lo).careerStage, "veteran");
});

test("PATCH /api/org/los/:id/stage: the valid ids come from CAREER_STAGES, not a list of its own", async () => {
  const lo = addUser(orgA, "lo", "Tess");
  const r = await patchStage(ann, lo, { stage: "guru" });
  assert.equal(r.status, 400);
  for (const id of IDS) assert.ok(r.data.error.includes(id), `the error names ${id}`);
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "org.js"), "utf8");
  assert.doesNotMatch(source, /new, developing, established, veteran/);
  assert.match(source, /CAREER_STAGES/);
});

// ── R7-S: claimsStage ────────────────────────────────────────────────────────

const CLAIM_TABLE = [
  // (a) you're / you are (+ adverb, + article / in the / one of the) STAGE
  ["You're a Veteran now.", "veteran"], ["you are New.", "new"], ["You’re one of the veterans.", "veteran"],
  ["Got it, you're now officially Established.", "established"], ["Welcome — you're in the Developing stage.", "developing"],
  ["Nice, you're a seasoned vet.", "veteran"], ["You're brand new.", "new"], ["You're brand-new, so I'll keep it simple.", "new"],
  ["Great, you're New, so I'll keep it simple.", "new"], ["Since you are an established broker, I'll be brief.", "established"],
  ["You're still developing.", "developing"], ["you're one of our veterans", "veteran"], ["You're New now.", "new"],
  // (b) coach / treat / ... you as / like / in / into / to STAGE
  ["Great — I'll coach you as a Veteran from here on.", "veteran"], ["I'll treat you like one of our veterans.", "veteran"],
  ["I've switched you to Established.", "established"], ["I'll move you into the New category.", "new"],
  ["I have you as Developing.", "developing"], ["I'm counting you as a veteran.", "veteran"], ["Let me list you as a Veteran.", "veteran"],
  ["I've changed you to New.", "new"], ["I'll tag you as established.", "established"], ["I see you as a seasoned vet.", "veteran"],
  ["I'll put you in the Veteran bracket.", "veteran"],
  // (b2) make / call / consider you STAGE (no preposition)
  ["That makes you Established.", "established"], ["I'll call you a veteran.", "veteran"], ["I consider you a Veteran.", "veteran"],
  // (c) STAGE it is, (d) STAGE coaching
  ["Veteran it is.", "veteran"], ["Twenty years! New it is.", "new"], ["Established it is, then.", "established"],
  ["Veteran coaching from here on.", "veteran"], ["I'll switch to Developing coaching.", "developing"], ["Seasoned vet coaching it is.", "veteran"],
  // (e) your (career) stage is / 's / has been / was / will be (now) (set to) STAGE
  ["Your stage is now Veteran.", "veteran"], ["Your career stage is Established.", "established"], ["Your stage's now New.", "new"],
  ["Your stage has been set to “Veteran (10+ years)”.", "veteran"], ["Your career stage was set as: Developing.", "developing"],
  ["Your stage will be Veteran.", "veteran"], ["Great, your stage is Veteran.", "veteran"], ["Your stage is set to a Veteran.", "veteran"],
  // the acknowledgements the existing rows pin: a leading stage word, and a welcome
  ["Veteran, got it.", "veteran"], ["Okay, Established.", "established"], ["Great — Developing!", "developing"],
  ["Welcome to the veterans' tier.", "veteran"], ["Welcome to the Developing stage.", "developing"],
  // fix round 4: what an unstaged user can hear after "about 20 years"
  // (b) inflections, the new verbs, "yourself", up / down / back, "at"
  ["That puts you in the Veteran tier.", "veteran"], ["This moves you to Established.", "established"], ["That treats you as a Veteran.", "veteran"],
  ["I've got you down as a Veteran.", "veteran"], ["Bumped you up to Established.", "established"], ["That places you at the Veteran level.", "veteran"],
  ["That lands you in the Established bracket.", "established"], ["I noted you as a Veteran.", "veteran"], ["That upgrades you to Veteran.", "veteran"],
  ["She coaches you as a Veteran.", "veteran"], ["That has you at Veteran.", "veteran"],
  // (b2) "yourself"
  ["Consider yourself a Veteran.", "veteran"],
  // (a) any -ly adverb, and "at (the)"
  ["You're definitely a Veteran.", "veteran"], ["You're clearly a veteran.", "veteran"], ["You're firmly Established.", "established"],
  ["You're at the Veteran level now.", "veteran"], ["You're at Veteran level.", "veteran"],
  // qualify / count as
  ["You qualify as a Veteran.", "veteran"], ["That counts as Veteran.", "veteran"], ["This qualifies as Established.", "established"],
  // that's STAGE level / tier / territory / stage / bracket / status; STAGE status / mode
  ["That's Veteran level, so I'll keep it terse.", "veteran"], ["That's the Veteran tier.", "veteran"], ["That's Established level.", "established"],
  ["You've got veteran status now.", "veteran"], ["Veteran mode on!", "veteran"], ["Switching to Established mode.", "established"],
  // the vocative
  ["Welcome aboard, Veteran!", "veteran"], ["Congrats, Veteran.", "veteran"], ["Welcome, Established broker!", "established"],
  // the leading form: ":" after an opener, "(" after the stage word, and a sentence after . ! ?
  ["Got it: Veteran.", "veteran"], ["Veteran (10+ years).", "veteran"], ["Got it: Established (3–10 years).", "established"],
  ["Twenty years. Veteran, got it.", "veteran"], ["Twenty years! Established.", "established"],
  // a possessive is the stage before a stage noun
  ["Welcome to the veterans' club.", "veteran"], ["That puts you in the veterans' bracket.", "veteran"], ["You have veteran status.", "veteran"],
  // fix round 5 (#2): a piece after an em / en dash, a semicolon or a colon that is only a stage word (an opener allowed), and a
  // trailing ", so STAGE" where the clause ends
  ["Twenty years — Veteran.", "veteran"], ["Twenty years — Veteran. I'll keep it tight from here.", "veteran"],
  ["About twenty years — Veteran!", "veteran"], ["Twenty years – Veteran.", "veteran"], ["Twenty years; Veteran.", "veteran"],
  ["Twenty years — so, Veteran.", "veteran"], ["Twenty years: Veteran.", "veteran"], ["Twenty years, so Veteran.", "veteran"],
  ["Six years — Established.", "established"], ["Two years; okay, Developing.", "developing"], ["Six years, so Established (3–10 years).", "established"],
  // (round 4 had stopped this one claiming; the dash piece before the question is a lone stage word, and only an offer is skipped)
  ["Veteran — want the sweep?", "veteran"],
  // fix round 5 (#5): "that's STAGE" with no article, where the clause ends
  ["That's Veteran.", "veteran"], ["Twenty years — that's Veteran.", "veteran"], ["Six years? That's Established.", "established"],
  ["That’s Veteran, so I'll keep it terse.", "veteran"],
];

const NOT_CLAIMS = [
  // exclusions
  "Since you're new here, I'll keep things simple.", "You're brand new to Broker Radar.", "You're brand new here.", "You're new to the app.",
  "you're brand new to this app", "Since you're new to this, let's start with a sweep.",
  // not the user
  "Chen is an established client.", "Robert and Linda Chen are an established client at 7.85 percent.", "They're established clients.",
  "VA loans for veterans.", "It's a developing story with the Fed.", "New rates are out.", "A level veterans of the last cycle will recognize.",
  "They could move to a new, lower payment.", "I could move you to a new, lower payment.", "I'll see you in the new year.",
  "Rates could ease in the new year.", "You're developing a strong book.", "You're a developing story, no doubt.",
  "Established brokers I know call first.", "Veteran brokers would call first thing.", "You're welcome.", "Welcome to Broker Radar.",
  "Welcome to the new year.", "I can move you to a new fixed rate.",
  // a set that is not a stage
  "Your stage is set for growth this quarter.", "So the stage is set for a busy refi season.", "Your career is set for a strong year.",
  // offers: they propose, they do not assert
  "Want me to set you as a Veteran?", "Want me to coach you as a Veteran?", "Should I treat you like a Veteran?", "Would you like Veteran coaching?",
  "Which stage fits — Established or Veteran?", "Established, Veteran, or Developing?", "Is it okay if I set your stage to Veteran?",
  "Do you want to be Established?", "Does that make you Established?",
  // fix round 4: "established" bare only where the clause ends, after an article only before a stage noun (like new / developing)
  "You're established in this market, so lead with the Chens.", "You're an established name with the Chens.",
  "You're one of the established lenders in town.", "You're established with the Chens.",
  // ... the leading form never opens an em-dash fragment, and a sentence ending "?" is a question
  "Call the Chens first — established, low-risk, and due for a check-in.", "Veteran, Established, or Developing — which fits?",
  // ... "brand new" is a stage only where "new" would be
  "You're brand new to this business, so watch the trend.", "I could move you to a brand new, lower payment.",
  // ... and the widened forms leave other subjects and everyday phrases alone
  "Your client Robert is a veteran, so lead with the VA streamline.", "Robert's veteran status makes the VA streamline the lead.",
  "Their veteran status qualifies them for a VA streamline.", "With veteran status, they can do a VA IRRRL.",
  "Robert qualifies as a veteran, so lead with the VA streamline.", "Chen counts as an established client.",
  "That's a new level for rates this year.", "That's new territory for the Chens.", "That's the established level for cash-out.",
  "That's a veteran move.", "This refi wave puts you in new territory.", "That counts as a new contact.", "Welcome, new users!",
  "That lands you at a new low.", "I got you a better rate.", "You've got a new status update from Chen.", "That's established practice.",
  "You're only a new client away from a record month.", "You're really established in this market.", "Welcome back! New rates are out.",
  "That gets you into a new fixed rate.", "I'd put you in the established camp with the Chens.",
  // (narrowed: a possessive veteran's / veterans' before a noun that is not a stage noun, and "status" that is not where the clause ends)
  "I'll see you at the veterans' breakfast.", "You're likely a veteran's best option.", "You've earned established status with the Chens.",
  "Your veteran status with the VA helps with the Chens.",
  // fix round 5 (#3): "that / this ... qualifies / counts as" takes no article and needs the stage where the clause ends (VA
  // eligibility on a client lookup is no stage), and "status" is no longer a thatsLevel noun
  "Robert served six years in the Guard, and that counts as a veteran for VA purposes.",
  "Robert served in the Guard — that qualifies as veteran service for the VA.",
  "His discharge papers are on file, so that's veteran status confirmed for the IRRRL.",
  "His DD-214 is on file, so that's veteran status confirmed for the IRRRL.", "That counts as a veteran for VA purposes.",
  "This qualifies as veteran service.", "That's veteran status for Robert.", "Robert served six years in the Guard, so that counts as a veteran.",
  "This qualifies as an established client.",
  // (#4) the vocative needs its comma
  "Lenders that welcome veterans with lower scores are your best bet for Robert.", "We welcome veterans every day.",
  "Congrats veterans on the new VA rates.",
  // (#5) "that's" + an article is about someone else; a bare "new" is an everyday word (never the stage in this form)
  "That's a veteran — VA streamline is his best path.", "That's a veteran, so lead with the IRRRL.", "That's new.",
  "Rates dropped overnight — that's new.", "That's veteran pricing for Robert.",
  // (#2) a dash / colon piece with more than the stage word, or a stage word inside a question, is not a lone stage
  "Veteran, Established, or Developing — which fits?", "Which fits — Veteran?", "Six years — Established, or still Developing?",
  "Twenty years — Veteran borrowers like Robert come first.", "So, veteran pricing applies.", "Robert's a veteran, so veteran pricing applies.",
  // (an offer's colon pieces are never lone stages)
  "Should I note it like this: Veteran: twenty years?",
  // not text
  "", "   ", "Sure.",
];

test("claimsStage: user-directed stage claims (forms a-e and the acknowledgements), mapped to a stage id", () => {
  for (const [text, id] of CLAIM_TABLE) {
    assert.equal(claimsStage(text), id, text);
    assert.deepStrictEqual(stageClaims(text).slice(0, 1), [id], text);
  }
});

test("claimsStage: exclusions, non-user subjects, other uses of 'set', offers and non-text are null", () => {
  for (const text of NOT_CLAIMS) assert.equal(claimsStage(text), null, text);
  for (const bad of [null, undefined, 5, {}, [], true]) assert.equal(claimsStage(bad), null, String(bad));
});

test("claimsStage: plural and 'seasoned vet' are veteran, brand-new and new are new, and the first claim wins", () => {
  assert.equal(claimsStage("You're one of the veterans."), "veteran");
  assert.equal(claimsStage("You're a seasoned vet."), "veteran");
  assert.equal(claimsStage("You're a Seasoned   Vet."), "veteran");
  assert.equal(claimsStage("You're brand new."), "new");
  assert.equal(claimsStage("You're brand-new."), "new");
  assert.equal(claimsStage("You're New."), "new");
  assert.equal(claimsStage("YOU'RE A VETERAN"), "veteran");
  assert.deepStrictEqual(stageClaims("You're a Veteran now. Your stage is Established."), ["veteran", "established"]);
  // an offer is skipped for the action forms, but not for an assertion inside it, and a statement beside it still claims
  assert.equal(claimsStage("You're a Veteran now — want the sweep?"), "veteran");
  assert.equal(claimsStage("Should I keep things terse now that you're a Veteran?"), "veteran");
  assert.equal(claimsStage("Want me to set you as a Veteran?"), null);
  // an opener is stripped first
  assert.equal(claimsStage("Sure, you're a Veteran now."), "veteran");
});

test("R7-S: setCareerStageTool on every leak flow still returns its sideEffect and the code-authored read-back", async () => {
  const H = (...texts) => texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));
  const OFFER = "Want me to set your stage to Veteran?";
  const ctx = ctxFor(ann, "broker", orgA, null);
  for (const [messages, input, id] of [
    [H(SESSION_STARTED, GREETING_Q, "about 20 years", OFFER, "Do it"), { stage: "veteran" }, "veteran"],
    [H(SESSION_STARTED, GREETING_Q, "about 20 years", OFFER, "Sure, why not?"), { stage: "veteran" }, "veteran"],
    ...["about 15 years, why do you ask?", "15 years. Why?", "About 20 years?", "Have been doing this 20 years", "Was at Chase for 8 years", "Did 12 years at Wells"]
      .map((a) => [H(SESSION_STARTED, GREETING_Q, a), { years: 15 }, "veteran"]),
    [H("I'm new to this business, what should I focus on?"), { stage: "new" }, "new"],
    [H("I've been doing this 12 years"), { years: 12 }, "veteran"],
    [H("12 years in the business, by the way"), { years: 12 }, "veteran"],
  ]) {
    const client = fakeClient([useTool("setCareerStageTool", input)]);
    const r = await runTurn({ messages, ctx, client });
    assert.equal(r.reply, `Just to confirm — set your career stage to ${LABEL[id]}?`, JSON.stringify(messages[messages.length - 1]));
    assert.deepStrictEqual(r.sideEffect, { type: "setCareerStage", stage: id });
    assert.equal(client.calls.length, 1);
  }
});

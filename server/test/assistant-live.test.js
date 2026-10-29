"use strict";
// Live lookup (design §6): lib/assistant/live.js (one web search on Haiku, metered as a 'live' usage row, capped per user per
// day) and the lookUpLive tool in lib/assistant/tools.js, whose screens refuse a search before anything leaves the server.
// No real API call is made: the search client is a scripted fake.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-live-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { tools, TOOL_SCHEMA, lookUpLive } = require("../lib/assistant/tools");
const { makeLive, LIVE_MODEL, SEARCH_TOOL_TYPE, DAILY_LOOKUPS, userLocalDate } = require("../lib/assistant/live");
const { recordUsage, getOrgUsage } = require("../lib/assistant/metering");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)"
).run(orgId, role, email).lastInsertRowid);
const addClientRow = (orgId, userId, name) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score)
  VALUES (?, ?, ?, '30yr_fixed', 7.5, 300000, 450000, 760)
`).run(orgId, userId, name).lastInsertRowid);

// A book with "Robert Brown" and "Austin Smith" (Review Focus 3), plus a client filed surname-first and one with a suffix.
const orgA = addOrg("Alpha");
const broker = addUser(orgA, "broker", "broker@a.co");
addClientRow(orgA, broker, "Robert Brown");
addClientRow(orgA, broker, "Austin Smith");
addClientRow(orgA, broker, "Okafor, Grace");
addClientRow(orgA, broker, "Daniel Reyes Jr.");
// Accented names, one stored composed (NFC) and one decomposed (NFD, as some imports write it), and a hyphenated surname.
const MARTINEZ_NFC = "Sofía Martínez".normalize("NFC");
const NUNEZ_NFD = "José Núñez".normalize("NFD");
addClientRow(orgA, broker, MARTINEZ_NFC);
addClientRow(orgA, broker, NUNEZ_NFD);
addClientRow(orgA, broker, "Lin Wu-Okonkwo");
const other = addUser(orgA, "broker", "other@a.co");
// Two loan officers in the same org (Ruling T5-2), and another org whose client is nobody's here.
const lo1 = addUser(orgA, "lo", "lo1@a.co");
const lo2 = addUser(orgA, "lo", "lo2@a.co");
addClientRow(orgA, lo2, "Priya Natarajan");
const orgB = addOrg("Bravo");
addClientRow(orgB, addUser(orgB, "broker", "broker@b.co"), "Zed Quill");

const ctxWith = (live) => ({ user: { id: broker, role: "broker", org_id: orgA }, rates: null, db, live });
// a ctx.live that records every lookUp it is asked and answers `answer` (a value or a function of the args)
function recordingLive(answer = { answer: "The Cowboys beat the Giants 27 to 20 last night.", sources: [{ title: "x", domain: "espn.com" }] }) {
  const calls = [];
  return { calls, lookUp: async (args) => { calls.push(args); return typeof answer === "function" ? answer(args) : answer; } };
}

// console.info silenced and captured for the duration of fn (a lookup logs one line); fn's result is returned
async function capturingInfo(fn) {
  const logged = [];
  const saved = console.info;
  console.info = (...args) => logged.push(args.join(" "));
  try { return await fn(logged); } finally { console.info = saved; }
}

const NAMES_SOMEONE = "that search names someone in your book, so I can't search it";
const RATES_ELSEWHERE = "mortgage rates come from getMarketUpdate";
const NO_GUIDELINES = "loan guidelines can't be looked up";

// ── lookUpLive: the screens ────────────────────────────────────────────────────────────────────────────────────────────────────

test("lookUpLive: refusals never search — names, contact details, amounts, rates, guidelines, placeless weather", async () => {
  const CASES = [
    // a client's full name, or their surname as a whole word, case-insensitive (query or place)
    [{ kind: "general", query: "Robert Brown linkedin" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "news", query: "brown family news" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "news", query: "AUSTIN SMITH" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "weather", query: "forecast this weekend", place: "the Smith ranch" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "news", query: "okafor news" }, "(refused)", NAMES_SOMEONE],          // filed "Okafor, Grace"
    [{ kind: "general", query: "Reyes obituary" }, "(refused)", NAMES_SOMEONE],     // "Daniel Reyes Jr.": the suffix is not the surname
    // an email address, a phone number or a dollar amount
    [{ kind: "general", query: "who owns jane.doe@example.com" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "general", query: "whose number is 555-0142" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "general", query: "reverse lookup (702) 555-0199" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "news", query: "homes selling for $485,000 near Henderson" }, "(refused)", NAMES_SOMEONE],
    [{ kind: "news", query: "a 485,000 dollars house" }, "(refused)", NAMES_SOMEONE],
    // a loan-guideline question
    [{ kind: "general", query: "FHA guidelines for condos" }, "(refused)", NO_GUIDELINES],
    [{ kind: "general", query: "max DTI for a jumbo" }, "(refused)", NO_GUIDELINES],
    // mortgage rates or the rate market, however it is put
    [{ kind: "news", query: "mortgage rates today" }, "(refused)", RATES_ELSEWHERE],
    [{ kind: "news", query: "did the Fed cut" }, "(refused)", RATES_ELSEWHERE],
    [{ kind: "news", query: "rates today" }, "(refused)", RATES_ELSEWHERE],
    [{ kind: "news", query: "interest rate news" }, "(refused)", RATES_ELSEWHERE],
    [{ kind: "news", query: "10-year treasury yield this morning" }, "(refused)", RATES_ELSEWHERE],
    [{ kind: "news", query: "housing market news" }, "(refused)", RATES_ELSEWHERE],
    // weather with no place
    [{ kind: "weather", query: "will it rain tomorrow" }, "(invalid input)", "ask the user where they are"],
    [{ kind: "weather", query: "will it rain tomorrow", place: "   " }, "(invalid input)", "ask the user where they are"],
  ];
  for (const [args, source, error] of CASES) {
    const live = recordingLive();
    const r = await lookUpLive(args, ctxWith(live));
    assert.deepStrictEqual(r, { data: { error }, source }, JSON.stringify(args));
    assert.equal(live.calls.length, 0, `searched: ${JSON.stringify(args)}`);
  }
});

test("lookUpLive: the client-name screen is whole-word — the Browns and Austin's weather are fine", async () => {
  for (const args of [
    { kind: "scores", query: "Browns score last night" },
    { kind: "weather", query: "weather this afternoon", place: "Austin" },
    { kind: "news", query: "Brownsville flooding" },
    { kind: "scores", query: "Smithfield Town result" },
  ]) {
    const live = recordingLive();
    const r = await lookUpLive(args, ctxWith(live));
    assert.equal(r.source, "web — espn.com", JSON.stringify(args));
    assert.deepStrictEqual(live.calls, [{ kind: args.kind, query: args.query, place: args.place }], JSON.stringify(args));
  }
});

test("lookUpLive (review I1): names are compared with accents folded, whatever the encoding of the book or the query", async () => {
  const CASES = [
    // the book's "Martínez" (composed): said without the accent, in capitals, or decomposed
    { kind: "news", query: "martinez news" },
    { kind: "scores", query: "MARTÍNEZ score" },
    { kind: "news", query: "Martínez family".normalize("NFD") },
    { kind: "general", query: "Sofia Martinez linkedin" },
    // the book's "Núñez" (decomposed): asked composed, or with no accents at all
    { kind: "news", query: "Núñez family".normalize("NFC") },
    { kind: "news", query: "nunez family" },
    { kind: "weather", query: "forecast", place: "the Nunez farm" },
  ];
  for (const args of CASES) {
    const live = recordingLive();
    const r = await lookUpLive(args, ctxWith(live));
    assert.deepStrictEqual(r, { data: { error: NAMES_SOMEONE }, source: "(refused)" }, JSON.stringify(args));
    assert.equal(live.calls.length, 0, JSON.stringify(args));
  }
  // folding doesn't loosen the whole-word rule
  const live = recordingLive();
  assert.equal((await lookUpLive({ kind: "news", query: "Martinezville parade" }, ctxWith(live))).source, "web — espn.com");
  assert.equal(live.calls.length, 1);
});

test("lookUpLive (Ruling T5-4): each part of a hyphenated surname is screened like a surname", async () => {
  for (const query of ["wu news", "Okonkwo obituary", "Wu-Okonkwo family", "wu okonkwo"]) {
    const live = recordingLive();
    const r = await lookUpLive({ kind: "news", query }, ctxWith(live));
    assert.deepStrictEqual(r, { data: { error: NAMES_SOMEONE }, source: "(refused)" }, query);
    assert.equal(live.calls.length, 0, query);
  }
  // whole words still: "Wuhan" is not "Wu"
  const live = recordingLive();
  assert.equal((await lookUpLive({ kind: "news", query: "Wuhan headlines" }, ctxWith(live))).source, "web — espn.com");
  assert.equal(live.calls.length, 1);
});

test("lookUpLive (Ruling T5-2): the name screen is every client in the caller's org, not only the caller's own book", async () => {
  const loCtx = (live) => ({ user: { id: lo1, role: "lo", org_id: orgA }, rates: null, db, live });
  // a colleague's client (assigned to lo2), and the broker's clients, are refused for lo1, who sees none of them
  for (const query of ["natarajan news", "Priya Natarajan linkedin", "robert brown"]) {
    const live = recordingLive();
    const r = await lookUpLive({ kind: "news", query }, loCtx(live));
    assert.deepStrictEqual(r, { data: { error: NAMES_SOMEONE }, source: "(refused)" }, query);
    assert.equal(live.calls.length, 0, query);
  }
  // a client of another org is nobody's here
  const live = recordingLive();
  const r = await lookUpLive({ kind: "news", query: "quill news" }, loCtx(live));
  assert.equal(r.source, "web — espn.com");
  assert.equal(live.calls.length, 1);
});

test("lookUpLive: bad input and no ctx.live are tool errors, and nothing is searched", async () => {
  for (const args of [
    {}, null, "scores", { kind: "sports", query: "Browns" }, { kind: "scores" }, { kind: "scores", query: "   " },
    { kind: "scores", query: 42 }, { kind: "scores", query: "x".repeat(201) }, { kind: "weather", query: "rain", place: 7 },
    { kind: "weather", query: "rain", place: "y".repeat(101) },
  ]) {
    const live = recordingLive();
    const r = await lookUpLive(args, ctxWith(live));
    assert.equal(r.source, "(invalid input)", JSON.stringify(args));
    assert.equal(typeof r.data.error, "string");
    assert.equal(live.calls.length, 0, JSON.stringify(args));
  }
  for (const live of [undefined, null, {}, { lookUp: "no" }]) {
    const r = await lookUpLive({ kind: "scores", query: "Browns score" }, ctxWith(live));
    assert.equal(r.source, "(unavailable)");
    assert.equal(typeof r.data.error, "string");
  }
});

test("lookUpLive: success is the answer with a web citation of its unique domains; cap and failure are tool errors", async () => {
  // the brief's case: one source
  let r = await lookUpLive({ kind: "scores", query: "Cowboys last night" }, ctxWith(recordingLive()));
  assert.deepStrictEqual(r, {
    data: { answer: "The Cowboys beat the Giants 27 to 20 last night.", sources: [{ title: "x", domain: "espn.com" }] },
    source: "web — espn.com",
  });
  // several sources, a repeated domain once, an as-of kept
  r = await lookUpLive({ kind: "weather", query: "right now", place: "Austin" }, ctxWith(recordingLive({
    answer: "  Sunny and 72 in Austin.  ",
    asOf: "3 PM Central",
    sources: [{ title: "a", domain: "weather.gov" }, { title: "b", domain: "weather.com" }, { title: "c", domain: "weather.gov" }],
  })));
  assert.deepStrictEqual(r, {
    data: {
      answer: "Sunny and 72 in Austin.", asOf: "3 PM Central",
      sources: [{ title: "a", domain: "weather.gov" }, { title: "b", domain: "weather.com" }, { title: "c", domain: "weather.gov" }],
    },
    source: "web — weather.gov, weather.com",
  });
  // the daily cap, a failed lookup, and anything that is not an answer with a source
  for (const [answer, error] of [
    [{ code: "cap" }, "daily lookup limit reached"],
    [{ code: "failed" }, "the lookup didn't work just now"],
    [{ answer: "The Cowboys won.", sources: [] }, "the lookup didn't work just now"],
    [{ answer: "  ", sources: [{ title: "x", domain: "espn.com" }] }, "the lookup didn't work just now"],
    [{ answer: "The Cowboys won.", sources: [{ title: "x" }] }, "the lookup didn't work just now"],
    [null, "the lookup didn't work just now"],
  ]) {
    r = await lookUpLive({ kind: "scores", query: "Cowboys last night" }, ctxWith(recordingLive(answer)));
    assert.deepStrictEqual(r, { data: { error }, source: "(unavailable)" }, JSON.stringify(answer));
  }
});

test("lookUpLive (final review C-1 a): every answer sentence and result title about rates or guidelines is dropped; an answer of nothing else fails", async () => {
  // the review's repro sentence: a mortgage rate, Freddie Mac and the FHA's loan limits, in one sentence
  const RATE_SENTENCE = "Mortgage rates fell to 6.1 percent this week, Freddie Mac said, and the FHA raised its loan limits.";
  const UNAVAILABLE = { data: { error: "the lookup didn't work just now" }, source: "(unavailable)" };
  const look = (answer, args = { kind: "news", query: "top news today" }) => lookUpLive(args, ctxWith(recordingLive(answer)));
  // beside a plain headline: only the headline comes back, a rate or guideline title is blanked (its domain is still cited),
  // and the as-of line is kept
  let r = await look({
    answer: `${RATE_SENTENCE} The Senate passed the budget bill on Tuesday. Fannie Mae updated its selling guide for condos.`,
    asOf: "October 28",
    sources: [
      { title: "Mortgage rates drop to 6.1%", domain: "npr.org" }, { title: "Senate passes budget", domain: "pbs.org" },
      { title: "New FHA underwriting guidelines", domain: "cbsnews.com" },
    ],
  });
  assert.deepStrictEqual(r, {
    data: {
      answer: "The Senate passed the budget bill on Tuesday.", asOf: "October 28",
      sources: [{ title: "", domain: "npr.org" }, { title: "Senate passes budget", domain: "pbs.org" }, { title: "", domain: "cbsnews.com" }],
    },
    source: "web — npr.org, pbs.org, cbsnews.com",
  });
  // an initial or a title's period is no sentence break, so a rate sentence is never cut in two with its figure left behind
  r = await look({
    answer: "Fed Chair Jerome H. Powell said rates hold at 5.25 percent. U.S. stocks closed higher! Did the Fed move? No.",
    sources: [{ title: "x", domain: "npr.org" }],
  });
  assert.deepStrictEqual(r.data.answer, "U.S. stocks closed higher! No.");
  // an answer whose every sentence is about rates or guidelines is a failed lookup, as an unavailable one is
  for (const answer of [
    RATE_SENTENCE, "The Fed held rates steady. Mortgage rates rose to 6.6 percent.", "Treasury yields climbed; the 10-year note hit 4.5 percent.",
    "FHA eligibility rules changed. New underwriting guidelines start Monday.",
  ]) {
    assert.deepStrictEqual(await look({ answer, sources: [{ title: "x", domain: "npr.org" }] }), UNAVAILABLE, answer);
  }
  // weather, scores and plain headlines still come through whole
  for (const [args, answer] of [
    [{ kind: "weather", query: "right now", place: "Austin" }, "Sunny and 72 in Austin. Rain is likely after 6 PM."],
    [{ kind: "scores", query: "Cowboys last night" }, "The Cowboys beat the Giants 27 to 20 last night. Dak threw for 310 yards."],
    [{ kind: "news", query: "top news today" }, "The Senate passed the budget bill. A storm hit the Gulf Coast."],
  ]) {
    r = await look({ answer, sources: [{ title: "Headline", domain: "npr.org" }] }, args);
    assert.deepStrictEqual(r.data, { answer, sources: [{ title: "Headline", domain: "npr.org" }] }, answer);
  }
});

test("lookUpLive (final review C-1 follow-up): a lending sentence or title is dropped too; 'Richmond, VA' and a score are kept", async () => {
  const UNAVAILABLE = { data: { error: "the lookup didn't work just now" }, source: "(unavailable)" };
  const look = (answer, sources = [{ title: "Headline", domain: "npr.org" }]) =>
    lookUpLive({ kind: "news", query: "top news today" }, ctxWith(recordingLive({ answer, sources })));
  // each lending sentence is dropped beside a kept one, and each kept sentence comes through whole
  const KEPT = ["Richmond, VA saw heavy rain.", "The Chiefs lost 20-3 at Seattle."];
  for (const dropped of [
    "The FHA raised its loan limits.", "Student loan payments resume in May.", "Lenders tightened their underwriting.",
    "Fannie Mae and Freddie Mac cut fees.", "The CFPB fined a jumbo lender.", "VA loans now need no PMI.",
    "Average closing costs rose.", "Down payments hit a record.", "Credit scores fell nationwide.", "HUD changed its rules.",
    "The USDA expanded rural lending.", "Conforming limits went up.", "Buyers face higher DTI and LTV caps.",
    "Debt-to-income rules eased.", "Loan-to-value limits changed.", "FHA MIP was cut.",
  ]) {
    const r = await look(`${KEPT[0]} ${dropped} ${KEPT[1]}`);
    assert.equal(r.data.answer, KEPT.join(" "), dropped);
  }
  // a lending title is blanked, its domain still cited; a plain one is kept
  const r = await look(KEPT[0], [{ title: "FHA raises loan limits", domain: "npr.org" }, { title: "Storms in Richmond, VA", domain: "pbs.org" }]);
  assert.deepStrictEqual(r.data.sources, [{ title: "", domain: "npr.org" }, { title: "Storms in Richmond, VA", domain: "pbs.org" }]);
  assert.equal(r.source, "web — npr.org, pbs.org");
  // a lookup whose every sentence is a lending sentence fails, as the all-rates one does
  for (const answer of ["The FHA raised its loan limits.", "Student loan payments resume in May. Lenders expect more defaults."]) {
    assert.deepStrictEqual(await look(answer), UNAVAILABLE, answer);
  }
});

test("lookUpLive (residual R4): a rate sentence with no rate word (a 30-year, borrowing costs, the APR) is dropped; a score is kept", async () => {
  const look = (answer) =>
    lookUpLive({ kind: "news", query: "top news today" }, ctxWith(recordingLive({ answer, sources: [{ title: "Headline", domain: "npr.org" }] })));
  const KEPT = "The Chiefs lost 20-3 at Seattle.";
  for (const dropped of [
    "The average 30-year hit 6.1 percent.", "Borrowing costs rose again.", "The APR climbed.", "The thirty-year eased this week.",
    "A 15-year now averages 5.4 percent.", "Fifteen-year terms got cheaper.", "The average apr fell.", "Borrowing cost hit a high.",
  ]) {
    assert.equal((await look(`${KEPT} ${dropped}`)).data.answer, KEPT, dropped);
  }
  assert.deepStrictEqual(await look("The average 30-year hit 6.1 percent. Borrowing costs rose again."), {
    data: { error: "the lookup didn't work just now" }, source: "(unavailable)",
  });
  assert.equal((await look(KEPT)).data.answer, KEPT);
});

test("TOOL_SCHEMA: lookUpLive takes kind, query and place, for the outside world only — never clients, rates or guidelines", () => {
  const t = TOOL_SCHEMA.find((x) => x.name === "lookUpLive");
  assert.ok(t, "lookUpLive is described");
  assert.equal(typeof tools.lookUpLive, "function");
  assert.deepStrictEqual(t.input_schema.properties.kind.enum, ["scores", "news", "weather", "general"]);
  assert.equal(t.input_schema.properties.query.type, "string");
  assert.equal(t.input_schema.properties.place.type, "string");
  assert.deepStrictEqual(t.input_schema.required, ["kind", "query"]);
  for (const word of [/outside world/i, /never/i, /client/i, /rates/i, /guideline/i, /place/i]) assert.match(t.description, word);
});

// ── live.js: the search ────────────────────────────────────────────────────────────────────────────────────────────────────────

// `script[i]` answers the (i+1)th messages.create(params, options) call: a response, a function of (params, options), or an Error
// to throw. `calls` keeps every request with its options.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params, options) => {
        calls.push({ params: JSON.parse(JSON.stringify(params)), options });
        const next = script[calls.length - 1];
        if (next === undefined) throw new Error("fake client: script exhausted at call " + calls.length);
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(params, options) : next;
      },
    },
  };
}
// A web-search answer as the API shapes it: the search call, its results, then the answer in text blocks (split where it cites).
const searched = ({
  results = [["https://www.espn.com/nfl/game/_/gameId/1", "Giants 20-27 Cowboys (Oct 26, 2026) Final Score - ESPN"]],
  text = ["The Cowboys beat the Giants ", "27 to 20", " last night.\n\nAs of: Sunday night, October 26"],
  stop_reason = "end_turn",
  usage = { input_tokens: 2400, output_tokens: 60, server_tool_use: { web_search_requests: 1 } },
  lead = [],
} = {}) => ({
  id: "msg_live", type: "message", role: "assistant", model: LIVE_MODEL, stop_reason, usage,
  content: [
    ...lead,
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "cowboys giants score" } },
    {
      type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
      content: Array.isArray(results)
        ? results.map(([url, title]) => ({ type: "web_search_result", url, title, encrypted_content: "e", page_age: "1 day ago" }))
        : results,
    },
    ...text.map((t) => ({ type: "text", text: t })),
  ],
});
const liveRows = (userId) => db.prepare(
  "SELECT kind, turn_id, input_tokens, output_tokens FROM assistant_usage WHERE user_id = ? ORDER BY id"
).all(userId);

test.beforeEach(() => {
  db.prepare("DELETE FROM assistant_usage").run();
});

test("makeLive: the request is Haiku with the web search tool (3 uses), thinking off, no tool_choice, today's date and the place", async () => {
  const client = fakeClient([searched()]);
  const now = Date.UTC(2026, 9, 28, 15, 0, 0);
  const out = await capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "turn-1", now })
    .lookUp({ kind: "weather", query: "rain this afternoon?", place: "Austin, TX" }));
  assert.ok(out.answer);
  assert.equal(client.calls.length, 1);
  const { params, options } = client.calls[0];
  assert.equal(params.model, "claude-haiku-5-5");
  assert.equal(LIVE_MODEL, "claude-haiku-5-5");
  assert.equal(SEARCH_TOOL_TYPE, "web_search_20250305");
  assert.deepStrictEqual(params.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
  assert.deepStrictEqual(params.thinking, { type: "disabled" });
  for (const key of ["tool_choice", "temperature", "top_p", "top_k", "system"]) assert.ok(!(key in params), key);
  assert.ok(Number.isInteger(params.max_tokens) && params.max_tokens > 0);
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, "user");
  const prompt = params.messages[0].content;
  assert.equal(typeof prompt, "string");
  assert.match(prompt, /Wednesday, October 28, 2026/);
  assert.ok(prompt.includes("rain this afternoon?"));
  assert.ok(prompt.includes("Austin, TX"));
  assert.match(prompt, /two short sentences/);
  assert.match(prompt, /never from memory/);
  assert.match(prompt, /neutral/);
  assert.ok(options && options.signal && typeof options.signal.aborted === "boolean", "the request can be aborted");
});

test("makeLive (final review M-6): with the user's local date the prompt says that day; with none, or a bad one, today's UTC date", async () => {
  // 03:30 UTC on Thursday the 29th: still Wednesday the 28th on the US west coast
  const now = Date.UTC(2026, 9, 29, 3, 30, 0);
  const promptFor = async (localDate) => {
    const client = fakeClient([searched()]);
    await capturingInfo(() => makeLive({ client, db, userId: broker, now, localDate }).lookUp({ kind: "scores", query: "Cowboys last night" }));
    return client.calls[0].params.messages[0].content;
  };
  let prompt = await promptFor("2026-10-28");
  const firstLine = (p) => p.split("\n")[0];
  assert.equal(firstLine(prompt), "Today is Wednesday, October 28, 2026 (the user's local date).");
  assert.doesNotMatch(prompt, /UTC/);
  // a day ahead of UTC (Auckland) is a local date too
  assert.equal(firstLine(await promptFor("2026-10-30")), "Today is Friday, October 30, 2026 (the user's local date).");
  // no local date, a malformed or impossible one, or one more than a day from the UTC date: the UTC line
  for (const bad of [undefined, null, "", "yesterday", "2026-10-29T00:00", "2026-1-29", "2026-02-30", "2026-13-01", 20261029, "2026-10-27", "2026-10-31", "2025-10-29"]) {
    prompt = await promptFor(bad);
    assert.equal(firstLine(prompt), "Today is Thursday, October 29, 2026 (UTC).", JSON.stringify(bad));
  }
});

test("userLocalDate (final review M-6): a real YYYY-MM-DD within one day of the UTC date, else null", () => {
  const now = Date.UTC(2026, 9, 29, 3, 30, 0);
  for (const ok of ["2026-10-28", "2026-10-29", "2026-10-30"]) assert.equal(userLocalDate(ok, now), ok);
  for (const bad of [undefined, null, "", " 2026-10-29", "2026-10-29 ", "2026/10/29", "2026-02-30", "2026-00-10", "2026-10-00", "2026-10-27", "2026-10-31", {}, 7]) {
    assert.equal(userLocalDate(bad, now), null, JSON.stringify(bad));
  }
  // across a month and a year end
  assert.equal(userLocalDate("2026-12-31", Date.UTC(2027, 0, 1, 2, 0)), "2026-12-31");
  assert.equal(userLocalDate("2027-01-01", Date.UTC(2026, 11, 31, 20, 0)), "2027-01-01");
});

test("makeLive (polish P1): news, scores and general lookups search only the outlets that let the search in; weather is unrestricted", async () => {
  // Q1: AP, Reuters and BBC block Anthropic's crawler, and the API rejects a whole request that names a blocked domain.
  const NEWS = ["npr.org", "pbs.org", "cbsnews.com", "abcnews.go.com", "nbcnews.com", "upi.com"];
  const CASES = [
    ["news", NEWS],
    ["general", NEWS],
    ["scores", ["espn.com", "cbssports.com"]],
    ["weather", undefined],
    ["nonsense", NEWS], // an unknown kind falls back to general, as KIND_WORDS does
  ];
  for (const [kind, domains] of CASES) {
    const client = fakeClient([searched()]);
    const args = kind === "weather" ? { kind, query: "rain this afternoon?", place: "Denver" } : { kind, query: "anything" };
    await capturingInfo(() => makeLive({ client, db, userId: broker }).lookUp(args));
    const [tool] = client.calls[0].params.tools;
    assert.equal(client.calls[0].params.tools.length, 1, kind);
    if (domains) assert.deepStrictEqual(tool.allowed_domains, domains, kind);
    else assert.ok(!("allowed_domains" in tool), kind);
    assert.equal(tool.type, "web_search_20250305", kind);
    assert.equal(tool.max_uses, 3, kind);
  }
});

// The error the SDK throws for a 400, shaped as it is: `status`, the parsed body at `error`, and "400 " + the body as the message.
function apiError(status, message) {
  const body = { type: "error", error: { type: "invalid_request_error", message } };
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status, error: body });
}
// The API's message for a request whose allowed_domains names sites that block the crawler (verbatim, domains filled in).
const blockedMessage = (...names) => `The following domains are not accessible to our user agent: [${names.map((n) => `'${n}'`).join(", ")}]. ` +
  "Read more: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";
const blocked = (...names) => apiError(400, blockedMessage(...names));
const NEWS_LIST = ["npr.org", "pbs.org", "cbsnews.com", "abcnews.go.com", "nbcnews.com", "upi.com"];
const SCORES_LIST = ["espn.com", "cbssports.com"];

// console.error silenced and captured for the duration of fn (a retry logs the sites it dropped); fn's result is returned
async function capturingError(fn) {
  const logged = [];
  const saved = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try { return await fn(logged); } finally { console.error = saved; }
}

test("makeLive (Q1): a request that names blocked sites is sent once more without them, in order, and answers", async () => {
  const client = fakeClient([blocked("npr.org", "upi.com"), searched()]);
  const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "retry-1" })
    .lookUp({ kind: "news", query: "headlines" })));
  assert.ok(out.answer, "the lookup answers");
  assert.equal(out.code, undefined);
  assert.equal(client.calls.length, 2);
  assert.deepStrictEqual(client.calls[0].params.tools[0].allowed_domains, NEWS_LIST);
  assert.deepStrictEqual(client.calls[1].params.tools[0].allowed_domains, ["pbs.org", "cbsnews.com", "abcnews.go.com", "nbcnews.com"]);
  // the retry is the same request otherwise, under the same abort signal (the one time budget covers both)
  const { allowed_domains: _a, ...first } = client.calls[0].params.tools[0];
  const { allowed_domains: _b, ...second } = client.calls[1].params.tools[0];
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual({ ...client.calls[1].params, tools: null }, { ...client.calls[0].params, tools: null });
  assert.equal(client.calls[1].options.signal, client.calls[0].options.signal);
  // one usage row, with the tokens of the response that came back
  assert.deepStrictEqual(liveRows(broker), [{ kind: "live", turn_id: "retry-1", input_tokens: 2400, output_tokens: 60 }]);
  // the same for scores
  const scores = fakeClient([blocked("cbssports.com"), searched()]);
  await capturingError(() => capturingInfo(() => makeLive({ client: scores, db, userId: broker }).lookUp({ kind: "scores", query: "Cowboys" })));
  assert.deepStrictEqual(scores.calls.map((c) => c.params.tools[0].allowed_domains), [SCORES_LIST, ["espn.com"]]);
});

test("makeLive (Q1): a site is dropped by its whole name only — news.com leaves cbsnews.com, go.com leaves abcnews.go.com, the link drops nothing", async () => {
  for (const names of [["news.com"], ["go.com"], ["www.npr.org"], ["anthropic.com", "support.anthropic.com"]]) {
    const client = fakeClient([blocked(...names), searched()]);
    const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker }).lookUp({ kind: "news", query: "headlines" })));
    assert.deepStrictEqual(out, { code: "failed" }, names.join());
    assert.equal(client.calls.length, 1, names.join());
  }
  // and a whole name next to look-alikes is the one dropped
  const client = fakeClient([blocked("news.com", "abcnews.go.com", "go.com"), searched()]);
  await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker }).lookUp({ kind: "news", query: "headlines" })));
  assert.deepStrictEqual(client.calls[1].params.tools[0].allowed_domains, ["npr.org", "pbs.org", "cbsnews.com", "nbcnews.com", "upi.com"]);
});

test("makeLive (Q1): no retry when the message names none of ours, or all of them — never a request with no allowed_domains", async () => {
  const CASES = [
    ["news", NEWS_LIST, blocked(...NEWS_LIST)],
    ["general", NEWS_LIST, blocked(...NEWS_LIST)],
    ["scores", SCORES_LIST, blocked(...SCORES_LIST)],
    ["news", NEWS_LIST, blocked("apnews.com")],
    ["news", NEWS_LIST, blocked("apnews.com", "bbc.com")],
    ["scores", SCORES_LIST, blocked("apnews.com")],
    ["news", NEWS_LIST, blocked()],
  ];
  for (const [kind, list, err] of CASES) {
    const client = fakeClient([err, searched()]);
    const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "no-retry" }).lookUp({ kind, query: "anything" })));
    assert.deepStrictEqual(out, { code: "failed" }, err.error.error.message);
    assert.equal(client.calls.length, 1, err.error.error.message);
    assert.deepStrictEqual(client.calls[0].params.tools[0].allowed_domains, list);
  }
  // one usage row each, with no tokens
  assert.deepStrictEqual(liveRows(broker), CASES.map(() => ({ kind: "live", turn_id: "no-retry", input_tokens: 0, output_tokens: 0 })));
});

test("makeLive (Q1): weather has no allowed_domains and never retries", async () => {
  const client = fakeClient([blocked("npr.org"), searched()]);
  const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker }).lookUp({ kind: "weather", query: "rain?", place: "Denver" })));
  assert.deepStrictEqual(out, { code: "failed" });
  assert.equal(client.calls.length, 1);
});

test("makeLive (Q1): another 400, a 500, or any other error is not retried", async () => {
  const CASES = {
    otherBadRequest: apiError(400, "max_uses must be a positive integer"),
    otherBadRequestMentioningSites: apiError(400, "allowed_domains: 'npr.org' is not a valid domain"),
    serverError: apiError(500, blockedMessage("npr.org")),    // the right words on the wrong status
    overloaded: apiError(529, "Overloaded"),
    plain: new Error("overloaded"),
    aborted: Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" }),
  };
  await capturingError(() => capturingInfo(async () => {
    for (const [name, err] of Object.entries(CASES)) {
      const client = fakeClient([err, searched()]);
      const out = await makeLive({ client, db, userId: broker, turnId: name }).lookUp({ kind: "news", query: "headlines" });
      assert.deepStrictEqual(out, { code: "failed" }, name);
      assert.equal(client.calls.length, 1, name);
    }
  }));
  assert.equal(liveRows(broker).length, Object.keys(CASES).length);
});

test("makeLive (Q1): the retry is the last try — a second blocked-site error fails after exactly two requests, with one usage row", async () => {
  // the second error even names more of our sites: still no third request
  const client = fakeClient([blocked("npr.org"), blocked("pbs.org", "upi.com"), searched()]);
  const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "twice" }).lookUp({ kind: "news", query: "headlines" })));
  assert.deepStrictEqual(out, { code: "failed" });
  assert.equal(client.calls.length, 2);
  assert.deepStrictEqual(liveRows(broker), [{ kind: "live", turn_id: "twice", input_tokens: 0, output_tokens: 0 }]);
  // a retry that comes back unfinished is failed the ordinary way, with its tokens metered
  const cut = fakeClient([blocked("npr.org"), searched({ stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 5 } })]);
  const out2 = await capturingError(() => capturingInfo(() => makeLive({ client: cut, db, userId: broker, turnId: "cut" }).lookUp({ kind: "news", query: "headlines" })));
  assert.deepStrictEqual(out2, { code: "failed" });
  assert.equal(cut.calls.length, 2);
  assert.deepStrictEqual(liveRows(broker).slice(-1), [{ kind: "live", turn_id: "cut", input_tokens: 10, output_tokens: 5 }]);
});

test("makeLive (Q1): both requests run under the one time budget — a retry that hangs is aborted and failed", async () => {
  let signal;
  const calls = [];
  const client = {
    calls,
    messages: {
      create: (params, options) => {
        calls.push(params);
        if (calls.length === 1) return Promise.reject(blocked("npr.org"));
        signal = options.signal;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    },
  };
  const started = Date.now();
  const out = await capturingError(() => capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "slow-retry", timeoutMs: 40 })
    .lookUp({ kind: "news", query: "headlines" })));
  assert.deepStrictEqual(out, { code: "failed" });
  assert.equal(calls.length, 2);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 2000);
  assert.deepStrictEqual(liveRows(broker), [{ kind: "live", turn_id: "slow-retry", input_tokens: 0, output_tokens: 0 }]);
});

test("makeLive (Q1): the retry logs the dropped sites — not the query, not an answer", async () => {
  const client = fakeClient([blocked("npr.org", "upi.com"), searched({ text: ["Parsnips fell sharply in Tulsa.\n\nAs of: today"] })]);
  let errors = [];
  let infos = [];
  await capturingError((loggedErrors) => capturingInfo(async (loggedInfo) => {
    await makeLive({ client, db, userId: broker }).lookUp({ kind: "news", query: "zebra crossing incident" });
    errors = [...loggedErrors];
    infos = [...loggedInfo];
  }));
  assert.deepStrictEqual(errors, ["charlie live: search blocked by npr.org, upi.com"]);
  assert.equal(infos.length, 1);
  for (const line of [...errors, ...infos]) assert.ok(!/zebra|crossing|parsnips|tulsa/i.test(line), line);
  // no retry, no line
  const quiet = fakeClient([searched()]);
  const none = await capturingError(async (logged) => {
    await capturingInfo(() => makeLive({ client: quiet, db, userId: broker }).lookUp({ kind: "news", query: "headlines" }));
    return logged;
  });
  assert.deepStrictEqual(none, []);
});

test("makeLive (polish P2, Q2): only the weather prompt asks for Fahrenheit only, from a source that reports it, with no Celsius-only readings", async () => {
  const FAHRENHEIT = "Give temperatures in degrees Fahrenheit only, from a source that reports Fahrenheit; leave out any reading given only in Celsius, and never convert units yourself.";
  const OLD = "Give temperatures in degrees Fahrenheit, from a source that reports Fahrenheit; never convert units yourself.";
  for (const kind of ["weather", "news", "scores", "general"]) {
    const client = fakeClient([searched()]);
    await capturingInfo(() => makeLive({ client, db, userId: broker }).lookUp({ kind, query: "anything", place: "Denver" }));
    const prompt = client.calls[0].params.messages[0].content;
    assert.equal(prompt.includes(FAHRENHEIT), kind === "weather", kind);
    assert.ok(!prompt.includes(OLD), `the old sentence is gone (${kind})`);
    if (kind === "weather") {
      // right after the answer-only-from-searches line, before the as-of line
      const lines = prompt.split("\n");
      const at = lines.indexOf(FAHRENHEIT);
      assert.match(lines[at - 1], /^Answer only from what your searches found/);
      assert.match(lines[at + 1], /^Then, on a last line of its own, write "As of: "/);
    }
  }
});

test("makeLive: the answer is the text after the search, the as-of line apart; sources are the results' unique domains", async () => {
  const client = fakeClient([searched({
    results: [
      ["https://www.espn.com/nfl/game/_/gameId/1", "Giants 20-27 Cowboys - ESPN"],
      ["https://www.nfl.com/games/giants-at-cowboys", "Giants at Cowboys | NFL"],
      ["https://espn.com/nfl/recap", "Recap - ESPN"],
      ["not a url", "Broken"],
    ],
    // a sentence the model wrote before it searched is not the answer
    lead: [{ type: "text", text: "Let me look that up." }],
  })]);
  const out = await capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "turn-1" }).lookUp({ kind: "scores", query: "Cowboys" }));
  assert.deepStrictEqual(out, {
    answer: "The Cowboys beat the Giants 27 to 20 last night.",
    asOf: "Sunday night, October 26",
    sources: [{ title: "Giants 20-27 Cowboys - ESPN", domain: "espn.com" }, { title: "Giants at Cowboys | NFL", domain: "nfl.com" }],
  });
  // no as-of line: no asOf
  const plain = fakeClient([searched({ text: ["The Cowboys beat the Giants 27 to 20 last night."] })]);
  const out2 = await capturingInfo(() => makeLive({ client: plain, db, userId: broker }).lookUp({ kind: "scores", query: "Cowboys" }));
  assert.deepStrictEqual(out2, {
    answer: "The Cowboys beat the Giants 27 to 20 last night.",
    sources: [{ title: "Giants 20-27 Cowboys (Oct 26, 2026) Final Score - ESPN", domain: "espn.com" }],
  });
});

test("makeLive: each lookup is one 'live' usage row with its tokens and the turn's id; the turn and org totals still add up", async () => {
  const client = fakeClient([searched(), searched({ usage: { input_tokens: 3100, output_tokens: 75 } })]);
  const live = makeLive({ client, db, userId: broker, turnId: "turn-9" });
  await capturingInfo(async () => {
    await live.lookUp({ kind: "scores", query: "Cowboys" });
    await live.lookUp({ kind: "news", query: "headlines" });
  });
  assert.deepStrictEqual(liveRows(broker), [
    { kind: "live", turn_id: "turn-9", input_tokens: 2400, output_tokens: 60 },
    { kind: "live", turn_id: "turn-9", input_tokens: 3100, output_tokens: 75 },
  ]);
  // a 'live' row is not a turn, but its tokens are in the org's totals
  recordUsage({ userId: broker, kind: "turn", turnId: "turn-9", inputTokens: 500, outputTokens: 50 });
  const o = getOrgUsage(orgA, 30);
  assert.equal(o.turns, 1);
  assert.equal(o.inputTokens, 6000);
  assert.equal(o.outputTokens, 185);
  // and recordUsage keeps the kind
  recordUsage({ userId: other, kind: "live" });
  assert.equal(liveRows(other)[0].kind, "live");
});

test("makeLive: 50 'live' rows today and the lookup is the cap, with no API call; other rows don't count", async () => {
  assert.equal(DAILY_LOOKUPS, 50);
  // 49 today, plus rows that are not this user's live lookups today
  for (let i = 0; i < 49; i++) recordUsage({ userId: broker, kind: "live", turnId: "t" });
  for (const kind of ["turn", "tts", "stt"]) recordUsage({ userId: broker, kind, turnId: "t" });
  recordUsage({ userId: other, kind: "live", turnId: "t" });
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO assistant_usage (user_id, kind, created_at) VALUES (?, 'live', datetime('now', '-1 day'))").run(broker);
  }
  let client = fakeClient([searched()]);
  await capturingInfo(async (logged) => {
    const out = await makeLive({ client, db, userId: broker, turnId: "t" }).lookUp({ kind: "scores", query: "Cowboys" });
    assert.ok(out.answer, "the 50th lookup runs");
    assert.equal(client.calls.length, 1);
    // that was the 50th: the next is the cap, with no call and no new row
    client = fakeClient([searched()]);
    const before = liveRows(broker).length;
    const capped = await makeLive({ client, db, userId: broker, turnId: "t" }).lookUp({ kind: "scores", query: "Cowboys" });
    assert.deepStrictEqual(capped, { code: "cap" });
    assert.equal(client.calls.length, 0);
    assert.equal(liveRows(broker).length, before);
    assert.deepStrictEqual(logged.map((l) => l.replace(/\d+ms$/, "Nms")), ["charlie live: scores ok Nms", "charlie live: scores cap Nms"]);
  });
});

test("makeLive: a search that outruns its time is aborted and failed, and still metered", async () => {
  let signal;
  const hangs = {
    calls: [],
    messages: {
      create: (params, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    },
  };
  const ignores = { messages: { create: () => new Promise(() => {}) } };   // a client that ignores the signal cannot hold it either
  for (const client of [hangs, ignores]) {
    const started = Date.now();
    const out = await capturingInfo(() => makeLive({ client, db, userId: broker, turnId: "slow", timeoutMs: 40 }).lookUp({ kind: "news", query: "headlines" }));
    assert.deepStrictEqual(out, { code: "failed" });
    assert.ok(Date.now() - started < 2000);
  }
  assert.equal(signal.aborted, true);
  assert.deepStrictEqual(liveRows(broker), [
    { kind: "live", turn_id: "slow", input_tokens: 0, output_tokens: 0 },
    { kind: "live", turn_id: "slow", input_tokens: 0, output_tokens: 0 },
  ]);
});

test("makeLive: a refusal, a paused or cut-off answer, an error, no results or no text is failed — and logged without the query", async () => {
  const CASES = {
    refusal: searched({ stop_reason: "refusal" }),
    paused: searched({ stop_reason: "pause_turn" }),
    cutOff: searched({ stop_reason: "max_tokens" }),
    throws: new Error("overloaded"),
    searchError: searched({ results: { type: "web_search_tool_result_error", error_code: "unavailable" } }),
    noResults: searched({ results: [] }),
    noText: searched({ text: [] }),
    onlyAsOf: searched({ text: ["As of: today"] }),
    garbage: "nonsense",
  };
  await capturingInfo(async (logged) => {
    for (const [name, response] of Object.entries(CASES)) {
      const client = fakeClient([response]);
      const out = await makeLive({ client, db, userId: broker, turnId: name }).lookUp({ kind: "news", query: "secret words in the query" });
      assert.deepStrictEqual(out, { code: "failed" }, name);
      assert.equal(client.calls.length, 1, name);
    }
    assert.equal(logged.length, Object.keys(CASES).length);
    for (const line of logged) assert.match(line, /^charlie live: news failed \d+ms$/);
  });
  // every call that went out is metered (the error with no tokens)
  assert.equal(liveRows(broker).length, Object.keys(CASES).length);
});

// ── Residual R1: client-name matching costs milliseconds, and answers exactly as before ────────────────────────────────────────

// The matchers as they were at 72464ae, kept verbatim as the reference: a regex per term per client on every call.
const REF = (() => {
  const NAME_WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*/gu;
  const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const plainText = (s) =>
    String(s).normalize("NFKD").replace(/\p{M}/gu, "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wholeWordIn = (text, term) =>
    new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{M}\\p{N}])`, "iu").test(text);
  function screenedNames(name) {
    const full = plainText(name);
    if (!full) return [];
    const words = full.match(NAME_WORD_RE) || [];
    while (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop();
    const surnames = [];
    if (words.length > 0) surnames.push(words[words.length - 1]);
    const comma = full.indexOf(",");
    const surnameFirst = comma > 0 ? full.slice(0, comma).match(NAME_WORD_RE) || [] : [];
    if (surnameFirst.length > 0) surnames.push(surnameFirst[surnameFirst.length - 1]);
    return [full, ...surnames.flatMap((s) => (s.includes("-") ? [s, ...s.split("-")] : [s]))];
  }
  const namesClient = (text, ctx) => {
    const { user, db } = ctx || {};
    if (!user || !db) throw new Error("assistant tool ctx requires { user, db }");
    const t = plainText(text);
    return db.prepare("SELECT name FROM clients WHERE org_id = ?").all(user.org_id)
      .some((row) => screenedNames(row.name || "").some((term) => wholeWordIn(t, term)));
  };
  const NAME_JOINERS = new Set(["and", "or", "the", "of"]);
  const mentionsClient = (text, ctx) => {
    const { user, db } = ctx || {};
    if (!user || !db) throw new Error("assistant tool ctx requires { user, db }");
    const t = plainText(text);
    return db.prepare("SELECT name FROM clients WHERE org_id = ?").all(user.org_id).some((row) => {
      const name = row.name || "";
      const words = (plainText(name).match(NAME_WORD_RE) || []).filter((w) => {
        const lower = w.toLowerCase();
        return w.length > 1 && /\p{L}/u.test(w) && !NAME_SUFFIXES.has(lower) && !NAME_JOINERS.has(lower);
      });
      return [...screenedNames(name), ...words].some((term) => wholeWordIn(t, term));
    });
  };
  return { namesClient, mentionsClient };
})();

// A small seeded generator, so the generated texts are the same on every run.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Names with the hard cases: accents composed and decomposed, curly and straight apostrophes, hyphens, surname-first filing,
// suffixes, a number for a surname, a joining word, an ampersand, other scripts with their own case rules, and a name with no word.
const R1_NAMES = [
  "Grace Okafor", "Okafor, Grace", "Sofía Martínez".normalize("NFC"), "José Núñez".normalize("NFD"), "Lin Wu-Okonkwo",
  "Daniel Reyes Jr.", "John Smith III", "Client 01", "Tom and Ellie Brandt", "Robert & Linda Chen", "Siobhán O’Brien",
  "D'Angelo Price", "Mary-Kate Olsen", "An Nguyen", "Cher", "Don Day", "Işık Yılmaz", "Ægir Þórsson", "ΟΔΥΣΣΕΑΣ Παπαδόπουλος",
  "Groß Straße", "李 小龙", "Jean-Luc O'Neil-Ward", "Q", "Ana-María de la Cruz", "&&", "Brown, Robert Sr.",
];
// The words texts are made of: each name word in several spellings, possessives, plurals, joins, contractions, other words.
function r1Vocabulary() {
  const words = new Set(["the", "call", "today", "and", "of", "deal", "great", "Don't", "won't", "can't", "an", "day", "client",
    "1", "01", "Jr", "III", "&&", "&", "isik", "ISIK", "Işık", "strasse", "STRASSE", "groß", "GROSS", "οδυσσεας", "ΟΔΥΣΣΕΑΣ",
    "Οδυσσέας", "obrien", "O'Brien", "O’Brien’s", "o'brien-smith", "wu", "OKONKWO", "Wu-Okonkwo-Lee", "okafor's", "Okafors",
    "Mary-Kate's", "kate", "Jean-Luc", "luc-o'neil", "ward", "de", "la", "cruz", "Ana-Maria", "brandt's", "Chens", "chen's"]);
  for (const name of R1_NAMES) {
    for (const w of name.split(/[\s,]+/).filter(Boolean)) {
      const bare = w.normalize("NFKD").replace(/\p{M}/gu, "");
      for (const v of [w, w.toLowerCase(), w.toUpperCase(), bare, `${bare}'s`, `${w}’s`, `${w}s`, `${w}-${bare}`, w.normalize("NFD")]) {
        words.add(v);
      }
    }
  }
  return [...words];
}

test("Residual R1: namesClient and mentionsClient answer exactly as the regex reference does, over generated names and texts", async () => {
  const { namesClient, mentionsClient } = require("../lib/assistant/tools");
  const rand = seeded(20261029);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const vocabulary = r1Vocabulary();
  const glue = [" ", " ", " ", ", ", ". ", "! ", " — ", " (", ") ", "-", "'", " & ", "\n"];
  // four books: every name, and three random handfuls
  const books = [R1_NAMES];
  for (let i = 0; i < 3; i++) books.push(R1_NAMES.filter(() => rand() < 0.35));
  let compared = 0;
  const seen = { names: new Set(), mentions: new Set() };
  for (const [b, names] of books.entries()) {
    const orgId = addOrg(`R1 book ${b}`);
    const userId = addUser(orgId, "broker", `r1-${b}@x.co`);
    for (const name of names) addClientRow(orgId, userId, name);
    const ctx = { user: { id: userId, role: "broker", org_id: orgId }, db };
    for (let i = 0; i < 300; i++) {
      let text = "";
      const n = 1 + Math.floor(rand() * 8);
      for (let j = 0; j < n; j++) text += (j ? pick(glue) : "") + pick(vocabulary);
      const want = { names: REF.namesClient(text, ctx), mentions: REF.mentionsClient(text, ctx) };
      assert.strictEqual(namesClient(text, ctx), want.names, `namesClient, book ${b}: ${JSON.stringify(text)}`);
      assert.strictEqual(mentionsClient(text, ctx), want.mentions, `mentionsClient, book ${b}: ${JSON.stringify(text)}`);
      seen.names.add(want.names);
      seen.mentions.add(want.mentions);
      compared += 1;
    }
    // each name, as it is filed, against itself and against every other spelling of it
    for (const name of R1_NAMES) {
      for (const text of [name, name.toUpperCase(), name.normalize("NFD"), name.normalize("NFKD").replace(/\p{M}/gu, ""), `Call ${name} today.`]) {
        assert.strictEqual(namesClient(text, ctx), REF.namesClient(text, ctx), `namesClient, book ${b}: ${JSON.stringify(text)}`);
        assert.strictEqual(mentionsClient(text, ctx), REF.mentionsClient(text, ctx), `mentionsClient, book ${b}: ${JSON.stringify(text)}`);
      }
    }
  }
  assert.ok(compared >= 1200, `${compared} texts compared`);
  // both answers came up for both functions, so the comparison is not one-sided
  assert.deepStrictEqual([seen.names.size, seen.mentions.size], [2, 2]);
});

test("Residual R1: with a 2,000-client org, 20 calls of each matcher take under 300 ms in total", async () => {
  const tools = require("../lib/assistant/tools");
  const orgId = addOrg("R1 big book");
  const userId = addUser(orgId, "broker", "r1-big@x.co");
  // 2,000 distinct alphabetic names, made of syllables
  const SYL = ["ka", "lo", "mi", "ne", "ru", "sa", "ti", "vo", "ze", "pa", "do", "fe", "gu", "hi", "ja", "be"];
  const word = (n, len) => {
    let w = "";
    for (let i = 0; i < len; i++) { w += SYL[n % SYL.length]; n = Math.floor(n / SYL.length); }
    return w[0].toUpperCase() + w.slice(1);
  };
  const insert = db.transaction(() => {
    for (let i = 0; i < 2000; i++) addClientRow(orgId, userId, `${word(i * 7 + 3, 3)} ${word(i, 4)}`);
  });
  insert();
  // one turn's ctx, as runTurn makes it: the names are read once, on the first call, and the forty calls share them
  const ctx = tools.withTurnClientNames({ user: { id: userId, role: "broker", org_id: orgId }, db });
  const texts = [
    "Ugh, what a day. Long day, huh? Grab a coffee.", "How's Grace doing these days?", `Call ${word(1234, 4)} first thing tomorrow.`,
    "I don't think the market cares much about my feelings today, honestly.",
  ];
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  for (let i = 0; i < 20; i++) {
    tools.mentionsClient(texts[i % texts.length], ctx);
    assert.ok(elapsed() < 300, `mentionsClient call ${i + 1}: ${elapsed()} ms so far`);
  }
  for (let i = 0; i < 20; i++) {
    tools.namesClient(texts[i % texts.length], ctx);
    assert.ok(elapsed() < 300, `namesClient call ${i + 1}: ${elapsed()} ms so far`);
  }
  // and they still find a name in a book this size
  assert.equal(tools.mentionsClient(texts[2], ctx), true);
  assert.equal(tools.namesClient(texts[2], ctx), true);
  assert.equal(tools.mentionsClient(texts[0], ctx), false);
});

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
const { makeLive, LIVE_MODEL, SEARCH_TOOL_TYPE, DAILY_LOOKUPS } = require("../lib/assistant/live");
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

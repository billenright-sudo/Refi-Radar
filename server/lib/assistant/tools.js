"use strict";
// Deterministic tools the Charli co-pilot calls to get facts, so the model never invents a
// number. Every tool is (args, ctx) -> { data, source, sideEffect? } with
// ctx = { user, rates, db } (user = the req.user row; rates = the flat current-rates object).
//
// Read tools query the CRM / the server sweep engine (lib/refi.js, the single math source).
// Side-effect tools (addClientTool, logContactTool, setCareerStageTool) only PACKAGE the intent in
// `sideEffect` and return a preview — they never write. The write happens later, behind a confirmation.
const refi = require("../refi");
const { getMovement } = require("../rateHistory");
const { CAREER_STAGES, stageById, stageForYears } = require("./coaching");
const { GLOSSARY, GLOSSARY_SOURCE, lookupTerm } = require("./glossary");

const todayUtc = () => new Date().toISOString().slice(0, 10);
const hasRates = (rates) => !!rates && Number.isFinite(rates.rate_30yr_fixed);
const ratesDate = (rates) => (typeof rates.date === "string" && rates.date ? rates.date : todayUtc());
// The rates endpoint falls back to hard-coded numbers ("Estimated — live fetch unavailable")
// when the live fetch fails. Those are never snapshotted and must never be treated as live.
const isEstimated = (rates) => /^estimated/i.test(String(rates.source || ""));

// A tool that cannot answer returns an error in `data` (never throws on bad input and never
// guesses), so the model can recover or tell the user. `source` is a parenthesised non-citation
// label like "(not found)" so an error can't be mistaken for a cited fact.
const fail = (source, error) => ({ data: { error }, source });

// Same scoping as routes/sweeps.js and routes/clients.js: a broker sees every client in its
// org; anyone else (a loan officer) sees only the clients assigned to them.
function scopedClients(ctx) {
  const { user, db } = ctx || {};
  if (!user || !db) throw new Error("assistant tool ctx requires { user, db }");
  return user.role === "broker"
    ? db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(user.org_id)
    : db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(user.id);
}

// Row -> the camelCase client shape of routes/clients.js, minus org/user ids and timestamps
// the model has no use for.
function toClient(row) {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, lastContact: row.last_contact,
  };
}

// ── Read tools ───────────────────────────────────────────────────────────────

// The rates and their moves as the model sees, speaks and cites them: every finite number to two decimals, in a NEW object
// (FRED publishes three, and "7.251" read aloud is noise). Rounding happens here, at the tool boundary, so the figure check
// matches "7.25" against 7.25 exactly; ctx.rates itself, which the sweep engine prices from, is never touched.
const twoDecimals = (obj) => (obj && typeof obj === "object"
  ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(2)) : v]))
  : obj);

function getMarketUpdate(_args, ctx) {
  const rates = ctx && ctx.rates;
  if (!hasRates(rates)) return fail("(unavailable)", "current rates are unavailable");
  const date = ratesDate(rates);
  // Never cite the hard-coded fallback as "live", and never diff it against the last live
  // snapshot (that would invent a day-over-day move): report it as estimated with no history.
  if (isEstimated(rates)) {
    return {
      data: { rates: twoDecimals(rates), deltas: null, hasHistory: false, estimated: true },
      source: `estimated rates ${date}`,
    };
  }
  const { current, deltas, hasHistory } = getMovement(rates);
  return { data: { rates: twoDecimals(current), deltas: twoDecimals(deltas), hasHistory }, source: `live rates ${date}` };
}

function runSweepTool(_args, ctx) {
  const rates = ctx && ctx.rates;
  if (!hasRates(rates)) return fail("(unavailable)", "current rates are unavailable");
  const result = refi.runSweep(scopedClients(ctx), rates);
  // Same sweep either way; when the inputs were the hard-coded fallback, say so in the result.
  if (isEstimated(rates)) {
    return { data: { ...result, estimated: true }, source: `sweep engine (estimated rates ${ratesDate(rates)})` };
  }
  return { data: result, source: "sweep engine" };
}

function findClient(args, ctx) {
  const query = String((args && args.query) == null ? "" : args.query).trim().toLowerCase();
  if (!query) return { data: { matches: [], error: "a client name to search for is required" }, source: "(invalid input)" };
  const matches = scopedClients(ctx)
    .filter((row) => String(row.name || "").toLowerCase().includes(query))
    .map(toClient);
  return { data: { matches }, source: "client record" };
}

// What a term means, from the fixed glossary (lib/assistant/glossary.js): the model reads the definition as given
// and never defines a term from memory. An unknown term is "(not found)", never a guess.
function explainTerm(args, _ctx) {
  const raw = args && typeof args === "object" && !Array.isArray(args) ? args.term : undefined;
  if (typeof raw !== "string" || !raw.trim()) return fail("(invalid input)", "a term to explain is required");
  const found = lookupTerm(raw);
  if (!found) return fail("(not found)", "that term is not in the glossary");
  return { data: { term: found.term, definition: found.definition }, source: GLOSSARY_SOURCE };
}

// ── Side-effect tools: package the intent, never write ───────────────────────

function addClientTool(fields, _ctx) {
  const f = fields || {};
  return {
    data: { preview: { ...f } },
    source: "(unsaved)",
    sideEffect: { type: "addClient", fields: { ...f } },
  };
}

function logContactTool(args, ctx) {
  const raw = args && args.clientId;
  // A string id must be plain digits: Number() would also accept "1e2", "0x10" and " 5 ".
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) return fail("(invalid input)", "a valid clientId is required");
  const row = scopedClients(ctx).find((r) => r.id === id);
  if (!row) return fail("(not found)", "no such client in your book");
  return {
    data: { client: toClient(row) },
    source: "client record",
    sideEffect: { type: "logContact", clientId: row.id },
  };
}

// A number of years as the model may pass it: a number, or a plain decimal string like logContactTool's digit-string
// id ("20", "2.5"; not "1e1", "0x10" or " 5 "). NaN for anything else.
const yearsOf = (raw) =>
  typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;

// Package the user's career stage for confirmation. The stage is either named (`stage`, one of the CAREER_STAGES
// ids) or derived by code from a number of years (`years`, mapped at fixed cut-offs: under 1 new, 1 to under 3
// developing, 3 to under 10 established, 10 or more veteran), never picked by the model. With both, they must
// agree. Like the other side-effect tools it never writes: /api/assistant/confirm does, after the user says yes.
function setCareerStageTool(args, _ctx) {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const invalid = () => fail("(invalid input)", "a career stage or a number of years from 0 to 70 is required");
  const named = a.stage !== undefined && a.stage !== null;
  const counted = a.years !== undefined && a.years !== null;
  if (!named && !counted) return invalid();
  const byName = named ? stageById(a.stage) : null;
  const byYears = counted ? stageForYears(yearsOf(a.years)) : null;
  if ((named && !byName) || (counted && !byYears)) return invalid();
  if (byName && byYears && byName.id !== byYears.id) return invalid();
  const { id, label } = byName || byYears;
  return { data: { stage: id, label }, source: "(unsaved)", sideEffect: { type: "setCareerStage", stage: id } };
}

// Null-prototype map: a model-supplied tool name like "constructor" or "toString" must not
// resolve to an inherited Object.prototype function.
const tools = Object.freeze(
  Object.assign(Object.create(null), {
    getMarketUpdate, runSweepTool, findClient, explainTerm, addClientTool, logContactTool, setCareerStageTool,
  })
);

// ── Anthropic tool definitions (names match the keys of `tools` exactly) ─────

const NO_ARGS = { type: "object", properties: {}, required: [] };

const TOOL_SCHEMA = [
  {
    name: "getMarketUpdate",
    description:
      "Today's mortgage rates (30-yr fixed, 15-yr fixed, 30-yr top-tier, 5/1 ARM) and how they moved " +
      "since the most recent prior-day snapshot. Use for any question about current rates or the market. " +
      "`deltas` is null when no prior day has been recorded yet: say there is no history, never guess a move. " +
      "Only report non-zero changes. The 5/1 ARM figure comes from a different source and may be an " +
      "estimate, so do not report its movement on its own.",
    input_schema: NO_ARGS,
  },
  {
    name: "runSweepTool",
    description:
      "Run the refinance opportunity sweep over the user's book of clients at today's rates: counts, " +
      "each client's ranked opportunities (rate & term, cash-out, ARM to fixed, term swap) with savings " +
      "figures, and clients due for a check-in. Use for 'who should I call' or 'what's in my pipeline'. " +
      "Read-only.",
    input_schema: NO_ARGS,
  },
  {
    name: "findClient",
    description:
      "Look up the user's clients by name (case-insensitive, partial match) and return every match with " +
      "their loan details and last contact. If more than one comes back, ask which one is meant; if none, " +
      "say so. Never guess. Use this first to get a client's id.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Part of the client's name, e.g. 'chen'." } },
      required: ["query"],
    },
  },
  {
    name: "explainTerm",
    description:
      "Look up what a mortgage or Broker Radar term means in Broker Radar's own glossary: " +
      GLOSSARY.map((e) => e.term).join(", ") + ". Use it whenever the user asks what a term means or a term " +
      "needs explaining, and read the definition as given; never define a term from memory. Definitions only: " +
      "it has no loan-guideline limits. A term it does not know comes back not found: say you can't verify it " +
      "and never define it yourself.",
    input_schema: {
      type: "object",
      properties: { term: { type: "string", description: "The term to explain, e.g. 'LTV' or 'cash-out refinance'." } },
      required: ["term"],
    },
  },
  {
    name: "addClientTool",
    description:
      "Prepare a NEW client record for the user to confirm. This does NOT save anything: it returns a " +
      "preview, and the client is only created after the user confirms. Ask for any missing required " +
      "field rather than guessing it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Client full name." },
        email: { type: "string" },
        phone: { type: "string" },
        loanType: { type: "string", enum: ["30yr_fixed", "15yr_fixed", "5_1_arm"] },
        currentRate: { type: "number", description: "Current interest rate in percent, e.g. 7.25." },
        loanBalance: { type: "number", description: "Current loan balance in dollars." },
        propertyValue: { type: "number", description: "Property value in dollars." },
        closeDate: { type: "string", description: "Original close date, YYYY-MM-DD." },
        creditScore: { type: "integer", description: "FICO score, 300 to 850." },
        notes: { type: "string" },
      },
      required: ["name", "loanType", "currentRate", "loanBalance", "propertyValue"],
    },
  },
  {
    name: "logContactTool",
    description:
      "Prepare to log that the user just contacted an existing client (sets their last contact to now). " +
      "This does NOT save anything: the user must confirm first. Get the clientId from findClient; never " +
      "guess it.",
    input_schema: {
      type: "object",
      properties: { clientId: { type: "integer", description: "The id of the client, from findClient." } },
      required: ["clientId"],
    },
  },
  {
    name: "setCareerStageTool",
    description:
      "Prepare to record the user's career stage, which only tailors how you coach them. This does NOT save " +
      "anything: the user must confirm first. When the user says how many years they have been originating, pass " +
      "`years` as that number exactly as they said it; the stage is chosen for you, so never map it yourself and " +
      "never work years out from a date. Pass `stage` only when the user names a stage or asks to switch to one. " +
      "Never guess either.",
    input_schema: {
      type: "object",
      properties: {
        years: { type: "number", description: "Years the user has been originating, as they said it, 0 to 70." },
        stage: { type: "string", enum: CAREER_STAGES.map((s) => s.id), description: "A career stage the user named." },
      },
      required: [],
    },
  },
];

module.exports = {
  tools, TOOL_SCHEMA, getMarketUpdate, runSweepTool, findClient, explainTerm, addClientTool, logContactTool, setCareerStageTool,
};

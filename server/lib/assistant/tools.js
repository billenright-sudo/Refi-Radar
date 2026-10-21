"use strict";
// Deterministic tools the Charli co-pilot calls to get facts, so the model never invents a
// number. Every tool is (args, ctx) -> { data, source, sideEffect? } with
// ctx = { user, rates, db } (user = the req.user row; rates = the flat current-rates object).
//
// Read tools query the CRM / the server sweep engine (lib/refi.js, the single math source).
// Side-effect tools (addClientTool, logContactTool) only PACKAGE the intent in `sideEffect`
// and return a preview — they never write. The write happens later, behind a confirmation.
const refi = require("../refi");
const { getMovement } = require("../rateHistory");

const todayUtc = () => new Date().toISOString().slice(0, 10);
const hasRates = (rates) => !!rates && Number.isFinite(rates.rate_30yr_fixed);

// A tool that cannot answer returns an error in `data` (never throws on bad input and never
// guesses), so the model can recover or tell the user.
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

function getMarketUpdate(_args, ctx) {
  const rates = ctx && ctx.rates;
  if (!hasRates(rates)) return fail("live rates (unavailable)", "current rates are unavailable");
  const { current, deltas, hasHistory } = getMovement(rates);
  const date = typeof rates.date === "string" && rates.date ? rates.date : todayUtc();
  // The rates endpoint falls back to hard-coded numbers when the live fetch fails; never
  // cite those as "live".
  const estimated = /^estimated/i.test(String(rates.source || ""));
  return {
    data: { rates: current, deltas, hasHistory },
    source: `${estimated ? "estimated" : "live"} rates ${date}`,
  };
}

function runSweepTool(_args, ctx) {
  const rates = ctx && ctx.rates;
  if (!hasRates(rates)) return fail("sweep engine", "current rates are unavailable");
  return { data: refi.runSweep(scopedClients(ctx), rates), source: "sweep engine" };
}

function findClient(args, ctx) {
  const query = String((args && args.query) == null ? "" : args.query).trim().toLowerCase();
  if (!query) return { data: { matches: [], error: "a client name to search for is required" }, source: "client record" };
  const matches = scopedClients(ctx)
    .filter((row) => String(row.name || "").toLowerCase().includes(query))
    .map(toClient);
  return { data: { matches }, source: "client record" };
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
  const id = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) return fail("client record", "a valid clientId is required");
  const row = scopedClients(ctx).find((r) => r.id === id);
  if (!row) return fail("client record", "no such client in your book");
  return {
    data: { client: toClient(row) },
    source: "client record",
    sideEffect: { type: "logContact", clientId: row.id },
  };
}

const tools = Object.freeze({ getMarketUpdate, runSweepTool, findClient, addClientTool, logContactTool });

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
];

module.exports = { tools, TOOL_SCHEMA, getMarketUpdate, runSweepTool, findClient, addClientTool, logContactTool };

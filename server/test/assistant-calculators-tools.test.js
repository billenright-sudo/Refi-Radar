"use strict";
// Charlie's four calculator tools (server/lib/assistant/tools.js) and their code-written lines (server/lib/assistant/calcLines.js),
// against a throwaway DB. Every figure comes from server/lib/calculators.js; every sentence is written by code.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-calcs-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { recordSnapshot } = require("../lib/rateHistory");
const tools = require("../lib/assistant/tools");
const calcLines = require("../lib/assistant/calcLines");
const calc = require("../lib/calculators");

const LIVE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-11-24", source: "Optimal Blue lock data (2026-11-24)" };

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Calc Org')").run().lastInsertRowid);
const addUser = (role, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)"
).run(orgId, role, email).lastInsertRowid);
const lo1 = addUser("lo", "lo1@calc.co");
const lo2 = addUser("lo", "lo2@calc.co");
function addClient(userId, f) {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, credit_score,
      credit_score_known, close_date, balance_as_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, f.name, f.email || null, f.phone || null, f.loanType, f.rate, f.balance, f.value, f.score, f.scoreKnown,
    f.closeDate || null, f.balanceAsOf || null).lastInsertRowid);
}
const okaforId = addClient(lo1, {
  name: "Grace Okafor", email: "grace@example.test", phone: "555-0199", loanType: "30yr_fixed", rate: 7.25, balance: 350000,
  value: 700000, score: 742, scoreKnown: 1, closeDate: "2024-03-15", balanceAsOf: "2026-11-25",
});
const armClientId = addClient(lo1, {
  name: "Arlo Armstrong", loanType: "5_1_arm", rate: 6.9, balance: 300000, value: 500000, score: 720, scoreKnown: 1,
  closeDate: "2022-06-10", balanceAsOf: "2026-11-25",
});
const defaultScoreId = addClient(lo1, {
  name: "Dee Fault", loanType: "30yr_fixed", rate: 6.75, balance: 250000, value: 400000, score: 700, scoreKnown: 0,
  closeDate: "2023-01-20", balanceAsOf: "2026-11-25",
});
recordSnapshot(LIVE, "2026-11-24", "fred");

const NOW = Date.parse("2026-11-25T12:00:00Z");
const ctxOf = (id, now = NOW) => ({ user: { id, role: "lo", org_id: orgId }, rates: LIVE, db, now });
const ctxLo1 = ctxOf(lo1);
const ctxLo2 = ctxOf(lo2);
const ctxLater = ctxOf(lo1, NOW + 20 * 86400000);   // the snapshot is too old by then

test("payment: nothing else said", () => {
  const r = tools.paymentCalcTool({ loanAmount: 400000, rate: 6.5 }, ctxLo1);
  assert.equal(r.say, "On $400,000 at 6.5% over 30 years, principal and interest is $2,528.27 a month, before taxes, insurance and any HOA.");
  assert.equal(r.source, "calculator"); assert.deepEqual(r.data.result, calc.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: null,
    taxesYearly: null, insuranceYearly: null, miMonthly: null, hoaMonthly: null, homeValue: null, creditScore: null }));
});
test("payment with extras and not-entered", () => {
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, rate: 6.5, taxesYearly: 4800 }, ctxLo1).say,
    "On $400,000 at 6.5% over 30 years, the payment is $2,928.27 a month: $2,528.27 principal and interest, $400.00 taxes. " +
    "Insurance, mortgage insurance and HOA not entered.");
  assert.equal(calcLines.paymentLine(calc.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: 30, taxesYearly: 4800,
    insuranceYearly: 1800, hoaMonthly: 50, homeValue: 450000, creditScore: 740 })),
    "On $400,000 at 6.5% over 30 years, the payment is $3,254.94 a month: $2,528.27 principal and interest, $400.00 taxes, " +
    "$150.00 insurance, $126.67 estimated mortgage insurance, $50.00 HOA.");
});
test("break-even: the spec's Okafor example", () => {
  const q = tools.breakEvenCalcTool({ clientId: okaforId, monthsLeft: 324, currentBalance: 350000 }, ctxLo1);
  assert.equal(q.say, "What rate are you looking at for them?");
  const a = tools.breakEvenCalcTool({ clientId: okaforId, monthsLeft: 324, currentBalance: 350000, newRate: 6.25 }, ctxLo1);
  assert.equal(a.say, "Taking Grace Okafor's $350,000 at 7.25% with 324 months left to 6.25% over 30 years moves the payment " +
    "from $2,464.68 to $2,155.01, saving $309.67 a month. With estimated closing costs of $6,000, break-even is month 20.");
  const b = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newRate: 6.75 }, ctxLo1);
  assert.equal(b.say, "Taking the $350,000 at 7.25% with 324 months left to 6.75% over 30 years moves the payment from $2,464.68 " +
    "to $2,270.09, saving $194.59 a month. With estimated closing costs of $6,000, break-even is month 31. Lower payment, higher total: " +
    "restarting the clock costs $24,676 more over the life of the loan than keeping the current loan.");
  assert.match(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newRate: 6.25, costsInLoan: true }, ctxLo1).say,
    /with estimated closing costs of \$6,000 added to the loan, break-even is month 22\.$/i);
});
test("at today's rate: the stored 30- or 15-year FRED average, said as an estimate", () => {
  const a = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true }, ctxLo1);
  assert.match(a.say, /to today's estimated average of 6\.52% over 30 years/); assert.equal(a.data.todaysAverage, true);
  assert.match(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true, newTermYears: 15 }, ctxLo1).say, /5\.91%/);
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true, newTermYears: 20 }, ctxLo1).say, "What's the new rate?");
  // no snapshot (or one older than 10 days): she asks
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true }, ctxLater).say, "What's the new rate?");
  // never for a payment, a buydown or a second's rate
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, useTodaysAverage: true }, ctxLo1).say, "What's the rate?");
});
test("blended and buydown lines, spec examples", () => {
  assert.equal(tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
    second: { kind: "second", rate: 8.5, termYears: 20, costs: 1500 }, cashOut: { rate: 6.75, termYears: 30 }, compareYears: 7 }, ctxLo1).say,
    "Keeping the $300,000 first at 3% with 300 months left and adding a second of $100,000 at 8.5% over 20 years blends to 4.375% at $2,290.45 a month. A cash-out to " +
    "$406,500 at 6.75% over 30 years, with estimated costs of $6,500 in the loan, is $2,636.55 a month. Over 7 years, keeping the " +
    "first costs $77,629 less.");
  assert.equal(tools.buydownCalcTool({ kind: "2-1", loanAmount: 400000, noteRate: 7 }, ctxLo1).say,
    "On $400,000 at 7% over 30 years, a 2-1 buydown makes the payment $2,147.29 in year one, $2,398.20 in year two, then $2,661.21. It costs $9,323.16.");
  assert.equal(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1.5 }, ctxLo1).say,
    "On $400,000 over 30 years, 1.5 points for $6,000.00 take the rate from 7% to 6.5% and the payment from $2,661.21 to $2,528.27, " +
    "saving $132.94 a month. Break-even is month 46.");
  assert.equal(tools.buydownCalcTool({ loanAmount: 400000, noteRate: 7 }, ctxLo1).say, "Which buydown: 2-1, 3-2-1 or 1-0?");
  assert.equal(tools.buydownCalcTool({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 2 }, ctxLo1).say, "The term must be at least as long as the buydown.");
});
test("Review Focus 5: a figure code can't read is asked for, never guessed", () => {
  assert.equal(tools.paymentCalcTool({ loanAmount: "400k", rate: 6.5 }, ctxLo1).say, "What's the loan amount?");
  assert.equal(tools.paymentCalcTool({ loanAmount: -5, rate: 6.5 }, ctxLo1).say, "Enter an amount above $0, up to $50,000,000.");
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, rate: 65 }, ctxLo1).say, "Enter a rate from 0% to 20%.");
});
test("scoped clients: another LO's client is no such client; the data carries no contact details", () => {
  const r = tools.breakEvenCalcTool({ clientId: okaforId, newRate: 6.25 }, ctxLo2);
  assert.deepEqual(r, { data: { error: "no such client in your book" }, source: "(not found)" });
  const mine = tools.breakEvenCalcTool({ clientId: okaforId, newRate: 6.25, monthsLeft: 324 }, ctxLo1);
  assert.deepEqual(Object.keys(mine.data.client), ["id", "name"]);
  assert.doesNotMatch(JSON.stringify(mine), /@example|555-/);   // the fixture's email and phone
  assert.equal(mine.data.result.inputs.creditScore, 742);
});
test("the 700 default score is never used", () => {
  const r = tools.paymentCalcTool({ clientId: defaultScoreId }, ctxLo1);
  assert.equal(r.data.result.inputs.creditScore, null);
});
test("a client with no months left on record: she asks", () => {
  assert.equal(tools.breakEvenCalcTool({ clientId: armClientId, newRate: 6.25 }, ctxLo1).say, "How many months are left on the current loan?");
});

// ── beyond the brief's cases: the shapes, the record's months left, and the rulings' wording ──

test("shapes: an answer, a question and a refusal; a bad clientId is the plain invalid-input error with no say", () => {
  const a = tools.paymentCalcTool({ loanAmount: 400000, rate: 6.5 }, ctxLo1);
  assert.deepEqual(Object.keys(a).sort(), ["data", "say", "source"]);
  assert.deepEqual(Object.keys(a.data).sort(), ["calculator", "client", "result", "todaysAverage"]);
  assert.equal(a.data.client, null); assert.equal(a.data.todaysAverage, false); assert.equal(a.data.calculator, "payment");
  const q = tools.paymentCalcTool({ rate: 6.5 }, ctxLo1);
  assert.deepEqual(q, { data: { calculator: "payment", missing: "loanAmount" }, source: "(calculator question)", say: "What's the loan amount?" });
  const n = tools.paymentCalcTool({ loanAmount: 400000, rate: 65, termYears: 99 }, ctxLo1);
  assert.deepEqual(n, { data: { calculator: "payment", refused: "rate" }, source: "(calculator refusal)", say: "Enter a rate from 0% to 20%." });
  // a refusal wins over a question
  assert.equal(tools.paymentCalcTool({ rate: 65 }, ctxLo1).say, "Enter a rate from 0% to 20%.");
  assert.deepEqual(tools.breakEvenCalcTool({ clientId: "abc" }, ctxLo1), { data: { error: "a valid clientId is required" }, source: "(invalid input)" });
  // a plain digit string is a number; "400k" and NaN-ish text never are
  assert.equal(tools.paymentCalcTool({ loanAmount: "400000", rate: "6.5" }, ctxLo1).say, a.say);
});
test("the record fills in: Grace Okafor's 330 months left, today's balance, her rate", () => {
  const r = tools.breakEvenCalcTool({ clientId: okaforId, newRate: 6.25 }, ctxLo1);
  assert.equal(r.data.result.inputs.monthsLeft, 330);
  assert.equal(r.data.result.inputs.currentBalance, 350000);
  assert.equal(r.data.result.inputs.currentRate, 7.25);
  assert.match(r.say, /^Taking Grace Okafor's \$350,000 at 7\.25% with 330 months left to 6\.25% over 30 years/);
  assert.deepEqual(r.data.client, { id: okaforId, name: "Grace Okafor" });
  // the figures are exactly the shared function's
  assert.deepEqual(r.data.result.out, calc.breakEvenCalc(r.data.result.inputs).out);
  const blended = tools.blendedRateCalcTool({ clientId: okaforId, cashNeeded: 50000, second: { rate: 8.5 }, cashOut: { rate: 6.75 } }, ctxLo1);
  assert.equal(blended.data.result.inputs.firstMonthsLeft, 330);
  assert.equal(blended.data.result.inputs.firstBalance, 350000);
});
test("break-even wording: no costs, no saving, a month left", () => {
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newRate: 6.25, closingCosts: 0 }, ctxLo1).say,
    "Taking the $350,000 at 7.25% with 324 months left to 6.25% over 30 years moves the payment from $2,464.68 to $2,155.01, " +
    "saving $309.67 a month. No costs entered.");
  const none = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 6.25, monthsLeft: 324, newRate: 7.25 }, ctxLo1).say;
  assert.match(none, /, \$\d[\d,]*\.\d\d more a month\. The new payment isn't lower, so the costs are never earned back\.$/);
  assert.doesNotMatch(none, /break-even is month/);
  assert.match(tools.breakEvenCalcTool({ currentBalance: 5000, currentRate: 7.25, monthsLeft: 1, newRate: 6.25 }, ctxLo1).say, / with 1 month left /);
});
test("blended: a HELOC adds its note; today's average on the cash-out rate only", () => {
  const heloc = tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
    second: { kind: "heloc", rate: 8.5, termYears: 20 }, cashOut: { rate: 6.75, termYears: 30 }, compareYears: 7 }, ctxLo1).say;
  assert.match(heloc, /adding a HELOC of \$100,000 at 8\.5% over 20 years/);
  assert.ok(heloc.endsWith(" " + calc.CALC_LINES.helocNote));
  const avg = tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
    second: { rate: 8.5, termYears: 20 }, cashOut: { useTodaysAverage: true } }, ctxLo1);
  assert.match(avg.say, /A cash-out to \$406,500 at today's estimated average of 6\.52% over 30 years/);
  assert.match(avg.say, /Over 5 years, /);
  assert.equal(avg.data.todaysAverage, true);
  // never for the second's rate
  assert.equal(tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
    second: { useTodaysAverage: true }, cashOut: { rate: 6.75 }, useTodaysAverage: true }, ctxLo1).say, "What's the rate on the second?");
  assert.equal(tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, second: { rate: 8.5 }, cashOut: { rate: 6.75 } }, ctxLo1).say,
    "How much cash do they need?");
});
test("buydown: points said without a kind is points; zero cost; a bare points kind asks how many", () => {
  assert.match(tools.buydownCalcTool({ loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1 }, ctxLo1).say, /, 1 point for \$4,000\.00 takes the rate /);
  assert.match(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 0 }, ctxLo1).say,
    /saving \$132\.94 a month\. No cost entered\.$/);
  assert.equal(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5 }, ctxLo1).say, "How many points?");
  assert.equal(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7 }, ctxLo1).say, "What's the rate with points?");
  assert.equal(tools.buydownCalcTool({ kind: "1-0", loanAmount: 400000, noteRate: 0.5 }, ctxLo1).say, "The note rate is too low for this buydown.");
  assert.equal(tools.buydownCalcTool({ kind: "2-1", loanAmount: 400000, noteRate: 7, termYears: 1 }, ctxLo1).say, "The term must be at least as long as the buydown.");
});
test("the tools are registered and described: figures are numbers, clientId an integer", () => {
  for (const name of ["paymentCalcTool", "breakEvenCalcTool", "blendedRateCalcTool", "buydownCalcTool"]) {
    assert.equal(typeof tools.tools[name], "function", name);
    const t = tools.TOOL_SCHEMA.find((s) => s.name === name);
    assert.ok(t, name);
    assert.match(t.description, /only the figures the user said/);
    if (t.input_schema.properties.clientId) assert.equal(t.input_schema.properties.clientId.type, "integer");
  }
  const be = tools.TOOL_SCHEMA.find((s) => s.name === "breakEvenCalcTool").input_schema.properties;
  assert.equal(be.useTodaysAverage.type, "boolean");
  assert.equal(be.newRate.type, "number");
  assert.deepEqual(tools.TOOL_SCHEMA.find((s) => s.name === "buydownCalcTool").input_schema.properties.kind.enum, ["2-1", "3-2-1", "1-0", "points"]);
  assert.equal(tools.TOOL_SCHEMA.find((s) => s.name === "buydownCalcTool").input_schema.properties.clientId, undefined);
});

// ── final fix wave ──
const recordClient = (name, f) => addClient(lo1, { name, loanType: "30yr_fixed", rate: 6.75, balance: 250000, value: 400000, score: 720,
  scoreKnown: 1, closeDate: "2023-01-20", balanceAsOf: "2026-11-25", ...f });
const scoreZeroId = recordClient("Zed Zero");
const scoreHighId = recordClient("Hy Score");
const bigBalanceId = recordClient("Bigg Balance", { balance: 60000000, value: 90000000 });
const highRateId = recordClient("Ray Highrate", { rate: 25 });
db.prepare("UPDATE clients SET credit_score = 0 WHERE id = ?").run(scoreZeroId);
db.prepare("UPDATE clients SET credit_score = 900 WHERE id = ?").run(scoreHighId);

test("fix I2: a negative saving is said as its size; an exact $0.00 saving drops the clause", () => {
  const worse = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 6.25, monthsLeft: 324, newRate: 7.25 }, ctxLo1).say;
  assert.doesNotMatch(worse, /\$-/);
  assert.match(worse, /to \$\d[\d,]*\.\d\d, \$\d[\d,]*\.\d\d more a month\. The new payment isn't lower/);
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 6.25, monthsLeft: 360, newRate: 6.25 }, ctxLo1).say,
    "Taking the $350,000 at 6.25% with 360 months left to 6.25% over 30 years moves the payment from $2,155.01 to $2,155.01. " +
    "The new payment isn't lower, so the costs are never earned back.");
});
test("fix I3: a blended cash-out above $50,000,000 is refused on the cash needed, nothing throws", () => {
  const r = tools.blendedRateCalcTool({ firstBalance: 30000000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 30000000,
    second: { rate: 8.5 }, cashOut: { rate: 6.75 } }, ctxLo1);
  assert.equal(r.say, "Enter an amount above $0, up to $50,000,000.");
  assert.deepEqual(r.data, { calculator: "blendedRate", refused: "cashNeeded" });
});
test("fix I4: the payment and blended lines name the client and say the record's figures", () => {
  assert.equal(tools.paymentCalcTool({ clientId: okaforId }, ctxLo1).say,
    "On Grace Okafor's $350,000 at 7.25% over 30 years, principal and interest is $2,387.62 a month, before taxes, insurance and any HOA.");
  assert.match(tools.paymentCalcTool({ clientId: okaforId, taxesYearly: 4800 }, ctxLo1).say,
    /^On Grace Okafor's \$350,000 at 7\.25% over 30 years, the payment is \$2,787\.62 a month: \$2,387\.62 principal and interest, \$400\.00 taxes\./);
  const blended = tools.blendedRateCalcTool({ clientId: okaforId, cashNeeded: 50000, second: { rate: 8.5 }, cashOut: { rate: 6.75 } }, ctxLo1).say;
  assert.match(blended, /^Keeping Grace Okafor's \$350,000 first at 7\.25% with 330 months left and adding a second of \$50,000 at 8\.5% over 30 years blends to /);
  assert.match(tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 1, cashNeeded: 100000,
    second: { rate: 8.5 }, cashOut: { rate: 6.75 } }, ctxLo1).say, /^Keeping the \$300,000 first at 3% with 1 month left and adding/);
});
test("fix M2: one point takes, more points take", () => {
  assert.match(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1 }, ctxLo1).say, / 1 point for \$4,000\.00 takes the rate /);
  assert.match(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 2 }, ctxLo1).say, / 2 points for \$8,000\.00 take the rate /);
});
test("fix M4: a second's kind is read in any case", () => {
  for (const kind of ["HELOC", "Heloc", "heloc"]) {
    const r = tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
      second: { kind, rate: 8.5, termYears: 20 }, cashOut: { rate: 6.75 } }, ctxLo1);
    assert.equal(r.data.result.inputs.secondKind, "heloc", kind);
    assert.match(r.say, /adding a HELOC of \$100,000/, kind);
  }
});
test("fix M6: a record figure outside the limits is not on record; a said one is still refused", () => {
  assert.equal(tools.paymentCalcTool({ clientId: scoreZeroId }, ctxLo1).data.result.inputs.creditScore, null);
  assert.equal(tools.paymentCalcTool({ clientId: scoreHighId }, ctxLo1).data.result.inputs.creditScore, null);
  assert.equal(tools.paymentCalcTool({ clientId: bigBalanceId }, ctxLo1).say, "What's the loan amount?");
  assert.equal(tools.breakEvenCalcTool({ clientId: highRateId, newRate: 6 }, ctxLo1).say, "What's the rate?");
  assert.equal(tools.paymentCalcTool({ clientId: bigBalanceId, loanAmount: 60000000 }, ctxLo1).say, "Enter an amount above $0, up to $50,000,000.");
  assert.equal(tools.paymentCalcTool({ clientId: highRateId, rate: 25 }, ctxLo1).say, "Enter a rate from 0% to 20%.");
});

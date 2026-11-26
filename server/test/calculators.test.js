"use strict";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const BEGIN = "// ---- calculators: shared math begin ----";
const END = "// ---- calculators: shared math end ----";
const SERVER_FILE = path.join(__dirname, "../lib/calculators.js");
const CLIENT_FILE = path.join(__dirname, "../../client/src/calculators.mjs");

let server, client;
before(async () => {
  server = require("../lib/calculators");
  client = await import(require("url").pathToFileURL(CLIENT_FILE).href);
});

// Every example runs on both copies.
const each = (name, fn) => {
  test(`${name} [server]`, () => fn(server));
  test(`${name} [client]`, () => fn(client));
};
const blockOf = (f) => {
  const t = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const a = t.indexOf(BEGIN), b = t.indexOf(END);
  assert.ok(a >= 0 && b > a, f);
  return t.slice(a, b + END.length);
};
const pmiOf = (side) => (side === server ? require("../lib/pmi").pmiMonthly : (...a) => pmiClient(...a));
let pmiClient;
before(async () => {
  pmiClient = (await import(require("url").pathToFileURL(path.join(__dirname, "../../client/src/refiAnalysis.mjs")).href)).pmiMonthly;
});

test("the shared block is the same text in both files", () => {
  assert.equal(blockOf(SERVER_FILE), blockOf(CLIENT_FILE));
});
test("the shared block has no require, import or export", () => {
  assert.doesNotMatch(blockOf(SERVER_FILE), /\brequire\s*\(|^\s*import\b|^\s*export\b|module\.exports/m);
});
each("payment, spec 2.1", (side) => {
  const r = side.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: 30, taxesYearly: 4800, insuranceYearly: 1800,
    miMonthly: null, hoaMonthly: 50, homeValue: 450000, creditScore: 740 });
  assert.deepEqual(r.out, { pi: 2528.27, taxes: 400, insurance: 150, mi: 126.67, hoa: 50, total: 3254.94 });
  assert.deepEqual(r.estimated, { mi: true }); assert.deepEqual(r.notEntered, []);
});
each("payment edge cases", (side) => {
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 0, termYears: 30 }).out.pi, 1111.11);
  const bare = side.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: null });
  assert.deepEqual(bare.defaulted, ["termYears"]); assert.deepEqual(bare.notEntered, ["taxes", "insurance", "mi", "hoa"]);
  assert.equal(bare.out.total, 2528.27);
  // over 80% with no value or score: no estimate
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6.5, homeValue: 450000 }).out.mi, 0);
  assert.deepEqual(side.paymentCalc({ loanAmount: null, rate: null }), { ok: false, errors: {}, missing: ["loanAmount", "rate"] });
  assert.deepEqual(side.paymentCalc({ loanAmount: 0, rate: 21, termYears: 41 }).errors,
    { loanAmount: side.CALC_LINES.amount, rate: side.CALC_LINES.rate, termYears: side.CALC_LINES.term });
  assert.equal(side.paymentCalc({ loanAmount: 50000001, rate: 6 }).errors.loanAmount, side.CALC_LINES.amount);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, termYears: 30.5 }).errors.termYears, side.CALC_LINES.term);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, taxesYearly: -1 }).errors.taxesYearly, side.CALC_LINES.optionalAmount);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, homeValue: 450000, creditScore: 900 }).errors.creditScore, side.CALC_LINES.score);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: Number.NaN }).errors.rate, side.CALC_LINES.rate);
});
each("formatting", (side) => {
  assert.equal(side.fmtCents(2528.27), "$2,528.27"); assert.equal(side.fmtCents(400), "$400.00");
  assert.equal(side.fmtDollars(24676.4), "$24,676"); assert.equal(side.fmtAmount(400000), "$400,000");
  assert.equal(side.fmtAmount(1500.5), "$1,500.50"); assert.equal(side.fmtRate(6.5), "6.5%");
  assert.equal(side.fmtRate(6.25), "6.25%"); assert.equal(side.fmtRate(5.1500000000000004), "5.15%");
  assert.equal(side.fmtBlended(4.375), "4.375%"); assert.equal(side.fmtBlended(4.2), "4.200%");
  assert.equal(side.possessive("Grace Okafor"), "Grace Okafor's"); assert.equal(side.possessive("James Rivers"), "James Rivers'");
  assert.equal(side.roundRate(6.12345), 6.123);
});

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

const LOAN = { currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newTermYears: 30 };
each("break-even, spec 2.2 at 6.25% in cash", (side) => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25 });
  assert.equal(r.out.currentPayment, 2464.68); assert.equal(r.out.newPayment, 2155.01);
  assert.equal(r.out.monthlySavings, 309.67); assert.equal(r.out.closingCosts, 6000); assert.deepEqual(r.estimated, { closingCosts: true });
  assert.equal(r.out.breakEvenMonth, 20); assert.equal(r.out.currentTotal, 798556); assert.equal(r.out.newTotal, 781804);
  assert.deepEqual(r.warnings, []);
});
each("break-even at 6.75%: the long-run warning", (side) => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.75 });
  assert.equal(r.out.newPayment, 2270.09); assert.equal(r.out.monthlySavings, 194.59); assert.equal(r.out.breakEvenMonth, 31);
  assert.equal(r.out.newTotal, 823232); assert.equal(r.out.totalDifference, 24676);
  assert.deepEqual(r.warnings, ["Lower payment, higher total: restarting the clock costs $24,676 more over the life of the loan than keeping the current loan."]);
});
each("break-even with the costs in the loan", (side) => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25, costsInLoan: true });
  assert.equal(r.out.newAmount, 356000); assert.equal(r.out.newPayment, 2191.95); assert.equal(r.out.monthlySavings, 272.73);
  assert.equal(r.out.breakEvenMonth, 22); assert.equal(r.out.newTotal, 789102); assert.equal(r.out.totalDifference, -9454);
  assert.deepEqual(r.notes, [side.CALC_LINES.costsInLoan]);
});
each("break-even edge cases", (side) => {
  const none = side.breakEvenCalc({ ...LOAN, newRate: 6.25, closingCosts: 0 });
  assert.equal(none.out.breakEvenMonth, null); assert.ok(none.notes.includes("No costs entered"));
  const worse = side.breakEvenCalc({ ...LOAN, newRate: 8 });   // 30 years at 8%: $2,568.18, above today's $2,464.68
  assert.ok(worse.out.monthlySavings < 0); assert.equal(worse.out.breakEvenMonth, null);
  assert.deepEqual(worse.warnings, [side.CALC_LINES.noSavings]);
  assert.equal(side.CALC_LINES.moreAMonth("$12.40"), "$12.40 more a month");
  // same P&I both sides (27 years = 324 months) and $10 of current MI: $10 saved, break-even month 600 > 324
  const late = side.breakEvenCalc({ ...LOAN, newRate: 7.25, newTermYears: 27, miNowMonthly: 10 });
  assert.equal(late.out.breakEvenMonth, 600); assert.ok(late.warnings.includes(side.CALC_LINES.tooLate));
  assert.equal(side.breakEvenCalc({ ...LOAN, newRate: 0 }).out.newPI, 972.22);      // zero rate: calcPayment spreads it
  assert.deepEqual(side.breakEvenCalc({ currentBalance: 350000 }).missing, ["currentRate", "monthsLeft", "newRate"]);
  assert.equal(side.breakEvenCalc({ ...LOAN, monthsLeft: 481, newRate: 6 }).errors.monthsLeft, side.CALC_LINES.monthsLeft);
});
each("Review Focus 3: a one-cent saving gives a finite late break-even", (side) => {
  // same P&I both sides (27 years = 324 months), so a typed cent of current MI is the whole saving
  const r = side.breakEvenCalc({ ...LOAN, newRate: 7.25, newTermYears: 27, miNewMonthly: 0, miNowMonthly: 0.01 });
  assert.equal(r.out.monthlySavings, 0.01); assert.equal(r.out.breakEvenMonth, 600000);
  assert.ok(Number.isFinite(r.out.breakEvenMonth)); assert.ok(r.warnings.includes(side.CALC_LINES.tooLate));
});
each("new-loan PMI estimate over the cautious value", (side) => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25, costsInLoan: true, homeValue: 400000, creditScore: 740 });
  assert.equal(r.out.miNew, pmiOf(side)(740, 356000 / 400000 * 100, 30, 356000)); assert.deepEqual(r.estimated, { closingCosts: true, miNew: true });
  assert.equal(r.out.newPayment, side.roundCents(r.out.newPI + r.out.miNew));
});

const BLEND = { firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000, secondKind: "second",
  secondRate: 8.5, secondTermYears: 20, secondCosts: 1500, cashOutRate: 6.75, cashOutTermYears: 30, compareYears: 7 };
each("blended rate, spec 2.3", (side) => {
  const r = side.blendedRateCalc(BLEND);
  assert.equal(r.out.firstPayment, 1422.63); assert.equal(r.out.secondPayment, 867.82);
  assert.equal(r.out.blendedRate, 4.375); assert.equal(r.out.combinedPayment, 2290.45);
  assert.equal(r.out.cashOutCosts, 6500); assert.equal(r.out.cashOutAmount, 406500); assert.equal(r.out.cashOutPayment, 2636.55);
  assert.deepEqual(r.out.keep, { paid: 192398, firstOwed: 237215, secondOwed: 81779, cashCosts: 1500, total: 512892 });
  assert.deepEqual(r.out.cashOut, { paid: 221470, owed: 369051, total: 590521 });
  assert.equal(r.out.cheaper, "keep"); assert.equal(r.out.difference, 77629);
});
each("HELOC: interest-only line and note", (side) => {
  const r = side.blendedRateCalc({ ...BLEND, secondKind: "heloc" });
  assert.equal(r.out.helocInterestOnly, 708.33);
  assert.deepEqual(r.notes, ["Interest-only payment on the second: $708.33 a month", side.CALC_LINES.helocNote]);
});
each("blended edge cases", (side) => {
  assert.deepEqual(side.blendedRateCalc({ ...BLEND, cashNeeded: 0 }).errors, { cashNeeded: "Enter the cash needed." });
  const long = side.blendedRateCalc({ ...BLEND, compareYears: 40 });
  assert.equal(long.out.keep.firstOwed, 0); assert.equal(long.out.keep.secondOwed, 0); assert.equal(long.out.cashOut.owed, 0);
  assert.equal(long.out.keep.paid, Math.round(1422.63 * 300 + 867.82 * 240));
  assert.equal(side.blendedRateCalc({ ...BLEND, secondRate: 2 }).ok, true);   // a second below the first: no warning
  assert.deepEqual(side.blendedRateCalc({ ...BLEND, compareYears: null }).defaulted, ["compareYears"]);
});

each("2-1 buydown, spec 2.4", (side) => {
  const r = side.buydownCalc({ kind: "2-1", loanAmount: 400000, noteRate: 7, termYears: 30 });
  assert.equal(r.out.notePayment, 2661.21);
  assert.deepEqual(r.out.years, [{ year: 1, rate: 5, payment: 2147.29 }, { year: 2, rate: 6, payment: 2398.2 }]);
  assert.equal(r.out.subsidy, 9323.16);
});
each("3-2-1 buydown", (side) => {
  const r = side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 30 });
  assert.equal(r.out.years[0].payment, 1909.66); assert.equal(r.out.subsidy, 18341.76);
});
each("Review Focus 2: reduced rates carry no float noise", (side) => {
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 6.15 }).out.years.map((y) => y.rate), [3.15, 4.15, 5.15]);
});
each("temporary buydown refusals", (side) => {
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 2 }).errors, { termYears: side.CALC_LINES.termTooShort });
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 2.5 }).errors, { noteRate: side.CALC_LINES.noteTooLow });
  assert.equal(side.buydownCalc({ kind: "2-1", loanAmount: 400000, noteRate: 2 }).out.years[0].payment, 1111.11);  // 0% year: calcPayment
  assert.deepEqual(side.buydownCalc({ kind: "4-3", loanAmount: 400000, noteRate: 7 }).missing, ["kind"]);
});
each("points, spec 2.4", (side) => {
  const r = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1.5, termYears: 30 });
  assert.deepEqual(r.out, { kind: "points", cost: 6000, points: 1.5, paymentWithout: 2661.21, paymentWith: 2528.27,
    monthlySavings: 132.94, breakEvenMonth: 46, fullTermSavings: 41858 });
  assert.equal(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, pointsCost: 6000 }).out.points, 1.5);
});
each("points edge cases", (side) => {
  assert.deepEqual(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 7, points: 1 }).errors,
    { rateWithPoints: side.CALC_LINES.pointsNotLower });
  const free = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 0 });
  assert.equal(free.out.breakEvenMonth, null); assert.deepEqual(free.notes, ["No cost entered"]);
  const never = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.99, points: 5, termYears: 5 });
  assert.deepEqual(never.warnings, [side.CALC_LINES.pointsNever]);
  assert.deepEqual(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5 }).missing, ["points"]);
  assert.equal(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 21 }).errors.points, side.CALC_LINES.points);
});

test("500 input sets give identical results from both files", async () => {
  const refiClient = await import(require("url").pathToFileURL(path.join(__dirname, "../../client/src/refiAnalysis.mjs")).href);
  const refiServer = require("../lib/refi");
  const pmiServer = require("../lib/pmi");
  // 32-bit LCG, fixed seed: the same 500 sets on every run
  let state = 20261125;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (a) => a[int(0, a.length - 1)];
  const rate = () => int(0, 96) * 0.125;                 // 0 to 12 in steps of 0.125
  const amount = () => int(10000, 2000000);
  const maybe = (v, p = 0.25) => (next() < p ? null : v);  // some optional fields blank
  const wild = (v, bad) => (next() < 0.06 ? bad : v);     // now and then a value outside the limits or missing

  const makers = {
    paymentCalc: () => ({ loanAmount: wild(amount(), pick([null, 0, 60000000])), rate: wild(rate(), pick([null, 21])), termYears: maybe(int(1, 40)),
      taxesYearly: maybe(int(0, 20000)), insuranceYearly: maybe(int(0, 8000)), miMonthly: maybe(int(0, 400)), hoaMonthly: maybe(int(0, 800)),
      homeValue: maybe(amount()), creditScore: maybe(int(600, 800)) }),
    breakEvenCalc: () => ({ currentBalance: wild(amount(), pick([null, 0])), currentRate: rate(), monthsLeft: wild(int(1, 480), pick([null, 481])),
      newRate: wild(rate(), pick([null, 25])), newTermYears: maybe(int(1, 40)), closingCosts: maybe(int(0, 30000)),
      costsInLoan: pick([true, false, null]), miNowMonthly: maybe(int(0, 300)), miNewMonthly: maybe(int(0, 300), 0.5),
      homeValue: maybe(amount()), creditScore: maybe(int(600, 800)) }),
    blendedRateCalc: () => ({ firstBalance: wild(amount(), pick([null, 0])), firstRate: rate(), firstMonthsLeft: int(1, 480),
      cashNeeded: wild(int(5000, 500000), pick([null, 0])), secondKind: pick(["second", "heloc", null]), secondRate: rate(),
      secondTermYears: maybe(int(1, 40)), secondCosts: maybe(int(0, 8000)), cashOutRate: wild(rate(), pick([null, 30])),
      cashOutTermYears: maybe(int(1, 40)), cashOutCosts: maybe(int(0, 20000), 0.5), compareYears: maybe(int(1, 40)) }),
    buydownCalc: () => {
      const kind = pick(["2-1", "3-2-1", "1-0", "points", "points"]);
      const noteRate = rate();
      return { kind: wild(kind, "9-9"), loanAmount: amount(), noteRate, termYears: maybe(int(1, 40)),
        rateWithPoints: Math.max(0, noteRate - int(0, 16) * 0.125), points: pick([null, int(0, 40) * 0.25]),
        pointsCost: pick([null, int(0, 20000)]) };
    },
  };

  const seen = { paymentCalc: [0, 0], breakEvenCalc: [0, 0], blendedRateCalc: [0, 0], buydownCalc: [0, 0] };  // [sets, refusals]
  const names = Object.keys(makers);
  for (let i = 0; i < 500; i++) {
    const name = names[i % names.length];
    const set = makers[name]();
    const s = server[name](set), c = client[name](set);
    assert.deepEqual(c, s, `${name} set ${i}: ${JSON.stringify(set)}`);
    seen[name][0]++; if (!s.ok) seen[name][1]++;

    const amt = amount(), r = rate(), term = int(1, 40), score = int(600, 800), ltv = int(70, 99);
    assert.equal(refiClient.calcPayment(amt, r, term), refiServer.calcPayment(amt, r, term));
    assert.equal(refiClient.estClosingCosts(amt), refiServer.estClosingCosts(amt));
    assert.equal(refiClient.pmiMonthly(score, ltv, term, amt), pmiServer.pmiMonthly(score, ltv, term, amt));
  }
  for (const name of names) {
    assert.ok(seen[name][0] >= 100, `${name}: ${seen[name][0]} sets`);
    assert.ok(seen[name][1] >= 1, `${name}: no refusal seen`);
    assert.ok(seen[name][0] > seen[name][1], `${name}: no result seen`);
  }
});

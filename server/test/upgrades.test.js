"use strict";
// The five upgrade checks (spec 4.6). Each lens gets a flagging client and a non-flagging client per guard; where a guard could be
// shadowed by another rule, a control case shows the same client flags once that one input changes.
const { describe, test } = require("node:test");
const assert = require("node:assert");
const U = require("../lib/upgrades");
const { upgradesFor } = U;
const { analyze, calcPayment, estClosingCosts } = require("../lib/refi");
const { createIndex } = require("../lib/hpi");

const TODAY = "2026-11-13";
const RATES = { rate_30yr_fixed: 6.25, rate_15yr_fixed: 5.6, rate_5_1_arm: 6.1, rate_30yr_top_tier: 6.1, rate_30yr_fha: 5.9, rate_30yr_va: 5.8 };
// The shape of the fallback rate sets (routes/rates.js): no FHA, VA or top-tier rate.
const FALLBACK_SHAPE = { rate_30yr_fixed: 6.25, rate_15yr_fixed: 5.6, rate_5_1_arm: 6.1 };

const GAP = {
  program: "Add the loan program to check upgrades.",
  credit: "Add a credit score to check upgrades.",
  zip: "Add the property ZIP to check home value growth.",
  mi: "Add the monthly mortgage insurance to check whether PMI can be dropped.",
  close: "Add the original close date to check upgrades.",
  investment: "Investment property: upgrades aren't checked.",
};

// ZIP3 "850": flat at 100 from 2005Q1, then 140 in the latest quarter (2026Q3), so any earlier quarter grows by a factor of 1.40.
function makeIndex() {
  const n = (2026 * 4 + 2) - 2005 * 4 + 1;
  const s = Array(n).fill(100);
  s[n - 1] = 140;
  return createIndex({ source: "test", start: "2005Q1", end: "2026Q3", zip3: { "850": s } });
}
const index = makeIndex();
const run = (c, rates = RATES, today = TODAY) => upgradesFor(c, rates, today, { index });
const lensOf = (r, id) => r.lenses.find((l) => l.lens === id) || null;
const ids = (r) => r.lenses.map((l) => l.lens);
const money = (n) => Math.round(n).toLocaleString("en-US");

// FHA, 3.5% down in mid-2021, value on file is the purchase price, area prices up 40% since.
const base = (over = {}) => ({
  loanProgram: "fha", occupancy: "primary", loanType: "30yr_fixed", currentRate: 6.9,
  loanBalance: 289500, balanceAsOf: "2021-06-15", closeDate: "2021-06-15",
  originalAmount: 289500, originalValue: 300000, propertyValue: 300000, valueAsOf: "2021-06-15", propertyZip: "85016",
  creditScore: 720, creditScoreKnown: true, monthlyMi: null, editedByHand: "",
  ...over,
});
// The same client closed on another day (the stored balance and value date from the closing).
const closedOn = (d, over = {}) => base({ closeDate: d, balanceAsOf: d, valueAsOf: d, ...over });

describe("constants and gap lines", () => {
  test("constants", () => {
    assert.deepStrictEqual(
      [U.CONV_MIN_SCORE, U.STREAMLINE_MIN_SCORE, U.MAX_BREAK_EVEN, U.HIGH_SAVINGS, U.NTB_MIN_DROP, U.FHA_UFMIP, U.FHA_NEW_ANNUAL_MIP,
        U.VA_FUNDING_FEE, U.MI_ENDING_SOON_MONTHS, U.CONV_MAX_LTV, U.WAITING_DAYS],
      [620, 580, 36, 200, 0.5, 0.0175, 0.55, 0.005, 12, 80, 210],
    );
  });

  test("gap lines are verbatim", () => {
    assert.deepStrictEqual(U.GAPS, GAP);
  });
});

describe("fha_to_conv", () => {
  test("FHA, 3.5% down in 2021, prices up 40%: flags with its reason", () => {
    const r = run(base());
    const l = lensOf(r, "fha_to_conv");
    assert.ok(l, JSON.stringify(r));
    assert.strictEqual(l.label, "FHA → Conventional");
    assert.strictEqual(l.unit, "$/mo");
    assert.ok(l.ltv <= 80 && r.today.ltv <= 80, String(r.today.ltv));
    assert.strictEqual(l.ltv, r.today.ltv);

    const a = analyze({ loanType: "30yr_fixed", currentRate: 6.9, loanBalance: r.today.balance, propertyValue: r.today.cautiousValue, creditScore: 720 }, RATES);
    const savings = a.curPmt + r.mi.monthly - a.newPmt;
    assert.strictEqual(r.mi.basis, "estimated");
    assert.strictEqual(l.monthlySavings, Math.round(savings));
    assert.strictEqual(l.headline, l.monthlySavings);
    assert.strictEqual(l.breakEven, Math.ceil(estClosingCosts(r.today.balance) / savings));
    assert.ok(l.breakEven <= 36);
    assert.strictEqual(l.miMonthly, Math.round(r.mi.monthly));
    assert.strictEqual(l.priority, savings >= 200 ? "high" : "medium");
    assert.strictEqual(l.priority, "high");
    assert.strictEqual(
      l.detail,
      `FHA, about ${Math.round(l.ltv)}% of value, insurance about $${money(l.miMonthly)}/mo; conventional at ${l.effRate.toFixed(2)}% saves about $${money(l.monthlySavings)}/mo, break-even ${l.breakEven} mo`,
    );
    assert.match(l.detail, /^FHA, about \d+% of value, insurance about \$[\d,]+\/mo; conventional at \d+\.\d{2}% saves about \$[\d,]+\/mo, break-even \d+ mo$/);
    assert.deepStrictEqual(r.gaps, []);
  });

  test("the today block", () => {
    const { today: t } = run(base());
    assert.strictEqual(t.balanceFrom, 289500);
    assert.strictEqual(t.balanceAsOf, "2021-06-15");
    assert.strictEqual(t.balanceBasis, "rolled");
    assert.ok(t.balance > 0 && t.balance < 289500);
    assert.strictEqual(t.valueFrom, 300000);
    assert.strictEqual(t.value, 420000);
    assert.strictEqual(t.cautiousValue, 378000);
    assert.strictEqual(t.valueAsOf, "2021-06-15");
    assert.strictEqual(t.valueBasis, "grown");
    assert.strictEqual(t.growthPct, 40);
    assert.strictEqual(t.ltv, Math.round((t.balance / 378000) * 1000) / 10);
  });

  test("Review Focus 4: on the fallback rate shape it still runs", () => {
    const r = run(base(), FALLBACK_SHAPE);
    assert.ok(lensOf(r, "fha_to_conv"));
  });

  test("no ZIP: the flat value keeps LTV over 80, no flag, and the ZIP line", () => {
    const r = run(base({ propertyZip: "" }));
    assert.strictEqual(r.today.valueBasis, "flat");
    assert.ok(r.today.ltv > 80);
    assert.strictEqual(lensOf(r, "fha_to_conv"), null);
    assert.ok(r.gaps.includes(GAP.zip));
  });

  test("score not on file: no refi lenses and the credit-score line", () => {
    const r = run(base({ creditScoreKnown: false, creditScore: 700 }));
    assert.deepStrictEqual(r.lenses, []);
    assert.ok(r.gaps.includes(GAP.credit));
  });

  test("known score under 620: no flag", () => {
    const r = run(base({ creditScore: 600 }));
    assert.strictEqual(lensOf(r, "fha_to_conv"), null);
    assert.ok(!r.gaps.includes(GAP.credit));
  });

  test("FHA closed 2012 with no MI typed: MI unknown, no flag; typed MI flags", () => {
    // 7.75% so the principal-and-interest saving alone would pass the break-even: the MI guard is what stops it.
    const old = closedOn("2012-06-01", { currentRate: 7.75 });
    const r = run(old);
    assert.strictEqual(r.mi.basis, "unknown");
    assert.strictEqual(lensOf(r, "fha_to_conv"), null);
    assert.ok(lensOf(run({ ...old, monthlyMi: 150 }), "fha_to_conv"));
  });

  test("insurance ending on its own within 12 months: no flag", () => {
    // 90% original LTV: FHA insurance ends 11 years after closing.
    const r = run(closedOn("2016-05-13", { originalAmount: 270000, loanBalance: 270000 }));
    assert.strictEqual(r.mi.endsOn, "2027-05-13");
    assert.strictEqual(lensOf(r, "fha_to_conv"), null);
    const later = run(closedOn("2017-05-13", { originalAmount: 270000, loanBalance: 270000 }));
    assert.strictEqual(later.mi.endsOn, "2028-05-13");
    assert.ok(lensOf(later, "fha_to_conv"));
  });

  test("break-even over 36 months, or no saving: no flag", () => {
    const slow = run(base({ currentRate: 5.6 }));
    const a = analyze({ loanType: "30yr_fixed", currentRate: 5.6, loanBalance: slow.today.balance, propertyValue: slow.today.cautiousValue, creditScore: 720 }, RATES);
    const savings = a.curPmt + slow.mi.monthly - a.newPmt;
    assert.ok(savings > 0 && Math.ceil(estClosingCosts(slow.today.balance) / savings) > 36);
    assert.strictEqual(lensOf(slow, "fha_to_conv"), null);
    assert.strictEqual(lensOf(run(base({ currentRate: 4 })), "fha_to_conv"), null);
  });

  test("a 15-year FHA is priced as a 15-year conventional", () => {
    const r = run(base({ loanType: "15yr_fixed", currentRate: 6.4 }));
    const l = lensOf(r, "fha_to_conv");
    const a = analyze({ loanType: "15yr_fixed", currentRate: 6.4, loanBalance: r.today.balance, propertyValue: r.today.cautiousValue, creditScore: 720 }, RATES);
    const savings = a.curPmt + r.mi.monthly - a.newPmt;
    assert.ok(l, JSON.stringify(r));
    assert.strictEqual(l.monthlySavings, Math.round(savings));
    assert.strictEqual(l.effRate, 5.6); // the 15-year market rate: no top-tier anchor for a 15-year
    assert.strictEqual(l.priority, "medium");
    assert.strictEqual(lensOf(r, "fha_streamline"), null);
  });
});

describe("fha_streamline", () => {
  // 7.75%, closed 2023, no ZIP (so LTV stays over 80 and FHA → Conventional is out of the way).
  const s23 = (over = {}) => closedOn("2023-09-15", { currentRate: 7.75, propertyZip: "", ...over });

  test("a 7.75% FHA closed in 2023 flags with its reason", () => {
    const r = run(s23());
    assert.deepStrictEqual(ids(r), ["fha_streamline"]);
    const l = lensOf(r, "fha_streamline");
    assert.strictEqual(l.label, "FHA Streamline");
    const bal = r.today.balance;
    const savings = calcPayment(bal, 7.75, 30) + r.mi.monthly - (calcPayment(bal, 5.9, 30) + (bal * 0.0055) / 12);
    const be = Math.ceil((estClosingCosts(bal) + 0.0175 * bal) / savings);
    assert.strictEqual(l.monthlySavings, Math.round(savings));
    assert.strictEqual(l.headline, l.monthlySavings);
    assert.strictEqual(l.breakEven, be);
    assert.ok(be <= 36);
    assert.strictEqual(l.priority, savings >= 200 ? "high" : "medium");
    assert.strictEqual(l.effRate, 5.9);
    assert.strictEqual(l.currentRate, 7.75);
    assert.strictEqual(l.ltv, r.today.ltv);
    assert.strictEqual(l.detail, `FHA 7.75% → about 5.90% FHA, saves about $${money(l.monthlySavings)}/mo, break-even ${be} mo (upfront FHA insurance counted)`);
  });

  test("inside the waiting period: no flag; past it: flags", () => {
    // Closed 150 days ago: 210 days not yet passed.
    assert.strictEqual(lensOf(run(closedOn("2026-06-16", { currentRate: 7.75, propertyZip: "" })), "fha_streamline"), null);
    // Closed 2026-03-20: 210 days on 2026-10-16, first payment 2026-05-01 + 6 months = 2026-11-01, both passed by 2026-11-13.
    assert.ok(lensOf(run(closedOn("2026-03-20", { currentRate: 7.75, propertyZip: "" })), "fha_streamline"));
    // Closed 2026-04-20: 210 days on 2026-11-16 (first payment 2026-06-01 + 6 months = 2026-12-01).
    assert.strictEqual(lensOf(run(closedOn("2026-04-20", { currentRate: 7.75, propertyZip: "" })), "fha_streamline"), null);
  });

  test("no FHA rate (or the fallback rate shape): no flag", () => {
    const { rate_30yr_fha, ...noFha } = RATES;
    assert.strictEqual(lensOf(run(s23(), noFha), "fha_streamline"), null);
    assert.strictEqual(lensOf(run(s23(), FALLBACK_SHAPE), "fha_streamline"), null);
    assert.strictEqual(lensOf(run(s23(), { ...RATES, rate_30yr_fha: "5.9" }), "fha_streamline"), null);
  });

  test("score gate 580", () => {
    assert.strictEqual(lensOf(run(s23({ creditScore: 579 })), "fha_streamline"), null);
    assert.ok(lensOf(run(s23({ creditScore: 580 })), "fha_streamline"));
    const unknown = run(s23({ creditScoreKnown: false }));
    assert.deepStrictEqual(unknown.lenses, []);
    assert.ok(unknown.gaps.includes(GAP.credit));
  });

  test("only for 30-year fixed loans", () => {
    assert.strictEqual(lensOf(run(s23({ loanType: "15yr_fixed" })), "fha_streamline"), null);
    assert.strictEqual(lensOf(run(s23({ loanType: "5_1_arm" })), "fha_streamline"), null);
  });

  test("break-even over 36 months: no flag", () => {
    // Case-1 client: the rate test passes but the upfront insurance takes over 36 months to recover.
    const r = run(base());
    const bal = r.today.balance;
    const savings = calcPayment(bal, 6.9, 30) + r.mi.monthly - (calcPayment(bal, 5.9, 30) + (bal * 0.0055) / 12);
    assert.ok(savings > 0 && Math.ceil((estClosingCosts(bal) + 0.0175 * bal) / savings) > 36);
    assert.strictEqual(lensOf(r, "fha_streamline"), null);
  });
});

describe("va_irrrl", () => {
  const va = (d, over = {}) => closedOn(d, { loanProgram: "va", currentRate: 7.25, originalAmount: 300000, loanBalance: 300000, propertyZip: "", ...over });

  test("a 7.25% VA closed in 2023 flags with its reason", () => {
    const r = run(va("2023-09-15"));
    assert.deepStrictEqual(ids(r), ["va_irrrl"]);
    const l = lensOf(r, "va_irrrl");
    assert.strictEqual(l.label, "VA IRRRL");
    const bal = r.today.balance;
    const savings = calcPayment(bal, 7.25, 30) - calcPayment(bal, 5.8, 30);
    const be = Math.ceil((estClosingCosts(bal) + 0.005 * bal) / savings);
    assert.strictEqual(l.monthlySavings, Math.round(savings));
    assert.strictEqual(l.headline, l.monthlySavings);
    assert.strictEqual(l.breakEven, be);
    assert.ok(be <= 36);
    assert.strictEqual(l.priority, savings >= 200 ? "high" : "medium");
    assert.strictEqual(l.effRate, 5.8);
    assert.strictEqual(l.currentRate, 7.25);
    assert.strictEqual(l.detail, `VA 7.25% → about 5.80% VA, saves about $${money(l.monthlySavings)}/mo, break-even ${be} mo`);
  });

  test("first payment 5 months ago: no flag; 210 days after it: flags", () => {
    // Closed 2026-04-20: first payment 2026-06-01, 210 days after it is 2026-12-28.
    assert.strictEqual(lensOf(run(va("2026-04-20")), "va_irrrl"), null);
    // Closed 2026-02-20: first payment 2026-04-01, 210 days after it is 2026-10-28.
    assert.ok(lensOf(run(va("2026-02-20")), "va_irrrl"));
  });

  test("a 0.4-point drop: no flag", () => {
    assert.strictEqual(lensOf(run(va("2023-09-15", { currentRate: 6.2 })), "va_irrrl"), null);
  });

  test("no VA rate (or the fallback rate shape): no flag", () => {
    const { rate_30yr_va, ...noVa } = RATES;
    assert.strictEqual(lensOf(run(va("2023-09-15"), noVa), "va_irrrl"), null);
    assert.strictEqual(lensOf(run(va("2023-09-15"), FALLBACK_SHAPE), "va_irrrl"), null);
  });

  test("score gate 580 and 30-year fixed only", () => {
    assert.strictEqual(lensOf(run(va("2023-09-15", { creditScore: 579 })), "va_irrrl"), null);
    assert.ok(lensOf(run(va("2023-09-15", { creditScore: 580 })), "va_irrrl"));
    const unknown = run(va("2023-09-15", { creditScoreKnown: false }));
    assert.deepStrictEqual(unknown.lenses, []);
    assert.ok(unknown.gaps.includes(GAP.credit));
    assert.strictEqual(lensOf(run(va("2023-09-15", { loanType: "15yr_fixed" })), "va_irrrl"), null);
  });
});

describe("drop_pmi", () => {
  // Conventional, PMI typed, balance typed today, no ZIP; score unknown (Drop PMI needs none).
  const conv = (over = {}) => ({
    loanProgram: "conventional", occupancy: "primary", loanType: "30yr_fixed", currentRate: 6.5,
    loanBalance: 238000, balanceAsOf: TODAY, closeDate: "2022-03-15",
    originalAmount: 285000, originalValue: 300000, propertyValue: 300000, valueAsOf: "2022-03-15", propertyZip: "",
    creditScore: 700, creditScoreKnown: false, monthlyMi: 95, editedByHand: "",
    ...over,
  });
  // Path "current": originals unknown, a value the broker typed last month, so today's LTV = balance / 400,000.
  const seasoned = (closeDate, balance, over = {}) => conv({
    closeDate, loanBalance: balance, originalAmount: null, originalValue: null,
    propertyValue: 400000, valueAsOf: "2026-10-01", editedByHand: "property_value", ...over,
  });

  test("path original: balance at or under 80% of the original value", () => {
    const r = run(conv());
    assert.deepStrictEqual(ids(r), ["drop_pmi"]);
    const l = r.lenses[0];
    assert.strictEqual(l.label, "Drop PMI");
    assert.strictEqual(l.priority, "low");
    assert.strictEqual(l.unit, "$/mo");
    assert.strictEqual(l.headline, 95);
    assert.strictEqual(l.miMonthly, 95);
    assert.strictEqual(l.path, "original");
    assert.strictEqual(l.originalLtv, 79.3);
    assert.strictEqual(l.ltv, r.today.ltv);
    assert.strictEqual(l.detail, "Conventional, about 79% of the original value, PMI $95/mo: they can ask their lender to remove it");
    assert.deepStrictEqual(r.gaps, [GAP.zip]);
  });

  test("path current: 2 to 5 years needs LTV 75, after 5 years LTV 80", () => {
    const four74 = run(seasoned("2022-11-01", 296000));
    const l = lensOf(four74, "drop_pmi");
    assert.ok(l);
    assert.strictEqual(l.path, "current");
    assert.strictEqual(four74.today.ltv, 74);
    assert.strictEqual(l.detail, "Conventional, about 74% of value, PMI $95/mo: they can ask their lender to remove it");
    assert.strictEqual(lensOf(run(seasoned("2022-11-01", 304000)), "drop_pmi"), null); // 4 years, LTV 76
    assert.ok(lensOf(run(seasoned("2020-09-01", 316000)), "drop_pmi")); // 6 years, LTV 79
    assert.strictEqual(lensOf(run(seasoned("2020-09-01", 324000)), "drop_pmi"), null); // 6 years, LTV 81
    assert.strictEqual(lensOf(run(seasoned("2025-09-01", 280000)), "drop_pmi"), null); // 1 year, LTV 70
  });

  test("MI not typed: no flag and the MI line (original LTV over 80 or unknown)", () => {
    const r = run(conv({ monthlyMi: null }));
    assert.deepStrictEqual(r.lenses, []);
    assert.ok(r.gaps.includes(GAP.mi));
    assert.ok(run(conv({ monthlyMi: null, originalAmount: null })).gaps.includes(GAP.mi));
    // 20% down: no PMI to ask about.
    assert.ok(!run(conv({ monthlyMi: null, originalAmount: 240000 })).gaps.includes(GAP.mi));
  });

  test("MI typed as 0: no flag and no MI line", () => {
    const r = run(conv({ monthlyMi: 0 }));
    assert.deepStrictEqual(r.lenses, []);
    assert.ok(!r.gaps.includes(GAP.mi));
  });

  test("MI typed but the scheduled balance already reached 78%: no flag", () => {
    const r = run(conv({ closeDate: "2010-03-15", currentRate: 4.5, originalAmount: 240000, originalValue: 250000, loanBalance: 150000 }));
    assert.ok(r.mi.endsOn && r.mi.endsOn <= TODAY, String(r.mi.endsOn));
    assert.deepStrictEqual(r.lenses, []);
  });

  test("runs without rates, for jumbo too, and needs no score", () => {
    assert.ok(lensOf(run(conv(), null), "drop_pmi"));
    assert.ok(lensOf(run(conv({ loanProgram: "jumbo" })), "drop_pmi"));
    assert.ok(!run(conv()).gaps.includes(GAP.credit));
  });

  test("not for government programs", () => {
    assert.strictEqual(lensOf(run(base({ monthlyMi: 95, loanBalance: 200000, balanceAsOf: TODAY })), "drop_pmi"), null);
  });
});

describe("usda_to_conv", () => {
  const usda = (d, over = {}) => closedOn(d, { loanProgram: "usda", originalAmount: 300000, loanBalance: 300000, ...over });

  test("flags with the USDA annual fee", () => {
    const r = run(usda("2019-05-15"));
    const l = lensOf(r, "usda_to_conv");
    assert.ok(l, JSON.stringify(r));
    assert.strictEqual(l.label, "USDA → Conventional");
    assert.strictEqual(r.mi.annualRate, 0.35);
    const a = analyze({ loanType: "30yr_fixed", currentRate: 6.9, loanBalance: r.today.balance, propertyValue: r.today.cautiousValue, creditScore: 720 }, RATES);
    const savings = a.curPmt + r.mi.monthly - a.newPmt;
    assert.strictEqual(l.monthlySavings, Math.round(savings));
    assert.strictEqual(l.breakEven, Math.ceil(estClosingCosts(r.today.balance) / savings));
    assert.strictEqual(l.priority, "medium"); // under $200 a month
    assert.strictEqual(
      l.detail,
      `USDA, about ${Math.round(l.ltv)}% of value, fee about $${money(l.miMonthly)}/mo; conventional at ${l.effRate.toFixed(2)}% saves about $${money(l.monthlySavings)}/mo, break-even ${l.breakEven} mo`,
    );
  });

  test("USDA closed 2010 (no annual fee then): no flag", () => {
    // 7.75% so the principal-and-interest saving alone would pass the break-even: the fee guard is what stops it.
    const r = run(usda("2010-06-01", { currentRate: 7.75 }));
    assert.strictEqual(r.mi.monthly, 0);
    assert.strictEqual(lensOf(r, "usda_to_conv"), null);
  });
});

describe("gates", () => {
  test("investment property: no lenses, only the investment line", () => {
    const r = run(base({ occupancy: "investment" }));
    assert.deepStrictEqual(r.lenses, []);
    assert.deepStrictEqual(r.gaps, [GAP.investment]);
    assert.deepStrictEqual(run(base({ occupancy: "investment", loanProgram: "" })).gaps, [GAP.investment]);
  });

  test("no (or an unknown) program: no lenses, only the program line", () => {
    for (const loanProgram of ["", undefined, "nonqm"]) {
      const r = run(base({ loanProgram, creditScoreKnown: false, propertyZip: "" }));
      assert.deepStrictEqual(r.lenses, [], String(loanProgram));
      assert.deepStrictEqual(r.gaps, [GAP.program], String(loanProgram));
    }
  });

  test("no close date, or one that isn't a real day: no lenses and the close-date line", () => {
    for (const closeDate of ["", null, "2021-02-30", "06/15/2021", "garbage", "2021-6-15"]) {
      const r = run(base({ closeDate }));
      assert.deepStrictEqual(r.lenses, [], String(closeDate));
      assert.ok(r.gaps.includes(GAP.close), String(closeDate));
      assert.strictEqual(r.mi, null);
    }
  });

  test("no rates: no refi lenses, no throw", () => {
    const r = run(base(), null);
    assert.deepStrictEqual(r.lenses, []);
    assert.ok(r.today.balance > 0);
  });

  test("no home value or no balance: no lenses, and no NaN in the today block", () => {
    for (const over of [{ propertyValue: undefined }, { propertyValue: null }, { propertyValue: 0 }, { loanBalance: null }, { loanBalance: "" }]) {
      const r = run(base(over));
      assert.deepStrictEqual(r.lenses, [], JSON.stringify(over));
      for (const [k, v] of Object.entries(r.today)) assert.ok(!(typeof v === "number" && Number.isNaN(v)), k);
      assert.strictEqual(r.today.ltv, null);
    }
  });

  test("uses the bundled index by default", () => {
    const r = upgradesFor(base(), RATES, TODAY);
    assert.ok(Array.isArray(r.lenses) && Array.isArray(r.gaps));
  });
});

describe("ordering", () => {
  test("a client with both FHA → Conventional and FHA Streamline: the larger saver first", () => {
    const r = run(base({ currentRate: 7.75 }));
    assert.deepStrictEqual(ids(r), ["fha_to_conv", "fha_streamline"]);
    const [a, b] = r.lenses;
    assert.strictEqual(a.priority, b.priority);
    assert.ok(a.monthlySavings > b.monthlySavings);
  });
});

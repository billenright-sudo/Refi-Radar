"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { currentMi, endsWithinMonths } = require("../lib/mortgageInsurance");
const { calcPayment } = require("../lib/refi");
const { firstPaymentFromClosing } = require("../lib/intake/loan");

const TODAY = "2026-11-13";
const BAL = 300000;
const mi = (c, balance = BAL) => currentMi({ loanType: "30yr_fixed", currentRate: 6.5, monthlyMi: null, originalAmount: null, originalValue: null, ...c }, balance, TODAY);
const est = (c, monthly, rate) => {
  const r = mi(c);
  assert.strictEqual(r.basis, "estimated");
  assert.strictEqual(r.monthly, monthly);
  assert.strictEqual(r.annualRate, rate);
  return r;
};

test("FHA > 15 years by era", () => {
  assert.strictEqual(est({ loanProgram: "fha", closeDate: "2024-05-01" }, 125, 0.5).endsOn, null);
  est({ loanProgram: "fha", closeDate: "2016-07-01" }, 200, 0.8);
  est({ loanProgram: "fha", closeDate: "2014-03-01" }, 325, 1.3);
});

test("FHA band edge: lower figure wins within 90 days after a boundary", () => {
  est({ loanProgram: "fha", closeDate: "2023-04-15" }, 125, 0.5);
  est({ loanProgram: "fha", closeDate: "2015-02-10" }, 200, 0.8);
});

test("FHA 15 years", () => {
  est({ loanProgram: "fha", loanType: "15yr_fixed", closeDate: "2024-05-01" }, 37.5, 0.15);
  est({ loanProgram: "fha", loanType: "15yr_fixed", closeDate: "2018-01-01" }, 112.5, 0.45);
});

test("FHA too old or no close date is unknown", () => {
  for (const closeDate of ["2012-06-01", "2013-08-01", ""]) {
    const r = mi({ loanProgram: "fha", closeDate });
    assert.strictEqual(r.monthly, null);
    assert.strictEqual(r.basis, "unknown");
  }
});

test("FHA end date from original LTV", () => {
  const a = mi({ loanProgram: "fha", closeDate: "2016-07-01", originalAmount: 270000, originalValue: 300000 });
  assert.strictEqual(a.endsOn, "2027-07-01");
  assert.strictEqual(a.endsReason, "11_years");
  assert.strictEqual(a.originalLtv, 90);
  const b = mi({ loanProgram: "fha", closeDate: "2016-07-01", originalAmount: 289500, originalValue: 300000 });
  assert.strictEqual(b.endsOn, null);
  assert.strictEqual(b.endsReason, null);
});

test("typed amount is used as is", () => {
  const r = mi({ loanProgram: "fha", closeDate: "2016-07-01", monthlyMi: 212.5 });
  assert.strictEqual(r.monthly, 212.5);
  assert.strictEqual(r.basis, "typed");
  assert.strictEqual(r.annualRate, 0.85);
});

test("USDA by fiscal year", () => {
  est({ loanProgram: "usda", closeDate: "2018-01-01" }, 87.5, 0.35);
  est({ loanProgram: "usda", closeDate: "2012-03-01" }, 75, 0.3);
  est({ loanProgram: "usda", closeDate: "2013-01-15" }, 100, 0.4);
  est({ loanProgram: "usda", closeDate: "2014-03-01" }, 100, 0.4);
  est({ loanProgram: "usda", closeDate: "2015-06-01" }, 125, 0.5);
  est({ loanProgram: "usda", closeDate: "2016-11-01" }, 87.5, 0.35);
  const old = mi({ loanProgram: "usda", closeDate: "2010-05-01" });
  assert.strictEqual(old.monthly, 0);
  assert.strictEqual(old.basis, "none");
});

test("VA and untyped conventional or jumbo", () => {
  const va = mi({ loanProgram: "va", closeDate: "2020-01-01" });
  assert.strictEqual(va.monthly, 0);
  assert.strictEqual(va.basis, "none");
  for (const p of ["conventional", "jumbo"]) {
    const r = mi({ loanProgram: p, closeDate: "2020-01-01" });
    assert.strictEqual(r.monthly, null);
    assert.strictEqual(r.basis, "none");
    assert.strictEqual(r.endsOn, null);
  }
});

test("conventional typed MI ends at 78% of the original value", () => {
  const r = mi({ loanProgram: "conventional", closeDate: "2019-05-01", monthlyMi: 95, originalAmount: 285000, originalValue: 300000 });
  assert.strictEqual(r.basis, "typed");
  assert.strictEqual(r.endsReason, "78_percent");
  const pmt = calcPayment(285000, 6.5, 30);
  let bal = 285000, n = 0;
  while (bal > 0.78 * 300000) { bal = bal * (1 + 6.5 / 1200) - pmt; n++; }
  const [y, m] = firstPaymentFromClosing("2019-05-01").split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + (n - 1), 1)).toISOString().slice(0, 10);
  assert.strictEqual(r.endsOn, d);
});

test("conventional without both originals has no end date", () => {
  const r = mi({ loanProgram: "conventional", closeDate: "2019-05-01", monthlyMi: 95 });
  assert.strictEqual(r.endsOn, null);
});

test("insurance past its end date has ended", () => {
  const f = mi({ loanProgram: "fha", closeDate: "2014-07-01", originalAmount: 270000, originalValue: 300000 });
  assert.strictEqual(f.monthly, 0);
  assert.strictEqual(f.annualRate, 0);
  assert.strictEqual(f.basis, "none");
  assert.strictEqual(f.endsOn, "2025-07-01");
  assert.strictEqual(f.endsReason, "11_years");
  const c = mi({ loanProgram: "conventional", closeDate: "2005-01-01", monthlyMi: 95, originalAmount: 270000, originalValue: 300000 });
  assert.strictEqual(c.monthly, 0);
  assert.strictEqual(c.basis, "none");
  assert.strictEqual(c.endsReason, "78_percent");
  assert.ok(c.endsOn < TODAY, c.endsOn);
});

test("endsWithinMonths", () => {
  assert.strictEqual(endsWithinMonths({ endsOn: "2027-07-01" }, TODAY, 12), true);
  assert.strictEqual(endsWithinMonths({ endsOn: "2028-07-01" }, TODAY, 12), false);
  assert.strictEqual(endsWithinMonths({ endsOn: null }, TODAY, 12), false);
});

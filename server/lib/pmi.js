"use strict";
// An estimate of the monthly mortgage insurance (PMI) a new conventional loan over 80% LTV would carry. Pure: no I/O.
//
// Source: Arch MI's rate card "Borrower-Paid Monthly, Non-Refundable Annualized BPMI Rates", effective Feb. 9, 2026 (card
// MCUS-B0283B, archmi.com/rate-sheets): fixed-rate loans, percent of the loan balance a year, paid monthly (the yearly rate over
// 12, on the loan balance). Each LTV band uses the card's highest-coverage row: the standard Fannie Mae / Freddie Mac coverage on
// a term over 20 years, and more than standard on a shorter one, so the estimate leans high. The card's top band is 95.01% to
// 97%; a higher LTV uses that row too. None of the card's adjustments (debt-to-income over 45%, two borrowers, cash-out) apply.
//
// It is an estimate for ranking who to call, never a quote. client/src/refiAnalysis.mjs mirrors this table
// (refiAnalysis.test.mjs checks the two agree).
const PMI_OVER_LTV = 80;
const DEFAULT_SCORE = 700;   // an unknown score, as lib/refi prices the rate
const SCORE_FLOORS = [760, 740, 720, 700, 680, 660, 640, 620, 0];
// [the LTV band's upper edge, percent a year for each SCORE_FLOORS column]
const OVER_20_YEARS = [
  [85, [0.19, 0.20, 0.23, 0.25, 0.28, 0.38, 0.40, 0.44, 0.62]],
  [90, [0.28, 0.38, 0.46, 0.55, 0.65, 0.90, 0.91, 0.94, 1.32]],
  [95, [0.38, 0.53, 0.66, 0.78, 0.96, 1.28, 1.33, 1.42, 1.99]],
  [Infinity, [0.58, 0.70, 0.87, 0.99, 1.21, 1.54, 1.65, 1.86, 2.60]],
];
const UP_TO_20_YEARS = [
  [85, [0.17, 0.19, 0.23, 0.23, 0.26, 0.32, 0.34, 0.41, 0.57]],
  [90, [0.25, 0.31, 0.37, 0.44, 0.51, 0.66, 0.74, 0.89, 1.25]],
  [95, [0.32, 0.43, 0.52, 0.62, 0.77, 0.95, 1.08, 1.27, 1.78]],
  [Infinity, [0.40, 0.53, 0.68, 0.80, 1.01, 1.34, 1.51, 1.72, 2.41]],
];

// Percent of the loan balance a year; 0 at or under 80% LTV (and for an LTV that isn't a number).
function pmiAnnualRate(creditScore, ltv, years) {
  if (!(ltv > PMI_OVER_LTV)) return 0;
  const score = Number(creditScore) || DEFAULT_SCORE;
  const col = SCORE_FLOORS.findIndex((floor) => score >= floor);
  const table = years <= 20 ? UP_TO_20_YEARS : OVER_20_YEARS;
  return table.find(([edge]) => ltv <= edge)[1][col];
}

// Dollars a month on `balance`, to the cent.
function pmiMonthly(creditScore, ltv, years, balance) {
  if (!(balance > 0)) return 0;
  return Math.round((pmiAnnualRate(creditScore, ltv, years) / 100 / 12) * balance * 100) / 100;
}

module.exports = { PMI_OVER_LTV, pmiAnnualRate, pmiMonthly };

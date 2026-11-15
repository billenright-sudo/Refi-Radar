// Equity helpers (3.5% annual appreciation), used by the client page's Equity Projection card, the dashboard's
// Portfolio Equity Snapshot and the client list.
export const APPRECIATION_RATE = 0.035;

// Project remaining loan balance N additional months from current balance
export function projectedBalance(balance, annualRate, loanType, additionalMonths) {
  const totalMonths = loanType === "15yr_fixed" ? 180 : 360;
  const r = annualRate / 100 / 12;
  if (r === 0) return Math.max(0, balance - (balance / totalMonths) * additionalMonths);
  const pmt = balance * (r * Math.pow(1 + r, totalMonths)) / (Math.pow(1 + r, totalMonths) - 1);
  const fut  = balance * Math.pow(1 + r, additionalMonths) - pmt * (Math.pow(1 + r, additionalMonths) - 1) / r;
  return Math.max(0, fut);
}

// Where the projection starts: today's balance and today's cautious value from the server's Upgrades block (the same
// figures the Upgrades card shows), or the stored figures when the client has none.
export function equityStart(client) {
  const t = client && client.upgrades && client.upgrades.today;
  const value = t && t.cautiousValue;
  const balance = t && t.balance;
  if (Number.isFinite(value) && value > 0 && Number.isFinite(balance) && balance >= 0) return { value, balance };
  return { value: Number(client.propertyValue), balance: Number(client.loanBalance) };
}

// The loan as the refi analysis prices it (refiAnalysis.mjs analyze): the same starting balance and value as the projection, so the
// client page, the client list and Home agree with this card. Mirrors server/lib/refi.js pricedToday.
export function pricedToday(client) {
  const start = equityStart(client);
  return { ...client, loanBalance: start.balance, propertyValue: start.value };
}

// Equity snapshot N years from now
export function equityAt(client, yearsFromNow) {
  const start    = equityStart(client);
  const months   = yearsFromNow * 12;
  const futBal   = projectedBalance(start.balance, client.currentRate, client.loanType, months);
  const futVal   = start.value * Math.pow(1 + APPRECIATION_RATE, yearsFromNow);
  const equity   = futVal - futBal;
  const ltvPct   = (futBal / futVal) * 100;
  const cashOut  = Math.max(0, futVal * 0.80 - futBal); // max cash-out at 80% LTV
  return { equity, futVal, futBal, ltvPct, equityPct: 100 - ltvPct, cashOut };
}

// Months until LTV drops below 80% (PMI removal threshold)
export function monthsToSubEightyLTV(client) {
  const start = equityStart(client);
  const currentLtv = (start.balance / start.value) * 100;
  if (currentLtv <= 80) return 0;
  for (let m = 1; m <= 360; m++) {
    const bal = projectedBalance(start.balance, client.currentRate, client.loanType, m);
    const val = start.value * Math.pow(1 + APPRECIATION_RATE, m / 12);
    if ((bal / val) * 100 <= 80) return m;
  }
  return null; // never reaches 80% in 30 years
}

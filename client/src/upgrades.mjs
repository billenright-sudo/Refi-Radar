// Pure helpers for the loan-upgrade screens (form options, badges, balance/value lines).
export const PROGRAM_OPTIONS = [["", "Not set"], ["conventional", "Conventional"], ["fha", "FHA"], ["va", "VA"], ["usda", "USDA"], ["jumbo", "Jumbo"]];
export const OCCUPANCY_OPTIONS = [["", "Not set"], ["primary", "Primary"], ["second_home", "Second home"], ["investment", "Investment"]];
export const UPGRADE_LENSES = ["fha_to_conv", "fha_streamline", "va_irrrl", "usda_to_conv", "drop_pmi"];

const PRIORITY_LABELS = { high: "High", medium: "Medium", low: "Monitor" };

// Badge for an upgrade row: drop_pmi is a goodwill call, the rest use the priority badge.
export function badgeFor(lens) {
  if (lens && lens.lens === "drop_pmi") return { label: "Goodwill", tone: "low" };
  const tone = lens && PRIORITY_LABELS[lens.priority] ? lens.priority : "low";
  return { label: PRIORITY_LABELS[tone], tone };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const roundTo = (n, step) => Math.round(n / step) * step;

export function balanceLine(today) {
  if (!today || today.balance == null) return "";
  if (today.balanceBasis !== "rolled") return `Balance ${usd(today.balance)} (as entered)`;
  const [y, m] = String(today.balanceAsOf || "").split("-");
  const when = MONTHS[Number(m) - 1] ? ` in ${MONTHS[Number(m) - 1]} ${y}` : "";
  return `Balance about ${usd(roundTo(today.balance, 100))} (rolled forward from ${usd(today.balanceFrom)}${when})`;
}

export function valueLine(today) {
  if (!today || today.valueFrom == null) return "";
  if (today.valueBasis === "typed") return `Value ${usd(today.valueFrom)} (you entered it)`;
  const est = usd(roundTo(today.cautiousValue, 1000));
  if (today.valueBasis === "flat") return `Value about ${est} (${usd(today.valueFrom)} less 10% for caution)`;
  const year = String(today.valueAsOf || "").slice(0, 4);
  return `Value about ${est} (from ${usd(today.valueFrom)}${year ? ` in ${year}` : ""}, area prices up ${Math.round(today.growthPct)}%, less 10% for caution)`;
}

// Credit score for the POST body: the integer when the field parses, else "" (the server then stores 700 and marks it not known).
export function creditScoreForPost(text) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : "";
}

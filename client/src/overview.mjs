// Overview page copy and small data helpers.
export const OVERVIEW_COPY = Object.freeze({
  refiReadyLabel: "Refi-ready today",
  refiReadySub: "Rate refis that pay back their closing costs within 3 years",
  allOppsLabel: "All opportunities",
  allOppsSub: "Includes cash-out, ARM-to-fixed and term options",
  savingsLabel: "Potential monthly savings",
  savingsSub: "Across refi-ready clients",
  dailyRates: "DAILY RATES",
  estimatedRates: "ESTIMATED RATES",
});

export const opportunityCount = (data) => {
  if (!data || data.success === false) return null;
  const n = data.counts && data.counts.withOpportunity;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

export const ratesHeading = (source) =>
  typeof source === "string" && source.startsWith("Estimated") ? OVERVIEW_COPY.estimatedRates : OVERVIEW_COPY.dailyRates;

// A tile's figure, whole, on one line: the CSS font-size for `value` in a tile that is an inline-size container (100cqi = the tile's
// content width). Short figures get `max` px; a long one shrinks until it fits the tile, never below `min` px. The figure is set in
// JetBrains Mono (each glyph 0.6em wide); 0.65 per character leaves room for rounding.
const FIGURE_EM_PER_CHAR = 0.65;
export const tileFigureSize = (value, { max = 28, min = 15 } = {}) => {
  const chars = Math.max(1, String(value ?? "").length);
  return `clamp(${min}px, calc(100cqi / ${(chars * FIGURE_EM_PER_CHAR).toFixed(2)}), ${max}px)`;
};

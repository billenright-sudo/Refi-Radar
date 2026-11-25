"use strict";
// FRED, the one primary source of the market rates: the Optimal Blue daily mortgage indices (OBMMI), computed from actual rate
// locks and published every business day (about a day behind). Used by routes/rates.js and the rate check (lib/pings/rateCheck.js).
// No database here, and no Claude call: the 5/1 ARM, which OBMMI has no index for, is the caller's to add (fredRateSet).
const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const OBMMI_SERIES = {
  rate_30yr_fixed:    "OBMMIC30YF",             // 30yr conforming
  rate_15yr_fixed:    "OBMMIC15YF",             // 15yr conforming
  rate_30yr_jumbo:    "OBMMIJUMBO30YF",         // 30yr jumbo
  rate_30yr_fha:      "OBMMIFHA30YF",           // 30yr FHA
  rate_30yr_top_tier: "OBMMIC30YFLVLE80FGE740", // 30yr, LTV<=80 FICO>=740
};
// 30yr VA, fetched on its own: it only feeds the VA IRRRL check, so when it fails the rest of the set is served without it.
const VA_SERIES = "OBMMIVA30YF";

// The valid observations of one series, newest first: FRED writes "." for a day with no value.
async function fredObservations(seriesId, fredKey, fetchImpl, signal) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=5`;
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`FRED ${seriesId} HTTP ${response.status}`);
  const data = await response.json();
  const valid = (data.observations || [])
    .filter((o) => o && o.value !== "." && Number.isFinite(parseFloat(o.value)))
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
  if (!valid.length) throw new Error(`FRED ${seriesId}: no observations`);
  return valid;
}

// -> { obmmi: { [key]: { date, value } }, va: { date, value } | null, previous30: { date, value } | null }: the latest observation of
// each OBMMI series and of VA, and the 30-year's observation before the latest one (the second valid one of the same reply).
// Throws on any OBMMI failure; a VA failure gives `va: null`.
async function fetchFredObservations({ fredKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!fredKey) throw new Error("FRED_API_KEY not configured");
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const vaFetch = fredObservations(VA_SERIES, fredKey, fetchImpl, ac.signal).catch((err) => {
      console.error(`FRED ${VA_SERIES} skipped:`, err.name === "AbortError" ? "FRED timeout" : err.message);
      return null;
    });
    const entries = await Promise.all(
      Object.entries(OBMMI_SERIES).map(async ([key, id]) => [key, await fredObservations(id, fredKey, fetchImpl, ac.signal)])
    );
    const va = await vaFetch;
    const obmmi = Object.fromEntries(entries.map(([key, list]) => [key, list[0]]));
    const thirty = entries.find(([key]) => key === "rate_30yr_fixed")[1];
    return { obmmi, va: va ? va[0] : null, previous30: thirty[1] || null };
  } finally {
    clearTimeout(timeout);
  }
}

// The rate set POST /api/rates serves from one fetch: the exact object it has always built. `arm` and `armSource` are the caller's.
function fredRateSet(obs, { arm, armSource }) {
  const { obmmi, va } = obs;
  return {
    rate_30yr_fixed: obmmi.rate_30yr_fixed.value,
    rate_15yr_fixed: obmmi.rate_15yr_fixed.value,
    rate_5_1_arm: arm,
    rate_30yr_jumbo: obmmi.rate_30yr_jumbo.value,
    rate_30yr_fha: obmmi.rate_30yr_fha.value,
    ...(va ? { rate_30yr_va: va.value } : {}),
    rate_30yr_top_tier: obmmi.rate_30yr_top_tier.value,
    date: obmmi.rate_30yr_fixed.date,
    source: `Optimal Blue lock data (${obmmi.rate_30yr_fixed.date}) · ${armSource}`,
  };
}

// Whether every OBMMI series carries the 30-year's date. A partial publish (some series already on the new day, some not) is not one
// observation: its numbers would mix two days.
function sameObservation(obs) {
  const day = obs && obs.obmmi && obs.obmmi.rate_30yr_fixed && obs.obmmi.rate_30yr_fixed.date;
  return Boolean(day) && Object.keys(OBMMI_SERIES).every((key) => obs.obmmi[key] && obs.obmmi[key].date === day);
}

module.exports = { FRED_BASE, OBMMI_SERIES, VA_SERIES, fetchFredObservations, fredRateSet, sameObservation };

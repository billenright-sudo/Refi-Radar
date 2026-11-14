"use strict";
// Home-price index lookups over a compact FHFA 3-digit-ZIP snapshot (lib/hpiData.json, refreshed by scripts/update-hpi.js).
// Pure: no clock, no network. A ZIP3 missing from the data means no growth (the caller stays flat).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})Q([1-4])$/;

// "2021-06-30" -> "2021Q2"; null for an unreadable date.
function quarterOf(date) {
  const m = DATE_RE.exec(String(date || ""));
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}Q${Math.floor((mo - 1) / 3) + 1}`;
}

const qNum = (q) => {
  const m = QUARTER_RE.exec(String(q || ""));
  return m ? Number(m[1]) * 4 + Number(m[2]) - 1 : null;
};

function createIndex(data) {
  const start = qNum(data && data.start);
  const end = qNum(data && data.end);
  const zip3 = (data && data.zip3) || {};
  const ready = start !== null && end !== null && end >= start;
  return {
    latestQuarter: ready ? data.end : null,
    growth(zip, fromDate, toDate) {
      if (!ready) return null;
      const z = String(zip == null ? "" : zip).trim();
      if (!/^\d{5}(-\d{4})?$/.test(z)) return null;
      const area = z.slice(0, 3);
      const series = zip3[area];
      if (!Array.isArray(series)) return null;
      const fq = quarterOf(fromDate);
      const from = qNum(fq);
      if (from === null || from < start) return null;
      const tq = quarterOf(toDate);
      const to = Math.min(end, tq ? qNum(tq) : end);
      if (from >= end || to <= from) return { factor: 1, area, fromQuarter: fq, toQuarter: data.end };
      const a = series[from - start];
      const b = series[to - start];
      if (!(typeof a === "number" && a > 0 && typeof b === "number" && b > 0)) return null;
      return { factor: b / a, area, fromQuarter: fq, toQuarter: `${Math.floor(to / 4)}Q${(to % 4) + 1}` };
    },
  };
}

const defaultIndex = createIndex(require("./hpiData.json"));

module.exports = { createIndex, defaultIndex, quarterOf };

import { useState, useEffect, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Loan helpers
// ---------------------------------------------------------------------------
const LOAN_LABELS = { "30yr_fixed": "30-Yr Fixed", "15yr_fixed": "15-Yr Fixed", "5_1_arm": "5/1 ARM" };

const calcPayment = (p, annualRate, years) => {
  const r = annualRate / 100 / 12, n = years * 12;
  if (r === 0) return p / n;
  return p * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
};

// Estimated loan-level pricing adjustments (rate-term refi, conventional).
// Price hits as % of loan amount by credit-score band × LTV band, simplified
// from the agency LLPA matrix. Converted to a rate adjustment at the customary
// 4:1 price-to-rate ratio and rounded to the nearest eighth — an estimate for
// prioritizing outreach, not a quote.
const LLPA_LTV_BREAKS = [30, 60, 70, 75, 80, 85, 90, 95];
const LLPA_GRID = [
  [780, [0,     0,     0,     0,     0.375, 0.375, 0.25,  0.25,  0.125]],
  [760, [0,     0,     0,     0.25,  0.625, 0.625, 0.5,   0.5,   0.25 ]],
  [740, [0,     0,     0.125, 0.375, 0.875, 1.0,   0.75,  0.625, 0.5  ]],
  [720, [0,     0,     0.25,  0.75,  1.25,  1.25,  1.0,   0.875, 0.75 ]],
  [700, [0,     0,     0.375, 0.875, 1.375, 1.5,   1.25,  1.125, 0.875]],
  [680, [0,     0,     0.625, 1.125, 1.75,  1.875, 1.5,   1.375, 1.125]],
  [660, [0,     0,     0.75,  1.375, 1.875, 2.125, 1.75,  1.625, 1.25 ]],
  [640, [0,     0,     1.125, 1.5,   2.25,  2.5,   2.0,   1.875, 1.5  ]],
  [0,   [0,     0.125, 1.5,   2.125, 2.75,  3.0,   2.5,   2.25,  1.75 ]],
];

const llpaPrice = (creditScore, ltv) => {
  const score = creditScore || 700;
  const row = LLPA_GRID.find(([floor]) => score >= floor)[1];
  let col = LLPA_LTV_BREAKS.findIndex((b) => ltv <= b);
  if (col === -1) col = LLPA_LTV_BREAKS.length;
  return row[col];
};

const roundEighth = (x) => Math.round(x / 0.125) * 0.125;

// The Optimal Blue top-tier index (LTV≤80, FICO≥740) is an observed lock rate
// whose cohort mix already embeds roughly this much LLPA price; adjustments
// for other borrowers are applied relative to it, not on top of it.
const LLPA_TOP_TIER_EMBEDDED = 0.25;

// Closing costs: fixed costs (title, appraisal, recording) plus 1% of balance
// (origination) — tracks typical refi costs better than a flat percentage.
const estClosingCosts = (balance) => 2500 + balance * 0.01;

const analyze = (client, rates) => {
  if (!rates) return null;
  const rMap = { "30yr_fixed": rates.rate_30yr_fixed, "15yr_fixed": rates.rate_15yr_fixed, "5_1_arm": rates.rate_5_1_arm };
  const mktRate = rMap[client.loanType];
  if (!mktRate) return null;
  const years = client.loanType === "15yr_fixed" ? 15 : 30;
  const ltv = (client.loanBalance / client.propertyValue) * 100;
  const score = client.creditScore || 700;
  const priceHit = llpaPrice(score, ltv);

  // 30yr clients anchor to the observed top-tier lock rate when available:
  // top-tier borrowers get the real cohort rate (no estimate), others get it
  // plus pricing relative to what the index already embeds. 15yr/ARM have no
  // top-tier index, so they use the average rate + absolute pricing estimate.
  const topTier = client.loanType === "30yr_fixed" ? rates.rate_30yr_top_tier : null;
  let base, baseLabel, rateAdj;
  if (topTier) {
    const isTopTier = score >= 740 && ltv <= 80;
    base = topTier;
    baseLabel = "top-tier";
    rateAdj = isTopTier ? 0 : roundEighth(Math.max(0, priceHit - LLPA_TOP_TIER_EMBEDDED) / 4);
  } else {
    base = mktRate;
    baseLabel = "market";
    rateAdj = roundEighth(priceHit / 4);
  }
  const effRate = base + rateAdj;
  const rateDelta = client.currentRate - effRate;
  const curPmt = calcPayment(client.loanBalance, client.currentRate, years);
  const newPmt = calcPayment(client.loanBalance, effRate, years);
  const monthlySavings = curPmt - newPmt;
  const annualSavings = monthlySavings * 12;
  const closingCosts = estClosingCosts(client.loanBalance);
  const breakEven = monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : 9999;
  const good = rateDelta >= 0.5 && breakEven <= 36 && monthlySavings > 0 && ltv <= 95;
  return { mktRate, base, baseLabel, effRate, rateAdj, rateDelta, curPmt, newPmt, monthlySavings, annualSavings, closingCosts, breakEven, ltv, good, priority: good ? (rateDelta >= 1.0 ? "high" : "medium") : "low" };
};

const $c = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const $r = (n) => `${(+n).toFixed(2)}%`;

// ---------------------------------------------------------------------------
// Equity helpers (3.5% annual appreciation)
// ---------------------------------------------------------------------------
const APPRECIATION_RATE = 0.035;

// Project remaining loan balance N additional months from current balance
function projectedBalance(balance, annualRate, loanType, additionalMonths) {
  const totalMonths = loanType === "15yr_fixed" ? 180 : 360;
  const r = annualRate / 100 / 12;
  if (r === 0) return Math.max(0, balance - (balance / totalMonths) * additionalMonths);
  const pmt = balance * (r * Math.pow(1 + r, totalMonths)) / (Math.pow(1 + r, totalMonths) - 1);
  const fut  = balance * Math.pow(1 + r, additionalMonths) - pmt * (Math.pow(1 + r, additionalMonths) - 1) / r;
  return Math.max(0, fut);
}

// Equity snapshot N years from now
function equityAt(client, yearsFromNow) {
  const months   = yearsFromNow * 12;
  const futBal   = projectedBalance(client.loanBalance, client.currentRate, client.loanType, months);
  const futVal   = client.propertyValue * Math.pow(1 + APPRECIATION_RATE, yearsFromNow);
  const equity   = futVal - futBal;
  const ltvPct   = (futBal / futVal) * 100;
  const cashOut  = Math.max(0, futVal * 0.80 - futBal); // max cash-out at 80% LTV
  return { equity, futVal, futBal, ltvPct, equityPct: 100 - ltvPct, cashOut };
}

// Months until LTV drops below 80% (PMI removal threshold)
function monthsToSubEightyLTV(client) {
  const currentLtv = (client.loanBalance / client.propertyValue) * 100;
  if (currentLtv <= 80) return 0;
  for (let m = 1; m <= 360; m++) {
    const bal = projectedBalance(client.loanBalance, client.currentRate, client.loanType, m);
    const val = client.propertyValue * Math.pow(1 + APPRECIATION_RATE, m / 12);
    if ((bal / val) * 100 <= 80) return m;
  }
  return null; // never reaches 80% in 30 years
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const C = {
  bg: "#07111f", surface: "#0b1928", surfaceHi: "#0f2035",
  border: "#193048", text: "#dce9f5", muted: "#5a7a99", mutedHi: "#8aafc9",
  amber: "#f59e0b", amberBg: "#1a1200",
  green: "#22c55e", greenBg: "#041a0e",
  red: "#f87171", redBg: "#200b0b",
  blue: "#60a5fa", purple: "#a78bfa",
};

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "1.5rem" };
const mono = { fontFamily: "'JetBrains Mono', monospace" };
const inputStyle = { background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", color: C.text, fontFamily: "inherit", fontSize: 14, width: "100%", outline: "none", boxSizing: "border-box" };
const btnPrimary = { background: C.amber, color: "#000", border: "none", borderRadius: 8, padding: "11px 24px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 20px", fontSize: 14, cursor: "pointer", fontFamily: "inherit" };
const btnDanger = { background: C.redBg, color: C.red, border: `1px solid #4a1414`, borderRadius: 8, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };

// ---------------------------------------------------------------------------
// Micro components
// ---------------------------------------------------------------------------
const Icon = ({ name, size = 18, color = "currentColor" }) => {
  const paths = {
    dashboard: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
    users:     "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    trending:  "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
    plus:      "M12 5v14M5 12h14",
    refresh:   "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
    arrow:     "M19 12H5M12 5l-7 7 7 7",
    check:     "M20 6L9 17l-5-5",
    phone:     "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.07 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.12 6.13l1.32-1.32a2 2 0 0 1 2.11-.45c.9.364 1.84.6 2.8.7A2 2 0 0 1 22 16.92z",
    mail:      "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
    alert:     "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
    star:      "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2",
    edit:      "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
    trash:     "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
    search:    "M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
    x:         "M18 6L6 18M6 6l12 12",
    bell:      "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
    upload:    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
    logout:    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
};

const PriorityBadge = ({ priority, good }) => {
  if (!good) return <span style={{ color: C.muted, fontSize: 12, fontWeight: 600 }}>Monitoring</span>;
  const cfg = priority === "high"
    ? { bg: C.redBg, color: C.red, label: "🔥 High Priority" }
    : { bg: C.amberBg, color: C.amber, label: "⚡ Refi Ready" };
  return <span style={{ background: cfg.bg, color: cfg.color, borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{cfg.label}</span>;
};

const TreasurySparkline = ({ history }) => {
  if (!history || history.length < 2) return null;
  const vals = history.map(h => h.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 0.01;
  const W = 140, H = 40;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={C.purple} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

const TreasuryWidget = ({ treasury }) => {
  if (!treasury) return null;
  const { current, previous, history } = treasury;
  const delta = current && previous ? (current.value - previous.value) : null;
  const isUp = delta > 0, isDown = delta < 0;
  const deltaColor = isUp ? C.red : isDown ? C.green : C.muted;
  const deltaLabel = delta !== null ? `${isUp ? "▲" : "▼"} ${Math.abs(delta).toFixed(2)}` : "";
  return (
    <div style={{ ...card, background: "#0d0a1f", borderColor: "#2a1f4a", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
      <div>
        <div style={{ color: C.purple, fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 6 }}>📈 10-Year Treasury Yield</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ ...mono, fontSize: 32, fontWeight: 700, color: C.purple }}>{current ? `${current.value.toFixed(2)}%` : "—"}</span>
          {deltaLabel && <span style={{ ...mono, fontSize: 14, fontWeight: 600, color: deltaColor }}>{deltaLabel}</span>}
        </div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{current?.date} · Federal Reserve (FRED)</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ color: C.muted, fontSize: 11, marginBottom: 8 }}>30-day trend</div>
        <TreasurySparkline history={history} />
        <div style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>Mortgage rates follow the 10-yr</div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Notification Bell
// ---------------------------------------------------------------------------
const NotificationBell = () => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const dropRef = useRef(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count");
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.count || 0);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    const iv = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(iv);
  }, [fetchUnreadCount]);

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const openBell = async () => {
    setOpen(prev => !prev);
    if (!open) {
      setLoadingNotifs(true);
      try {
        const res = await fetch("/api/notifications");
        if (res.ok) {
          const data = await res.json();
          setNotifications(Array.isArray(data.notifications) ? data.notifications.slice(0, 10) : []);
        }
      } catch { /* silent */ } finally {
        setLoadingNotifs(false);
      }
    }
  };

  const markAllRead = async () => {
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch { /* silent */ }
  };

  const timeAgo = (ts) => {
    if (!ts) return "";
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  return (
    <div ref={dropRef} style={{ position: "relative" }}>
      <button
        onClick={openBell}
        style={{ position: "relative", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer", color: C.mutedHi, display: "flex", alignItems: "center" }}
      >
        <Icon name="bell" size={18} color={C.mutedHi} />
        {unreadCount > 0 && (
          <span style={{ position: "absolute", top: -5, right: -5, background: C.red, color: "#fff", borderRadius: "50%", width: 18, height: 18, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 360, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 1000 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{ background: "none", border: "none", color: C.amber, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {loadingNotifs ? (
              <div style={{ padding: "2rem", textAlign: "center", color: C.muted, fontSize: 13 }}>Loading…</div>
            ) : notifications.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", color: C.muted, fontSize: 13 }}>No notifications yet</div>
            ) : notifications.map((n, i) => (
              <div key={n.id || i} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: n.read ? "transparent" : `${C.surfaceHi}` }}>
                {!n.read && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: C.amber, marginRight: 8, verticalAlign: "middle" }} />}
                <div style={{ color: C.text, fontSize: 13, marginBottom: 3 }}>{n.message || n.body || "New notification"}</div>
                <div style={{ color: C.muted, fontSize: 11 }}>{timeAgo(n.createdAt || n.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
const RefiRadarLogo = () => (
  <div style={{ marginBottom: "1.5rem" }}>
    <svg width="204" height="96" viewBox="0 0 680 320" xmlns="http://www.w3.org/2000/svg" style={{ display: "block", width: "100%" }}>
      <rect x="0" y="0" width="680" height="320" rx="12" fill="#07111f"/>
      <g transform="translate(340, 155)">
        <circle cx="0" cy="0" r="148" fill="none" stroke="#4a7a9b" strokeWidth="1.2" opacity="0.35"/>
        <circle cx="0" cy="0" r="120" fill="none" stroke="#4a7a9b" strokeWidth="1.2" opacity="0.45"/>
        <circle cx="0" cy="0" r="90"  fill="none" stroke="#5a8aab" strokeWidth="1.5" opacity="0.55"/>
        <circle cx="0" cy="0" r="62"  fill="none" stroke="#6a9abb" strokeWidth="1.5" opacity="0.65"/>
        <circle cx="0" cy="0" r="36"  fill="none" stroke="#7aaacb" strokeWidth="2"   opacity="0.75"/>
        <line x1="-148" y1="0" x2="148" y2="0" stroke="#4a7a9b" strokeWidth="0.75" opacity="0.4"/>
        <line x1="0" y1="-148" x2="0" y2="148" stroke="#4a7a9b" strokeWidth="0.75" opacity="0.4"/>
        <line x1="-105" y1="-105" x2="105" y2="105" stroke="#4a7a9b" strokeWidth="0.4" opacity="0.2"/>
        <line x1="105" y1="-105" x2="-105" y2="105" stroke="#4a7a9b" strokeWidth="0.4" opacity="0.2"/>
        <line x1="0" y1="0" x2="126" y2="-75" stroke="#8aafc9" strokeWidth="1.5" opacity="0.7"/>
        <path d="M0 0 L126 -75 A148 148 0 0 0 80 -124 Z" fill="#8aafc9" opacity="0.04"/>
        <circle cx="100" cy="-58" r="6"  fill="#8aafc9" opacity="0.85"/>
        <circle cx="100" cy="-58" r="11" fill="none" stroke="#8aafc9" strokeWidth="1" opacity="0.3"/>
        <circle cx="54"  cy="34"  r="4.5" fill="#8aafc9" opacity="0.55"/>
        <circle cx="-70" cy="-44" r="3.5" fill="#8aafc9" opacity="0.4"/>
        <circle cx="-30" cy="80"  r="3"   fill="#8aafc9" opacity="0.3"/>
        <circle cx="0"   cy="0"   r="4"   fill="#8aafc9" opacity="0.8"/>
        <circle cx="0"   cy="0"   r="8"   fill="none" stroke="#8aafc9" strokeWidth="1" opacity="0.3"/>
      </g>
      <text x="340" y="140" textAnchor="middle" fontFamily="Georgia, serif" fontSize="62" fontWeight="700" fill="#f59e0b" letterSpacing="-1">RefiRadar&#8482;</text>
      <line x1="80"  y1="162" x2="205" y2="162" stroke="#193048" strokeWidth="0.75"/>
      <line x1="475" y1="162" x2="600" y2="162" stroke="#193048" strokeWidth="0.75"/>
      <text x="340" y="175" textAnchor="middle" fontFamily="Georgia, serif" fontSize="13" fill="#8aafc9" letterSpacing="6">BROKER INTELLIGENCE PLATFORM</text>
      <text x="340" y="210" textAnchor="middle" fontFamily="sans-serif" fontSize="10" fill="#5a7a99" letterSpacing="3">A PRODUCT OF IGNITE BUSINESS SOLUTIONS</text>
    </svg>
  </div>
);

const Sidebar = ({ view, setView, refiCount, user, onLogout }) => {
  const nav = [
    { id: "dashboard", label: "Dashboard",      icon: "dashboard" },
    { id: "clients",   label: "All Clients",    icon: "users" },
    { id: "rates",     label: "Rate Watch",     icon: "trending" },
    { id: "add",       label: "Add Client",     icon: "plus" },
  ];

  const brokerNav = user?.role === "broker" ? [
    { id: "team",   label: "My Team",         icon: "users" },
    { id: "import", label: "Import Clients",  icon: "upload" },
  ] : [];

  const isBrokerActive = (id) => {
    if (id === "team") return view === "team" || view === "lo-portal";
    return view === id;
  };

  const initials = user ? `${(user.firstName || "?")[0]}${(user.lastName || "?")[0]}`.toUpperCase() : "??";
  const shortName = user ? `${user.firstName} ${(user.lastName || "")[0]}.` : "";

  return (
    <aside style={{ width: 220, minHeight: "100vh", background: C.bg, borderRight: `1px solid ${C.border}`, padding: "1.5rem 1rem", display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <RefiRadarLogo />
      {nav.map(({ id, label, icon }) => {
        const active = view === id || (view === "client-detail" && id === "clients") || (view === "edit" && id === "clients");
        return (
          <button key={id} onClick={() => setView(id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, background: active ? C.surfaceHi : "transparent", color: active ? C.text : C.muted, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: active ? 600 : 400, marginBottom: 4, width: "100%", textAlign: "left" }}>
            <Icon name={icon} size={16} color={active ? C.amber : C.muted} />
            {label}
            {id === "clients" && refiCount > 0 && (
              <span style={{ marginLeft: "auto", background: C.red, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>{refiCount}</span>
            )}
          </button>
        );
      })}

      {brokerNav.length > 0 && (
        <>
          <div style={{ borderTop: `1px solid ${C.border}`, margin: "8px 0" }} />
          {brokerNav.map(({ id, label, icon }) => {
            const active = isBrokerActive(id);
            return (
              <button key={id} onClick={() => setView(id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, background: active ? C.surfaceHi : "transparent", color: active ? C.text : C.muted, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: active ? 600 : 400, marginBottom: 4, width: "100%", textAlign: "left" }}>
                <Icon name={icon} size={16} color={active ? C.amber : C.muted} />
                {label}
              </button>
            );
          })}
        </>
      )}

      <div style={{ marginTop: "auto" }}>
        {user && (
          <div style={{ padding: "10px 8px", borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.amber, color: "#000", fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: C.text, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortName}</div>
              <div style={{ color: C.muted, fontSize: 11, textTransform: "capitalize" }}>{user.role}</div>
            </div>
            <button onClick={onLogout} title="Sign out" style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, padding: 4, display: "flex", alignItems: "center" }}>
              <Icon name="logout" size={15} color={C.muted} />
            </button>
          </div>
        )}
        <div style={{ padding: "0.5rem", borderTop: `1px solid ${C.border}` }}>
          <div style={{ color: C.muted, fontSize: 11, textAlign: "center" }}>© 2025 RefiRadar</div>
        </div>
      </div>
    </aside>
  );
};

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------
const AuthCard = ({ children }) => (
  <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
    <div style={{ width: "100%", maxWidth: 440 }}>
      <div style={{ marginBottom: "2rem", textAlign: "center" }}>
        <RefiRadarLogo />
      </div>
      <div style={{ ...card }}>
        {children}
      </div>
    </div>
  </div>
);

const AuthField = ({ label, type = "text", value, onChange, placeholder, disabled, readOnly }) => (
  <div style={{ marginBottom: "1rem" }}>
    <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</label>
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      style={{ ...inputStyle, opacity: (disabled || readOnly) ? 0.6 : 1, cursor: readOnly ? "default" : "text" }}
    />
  </div>
);

const LoginPage = ({ onLogin, goRegister }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || data.error || "Invalid credentials"); return; }
      onLogin(data.user);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: "1.5rem", textAlign: "center" }}>Sign In</h2>
      {error && (
        <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="alert" size={14} color={C.red} /> {error}
        </div>
      )}
      <form onSubmit={submit}>
        <AuthField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" disabled={loading} />
        <AuthField label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" disabled={loading} />
        <button type="submit" disabled={loading} style={{ ...btnPrimary, width: "100%", marginTop: 8, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>
      <div style={{ textAlign: "center", marginTop: "1.25rem", fontSize: 13, color: C.muted }}>
        Don't have an account?{" "}
        <button onClick={goRegister} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Register your brokerage
        </button>
      </div>
    </AuthCard>
  );
};

const RegisterPage = ({ onLogin, goLogin }) => {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", orgName: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || data.error || "Registration failed"); return; }
      onLogin(data.user);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: "1.5rem", textAlign: "center" }}>Start Your Free Trial</h2>
      {error && (
        <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="alert" size={14} color={C.red} /> {error}
        </div>
      )}
      <form onSubmit={submit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1rem" }}>
          <AuthField label="First Name" value={form.firstName} onChange={e => set("firstName", e.target.value)} placeholder="Bill" disabled={loading} />
          <AuthField label="Last Name" value={form.lastName} onChange={e => set("lastName", e.target.value)} placeholder="Enright" disabled={loading} />
        </div>
        <AuthField label="Email" type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="you@yourbrokerage.com" disabled={loading} />
        <AuthField label="Password" type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder="Choose a strong password" disabled={loading} />
        <AuthField label="Brokerage Name" value={form.orgName} onChange={e => set("orgName", e.target.value)} placeholder="Premier Mortgage Group" disabled={loading} />
        <div style={{ fontSize: 11, color: C.muted, marginBottom: "1rem" }}>Your company name — e.g. Premier Mortgage Group</div>
        <button type="submit" disabled={loading} style={{ ...btnPrimary, width: "100%", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Creating account…" : "Start 14-Day Free Trial"}
        </button>
      </form>
      <div style={{ textAlign: "center", marginTop: "1.25rem", fontSize: 13, color: C.muted }}>
        Already have an account?{" "}
        <button onClick={goLogin} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Sign in
        </button>
      </div>
    </AuthCard>
  );
};

const AcceptInvitePage = ({ token, onLogin }) => {
  const [inviteInfo, setInviteInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [inviteError, setInviteError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/auth/invite/${token}`);
        const data = await res.json();
        if (!res.ok) { setInviteError(data.message || "Invalid or expired invite link"); return; }
        setInviteInfo(data);
      } catch {
        setInviteError("Could not load invite details");
      } finally {
        setLoadingInfo(false);
      }
    };
    load();
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setSubmitError("Passwords do not match"); return; }
    if (password.length < 8) { setSubmitError("Password must be at least 8 characters"); return; }
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setSubmitError(data.message || data.error || "Failed to accept invite"); return; }
      window.history.replaceState({}, "", "/");
      onLogin(data.user);
    } catch {
      setSubmitError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingInfo) {
    return (
      <AuthCard>
        <div style={{ textAlign: "center", color: C.muted, padding: "2rem" }}>Loading invite details…</div>
      </AuthCard>
    );
  }

  if (inviteError) {
    return (
      <AuthCard>
        <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "1rem", color: C.red, textAlign: "center" }}>
          <Icon name="alert" size={16} color={C.red} />
          <div style={{ marginTop: 8 }}>{inviteError}</div>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
        <div style={{ color: C.amber, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>You've been invited to join</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{inviteInfo?.orgName}</h2>
      </div>
      <div style={{ background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: "1.25rem" }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Name</div>
        <div style={{ color: C.text, fontWeight: 600 }}>{inviteInfo?.firstName} {inviteInfo?.lastName}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 8, marginBottom: 4 }}>Email</div>
        <div style={{ color: C.text }}>{inviteInfo?.email}</div>
      </div>
      {submitError && (
        <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem" }}>
          {submitError}
        </div>
      )}
      <form onSubmit={submit}>
        <AuthField label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Choose a strong password" disabled={submitting} />
        <AuthField label="Confirm Password" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat password" disabled={submitting} />
        <button type="submit" disabled={submitting} style={{ ...btnPrimary, width: "100%", opacity: submitting ? 0.6 : 1 }}>
          {submitting ? "Joining…" : "Set Password & Join"}
        </button>
      </form>
    </AuthCard>
  );
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const StatCard = ({ label, value, sub, accent }) => (
  <div style={{ ...card, flex: 1 }}>
    <div style={{ color: C.muted, fontSize: 12, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
    <div style={{ ...mono, fontSize: 28, fontWeight: 700, color: accent || C.text, marginBottom: 4 }}>{value}</div>
    {sub && <div style={{ color: C.muted, fontSize: 13 }}>{sub}</div>}
  </div>
);

const OpportunityRow = ({ client, a, onClick }) => (
  <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "1rem 1.25rem", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surfaceHi, marginBottom: 8, cursor: "pointer" }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 600, color: C.text, marginBottom: 2 }}>{client.name}</div>
      <div style={{ fontSize: 13, color: C.muted }}>{LOAN_LABELS[client.loanType]} · {$c(client.loanBalance)} balance</div>
    </div>
    <div style={{ textAlign: "right" }}>
      <div style={{ ...mono, color: C.green, fontWeight: 700, fontSize: 18 }}>{$c(a.monthlySavings)}<span style={{ fontSize: 12, fontWeight: 400 }}>/mo</span></div>
      <div style={{ fontSize: 12, color: C.muted }}>saves {$r(a.rateDelta)} rate</div>
    </div>
    <PriorityBadge priority={a.priority} good={a.good} />
    <div style={{ color: C.muted }}>›</div>
  </div>
);

const OrgStatsCard = () => {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    fetch("/api/org/stats").then(r => r.ok ? r.json() : null).then(d => { if (d) setStats(d); }).catch(() => {});
  }, []);
  if (!stats) return null;

  const trialEnd = stats.trialEnds ? new Date(stats.trialEnds).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <div style={{ ...card, background: "#0a1525", borderColor: "#1e3a5a", marginBottom: "1.5rem", display: "flex", gap: "2rem", alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ color: C.blue, fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase" }}>Shop Overview</div>
      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: C.text }}>{stats.loCount ?? 0}</span>
          <span style={{ color: C.muted, fontSize: 13, marginLeft: 6 }}>Loan Officers</span>
        </div>
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: C.text }}>{stats.totalClients ?? 0}</span>
          <span style={{ color: C.muted, fontSize: 13, marginLeft: 6 }}>Total Clients</span>
        </div>
        {stats.plan && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: C.amberBg, color: C.amber, borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
              {stats.plan === "trial" ? "Trial" : stats.plan}
            </span>
            {trialEnd && <span style={{ color: C.muted, fontSize: 12 }}>expires {trialEnd}</span>}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Portfolio Equity Card (dashboard)
// ---------------------------------------------------------------------------
const PortfolioEquityCard = ({ clients, clientsLoading }) => {
  if (clientsLoading) return null;
  if (!clients || clients.length === 0) return null;

  const now5 = clients.map(c => ({
    now:  equityAt(c, 0),
    yr5:  equityAt(c, 5),
  }));

  const totalEquityNow    = now5.reduce((s, e) => s + e.now.equity, 0);
  const totalEquity5yr    = now5.reduce((s, e) => s + e.yr5.equity, 0);
  const totalCashOut      = now5.reduce((s, e) => s + e.now.cashOut, 0);
  const gain5yr           = totalEquity5yr - totalEquityNow;
  const avgLtv            = now5.reduce((s, e) => s + e.now.ltvPct, 0) / now5.length;

  // LTV health bar color
  const ltvColor = avgLtv > 85 ? C.red : avgLtv > 75 ? C.amber : C.green;

  return (
    <div style={{ ...card, background: "#0a1628", borderColor: "#1e3a5f", marginBottom: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <div style={{ color: C.blue, fontSize: 12, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          🏡 Portfolio Equity Snapshot · 3.5% Annual Appreciation
        </div>
        <div style={{ color: C.muted, fontSize: 12 }}>{clients.length} clients</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "1.5rem", marginBottom: "1.25rem" }}>
        {[
          ["Total Equity Today",      $c(totalEquityNow),  C.blue,   "combined across portfolio"],
          ["Projected in 5 Years",    $c(totalEquity5yr),  C.purple, `+${$c(gain5yr)} projected gain`],
          ["Cash-Out Potential",      $c(totalCashOut),    C.green,  "available at 80% LTV today"],
          ["Avg Portfolio LTV",       `${avgLtv.toFixed(1)}%`, ltvColor, avgLtv <= 80 ? "below PMI threshold" : "above 80% — PMI zone"],
        ].map(([label, val, accent, sub]) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
            <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: accent, marginBottom: 2 }}>{val}</div>
            <div style={{ fontSize: 12, color: C.muted }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* LTV distribution bar */}
      <div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>LTV Distribution</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {now5.map((e, i) => {
            const ltv = e.now.ltvPct;
            const col = ltv > 85 ? C.red : ltv > 75 ? C.amber : C.green;
            return (
              <div key={i} title={`${clients[i]?.name}: ${ltv.toFixed(1)}% LTV`}
                style={{ flex: 1, height: 8, borderRadius: 4, background: col, opacity: 0.75 }} />
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 4 }}>
          <span><span style={{ color: C.green }}>■</span> &lt;75% LTV (strong)</span>
          <span><span style={{ color: C.amber }}>■</span> 75–85% (watch)</span>
          <span><span style={{ color: C.red }}>■</span> &gt;85% (PMI / high risk)</span>
        </div>
      </div>
    </div>
  );
};

const Dashboard = ({ scored, refiReady, rates, ratesLoading, totalSavings, fetchRates, setView, setSelected, treasury, clientsLoading, user }) => {
  const topOpps = scored.filter(c => c.a?.good).slice(0, 5);
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const greeting = `Good ${timeOfDay}, ${user?.firstName || "there"} 👋`;

  return (
    <div style={{ animation: "fadeIn 0.35s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: C.text, marginBottom: 4 }}>{greeting}</h1>
          <div style={{ color: C.muted, fontSize: 14 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
        </div>
        <button onClick={fetchRates} disabled={ratesLoading} style={{ display: "flex", alignItems: "center", gap: 8, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 16px", color: C.muted, fontFamily: "inherit", fontSize: 13, cursor: "pointer" }}>
          <Icon name="refresh" size={14} color={ratesLoading ? C.amber : C.muted} />
          {ratesLoading ? "Fetching rates..." : "Refresh Rates"}
        </button>
      </div>

      {user?.role === "broker" && <OrgStatsCard />}

      <TreasuryWidget treasury={treasury} />

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <StatCard label="Refi Opportunities" value={ratesLoading || clientsLoading ? "—" : refiReady.length} sub="clients ready today" accent={refiReady.length > 0 ? C.amber : C.muted} />
        <StatCard label="Potential Monthly Savings" value={ratesLoading || clientsLoading ? "—" : $c(totalSavings / 12)} sub="across all opportunities" accent={C.green} />
        <StatCard label="Total Portfolio" value={clientsLoading ? "—" : scored.length} sub="clients tracked" />
        <StatCard label="Live Rate (30-Yr)" value={ratesLoading ? "Loading..." : (rates ? $r(rates.rate_30yr_fixed) : "—")} sub={rates?.source || "national average"} accent={C.blue} />
      </div>

      {/* Equity tile row */}
      {!clientsLoading && scored.length > 0 && (() => {
        const totalEquity   = scored.reduce((s, c) => s + equityAt(c, 0).equity, 0);
        const equity5yr     = scored.reduce((s, c) => s + equityAt(c, 5).equity, 0);
        const totalCashOut  = scored.reduce((s, c) => s + equityAt(c, 0).cashOut, 0);
        const avgLtv        = scored.reduce((s, c) => s + equityAt(c, 0).ltvPct, 0) / scored.length;
        const ltvColor      = avgLtv > 85 ? C.red : avgLtv > 75 ? C.amber : C.green;
        return (
          <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem" }}>
            <StatCard label="🏡 Portfolio Equity" value={$c(totalEquity)} sub="combined today · 3.5%/yr" accent={C.blue} />
            <StatCard label="📈 Equity in 5 Years" value={$c(equity5yr)} sub={`+${$c(equity5yr - totalEquity)} projected gain`} accent={C.purple} />
            <StatCard label="💰 Cash-Out Potential" value={$c(totalCashOut)} sub="available at 80% LTV" accent={C.green} />
            <StatCard label="📊 Avg Portfolio LTV" value={`${avgLtv.toFixed(1)}%`} sub={avgLtv <= 80 ? "below PMI threshold ✓" : "above 80% — PMI zone"} accent={ltvColor} />
          </div>
        );
      })()}

      {rates && !ratesLoading && (
        <div style={{ ...card, display: "flex", gap: "2rem", alignItems: "center", flexWrap: "wrap", marginBottom: "2rem", background: C.amberBg, borderColor: "#3a2800" }}>
          <div style={{ color: C.amber, fontSize: 12, fontWeight: 700, letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: rates.source?.startsWith("Estimated") ? C.muted : C.green, display: "inline-block" }} />
            {rates.source?.startsWith("Estimated") ? "ESTIMATED RATES" : "LIVE RATES"}
          </div>
          {[["30-Yr Fixed", rates.rate_30yr_fixed], ["15-Yr Fixed", rates.rate_15yr_fixed], ["5/1 ARM", rates.rate_5_1_arm]].map(([label, val]) => (
            <div key={label} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              <span style={{ ...mono, color: C.amber, fontWeight: 700, fontSize: 18 }}>{$r(val)}</span>
            </div>
          ))}
          <div style={{ marginLeft: "auto", color: C.muted, fontSize: 12 }}>via {rates.source}</div>
        </div>
      )}

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Top Refi Opportunities</h2>
          {refiReady.length > 5 && <button onClick={() => setView("clients")} style={{ color: C.amber, fontSize: 13, background: "none", border: "none", cursor: "pointer" }}>View all →</button>}
        </div>
        {ratesLoading || clientsLoading ? (
          <div style={{ ...card, textAlign: "center", padding: "3rem", color: C.muted }}>
            {clientsLoading ? "Loading client portfolio…" : "Analyzing portfolio with live rates…"}
          </div>
        ) : topOpps.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: "3rem", color: C.muted }}>No strong refi opportunities right now.</div>
        ) : (
          topOpps.map(c => <OpportunityRow key={c.id} client={c} a={c.a} onClick={() => { setSelected(c); setView("client-detail"); }} />)
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Client Row (clickable horizontal card — matches original "opportunity" style)
// ---------------------------------------------------------------------------
const ClientRow = ({ client: c, onClick }) => {
  const a = c.a;
  const stripe = a?.good ? (a.priority === "high" ? C.red : C.amber) : C.border;
  const hasSavings = a && a.monthlySavings > 0;

  return (
    <div
      onClick={onClick}
      className="client-tile"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "1rem 1.25rem",
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${stripe}`,
        background: C.surfaceHi,
        cursor: "pointer",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 2, fontSize: 15 }}>{c.name}</div>
        <div style={{ fontSize: 13, color: C.muted }}>
          {LOAN_LABELS[c.loanType]} · {$c(c.loanBalance)} balance · {$r(c.currentRate)}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        {hasSavings ? (
          <>
            <div style={{ ...mono, color: C.green, fontWeight: 700, fontSize: 18 }}>
              {$c(a.monthlySavings)}<span style={{ fontSize: 12, fontWeight: 400 }}>/mo</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>saves {$r(a.rateDelta)} rate</div>
          </>
        ) : (
          <>
            <div style={{ ...mono, color: C.blue, fontWeight: 700, fontSize: 16 }}>{$c(equityAt(c, 0).equity)}</div>
            <div style={{ fontSize: 12, color: C.muted }}>equity</div>
          </>
        )}
      </div>
      <PriorityBadge priority={a?.priority} good={a?.good} />
      <div style={{ color: C.muted, fontSize: 18 }}>›</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Clients list (with search)
// ---------------------------------------------------------------------------
const Clients = ({ scored, setSelected, setView }) => {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = scored.filter(c => {
    const matchFilter = filter === "all" ? true : filter === "refi" ? c.a?.good : !c.a?.good;
    const q = search.trim().toLowerCase();
    const matchSearch = !q || c.name.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.phone?.includes(q);
    return matchFilter && matchSearch;
  });

  return (
    <div style={{ animation: "fadeIn 0.35s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text }}>All Clients</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {[["all", "All"], ["refi", "Refi Ready"], ["watch", "Monitoring"]].map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} style={{ background: filter === id ? C.amber : C.surfaceHi, color: filter === id ? "#000" : C.muted, border: `1px solid ${filter === id ? C.amber : C.border}`, borderRadius: 7, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ position: "relative", marginBottom: "1rem" }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: C.muted, pointerEvents: "none" }}>
          <Icon name="search" size={15} color={C.muted} />
        </span>
        <input
          type="text"
          placeholder="Search by name, email, or phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, paddingLeft: 36 }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.muted, padding: 0 }}>
            <Icon name="x" size={14} color={C.muted} />
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ ...card, padding: "3rem", textAlign: "center", color: C.muted }}>
          {search ? `No clients matching "${search}"` : "No clients in this category."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {filtered.map(c => (
            <ClientRow key={c.id} client={c} onClick={() => { setSelected(c); setView("client-detail"); }} />
          ))}
        </div>
      )}
      {filtered.length > 0 && (
        <div style={{ color: C.muted, fontSize: 12, marginTop: 12, textAlign: "right" }}>
          {filtered.length} client{filtered.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Client Detail (with edit + delete)
// ---------------------------------------------------------------------------
const ClientDetail = ({ client, rates, setView, onDelete }) => {
  const a = analyze(client, rates);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clients/${client.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      onDelete(client.id);
      setView("clients");
    } catch (err) {
      console.error(err);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div style={{ animation: "fadeIn 0.3s ease", maxWidth: 720 }}>
      <button onClick={() => setView("clients")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, marginBottom: "1.5rem", fontFamily: "inherit" }}>
        <Icon name="arrow" size={14} /> Back to Clients
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 4 }}>{client.name}</h1>
          {client.closeDate && (
            <div style={{ color: C.muted, fontSize: 14 }}>Closed {new Date(client.closeDate + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {a && <PriorityBadge priority={a.priority} good={a.good} />}
          <button
            onClick={() => setView("edit")}
            style={{ display: "flex", alignItems: "center", gap: 6, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 14px", color: C.mutedHi, fontFamily: "inherit", fontSize: 13, cursor: "pointer" }}
          >
            <Icon name="edit" size={14} color={C.mutedHi} /> Edit
          </button>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} style={{ display: "flex", alignItems: "center", gap: 6, background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "8px 14px", color: C.red, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <Icon name="trash" size={14} color={C.red} /> Delete
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>Confirm?</span>
              <button onClick={handleDelete} disabled={deleting} style={{ background: C.red, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: deleting ? 0.6 : 1 }}>{deleting ? "…" : "Yes, delete"}</button>
              <button onClick={() => setConfirmDelete(false)} style={{ ...btnGhost, padding: "8px 12px", fontSize: 13 }}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
        {[["phone", "Phone", client.phone || "—"], ["mail", "Email", client.email || "—"], ["star", "Credit Score", client.creditScore || "—"]].map(([icon, label, val]) => (
          <div key={label} style={{ ...card, flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name={icon} size={16} color={C.amber} />
            <div>
              <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
              <div style={{ color: C.text, fontSize: 14, fontWeight: 600 }}>{val}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ ...card, marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: "1rem", textTransform: "uppercase", letterSpacing: "0.5px" }}>Current Loan Details</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" }}>
          {[
            ["Loan Type", LOAN_LABELS[client.loanType]],
            ["Current Rate", $r(client.currentRate)],
            ["Remaining Balance", $c(client.loanBalance)],
            ["Property Value", $c(client.propertyValue)],
            ["LTV", a ? `${a.ltv.toFixed(1)}%` : "—"],
            ["Est. Monthly Pmt", a ? $c(a.curPmt) : "—"],
          ].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
              <div style={{ ...mono, color: C.text, fontSize: 16, fontWeight: 600 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {a ? (
        <div style={{ ...card, background: a.good ? C.greenBg : C.surface, borderColor: a.good ? "#0f4a25" : C.border }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: "1rem", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {a.good ? "Refi Opportunity Analysis" : "Refi Analysis"}
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.25rem" }}>
            {[
              ["Est. Client Rate",    $r(a.effRate),                     C.blue],
              ["Rate Savings",        `${a.rateDelta.toFixed(2)}%`,      a.rateDelta >= 0.5 ? C.green : C.muted],
              ["New Monthly Payment", $c(a.newPmt),                      C.text],
              ["Monthly Savings",     $c(a.monthlySavings),              a.monthlySavings > 0 ? C.green : C.red],
              ["Annual Savings",      $c(a.annualSavings),               a.annualSavings > 0 ? C.green : C.red],
              ["Break-Even",          a.breakEven < 999 ? `${a.breakEven} months` : "N/A", a.breakEven <= 24 ? C.green : a.breakEven <= 36 ? C.amber : C.red],
            ].map(([label, val, accent]) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
                <div style={{ ...mono, color: accent || C.text, fontSize: 20, fontWeight: 700 }}>{val}</div>
              </div>
            ))}
          </div>
          {a.good && (
            <div style={{ marginTop: "1.25rem", padding: "1rem", background: `${C.greenBg}88`, borderRadius: 8, borderLeft: `3px solid ${C.green}` }}>
              <div style={{ color: C.green, fontWeight: 700, marginBottom: 4 }}>Recommendation</div>
              <div style={{ color: C.mutedHi, fontSize: 14 }}>
                {client.name.split(" ")[0]} could save <strong style={{ color: C.green }}>{$c(a.monthlySavings)}/month</strong> by refinancing from {$r(client.currentRate)} to an estimated {$r(a.effRate)} ({a.baseLabel} {$r(a.base)}{a.rateAdj > 0 ? ` + ${a.rateAdj.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}% credit/LTV pricing` : ""}). Break-even in {a.breakEven} months on ~{$c(a.closingCosts)} closing costs.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ ...card, textAlign: "center", color: C.muted, padding: "2rem" }}>Fetch live rates to see refi analysis.</div>
      )}

      {/* ── Equity Projection ─────────────────────────────────────────── */}
      {(() => {
        const now   = equityAt(client, 0);
        const yr1   = equityAt(client, 1);
        const yr3   = equityAt(client, 3);
        const yr5   = equityAt(client, 5);
        const yr10  = equityAt(client, 10);
        const pmiMonths = monthsToSubEightyLTV(client);
        const ltvColor  = now.ltvPct > 85 ? C.red : now.ltvPct > 75 ? C.amber : C.green;

        return (
          <div style={{ ...card, marginTop: "1.5rem", background: "#0a1628", borderColor: "#1e3a5f" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                🏡 Equity Projection
              </h3>
              <span style={{ fontSize: 12, color: C.muted }}>3.5% annual appreciation</span>
            </div>

            {/* Current equity bar */}
            <div style={{ marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <div>
                  <span style={{ ...mono, fontSize: 28, fontWeight: 700, color: C.blue }}>{$c(now.equity)}</span>
                  <span style={{ color: C.muted, fontSize: 14, marginLeft: 8 }}>current equity ({now.equityPct.toFixed(1)}%)</span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ ...mono, color: ltvColor, fontWeight: 700 }}>{now.ltvPct.toFixed(1)}% LTV</div>
                  {now.cashOut > 0 && <div style={{ color: C.green, fontSize: 12 }}>{$c(now.cashOut)} cash-out available</div>}
                </div>
              </div>
              {/* LTV bar */}
              <div style={{ height: 10, borderRadius: 6, background: C.surfaceHi, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, now.equityPct)}%`, background: ltvColor, borderRadius: 6, transition: "width 0.6s ease" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 4 }}>
                <span>0%</span><span>Equity →</span><span>100%</span>
              </div>
            </div>

            {/* Projection table */}
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1.25rem" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["", "Property Value", "Loan Balance", "Equity", "LTV", "Cash-Out @ 80%"].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: h === "" ? "left" : "right", fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[["Today", now], ["+1 Year", yr1], ["+3 Years", yr3], ["+5 Years", yr5], ["+10 Years", yr10]].map(([label, e], i) => {
                  const rowLtvColor = e.ltvPct > 85 ? C.red : e.ltvPct > 75 ? C.amber : C.green;
                  return (
                    <tr key={label} style={{ borderBottom: `1px solid ${C.border}44`, background: i === 0 ? `${C.surfaceHi}66` : "transparent" }}>
                      <td style={{ padding: "10px 12px", color: i === 0 ? C.text : C.mutedHi, fontWeight: i === 0 ? 700 : 400, fontSize: 13 }}>{label}</td>
                      <td style={{ padding: "10px 12px", ...mono, color: C.mutedHi, fontSize: 13, textAlign: "right" }}>{$c(e.futVal)}</td>
                      <td style={{ padding: "10px 12px", ...mono, color: C.muted, fontSize: 13, textAlign: "right" }}>{$c(e.futBal)}</td>
                      <td style={{ padding: "10px 12px", ...mono, color: C.blue, fontWeight: 700, fontSize: 13, textAlign: "right" }}>{$c(e.equity)}</td>
                      <td style={{ padding: "10px 12px", ...mono, color: rowLtvColor, fontWeight: 600, fontSize: 13, textAlign: "right" }}>{e.ltvPct.toFixed(1)}%</td>
                      <td style={{ padding: "10px 12px", ...mono, color: e.cashOut > 0 ? C.green : C.muted, fontSize: 13, textAlign: "right" }}>{e.cashOut > 0 ? $c(e.cashOut) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* PMI milestone */}
            {pmiMonths !== null && (
              <div style={{ padding: "0.75rem 1rem", borderRadius: 8, background: pmiMonths === 0 ? C.greenBg : C.amberBg, borderLeft: `3px solid ${pmiMonths === 0 ? C.green : C.amber}` }}>
                {pmiMonths === 0
                  ? <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>✓ LTV already below 80% — no PMI exposure</span>
                  : <span style={{ color: C.amber, fontSize: 13 }}>
                      <strong style={{ color: C.amber }}>PMI removal:</strong> LTV drops below 80% in approximately <strong style={{ color: C.amber }}>{pmiMonths < 12 ? `${pmiMonths} months` : `${(pmiMonths / 12).toFixed(1)} years`}</strong> (combined paydown + appreciation at 3.5%/yr)
                    </span>
                }
              </div>
            )}
          </div>
        );
      })()}

      {client.notes && (
        <div style={{ ...card, marginTop: "1rem", borderLeft: `3px solid ${C.amber}` }}>
          <div style={{ fontSize: 11, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Notes</div>
          <div style={{ color: C.text, fontSize: 14 }}>{client.notes}</div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Rate Watch
// ---------------------------------------------------------------------------
const RateWatch = ({ rates, ratesLoading, fetchRates, lastFetched, ratesError, treasury }) => (
  <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 640 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text }}>Rate Watch</h1>
      <button onClick={fetchRates} disabled={ratesLoading} style={{ ...btnPrimary, display: "flex", alignItems: "center", gap: 8, opacity: ratesLoading ? 0.6 : 1 }}>
        <Icon name="refresh" size={14} color="#000" />
        {ratesLoading ? "Fetching..." : "Refresh Now"}
      </button>
    </div>
    <TreasuryWidget treasury={treasury} />
    {ratesError && (
      <div style={{ ...card, background: C.redBg, borderColor: "#4a1414", color: C.red, marginBottom: "1rem", display: "flex", gap: 10, alignItems: "center" }}>
        <Icon name="alert" size={16} color={C.red} /> {ratesError}
      </div>
    )}
    {rates && (
      <div style={{ ...card, background: C.amberBg, borderColor: "#3a2800" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <span style={{ fontSize: 12, color: C.amber, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {rates.source?.startsWith("Estimated") ? "Estimated Rates" : "Live Mortgage Rates"}
          </span>
          <span style={{ fontSize: 12, color: C.muted }}>Source: {rates.source}</span>
        </div>
        {[["30-Year Fixed", rates.rate_30yr_fixed], ["15-Year Fixed", rates.rate_15yr_fixed], ["5/1 ARM", rates.rate_5_1_arm]].map(([label, val]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem 0", borderBottom: `1px solid #2a1800` }}>
            <div style={{ color: C.text, fontWeight: 600 }}>{label}</div>
            <div style={{ ...mono, fontSize: 32, fontWeight: 700, color: C.amber }}>{$r(val)}</div>
          </div>
        ))}
        {lastFetched && <div style={{ textAlign: "center", color: C.muted, fontSize: 12, marginTop: 12 }}>Last updated: {lastFetched.toLocaleTimeString()}</div>}
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Shared client form (Add + Edit)
// ---------------------------------------------------------------------------
const EMPTY_FORM = { name: "", email: "", phone: "", loanType: "30yr_fixed", currentRate: "", loanBalance: "", propertyValue: "", closeDate: "", creditScore: "", notes: "" };

function clientToForm(c) {
  return {
    name:          c.name || "",
    email:         c.email || "",
    phone:         c.phone || "",
    loanType:      c.loanType || "30yr_fixed",
    currentRate:   c.currentRate != null ? String(c.currentRate) : "",
    loanBalance:   c.loanBalance != null ? String(c.loanBalance) : "",
    propertyValue: c.propertyValue != null ? String(c.propertyValue) : "",
    closeDate:     c.closeDate || "",
    creditScore:   c.creditScore != null ? String(c.creditScore) : "",
    notes:         c.notes || "",
  };
}

const ClientForm = ({ initial, onSave, onCancel, title, saving }) => {
  const [form, setForm] = useState(initial || EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = "Required";
    if (!form.currentRate || isNaN(+form.currentRate)) e.currentRate = "Valid rate required";
    if (!form.loanBalance || isNaN(+form.loanBalance)) e.loanBalance = "Valid balance required";
    if (!form.propertyValue || isNaN(+form.propertyValue)) e.propertyValue = "Required";
    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    onSave(form);
  };

  const field = (key, label, placeholder, type = "text") => (
    <div>
      <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</label>
      <input type={type} placeholder={placeholder} value={form[key]} onChange={e => set(key, e.target.value)} style={{ ...inputStyle, borderColor: errors[key] ? C.red : C.border }} />
      {errors[key] && <div style={{ color: C.red, fontSize: 12, marginTop: 4 }}>{errors[key]}</div>}
    </div>
  );

  return (
    <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 620 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: "1.5rem" }}>{title}</h1>
      <div style={{ ...card }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginBottom: "1.25rem" }}>
          {field("name", "Full Name", "John & Jane Smith")}
          {field("email", "Email", "jsmith@email.com", "email")}
          {field("phone", "Phone", "(555) 000-0000", "tel")}
          <div>
            <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>Loan Type</label>
            <select value={form.loanType} onChange={e => set("loanType", e.target.value)} style={{ ...inputStyle }}>
              <option value="30yr_fixed">30-Year Fixed</option>
              <option value="15yr_fixed">15-Year Fixed</option>
              <option value="5_1_arm">5/1 ARM</option>
            </select>
          </div>
          {field("currentRate", "Current Rate (%)", "7.25", "number")}
          {field("loanBalance", "Remaining Balance ($)", "350000", "number")}
          {field("propertyValue", "Property Value ($)", "500000", "number")}
          {field("creditScore", "Credit Score", "760", "number")}
          {field("closeDate", "Original Close Date", "", "date")}
        </div>
        <div style={{ marginBottom: "1.5rem" }}>
          <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>Notes</label>
          <textarea placeholder="Notes about this client…" value={form.notes} onChange={e => set("notes", e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
        </div>
        <div style={{ display: "flex", gap: "1rem" }}>
          <button onClick={submit} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Client"}
          </button>
          <button onClick={onCancel} style={btnGhost}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

// Add Client (POST)
const AddClient = ({ setClients, setView }) => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:          form.name,
          email:         form.email,
          phone:         form.phone,
          loanType:      form.loanType,
          currentRate:   parseFloat(form.currentRate),
          loanBalance:   parseFloat(form.loanBalance),
          propertyValue: parseFloat(form.propertyValue),
          closeDate:     form.closeDate,
          creditScore:   parseInt(form.creditScore) || 700,
          notes:         form.notes,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(JSON.stringify(data.errors));
      setClients(prev => [...prev, data.client]);
      setSaved(true);
      setTimeout(() => { setSaved(false); setView("clients"); }, 1200);
    } catch (err) {
      console.error("Add client error:", err);
    } finally {
      setSaving(false);
    }
  };

  if (saved) return (
    <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 620 }}>
      <div style={{ ...card, background: C.greenBg, borderColor: "#0f4a25", color: C.green, display: "flex", gap: 10, alignItems: "center" }}>
        <Icon name="check" size={16} color={C.green} /> Client saved! Redirecting…
      </div>
    </div>
  );

  return (
    <ClientForm
      title="Add New Client"
      initial={EMPTY_FORM}
      onSave={handleSave}
      onCancel={() => setView("clients")}
      saving={saving}
    />
  );
};

// Edit Client (PUT)
const EditClient = ({ client, setClients, setSelected, setView }) => {
  const [saving, setSaving] = useState(false);

  const handleSave = async (form) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:          form.name,
          email:         form.email,
          phone:         form.phone,
          loanType:      form.loanType,
          currentRate:   parseFloat(form.currentRate),
          loanBalance:   parseFloat(form.loanBalance),
          propertyValue: parseFloat(form.propertyValue),
          closeDate:     form.closeDate,
          creditScore:   parseInt(form.creditScore) || 700,
          notes:         form.notes,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(JSON.stringify(data.errors));
      setClients(prev => prev.map(c => c.id === client.id ? data.client : c));
      setSelected(data.client);
      setView("client-detail");
    } catch (err) {
      console.error("Edit client error:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ClientForm
      title={`Edit — ${client.name}`}
      initial={clientToForm(client)}
      onSave={handleSave}
      onCancel={() => setView("client-detail")}
      saving={saving}
    />
  );
};

// ---------------------------------------------------------------------------
// My Team view (broker only)
// ---------------------------------------------------------------------------
const MyTeam = ({ setView, setSelectedLO }) => {
  const [los, setLos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ firstName: "", lastName: "", email: "" });
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    fetch("/api/org/los")
      .then(r => r.ok ? r.json() : { los: [] })
      .then(data => setLos(Array.isArray(data.los) ? data.los : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const sendInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setInviteError("");
    setInviteSuccess("");
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteForm),
      });
      const data = await res.json();
      if (!res.ok) { setInviteError(data.message || data.error || "Failed to send invite"); return; }
      setInviteSuccess(`Invitation sent to ${inviteForm.email}`);
      setInviteForm({ firstName: "", lastName: "", email: "" });
      // Refresh LO list
      const r2 = await fetch("/api/org/los");
      if (r2.ok) { const d2 = await r2.json(); setLos(Array.isArray(d2.los) ? d2.los : []); }
    } catch {
      setInviteError("Network error — please try again");
    } finally {
      setInviting(false);
    }
  };

  const setF = (k, v) => setInviteForm(p => ({ ...p, [k]: v }));

  return (
    <div style={{ animation: "fadeIn 0.35s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text }}>My Team</h1>
        <button onClick={() => { setShowInvite(p => !p); setInviteSuccess(""); setInviteError(""); }} style={{ ...btnPrimary, display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="plus" size={14} color="#000" /> Invite Loan Officer
        </button>
      </div>

      {showInvite && (
        <div style={{ ...card, marginBottom: "1.5rem", borderColor: C.amber }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: "1rem" }}>Invite a Loan Officer</h3>
          {inviteSuccess && (
            <div style={{ background: C.greenBg, border: `1px solid #0f4a25`, borderRadius: 8, padding: "10px 14px", color: C.green, fontSize: 13, marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
              <Icon name="check" size={14} color={C.green} /> {inviteSuccess}
            </div>
          )}
          {inviteError && (
            <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem" }}>
              {inviteError}
            </div>
          )}
          <form onSubmit={sendInvite}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>First Name</label>
                <input value={inviteForm.firstName} onChange={e => setF("firstName", e.target.value)} style={inputStyle} placeholder="Jane" disabled={inviting} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>Last Name</label>
                <input value={inviteForm.lastName} onChange={e => setF("lastName", e.target.value)} style={inputStyle} placeholder="Smith" disabled={inviting} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>Email</label>
                <input type="email" value={inviteForm.email} onChange={e => setF("email", e.target.value)} style={inputStyle} placeholder="jane@brokerage.com" disabled={inviting} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "1rem" }}>
              <button type="submit" disabled={inviting} style={{ ...btnPrimary, opacity: inviting ? 0.6 : 1 }}>
                {inviting ? "Sending…" : "Send Invitation"}
              </button>
              <button type="button" onClick={() => setShowInvite(false)} style={btnGhost}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>Loading team…</div>
        ) : los.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>No loan officers yet. Invite your first LO above.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Name", "Email", "Clients", "Status", "Action"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.muted, fontSize: 12, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {los.map((lo, i) => (
                <tr key={lo.id} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "transparent" : `${C.surfaceHi}44` }}>
                  <td style={{ padding: "14px 16px", fontWeight: 600, color: C.text }}>{lo.firstName} {lo.lastName}</td>
                  <td style={{ padding: "14px 16px", color: C.mutedHi, fontSize: 13 }}>{lo.email}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: C.text }}>{lo.clientCount ?? 0}</td>
                  <td style={{ padding: "14px 16px" }}>
                    {lo.inviteAccepted
                      ? <span style={{ background: C.greenBg, color: C.green, borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>Active</span>
                      : <span style={{ background: C.amberBg, color: C.amber, borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>Invite Pending</span>
                    }
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <button
                      onClick={() => { setSelectedLO(lo); setView("lo-portal"); }}
                      style={{ background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 14px", color: C.mutedHi, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
                    >
                      View Portal
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// LO Portal view (broker only)
// ---------------------------------------------------------------------------
const LOPortal = ({ lo, rates, setView }) => {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [alertedClients, setAlertedClients] = useState({});
  const [confirmAlert, setConfirmAlert] = useState(null);
  const [alertToast, setAlertToast] = useState("");

  useEffect(() => {
    fetch(`/api/org/los/${lo.id}/clients`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setClients(Array.isArray(data) ? data : (data.clients || [])))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [lo.id]);

  const scored = clients.map(c => ({ ...c, a: analyze(c, rates) }));

  const sendAlert = async (client) => {
    const a = client.a;
    try {
      await fetch("/api/org/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loId: lo.id, clientId: client.id, monthlySavings: a?.monthlySavings }),
      });
      setAlertedClients(prev => ({ ...prev, [client.id]: true }));
      setConfirmAlert(null);
      setAlertToast(`Alert sent to ${lo.firstName} ${lo.lastName}`);
      setTimeout(() => setAlertToast(""), 3000);
    } catch { /* silent */ }
  };

  return (
    <div style={{ animation: "fadeIn 0.35s ease" }}>
      {alertToast && (
        <div style={{ position: "fixed", top: 20, right: 20, background: C.greenBg, border: `1px solid #0f4a25`, borderRadius: 10, padding: "12px 20px", color: C.green, fontWeight: 600, fontSize: 14, zIndex: 2000, display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="check" size={14} color={C.green} /> {alertToast}
        </div>
      )}

      <button onClick={() => setView("team")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, marginBottom: "1.5rem", fontFamily: "inherit" }}>
        <Icon name="arrow" size={14} /> My Team
      </button>

      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 4 }}>{lo.firstName} {lo.lastName}'s Clients</h1>
        <div style={{ color: C.muted, fontSize: 14 }}>{lo.clientCount ?? clients.length} clients</div>
      </div>

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>Loading clients…</div>
        ) : scored.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>This LO has no clients yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Client", "Loan Type", "Current Rate", "Monthly Savings", "Status", "Action"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.muted, fontSize: 12, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scored.map((c, i) => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "transparent" : `${C.surfaceHi}44` }}>
                  <td style={{ padding: "14px 16px" }}>
                    <div style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{c.email}</div>
                  </td>
                  <td style={{ padding: "14px 16px", color: C.mutedHi, fontSize: 13 }}>{LOAN_LABELS[c.loanType]}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: C.red, fontWeight: 600 }}>{$r(c.currentRate)}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: c.a?.monthlySavings > 0 ? C.green : C.muted, fontWeight: 700 }}>{c.a ? $c(c.a.monthlySavings) : "—"}</td>
                  <td style={{ padding: "14px 16px" }}><PriorityBadge priority={c.a?.priority} good={c.a?.good} /></td>
                  <td style={{ padding: "14px 16px" }}>
                    {c.a?.good && (
                      alertedClients[c.id] ? (
                        <span style={{ color: C.green, fontSize: 12, fontWeight: 600 }}>✓ Alerted</span>
                      ) : confirmAlert === c.id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <button onClick={() => sendAlert(c)} style={{ background: C.amber, color: "#000", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Confirm</button>
                          <button onClick={() => setConfirmAlert(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmAlert(c.id)} style={{ background: C.amberBg, border: `1px solid #3a2800`, borderRadius: 6, padding: "5px 12px", color: C.amber, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                          Alert LO
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Import Clients view
// ---------------------------------------------------------------------------
const ImportClients = ({ setView, setClients }) => {
  const [step, setStep] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["csv", "xls", "xlsx"].includes(ext)) { setUploadError("Please upload a CSV or Excel file (.csv, .xls, .xlsx)"); return; }
    setUploading(true);
    setUploadError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) { setUploadError(data.message || data.error || "Upload failed"); return; }
      setPreview(data);
      setStep(2);
    } catch {
      setUploadError("Network error — please try again");
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    handleFile(file);
  };

  const confirmImport = async () => {
    setConfirming(true);
    try {
      const res = await fetch("/api/import/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileData: preview.fileData, mimetype: preview.mimetype, columnMap: preview.columnMap }),
      });
      const data = await res.json();
      if (!res.ok) { setUploadError(data.message || "Import failed"); return; }
      setResult(data);
      // Refresh clients list
      fetch("/api/clients").then(r => r.json()).then(d => { if (d.success) setClients(d.clients); }).catch(() => {});
    } catch {
      setUploadError("Network error — please try again");
    } finally {
      setConfirming(false);
    }
  };

  if (result) {
    return (
      <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 600 }}>
        <div style={{ ...card, background: C.greenBg, borderColor: "#0f4a25", marginBottom: "1.5rem" }}>
          <div style={{ color: C.green, fontSize: 20, fontWeight: 700, marginBottom: 8 }}>✓ Import Complete</div>
          <div style={{ color: C.mutedHi, fontSize: 14, marginBottom: 4 }}>Successfully imported <strong style={{ color: C.green }}>{result.imported}</strong> clients.</div>
          {result.skipped > 0 && <div style={{ color: C.muted, fontSize: 13 }}>{result.skipped} rows skipped.</div>}
        </div>
        <button onClick={() => setView("clients")} style={{ ...btnPrimary }}>Go to All Clients</button>
      </div>
    );
  }

  return (
    <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 700 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 6 }}>Import Clients</h1>
      <div style={{ color: C.muted, fontSize: 14, marginBottom: "1.5rem" }}>Upload a CSV or Excel file exported from your CRM</div>

      {uploadError && (
        <div style={{ background: C.redBg, border: `1px solid #4a1414`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="alert" size={14} color={C.red} /> {uploadError}
        </div>
      )}

      {step === 1 && (
        <>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            style={{ border: `2px dashed ${dragging ? C.amber : C.border}`, borderRadius: 14, padding: "4rem 2rem", textAlign: "center", cursor: "pointer", background: dragging ? C.amberBg : C.surfaceHi, transition: "all 0.2s", marginBottom: "1.25rem" }}
          >
            <Icon name="upload" size={36} color={dragging ? C.amber : C.muted} />
            <div style={{ color: dragging ? C.amber : C.muted, fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
              {uploading ? "Uploading…" : "Drop your file here, or click to browse"}
            </div>
            <div style={{ color: C.muted, fontSize: 13 }}>Accepts .csv, .xls, .xlsx</div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xls,.xlsx"
              style={{ display: "none" }}
              onChange={e => handleFile(e.target.files[0])}
            />
          </div>
          <div style={{ ...card, background: C.surfaceHi, borderColor: C.border }}>
            <div style={{ color: C.muted, fontSize: 13 }}>
              <strong style={{ color: C.mutedHi }}>Tip:</strong> We'll automatically detect columns for: name, email, phone, current rate, loan balance, property value, close date, credit score, notes
            </div>
          </div>
        </>
      )}

      {step === 2 && preview && (
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: "1rem" }}>Preview — {preview.totalRows} clients found</h2>
          <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: "1.25rem" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Name", "Email", "Current Rate", "Balance", "Property Value", "Loan Type"].map(h => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(preview.preview || []).slice(0, 5).map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "transparent" : `${C.surfaceHi}44` }}>
                      <td style={{ padding: "10px 14px", color: C.text, fontSize: 13 }}>{row.name || "—"}</td>
                      <td style={{ padding: "10px 14px", color: C.mutedHi, fontSize: 13 }}>{row.email || "—"}</td>
                      <td style={{ padding: "10px 14px", ...mono, color: C.red, fontSize: 13 }}>{row.currentRate ? `${row.currentRate}%` : "—"}</td>
                      <td style={{ padding: "10px 14px", ...mono, color: C.text, fontSize: 13 }}>{row.loanBalance ? $c(row.loanBalance) : "—"}</td>
                      <td style={{ padding: "10px 14px", ...mono, color: C.text, fontSize: 13 }}>{row.propertyValue ? $c(row.propertyValue) : "—"}</td>
                      <td style={{ padding: "10px 14px", color: C.mutedHi, fontSize: 13 }}>{LOAN_LABELS[row.loanType] || row.loanType || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ color: C.muted, fontSize: 13, marginBottom: "1.5rem" }}>
            <strong style={{ color: C.text }}>{preview.totalRows}</strong> clients will be imported.
            {preview.skipped > 0 && <> <strong style={{ color: C.amber }}>{preview.skipped}</strong> rows will be skipped.</>}
          </div>

          <div style={{ display: "flex", gap: "1rem" }}>
            <button onClick={confirmImport} disabled={confirming} style={{ ...btnPrimary, display: "flex", alignItems: "center", gap: 8, opacity: confirming ? 0.6 : 1 }}>
              <Icon name="check" size={14} color="#000" />
              {confirming ? "Importing…" : "Import All Clients"}
            </button>
            <button onClick={() => { setStep(1); setPreview(null); setUploadError(""); }} style={btnGhost}>Start Over</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------
export default function App() {
  const [authState, setAuthState] = useState("loading"); // "loading" | "unauthenticated" | "authenticated"
  const [user, setUser] = useState(null);
  const [authView, setAuthView] = useState("login"); // "login" | "register" | "accept-invite"
  const [inviteToken, setInviteToken] = useState(null);

  const [view, setView] = useState("dashboard");
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [rates, setRates] = useState(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [selected, setSelected] = useState(null);
  const [treasury, setTreasury] = useState(null);
  const [selectedLO, setSelectedLO] = useState(null);

  // Check for accept-invite token in URL first
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      setInviteToken(token);
      setAuthView("accept-invite");
      setAuthState("unauthenticated");
      return;
    }
    // Bootstrap auth
    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) { setAuthState("unauthenticated"); return; }
        const data = await res.json();
        if (data.user) { setUser(data.user); setAuthState("authenticated"); }
        else { setAuthState("unauthenticated"); }
      })
      .catch(() => setAuthState("unauthenticated"));
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
    setAuthState("authenticated");
    setView("dashboard");
  };

  const handleLogout = async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    setUser(null);
    setAuthState("unauthenticated");
    setAuthView("login");
    setClients([]);
  };

  // Load clients once authenticated
  useEffect(() => {
    if (authState !== "authenticated") return;
    setClientsLoading(true);
    fetch("/api/clients")
      .then(async (r) => {
        if (r.status === 401) { setUser(null); setAuthState("unauthenticated"); return; }
        const data = await r.json();
        if (data.success) setClients(data.clients);
      })
      .catch(err => console.error("Failed to load clients:", err))
      .finally(() => setClientsLoading(false));
  }, [authState]);

  const fetchRates = useCallback(async () => {
    setRatesLoading(true);
    setRatesError(null);
    try {
      const res = await fetch("/api/rates", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await res.json();
      if (data.rates) {
        setRates(data.rates);
        setLastFetched(new Date());
        if (!data.success) setRatesError(data.error || "Could not fetch live rates — showing estimates");
      }
    } catch {
      setRatesError("Server error — showing estimated rates");
      setRates({ rate_30yr_fixed: 6.87, rate_15yr_fixed: 6.18, rate_5_1_arm: 6.52, date: new Date().toISOString().split("T")[0], source: "Estimated — server error" });
      setLastFetched(new Date());
    } finally {
      setRatesLoading(false);
    }
  }, []);

  const fetchTreasury = useCallback(async () => {
    try {
      const res = await fetch("/api/treasury");
      const data = await res.json();
      if (data.success) setTreasury(data);
    } catch (err) {
      console.error("Treasury fetch error:", err.message);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchRates();
    fetchTreasury();
  }, [authState, fetchRates, fetchTreasury]);

  const handleDeleteClient = useCallback((id) => {
    setClients(prev => prev.filter(c => c.id !== id));
  }, []);

  const scored = clients
    .map(c => ({ ...c, a: analyze(c, rates) }))
    .sort((a, b) => (b.a?.good ? 1 : 0) - (a.a?.good ? 1 : 0) || (b.a?.rateDelta || 0) - (a.a?.rateDelta || 0));

  const refiReady = scored.filter(c => c.a?.good);
  const totalSavings = refiReady.reduce((s, c) => s + (c.a?.annualSavings || 0), 0);

  const globalStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    input:focus, select:focus, textarea:focus { border-color: #f59e0b !important; }
    tr:hover td { background: rgba(15,32,53,0.6) !important; }
    .client-tile { transition: transform 0.15s ease, box-shadow 0.15s ease; }
    .client-tile:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
  `;

  // Loading spinner
  if (authState === "loading") {
    return (
      <div style={{ fontFamily: "'Sora', 'Segoe UI', sans-serif", background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{globalStyles}</style>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: `3px solid ${C.border}`, borderTopColor: C.amber, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <div style={{ color: C.muted, fontSize: 14 }}>Loading RefiRadar…</div>
        </div>
      </div>
    );
  }

  // Unauthenticated
  if (authState === "unauthenticated") {
    return (
      <div style={{ fontFamily: "'Sora', 'Segoe UI', sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
        <style>{globalStyles}</style>
        {authView === "accept-invite" && inviteToken
          ? <AcceptInvitePage token={inviteToken} onLogin={handleLogin} />
          : authView === "register"
          ? <RegisterPage onLogin={handleLogin} goLogin={() => setAuthView("login")} />
          : <LoginPage onLogin={handleLogin} goRegister={() => setAuthView("register")} />
        }
      </div>
    );
  }

  // Authenticated app
  return (
    <div style={{ fontFamily: "'Sora', 'Segoe UI', sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      <style>{globalStyles}</style>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar view={view} setView={setView} refiCount={refiReady.length} user={user} onLogout={handleLogout} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Header bar */}
          <header style={{ height: 52, background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 2rem", flexShrink: 0 }}>
            <NotificationBell />
          </header>
          <main style={{ flex: 1, padding: "2rem 2.5rem", overflowX: "hidden" }}>
            {view === "dashboard"     && <Dashboard scored={scored} refiReady={refiReady} rates={rates} ratesLoading={ratesLoading} totalSavings={totalSavings} fetchRates={fetchRates} setView={setView} setSelected={setSelected} treasury={treasury} clientsLoading={clientsLoading} user={user} />}
            {view === "clients"       && <Clients scored={scored} setSelected={setSelected} setView={setView} />}
            {view === "rates"         && <RateWatch rates={rates} ratesLoading={ratesLoading} fetchRates={fetchRates} lastFetched={lastFetched} ratesError={ratesError} treasury={treasury} />}
            {view === "add"           && <AddClient setClients={setClients} setView={setView} />}
            {view === "client-detail" && selected && <ClientDetail client={selected} rates={rates} setView={setView} onDelete={handleDeleteClient} />}
            {view === "edit"          && selected && <EditClient client={selected} setClients={setClients} setSelected={setSelected} setView={setView} />}
            {view === "team"          && user?.role === "broker" && <MyTeam setView={setView} setSelectedLO={setSelectedLO} />}
            {view === "lo-portal"     && selectedLO && user?.role === "broker" && <LOPortal lo={selectedLO} rates={rates} setView={setView} />}
            {view === "import"        && <ImportClients setView={setView} setClients={setClients} />}
          </main>
        </div>
      </div>
    </div>
  );
}

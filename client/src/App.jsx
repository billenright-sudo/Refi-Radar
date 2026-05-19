import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Loan helpers
// ---------------------------------------------------------------------------
const LOAN_LABELS = { "30yr_fixed": "30-Yr Fixed", "15yr_fixed": "15-Yr Fixed", "5_1_arm": "5/1 ARM" };

const calcPayment = (p, annualRate, years) => {
  const r = annualRate / 100 / 12, n = years * 12;
  if (r === 0) return p / n;
  return p * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
};

const analyze = (client, rates) => {
  if (!rates) return null;
  const rMap = { "30yr_fixed": rates.rate_30yr_fixed, "15yr_fixed": rates.rate_15yr_fixed, "5_1_arm": rates.rate_5_1_arm };
  const mktRate = rMap[client.loanType];
  if (!mktRate) return null;
  const years = client.loanType === "15yr_fixed" ? 15 : 30;
  const rateDelta = client.currentRate - mktRate;
  const curPmt = calcPayment(client.loanBalance, client.currentRate, years);
  const newPmt = calcPayment(client.loanBalance, mktRate, years);
  const monthlySavings = curPmt - newPmt;
  const annualSavings = monthlySavings * 12;
  const closingCosts = client.loanBalance * 0.02;
  const breakEven = monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : 9999;
  const ltv = (client.loanBalance / client.propertyValue) * 100;
  const good = rateDelta >= 0.5 && breakEven <= 36 && monthlySavings > 0 && ltv <= 95;
  return { mktRate, rateDelta, curPmt, newPmt, monthlySavings, annualSavings, closingCosts, breakEven, ltv, good, priority: good ? (rateDelta >= 1.0 ? "high" : "medium") : "low" };
};

const $c = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const $r = (n) => `${(+n).toFixed(2)}%`;

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
// Sidebar
// ---------------------------------------------------------------------------
const Sidebar = ({ view, setView, refiCount }) => {
  const nav = [
    { id: "dashboard", label: "Dashboard",  icon: "dashboard" },
    { id: "clients",   label: "All Clients", icon: "users" },
    { id: "rates",     label: "Rate Watch",  icon: "trending" },
    { id: "add",       label: "Add Client",  icon: "plus" },
  ];
  return (
    <aside style={{ width: 220, minHeight: "100vh", background: C.bg, borderRight: `1px solid ${C.border}`, padding: "1.5rem 1rem", display: "flex", flexDirection: "column", flexShrink: 0 }}>
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
      <div style={{ marginTop: "auto", padding: "0.5rem", borderTop: `1px solid ${C.border}` }}>
        <div style={{ color: C.muted, fontSize: 11, textAlign: "center" }}>© 2025 RefiRadar</div>
      </div>
    </aside>
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

const Dashboard = ({ scored, refiReady, rates, ratesLoading, totalSavings, fetchRates, setView, setSelected, treasury, clientsLoading }) => {
  const topOpps = scored.filter(c => c.a?.good).slice(0, 5);
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? "Good morning 👋" : h < 17 ? "Good afternoon 👋" : "Good evening 👋"; })();
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

      <TreasuryWidget treasury={treasury} />

      <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Refi Opportunities" value={ratesLoading || clientsLoading ? "—" : refiReady.length} sub="clients ready today" accent={refiReady.length > 0 ? C.amber : C.muted} />
        <StatCard label="Potential Monthly Savings" value={ratesLoading || clientsLoading ? "—" : $c(totalSavings / 12)} sub="across all opportunities" accent={C.green} />
        <StatCard label="Total Portfolio" value={clientsLoading ? "—" : scored.length} sub="clients tracked" />
        <StatCard label="Live Rate (30-Yr)" value={ratesLoading ? "Loading..." : (rates ? $r(rates.rate_30yr_fixed) : "—")} sub={rates?.source || "national average"} accent={C.blue} />
      </div>

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

      {/* Search bar */}
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

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>
            {search ? `No clients matching "${search}"` : "No clients in this category."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Client", "Loan Type", "Current Rate", "Market Rate", "Monthly Savings", "Status"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: C.muted, fontSize: 12, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id} onClick={() => { setSelected(c); setView("client-detail"); }} style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: i % 2 === 0 ? "transparent" : `${C.surfaceHi}44` }}>
                  <td style={{ padding: "14px 16px" }}>
                    <div style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{c.email}</div>
                  </td>
                  <td style={{ padding: "14px 16px", color: C.mutedHi, fontSize: 13 }}>{LOAN_LABELS[c.loanType]}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: C.red, fontWeight: 600 }}>{$r(c.currentRate)}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: C.green, fontWeight: 600 }}>{c.a ? $r(c.a.mktRate) : "—"}</td>
                  <td style={{ padding: "14px 16px", ...mono, color: c.a?.monthlySavings > 0 ? C.green : C.muted, fontWeight: 700 }}>{c.a ? $c(c.a.monthlySavings) : "—"}</td>
                  <td style={{ padding: "14px 16px" }}><PriorityBadge priority={c.a?.priority} good={c.a?.good} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {filtered.length > 0 && (
        <div style={{ color: C.muted, fontSize: 12, marginTop: 8, textAlign: "right" }}>
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
              ["Today Market Rate",  $r(a.mktRate),                    C.blue],
              ["Rate Savings",       `${a.rateDelta.toFixed(2)}%`,     a.rateDelta >= 0.5 ? C.green : C.muted],
              ["New Monthly Payment", $c(a.newPmt),                    C.text],
              ["Monthly Savings",    $c(a.monthlySavings),             a.monthlySavings > 0 ? C.green : C.red],
              ["Annual Savings",     $c(a.annualSavings),              a.annualSavings > 0 ? C.green : C.red],
              ["Break-Even",         a.breakEven < 999 ? `${a.breakEven} months` : "N/A", a.breakEven <= 24 ? C.green : a.breakEven <= 36 ? C.amber : C.red],
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
                {client.name.split(" ")[0]} could save <strong style={{ color: C.green }}>{$c(a.monthlySavings)}/month</strong> by refinancing from {$r(client.currentRate)} to {$r(a.mktRate)}. Break-even in {a.breakEven} months.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ ...card, textAlign: "center", color: C.muted, padding: "2rem" }}>Fetch live rates to see refi analysis.</div>
      )}

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
// App root
// ---------------------------------------------------------------------------
export default function App() {
  const [view, setView] = useState("dashboard");
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [rates, setRates] = useState(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [selected, setSelected] = useState(null);
  const [treasury, setTreasury] = useState(null);

  // Load clients from API on mount
  useEffect(() => {
    fetch("/api/clients")
      .then(r => r.json())
      .then(data => { if (data.success) setClients(data.clients); })
      .catch(err => console.error("Failed to load clients:", err))
      .finally(() => setClientsLoading(false));
  }, []);

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

  useEffect(() => { fetchRates(); fetchTreasury(); }, [fetchRates, fetchTreasury]);

  const handleDeleteClient = useCallback((id) => {
    setClients(prev => prev.filter(c => c.id !== id));
  }, []);

  const scored = clients
    .map(c => ({ ...c, a: analyze(c, rates) }))
    .sort((a, b) => (b.a?.good ? 1 : 0) - (a.a?.good ? 1 : 0) || (b.a?.rateDelta || 0) - (a.a?.rateDelta || 0));

  const refiReady = scored.filter(c => c.a?.good);
  const totalSavings = refiReady.reduce((s, c) => s + (c.a?.annualSavings || 0), 0);

  return (
    <div style={{ fontFamily: "'Sora', 'Segoe UI', sans-serif", background: C.bg, minHeight: "100vh", color: C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        input:focus, select:focus, textarea:focus { border-color: #f59e0b !important; }
        tr:hover td { background: rgba(15,32,53,0.6) !important; }
      `}</style>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar view={view} setView={setView} refiCount={refiReady.length} />
        <main style={{ flex: 1, padding: "2rem 2.5rem", overflowX: "hidden" }}>
          {view === "dashboard"     && <Dashboard scored={scored} refiReady={refiReady} rates={rates} ratesLoading={ratesLoading} totalSavings={totalSavings} fetchRates={fetchRates} setView={setView} setSelected={setSelected} treasury={treasury} clientsLoading={clientsLoading} />}
          {view === "clients"       && <Clients scored={scored} setSelected={setSelected} setView={setView} />}
          {view === "rates"         && <RateWatch rates={rates} ratesLoading={ratesLoading} fetchRates={fetchRates} lastFetched={lastFetched} ratesError={ratesError} treasury={treasury} />}
          {view === "add"           && <AddClient setClients={setClients} setView={setView} />}
          {view === "client-detail" && selected && <ClientDetail client={selected} rates={rates} setView={setView} onDelete={handleDeleteClient} />}
          {view === "edit"          && selected && <EditClient client={selected} setClients={setClients} setSelected={setSelected} setView={setView} />}
        </main>
      </div>
    </div>
  );
}

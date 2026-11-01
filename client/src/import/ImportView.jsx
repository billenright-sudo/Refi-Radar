import { useRef, useState } from "react";
import { uploadFile, reviewAgain, confirmImport, withMapping, withStatus, outcomeText, summaryText, pageOf } from "./importer.mjs";

// The Import page: a broker uploads a CSV or Excel export, looks at what it will do, then imports it. Four steps:
//   upload -> review (pick the columns, tick the funded statuses, read the summary and the rows) -> import -> result.
// The logic and every server call are in importer.mjs; this file is the layout. Each change to a column or a status asks the server
// for the review again, and the Import button writes exactly the review on screen (or, if the rows have changed since, shows the
// fresh review instead and writes nothing).
//
// Props: ui = { C, card, mono, Icon } (App's design tokens), onImported() (called once the rows are written, so App can reload its
// client list), onDone() (the result screen's "Go to All Clients").

const UPLOAD_HINT = "Exports from ARIVE and Calyx Point are recognised; for any other file, pick the columns on the next step.";
const EVERY_ROW_FUNDED = "Every row is treated as a funded loan: no loan status or closing date column is picked.";
const NOT_IN_FILE = "— not in this file —";

// ── styles, built from App's tokens ──

const buttonStyle = (C, primary, can) => ({
  display: "flex", alignItems: "center", gap: 8, borderRadius: 8, fontFamily: "inherit", fontSize: 14,
  cursor: can ? "pointer" : "default", opacity: can ? 1 : 0.5,
  ...(primary
    ? { background: C.amber, color: "#000", border: "none", padding: "11px 24px", fontWeight: 700 }
    : { background: "transparent", color: C.muted, border: `1px solid ${C.border}`, padding: "11px 20px" }),
});
const pagerStyle = (C, can) => ({
  background: "transparent", color: C.mutedHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 12px", fontSize: 13,
  fontFamily: "inherit", cursor: can ? "pointer" : "default", opacity: can ? 1 : 0.5,
});
const selectStyle = (C) => ({
  width: "100%", background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", color: C.text,
  fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box",
});
const thStyle = (C) => ({
  padding: "10px 14px", textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase",
  whiteSpace: "nowrap",
});
const outcomeColor = (C, outcome) => (
  outcome === "created" ? C.green : outcome === "updated" ? C.blue : outcome === "unchanged" ? C.muted : C.amber
);

// ── pieces ──

const Heading = ({ title, hint, C }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
    {hint && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
  </div>
);

const ErrorLine = ({ text, ui: { C, Icon } }) => text && (
  <div role="alert" data-testid="import-error" style={{ background: C.redBg, border: "1px solid #4a1414", borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: "1rem", display: "flex", gap: 8, alignItems: "center" }}>
    <Icon name="alert" size={14} color={C.red} /> {text}
  </div>
);

// The counts in words, then one line per loan officer's book ("Lou Park: 12").
const Summary = ({ counts, ui: { C, mono } }) => (
  <div data-testid="import-summary">
    <div style={{ color: C.text, fontSize: 15, fontWeight: 600 }}>{summaryText(counts)}</div>
    {counts.byOwner.length > 0 && (
      <div style={{ marginTop: 8 }}>
        {counts.byOwner.map((o) => (
          <div key={o.id} style={{ color: C.mutedHi, fontSize: 13, lineHeight: 1.6 }}>{o.name}: <span style={mono}>{o.rows}</span></div>
        ))}
      </div>
    )}
  </div>
);

// ── step 1: upload ──

const UploadStep = ({ ui, busy, onFile }) => {
  const { C, card, Icon } = ui;
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const choose = () => { if (!busy) input.current?.click(); };
  return (
    <>
      <div
        data-testid="import-drop"
        role="button"
        tabIndex={0}
        aria-label="Choose a file to import"
        onClick={choose}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) onFile(e.dataTransfer.files[0]); }}
        style={{ border: `2px dashed ${dragging ? C.amber : C.border}`, borderRadius: 14, padding: "4rem 2rem", textAlign: "center", cursor: "pointer", background: dragging ? C.amberBg : C.surfaceHi, transition: "all 0.2s", marginBottom: "1.25rem" }}
      >
        <Icon name="upload" size={36} color={dragging ? C.amber : C.muted} />
        <div style={{ color: dragging ? C.amber : C.muted, fontSize: 16, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
          {busy ? "Uploading…" : "Drop your file here, or click to browse"}
        </div>
        <div style={{ color: C.muted, fontSize: 13 }}>Accepts .csv, .xls, .xlsx</div>
      </div>
      <input
        ref={input}
        data-testid="import-file"
        type="file"
        accept=".csv,.xls,.xlsx"
        style={{ display: "none" }}
        onChange={(e) => { const file = e.target.files[0]; e.target.value = ""; onFile(file); }}
      />
      <div style={{ ...card, background: C.surfaceHi, borderColor: C.border }}>
        <div style={{ color: C.muted, fontSize: 13 }}>{UPLOAD_HINT}</div>
      </div>
    </>
  );
};

// ── step 2: review ──

// A drop-down per field: the file's columns, or "— not in this file —". Two columns with the same header are told apart by number.
const ColumnPicks = ({ review, busy, ui: { C, card }, onPick }) => {
  const seen = {};
  for (const { header } of review.headers) seen[header.trim()] = (seen[header.trim()] || 0) + 1;
  const labelOf = ({ index, header }) => (seen[header.trim()] > 1 ? `${header.trim()} (column ${index + 1})` : header.trim());
  return (
    <section style={{ ...card, padding: "1.1rem", marginBottom: "1.25rem" }}>
      <Heading title="Columns" hint="We matched these from the file's headers. Change any that look wrong." C={C} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
        {review.fields.map((f) => (
          <label key={f.id} style={{ display: "block", minWidth: 0 }}>
            <span style={{ display: "block", color: C.muted, fontSize: 11.5, marginBottom: 4 }}>{f.label}</span>
            <select
              data-testid={`import-map-${f.id}`}
              value={String(review.mapping[f.id] ?? -1)}
              disabled={busy}
              onChange={(e) => onPick(f.id, Number(e.target.value))}
              style={selectStyle(C)}
            >
              <option value="-1">{NOT_IN_FILE}</option>
              {review.headers.map((h) => <option key={h.index} value={String(h.index)}>{labelOf(h)}</option>)}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
};

// A "counts as funded" box per loan status found in the file. A row whose status is not ticked is skipped.
const StatusPicks = ({ statuses, busy, ui: { C, card, mono }, onTick }) => (
  <section style={{ ...card, padding: "1.1rem", marginBottom: "1.25rem" }}>
    <Heading title="Loan status" hint="Only funded loans are imported. Tick the statuses that count as funded." C={C} />
    {statuses.map((s) => (
      <label key={s.value} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: 13, color: C.text, cursor: busy ? "default" : "pointer" }}>
        <input
          type="checkbox"
          data-testid={`import-status-${s.value}`}
          checked={s.funded}
          disabled={busy}
          onChange={(e) => onTick(s.value, e.target.checked)}
        />
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.label}</span>
        <span style={{ color: C.muted, fontSize: 12 }}><span style={mono}>{s.count}</span> {s.count === 1 ? "row" : "rows"}</span>
        <span style={{ color: C.mutedHi, fontSize: 12 }}>· counts as funded</span>
      </label>
    ))}
  </section>
);

// The rows, 50 a page: what the import will do with each, the name and the flags.
const RowsTable = ({ results, page, onPage, ui: { C, card, mono } }) => {
  const shown = pageOf(results, page);
  const first = (shown.page - 1) * 50;
  return (
    <section style={{ marginBottom: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Rows</div>
        {results.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.muted, fontSize: 12.5 }}>
            <span>{first + 1}–{first + shown.items.length} of {results.length}</span>
            {shown.pages > 1 && (
              <>
                <button type="button" onClick={() => onPage(shown.page - 1)} disabled={shown.page <= 1} style={pagerStyle(C, shown.page > 1)}>Previous</button>
                <span>Page {shown.page} of {shown.pages}</span>
                <button type="button" onClick={() => onPage(shown.page + 1)} disabled={shown.page >= shown.pages} style={pagerStyle(C, shown.page < shown.pages)}>Next</button>
              </>
            )}
          </div>
        )}
      </div>
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Row", "Name", "What happens", "Flags"].map((h) => <th key={h} style={thStyle(C)}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.items.map((r, i) => (
                <tr key={r.row} data-testid="import-row" style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "transparent" : `${C.surfaceHi}44`, verticalAlign: "top" }}>
                  <td style={{ padding: "10px 14px", ...mono, color: C.muted, fontSize: 12 }}>{r.row}</td>
                  <td style={{ padding: "10px 14px", color: C.text, fontSize: 13 }}>{r.name || "—"}</td>
                  <td style={{ padding: "10px 14px", color: outcomeColor(C, r.outcome), fontSize: 13 }}>{outcomeText(r)}</td>
                  <td style={{ padding: "10px 14px", color: C.mutedHi, fontSize: 12.5 }}>
                    {r.flags.length === 0 ? "—" : r.flags.map((flag) => <div key={flag}>{flag}</div>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

const ReviewStep = ({ ui, review, fileName, page, busy, importing, onPage, onPick, onTick, onImport, onStartOver }) => {
  const { C, card, Icon } = ui;
  const writes = review.counts.created + review.counts.updated;
  const canImport = !busy && writes > 0;
  return (
    <div aria-busy={busy}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: "1rem" }}>
        Review — {review.totalRows} {review.totalRows === 1 ? "row" : "rows"} in {fileName}
      </h2>

      {review.everyRowFunded && (
        <div data-testid="import-banner" role="status" style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 8, padding: "10px 14px", color: C.amber, fontSize: 13, marginBottom: "1.25rem", display: "flex", gap: 8, alignItems: "center" }}>
          <Icon name="alert" size={14} color={C.amber} /> {EVERY_ROW_FUNDED}
        </div>
      )}

      <ColumnPicks review={review} busy={busy} ui={ui} onPick={onPick} />
      {review.statuses && <StatusPicks statuses={review.statuses} busy={busy} ui={ui} onTick={onTick} />}

      <section style={{ ...card, padding: "1.1rem", marginBottom: "1.25rem" }}>
        <Heading title="What will happen" C={C} />
        <Summary counts={review.counts} ui={ui} />
      </section>

      <RowsTable results={review.results} page={page} onPage={onPage} ui={ui} />

      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <button type="button" data-testid="import-confirm" onClick={onImport} disabled={!canImport} style={buttonStyle(C, true, canImport)}>
          <Icon name="check" size={14} color="#000" />
          {importing ? "Importing…" : "Import"}
        </button>
        <button type="button" onClick={onStartOver} disabled={busy} style={buttonStyle(C, false, !busy)}>Start Over</button>
        {writes === 0 && !busy && <span style={{ color: C.muted, fontSize: 13 }}>Nothing here can be imported yet. Check the columns and statuses above.</span>}
      </div>
    </div>
  );
};

// ── step 4: result ──

const ResultStep = ({ ui, counts, onDone }) => {
  const { C, card } = ui;
  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ ...card, background: C.greenBg, borderColor: "#0f4a25", marginBottom: "1.5rem" }}>
        <div style={{ color: C.green, fontSize: 20, fontWeight: 700, marginBottom: 10 }}>✓ Import Complete</div>
        <Summary counts={counts} ui={ui} />
      </div>
      <button type="button" onClick={onDone} style={buttonStyle(C, true, true)}>Go to All Clients</button>
    </div>
  );
};

// ── the page ──

export default function ImportView({ ui, onImported, onDone }) {
  const { C } = ui;
  const [step, setStep] = useState("upload");   // "upload" | "review" | "importing" | "result"
  const [review, setReview] = useState(null);
  const [fileName, setFileName] = useState("");
  const [counts, setCounts] = useState(null);   // the written counts, for the result screen
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async (file) => {
    if (!file || busy) return;
    setBusy(true); setError("");
    const res = await uploadFile(fetch, file);
    if (res.ok) { setReview(res.data); setFileName(file.name); setPage(1); setStep("review"); }
    else setError(res.error);
    setBusy(false);
  };

  // The broker changed a column or a status: ask for the review again with their picks.
  const recheck = async (picks) => {
    if (busy) return;
    setBusy(true); setError("");
    const res = await reviewAgain(fetch, review, picks);
    if (res.ok) { setReview(res.data); setPage(1); }
    else setError(res.error);
    setBusy(false);
  };

  const runImport = async () => {
    if (busy || review.counts.created + review.counts.updated === 0) return;
    setBusy(true); setError(""); setStep("importing");
    const res = await confirmImport(fetch, review);
    if (res.ok) {
      setCounts(res.data.counts);
      setStep("result");
      if (onImported) onImported();
    } else {
      // The rows came out differently from the review: nothing was written, so the fresh review replaces the old one.
      if (res.changed) { setReview(res.review); setPage(1); }
      setError(res.error);
      setStep("review");
    }
    setBusy(false);
  };

  const startOver = () => { setStep("upload"); setReview(null); setCounts(null); setError(""); setPage(1); };

  return (
    <div style={{ animation: "fadeIn 0.35s ease", maxWidth: step === "result" ? 600 : 900 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 6 }}>Import Clients</h1>
      <div style={{ color: C.muted, fontSize: 14, marginBottom: "1.5rem" }}>Upload a CSV or Excel file exported from your CRM</div>

      <ErrorLine text={error} ui={ui} />

      {step === "upload" && <UploadStep ui={ui} busy={busy} onFile={upload} />}
      {(step === "review" || step === "importing") && review && (
        <ReviewStep
          ui={ui} review={review} fileName={fileName} page={page} busy={busy} importing={step === "importing"}
          onPage={setPage}
          onPick={(fieldId, column) => recheck(withMapping(review, fieldId, column))}
          onTick={(value, funded) => recheck(withStatus(review, value, funded))}
          onImport={runImport} onStartOver={startOver}
        />
      )}
      {step === "result" && counts && <ResultStep ui={ui} counts={counts} onDone={onDone} />}
    </div>
  );
}

// The Calculators page: four calculators on the shared math (calculators.mjs). Inputs live in React state only; nothing is saved,
// sent or kept once the page is left. `ui` carries App.jsx's shared styles.
import { createContext, useContext, useState } from "react";
import { gridCols } from "./layout.mjs";
import { useIsPhone } from "./useIsPhone.js";
import { CALC_LINES, paymentCalc, fmtCents } from "./calculators.mjs";
import { CARDS, freshInputs, inputFor } from "./calculatorsPage.mjs";

const Ctx = createContext(null);

// One labelled text field. `tag` is the small word beside the label; `placeholder` shows a filled-in estimate until something is typed.
function Field({ cardId, field, label, errors, tag, placeholder, children }) {
  const { ui, vals, set, touch, touched } = useContext(Ctx);
  const { C, inputStyle } = ui;
  const id = `calc-${cardId}-${field}`;
  const error = errors && errors[field] && touched[`${cardId}.${field}`] ? errors[field] : null;
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label htmlFor={id} style={{ display: "block", fontSize: 13, color: C.mutedHi, marginBottom: 6 }}>
        {label}{tag && <span style={{ fontSize: 11, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px", marginLeft: 8 }}>{tag}</span>}
      </label>
      <input id={id} type="text" inputMode="decimal" autoComplete="off" style={inputStyle} value={vals[cardId][field]} placeholder={placeholder || ""}
        onChange={(e) => set(cardId, field, e.target.value)} onBlur={() => touch(cardId, field)} />
      {children}
      {error && <div style={{ fontSize: 13, color: C.red, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// A result figure in the style of the Refi Analysis tiles. `tag` is a small word beside it ("not entered", "estimate").
function Tile({ label, value, tag, accent }) {
  const { ui, isPhone } = useContext(Ctx);
  const { C, mono, ph } = ui;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
      <div style={{ ...mono, color: accent || C.text, fontSize: 20, fontWeight: 700, wordBreak: "break-word", ...ph(isPhone, { fontSize: 17 }) }}>
        {value}
        {tag && <span style={{ fontSize: 11, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px", marginLeft: 8, fontWeight: 400 }}>{tag}</span>}
      </div>
    </div>
  );
}

const Tiles = ({ children }) => <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1.25rem 1rem" }}>{children}</div>;

// The estimate line sits under every result.
function Results({ children }) {
  const { ui } = useContext(Ctx);
  return (
    <div>
      {children}
      <div style={{ fontSize: 13, color: ui.C.muted, marginTop: "1.25rem" }}>{CALC_LINES.estimate}</div>
    </div>
  );
}

function PaymentCard() {
  const { ui, isPhone, vals } = useContext(Ctx);
  const { C } = ui;
  const s = vals.payment;
  const r = paymentCalc(inputFor("payment", s));
  const errors = r.ok ? null : r.errors;
  const miEstimated = r.ok && r.estimated.mi && s.miMonthly.trim() === "";
  const ne = (key) => (r.ok && r.notEntered.includes(key) ? CALC_LINES.notEntered : null);
  const F = (field, label, extra) => <Field cardId="payment" field={field} label={label} errors={errors} {...extra} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: gridCols(2, isPhone), gap: "1.5rem" }}>
      <div>
        {F("loanAmount", "Loan amount ($)")}
        {F("rate", "Rate (% a year)")}
        {F("termYears", "Term (years)")}
        {F("taxesYearly", "Property taxes ($ a year)")}
        {F("insuranceYearly", "Homeowner's insurance ($ a year)")}
        {F("miMonthly", "Mortgage insurance ($ a month)", { tag: miEstimated ? CALC_LINES.estimateTag : null, placeholder: miEstimated ? String(r.out.mi) : "" })}
        {F("hoaMonthly", "HOA dues ($ a month)")}
        {F("homeValue", "Home value ($, for the insurance estimate)")}
        {F("creditScore", "Credit score (for the insurance estimate)")}
      </div>
      <div>
        {r.ok && (
          <Results>
            <Tiles>
              <Tile label="Principal and interest" value={fmtCents(r.out.pi)} />
              <Tile label="Property taxes" value={fmtCents(r.out.taxes)} tag={ne("taxes")} />
              <Tile label="Homeowner's insurance" value={fmtCents(r.out.insurance)} tag={ne("insurance")} />
              <Tile label="Mortgage insurance" value={fmtCents(r.out.mi)} tag={r.estimated.mi ? CALC_LINES.estimateTag : ne("mi")} />
              <Tile label="HOA dues" value={fmtCents(r.out.hoa)} tag={ne("hoa")} />
              <Tile label="Total monthly payment" value={fmtCents(r.out.total)} accent={C.amber} />
            </Tiles>
          </Results>
        )}
      </div>
    </div>
  );
}

export default function CalculatorsView({ rates, prefill, onClearPrefill, ui }) {
  const { C, card, btnPrimary, btnGhost } = ui;
  const isPhone = useIsPhone();
  const [active, setActive] = useState("payment");
  const [vals, setVals] = useState(freshInputs);
  const [touched, setTouched] = useState({});

  const set = (cardId, field, value) => setVals((v) => ({ ...v, [cardId]: { ...v[cardId], [field]: value } }));
  const touch = (cardId, field) => setTouched((t) => (t[`${cardId}.${field}`] ? t : { ...t, [`${cardId}.${field}`]: true }));

  return (
    <Ctx.Provider value={{ ui, isPhone, vals, set, touch, touched, rates, prefill, onClearPrefill }}>
      <div style={{ animation: "fadeIn 0.35s ease", maxWidth: 960 }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text }}>Calculators</h1>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>{CALC_LINES.estimate}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "1.25rem" }}>
          {CARDS.map(([id, label]) => (
            <button key={id} onClick={() => setActive(id)} style={{ ...(active === id ? btnPrimary : btnGhost), padding: "8px 14px", fontSize: 13 }}>{label}</button>
          ))}
        </div>
        <div style={card}>
          {active === "payment" && <PaymentCard />}
        </div>
      </div>
    </Ctx.Provider>
  );
}

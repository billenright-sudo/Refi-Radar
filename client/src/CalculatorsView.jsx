// The Calculators page: four calculators on the shared math (calculators.mjs). Inputs live in React state only; nothing is saved,
// sent or kept once the page is left. `ui` carries App.jsx's shared styles.
import { createContext, useContext, useState } from "react";
import { gridCols } from "./layout.mjs";
import { useIsPhone } from "./useIsPhone.js";
import { CALC_LINES, paymentCalc, breakEvenCalc, blendedRateCalc, buydownCalc, closingCostsEstimate, fmtCents, fmtDollars, fmtRate, fmtBlended } from "./calculators.mjs";
import { CARDS, freshInputs, inputFor, fredLink, readNumber, fmtSigned, lifeDifference, seedTouched, MONTHS_MISSING, prefillStrip, prefillInputs } from "./calculatorsPage.mjs";

const Ctx = createContext(null);

// One labelled text field. `tag` is the small word beside the label; `placeholder` shows a filled-in estimate until something is typed.
// A refusal that depends on two fields (not a limit on this one) shows as soon as it exists.
const CROSS = new Set([CALC_LINES.termTooShort, CALC_LINES.noteTooLow, CALC_LINES.pointsNotLower]);

function Field({ cardId, field, label, errors, tag, placeholder, value, onEdit, children }) {
  const { ui, vals, set, touch, touched } = useContext(Ctx);
  const { C, inputStyle } = ui;
  const id = `calc-${cardId}-${field}`;
  const error = errors && errors[field] && (touched[`${cardId}.${field}`] || CROSS.has(errors[field])) ? errors[field] : null;
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label htmlFor={id} style={{ display: "block", fontSize: 13, color: C.mutedHi, marginBottom: 6 }}>
        {label}{tag && <span style={{ fontSize: 11, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px", marginLeft: 8 }}>{tag}</span>}
      </label>
      <input id={id} type="text" inputMode="decimal" autoComplete="off" style={inputStyle} value={value !== undefined ? value : vals[cardId][field]} placeholder={placeholder || ""}
        onChange={(e) => (onEdit ? onEdit(e.target.value) : set(cardId, field, e.target.value))} onBlur={() => touch(cardId, field)} />
      {children}
      {error && <div style={{ fontSize: 13, color: C.red, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// A result figure in the style of the Refi Analysis tiles. `tag` is a small word beside it ("not entered", "estimate").
function Tile({ label, value, tag, accent, sub }) {
  const { ui, isPhone } = useContext(Ctx);
  const { C, mono, ph } = ui;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{label}</div>
      <div style={{ ...mono, color: accent || C.text, fontSize: 20, fontWeight: 700, wordBreak: "break-word", ...ph(isPhone, { fontSize: 17 }) }}>
        {value}
        {tag && <span style={{ fontSize: 11, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px", marginLeft: 8, fontWeight: 400 }}>{tag}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
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

// Warnings (amber) and notes (muted) under a result.
function Lines({ warnings = [], notes = [] }) {
  const { ui } = useContext(Ctx);
  if (!warnings.length && !notes.length) return null;
  return (
    <div style={{ marginTop: "1.25rem" }}>
      {warnings.map((t) => <div key={t} style={{ fontSize: 13, color: ui.C.amber, marginBottom: 6 }}>{t}</div>)}
      {notes.map((t) => <div key={t} style={{ fontSize: 13, color: ui.C.muted, marginBottom: 6 }}>{t}</div>)}
    </div>
  );
}

// A row of buttons to pick one of a few options: the picked one is the primary button.
function Choice({ label, options, current, onPick }) {
  const { ui } = useContext(Ctx);
  const { C, btnPrimary, btnGhost } = ui;
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontSize: 13, color: C.mutedHi, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {options.map(([value, text]) => (
          <button key={value} type="button" onClick={() => onPick(value)} style={{ ...(current === value ? btnPrimary : btnGhost), padding: "8px 14px", fontSize: 13 }}>{text}</button>
        ))}
      </div>
    </div>
  );
}

// Label and figure rows inside a result (the compare-over breakdown).
function Rows({ title, rows }) {
  const { ui } = useContext(Ctx);
  const { C, mono } = ui;
  return (
    <div style={{ marginTop: "1.25rem" }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>{title}</div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, color: C.mutedHi, marginBottom: 4 }}>
          <span>{label}</span><span style={{ ...mono, color: C.text }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// Today's average, offered under a rate field; it fills the field only when clicked.
function AverageLink({ cardId, field, termYears }) {
  const { ui, rates, set } = useContext(Ctx);
  const link = fredLink(rates, readNumber(termYears));
  if (!link) return null;
  return (
    <button type="button" onClick={() => set(cardId, field, String(link.rate))}
      style={{ background: "none", border: "none", padding: 0, marginTop: 6, color: ui.C.blue, fontSize: 13, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
      {link.text}
    </button>
  );
}

// Inputs on the left, results on the right; on a phone the results sit under the inputs.
function TwoColumns({ inputs, results }) {
  const { isPhone } = useContext(Ctx);
  return (
    <div style={{ display: "grid", gridTemplateColumns: gridCols(2, isPhone), gap: "1.5rem" }}>
      <div style={{ minWidth: 0 }}>{inputs}</div>
      <div style={{ minWidth: 0 }}>{results}</div>
    </div>
  );
}

// Under a months-left field when the client's record has none (and nothing is typed yet).
function MonthsMissing({ cardId, field }) {
  const { ui, vals, prefill } = useContext(Ctx);
  if (!prefill || prefill.monthsLeft !== null || vals[cardId][field].trim() !== "") return null;
  return <div style={{ fontSize: 13, color: ui.C.muted, marginTop: 6 }}>{MONTHS_MISSING}</div>;
}

const noOf = (r, key) => (r.ok && r.notEntered.includes(key) ? CALC_LINES.notEntered : null);
const monthOrWhy = (month, costZero, noCostLine) => (month !== null ? `Month ${month}` : costZero ? noCostLine : "N/A");

function PaymentCard() {
  const { ui, vals } = useContext(Ctx);
  const { C } = ui;
  const s = vals.payment;
  const r = paymentCalc(inputFor("payment", s));
  const errors = r.ok ? null : r.errors;
  const miEstimated = r.ok && r.estimated.mi && s.miMonthly.trim() === "";
  const ne = (key) => noOf(r, key);
  const F = (field, label, extra) => <Field cardId="payment" field={field} label={label} errors={errors} {...extra} />;
  return (
    <TwoColumns
      inputs={<>
        {F("loanAmount", "Loan amount ($)")}
        {F("rate", "Rate (% a year)")}
        {F("termYears", "Term (years)")}
        {F("taxesYearly", "Property taxes ($ a year)")}
        {F("insuranceYearly", "Homeowner's insurance ($ a year)")}
        {F("miMonthly", "Mortgage insurance ($ a month)", { tag: miEstimated ? CALC_LINES.estimateTag : null, placeholder: miEstimated ? String(r.out.mi) : "" })}
        {F("hoaMonthly", "HOA dues ($ a month)")}
        {F("homeValue", "Home value ($, for the insurance estimate)")}
        {F("creditScore", "Credit score (for the insurance estimate)")}
      </>}
      results={r.ok && (
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
      )} />
  );
}

function BreakEvenCard() {
  const { ui, vals, set } = useContext(Ctx);
  const { C } = ui;
  const s = vals.breakEven;
  const r = breakEvenCalc(inputFor("breakEven", s));
  const errors = r.ok ? null : r.errors;
  const blank = (f) => s[f].trim() === "";
  const costsFigure = blank("closingCosts") ? closingCostsEstimate(readNumber(s.currentBalance)) : null;
  const miNewEst = r.ok && r.estimated.miNew && blank("miNewMonthly");
  const F = (field, label, extra) => <Field cardId="breakEven" field={field} label={label} errors={errors} {...extra} />;
  const o = r.ok ? r.out : null;
  const savingsTile = o && (o.monthlySavings < 0 ? CALC_LINES.moreAMonth(fmtCents(-o.monthlySavings)) : fmtCents(o.monthlySavings));
  return (
    <TwoColumns
      inputs={<>
        {F("currentBalance", "Current balance ($)")}
        {F("currentRate", "Current rate (% a year)")}
        {F("monthsLeft", "Months left on the current loan", { children: <MonthsMissing cardId="breakEven" field="monthsLeft" /> })}
        {F("newRate", "New rate (% a year)", { children: <AverageLink cardId="breakEven" field="newRate" termYears={s.newTermYears} /> })}
        {F("newTermYears", "New term (years)")}
        {F("closingCosts", "Closing costs ($)", { tag: costsFigure !== null ? CALC_LINES.estimateTag : null, placeholder: costsFigure !== null ? String(costsFigure) : "" })}
        <Choice label="Costs paid how" options={[["cash", "In cash"], ["loan", "Added to the new loan"]]} current={s.costsPaid} onPick={(v) => set("breakEven", "costsPaid", v)} />
        {F("miNowMonthly", "Mortgage insurance now ($ a month)")}
        {F("miNewMonthly", "Mortgage insurance on the new loan ($ a month)", { tag: miNewEst ? CALC_LINES.estimateTag : null, placeholder: miNewEst ? String(r.out.miNew) : "" })}
        {F("homeValue", "Home value ($, for the insurance estimate)")}
        {F("creditScore", "Credit score (for the insurance estimate)")}
      </>}
      results={o && (
        <Results>
          <Tiles>
            <Tile label="Current payment" value={fmtCents(o.currentPayment)} sub={CALC_LINES.currentPaymentLabel} />
            <Tile label="New payment" value={fmtCents(o.newPayment)} />
            <Tile label="Monthly savings" value={savingsTile} accent={o.monthlySavings > 0 ? C.green : C.red} />
            <Tile label="Break-even" value={monthOrWhy(o.breakEvenMonth, o.closingCosts === 0, CALC_LINES.noCosts)} accent={C.amber} />
            <Tile label="Mortgage insurance now" value={fmtCents(o.miNow)} tag={noOf(r, "miNow")} />
            <Tile label="Mortgage insurance, new loan" value={fmtCents(o.miNew)} tag={r.estimated.miNew ? CALC_LINES.estimateTag : noOf(r, "miNew")} />
            {o.costsInLoan && <Tile label="New loan amount" value={fmtDollars(o.newAmount)} />}
            <Tile label="Still to pay, current loan" value={fmtDollars(o.currentTotal)} />
            <Tile label="To pay, new loan" value={fmtDollars(o.newTotal)} />
            <Tile label="Difference over the life of the loan" value={lifeDifference(o.totalDifference)} />
          </Tiles>
          <Lines warnings={r.warnings} notes={r.notes.filter((n) => n !== CALC_LINES.noCosts)} />
        </Results>
      )} />
  );
}

function BlendedCard() {
  const { ui, vals, set } = useContext(Ctx);
  const { C } = ui;
  const s = vals.blended;
  const r = blendedRateCalc(inputFor("blended", s));
  const errors = r.ok ? null : r.errors;
  const first = readNumber(s.firstBalance), cash = readNumber(s.cashNeeded);
  const costsFigure = s.cashOutCosts.trim() === "" && first > 0 && cash > 0 ? closingCostsEstimate(first + cash) : null;
  const F = (field, label, extra) => <Field cardId="blended" field={field} label={label} errors={errors} {...extra} />;
  const o = r.ok ? r.out : null;
  const years = r.ok ? r.inputs.compareYears : null;
  const yearsWord = years === 1 ? "year" : "years";
  const summary = o && (o.cheaper === "keep" ? `Keeping the first and adding a second costs ${fmtDollars(o.difference)} less over ${years} ${yearsWord}.`
    : o.cheaper === "cashOut" ? `The cash-out costs ${fmtDollars(o.difference)} less over ${years} ${yearsWord}.`
    : `Both cost the same over ${years} ${yearsWord}.`);
  return (
    <TwoColumns
      inputs={<>
        {F("firstBalance", "First mortgage balance ($)")}
        {F("firstRate", "First mortgage rate (% a year)")}
        {F("firstMonthsLeft", "First mortgage months left", { children: <MonthsMissing cardId="blended" field="firstMonthsLeft" /> })}
        {F("cashNeeded", "Cash needed ($)")}
        <Choice label="Second kind" options={[["second", "Second"], ["heloc", "HELOC"]]} current={s.secondKind} onPick={(v) => set("blended", "secondKind", v)} />
        {F("secondRate", "Second rate (% a year)")}
        {F("secondTermYears", "Second term (years)")}
        {F("secondCosts", "Second closing costs ($, paid in cash)")}
        {F("cashOutRate", "Cash-out rate (% a year)", { children: <AverageLink cardId="blended" field="cashOutRate" termYears={s.cashOutTermYears} /> })}
        {F("cashOutTermYears", "Cash-out term (years)")}
        {F("cashOutCosts", "Cash-out closing costs ($, added to the new loan)", { tag: costsFigure !== null ? CALC_LINES.estimateTag : null, placeholder: costsFigure !== null ? String(costsFigure) : "" })}
        {F("compareYears", "Compare over (years)")}
      </>}
      results={o && (
        <Results>
          <Tiles>
            <Tile label="Blended rate" value={fmtBlended(o.blendedRate)} accent={C.amber} />
            <Tile label="First mortgage payment" value={fmtCents(o.firstPayment)} />
            <Tile label="Second payment" value={fmtCents(o.secondPayment)} />
            <Tile label="Combined payment" value={fmtCents(o.combinedPayment)} />
            <Tile label="Cash-out loan amount" value={fmtDollars(o.cashOutAmount)} />
            <Tile label="Cash-out payment" value={fmtCents(o.cashOutPayment)} />
            <Tile label="Keep + second total" value={fmtDollars(o.keep.total)} />
            <Tile label="Cash-out total" value={fmtDollars(o.cashOut.total)} />
          </Tiles>
          <div style={{ fontSize: 14, color: C.text, marginTop: "1.25rem" }}>{summary}</div>
          <Rows title={`Keep + second, over ${years} ${yearsWord}`} rows={[["Payments made", fmtDollars(o.keep.paid)], ["Still owed on the first", fmtDollars(o.keep.firstOwed)],
            ["Still owed on the second", fmtDollars(o.keep.secondOwed)], ["Costs paid in cash", fmtDollars(o.keep.cashCosts) + (noOf(r, "secondCosts") ? " (" + CALC_LINES.notEntered + ")" : "")], ["Total", fmtDollars(o.keep.total)]]} />
          <Rows title={`Cash-out, over ${years} ${yearsWord}`} rows={[["Payments made", fmtDollars(o.cashOut.paid)], ["Still owed", fmtDollars(o.cashOut.owed)], ["Total", fmtDollars(o.cashOut.total)]]} />
          <Lines notes={r.notes} />
        </Results>
      )} />
  );
}

const BUYDOWN_KINDS = [["2-1", "2-1"], ["3-2-1", "3-2-1"], ["1-0", "1-0"], ["points", "Points"]];

function BuydownCard() {
  const { ui, vals, set } = useContext(Ctx);
  const { C } = ui;
  const s = vals.buydown;
  const isPoints = s.kind === "points";
  const r = buydownCalc(inputFor("buydown", s));
  const errors = r.ok ? null : r.errors;
  const o = r.ok ? r.out : null;
  const F = (field, label, extra) => <Field cardId="buydown" field={field} label={label} errors={errors} {...extra} />;
  // The points pair: the one edited last shows what was typed, the other shows the recomputed figure.
  const edit = (field) => (v) => { set("buydown", field, v); set("buydown", "lastEdited", field); };
  const other = (field, shown) => (s.lastEdited && s.lastEdited !== field ? (o ? shown : "") : undefined);
  return (
    <TwoColumns
      inputs={<>
        <Choice label="Buydown" options={BUYDOWN_KINDS} current={s.kind} onPick={(v) => set("buydown", "kind", v)} />
        {F("loanAmount", "Loan amount ($)")}
        {F("noteRate", isPoints ? "Rate without points (% a year)" : "Note rate (% a year)")}
        {F("termYears", "Term (years)")}
        {isPoints && <>
          {F("rateWithPoints", "Rate with points (% a year)")}
          {F("points", "Points (% of the loan)", { onEdit: edit("points"), value: other("points", o && String(o.points)) })}
          {F("pointsCost", "Cost of the points ($)", { onEdit: edit("pointsCost"), value: other("pointsCost", o && String(o.cost)) })}
        </>}
      </>}
      results={o && (
        <Results>
          {o.kind === "points" ? (
            <Tiles>
              <Tile label="Cost of the points" value={fmtCents(o.cost)} />
              <Tile label="Points" value={String(o.points)} />
              <Tile label="Payment without points" value={fmtCents(o.paymentWithout)} />
              <Tile label="Payment with points" value={fmtCents(o.paymentWith)} />
              <Tile label="Monthly savings" value={fmtCents(o.monthlySavings)} accent={o.monthlySavings > 0 ? C.green : C.red} />
              <Tile label="Break-even" value={monthOrWhy(o.breakEvenMonth, o.cost === 0, CALC_LINES.noCost)} accent={C.amber} />
              <Tile label="Savings over the full term, less the cost" value={fmtSigned(o.fullTermSavings)} accent={o.fullTermSavings > 0 ? C.green : C.red} />
            </Tiles>
          ) : (
            <Tiles>
              {o.years.map((y) => <Tile key={y.year} label={`Year ${y.year} at ${fmtRate(y.rate)}`} value={fmtCents(y.payment)} />)}
              <Tile label="From then on" value={fmtCents(o.notePayment)} />
              <Tile label="Buydown cost" value={fmtCents(o.subsidy)} accent={C.amber} />
            </Tiles>
          )}
          <Lines warnings={r.warnings} notes={r.notes.filter((n) => n !== CALC_LINES.noCost)} />
        </Results>
      )} />
  );
}

export default function CalculatorsView({ rates, prefill, onClearPrefill, ui }) {
  const { C, card, btnPrimary, btnGhost } = ui;
  const isPhone = useIsPhone();
  const [active, setActive] = useState(prefill ? "breakEven" : "payment");
  const [vals, setVals] = useState(() => {
    const v = freshInputs();
    if (!prefill) return v;
    const seed = prefillInputs(prefill);
    for (const k of Object.keys(seed)) Object.assign(v[k], seed[k]);
    return v;
  });
  const [touched, setTouched] = useState(() => (prefill ? seedTouched(prefillInputs(prefill)) : {}));

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
        {prefill && (
          <div style={{ fontSize: 13, color: C.mutedHi, background: C.surfaceHi, borderRadius: 8, padding: "10px 14px", marginBottom: "1.25rem" }}>
            {prefillStrip(prefill)}{" "}
            <button type="button" onClick={onClearPrefill}
              style={{ background: "none", border: "none", padding: 0, color: C.blue, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>Clear</button>
          </div>
        )}
        <div style={card}>
          {active === "payment" && <PaymentCard />}
          {active === "breakEven" && <BreakEvenCard />}
          {active === "blended" && <BlendedCard />}
          {active === "buydown" && <BuydownCard />}
        </div>
      </div>
    </Ctx.Provider>
  );
}

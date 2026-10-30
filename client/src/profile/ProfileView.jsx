import { useEffect, useId, useRef, useState } from "react";
import { createCoalescer, inputAfterReload } from "../charli/google.mjs";
import { cleanName, validName, validEmail, loadProfile, saveName, requestEmailChange, saveStage, saveNmls } from "./profile.mjs";
import { CalendarCard, NmlsCard, StageCard } from "./cards.jsx";

// The Profile page: each user sets up their name, login email, Google calendar, tenure as a loan officer and NMLS IDs in one place.
// The logic and every server call are in profile.mjs; the Google card, the tenure card and the NMLS card are in cards.jsx.
//
// Props: user (from /api/auth/me), ui = { C, card, mono, Icon } (App's design tokens), onUserChanged(patch) (called with
// { firstName, lastName, email, careerStage } whenever the profile is taken from the server, so App's copy of the user follows),
// notice (optional: one line to show at the top when the page opens, e.g. where Google sent the browser back to;
// onNoticeShown() is called once it has been taken, so App can forget it).

const ROLES = { broker: "Broker", lo: "Loan officer" };

const inputStyle = (C, bad) => ({
  width: "100%", background: C.surfaceHi, border: `1px solid ${bad ? C.red : C.border}`, borderRadius: 8, padding: "7px 10px",
  color: C.text, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box",
});
const buttonStyle = (C, can) => ({
  border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 14px", background: "transparent", color: C.mutedHi, fontFamily: "inherit",
  fontSize: 13, fontWeight: 600, cursor: can ? "pointer" : "default", opacity: can ? 1 : 0.5, whiteSpace: "nowrap",
});

const Section = ({ title, hint, testId, ui: { C, card }, children }) => (
  <section data-testid={testId} style={{ ...card, padding: "1.1rem" }}>
    <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
    {hint && <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 0", lineHeight: 1.45 }}>{hint}</div>}
    <div style={{ marginTop: 12 }}>{children}</div>
  </section>
);

const Field = ({ label, value, onChange, testId, error, ui: { C }, ...input }) => {
  const id = useId();
  return (
    <div style={{ flex: "1 1 190px", minWidth: 0 }}>
      <label htmlFor={id} style={{ display: "block", color: C.muted, fontSize: 11.5, marginBottom: 4 }}>{label}</label>
      <input id={id} data-testid={testId} value={value} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} style={inputStyle(C, !!error)} {...input} />
    </div>
  );
};

const Note = ({ note, testId, C }) => note && (
  <div role="status" data-testid={testId} style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>
);

// ── Name ──

// `onSave(first, last)` resolves to { ok, data | error }. The fields follow the saved name until the user types in one.
const NameSection = ({ profile, ui, onSave }) => {
  const { C } = ui;
  const [first, setFirst] = useState(profile.firstName || "");
  const [last, setLast] = useState(profile.lastName || "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const seen = useRef({ first: profile.firstName, last: profile.lastName });

  useEffect(() => {
    setFirst((now) => inputAfterReload(now, seen.current.first, profile.firstName));
    setLast((now) => inputAfterReload(now, seen.current.last, profile.lastName));
    seen.current = { first: profile.firstName, last: profile.lastName };
  }, [profile.firstName, profile.lastName]);

  const problem = validName(first, last);
  const changed = cleanName(first) !== (profile.firstName || "") || cleanName(last) !== (profile.lastName || "");
  const can = !problem && changed && !busy;
  const firstBad = validName(first, "") !== null;   // which field the problem is in
  const lastBad = validName("A", last) !== null;
  const complaint = problem && (cleanName(first) === "" ? "Enter your first name." : problem);

  const submit = async (e) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true); setNote(null);
    const res = await onSave(first, last);
    if (res.ok) {
      setFirst(res.data.firstName || ""); setLast(res.data.lastName || "");
      setNote({ text: "Saved." });
    } else {
      setNote({ bad: true, text: res.error });
    }
    setBusy(false);
  };

  return (
    <Section title="Name" hint="Charlie uses your first name when he greets you." testId="profile-name" ui={ui}>
      <form onSubmit={submit} noValidate>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Field label="First name" value={first} onChange={setFirst} testId="profile-first-name" error={firstBad} maxLength={50} autoComplete="given-name" ui={ui} />
          <Field label="Last name" value={last} onChange={setLast} testId="profile-last-name" error={lastBad} maxLength={50} autoComplete="family-name" ui={ui} />
        </div>
        {changed && complaint && <div role="alert" data-testid="profile-name-problem" style={{ color: C.red, fontSize: 11.5, marginTop: 6 }}>{complaint}</div>}
        <div style={{ marginTop: 10 }}>
          <button type="submit" data-testid="profile-name-save" disabled={!can} style={buttonStyle(C, can)}>Save name</button>
        </div>
        <Note note={note} testId="profile-name-note" C={C} />
      </form>
    </Section>
  );
};

// ── Email ──

// `onRequest(email)` resolves to { ok, data: { pendingEmail } | error }. The login email changes only when the emailed link is opened.
const EmailSection = ({ profile, ui, onRequest }) => {
  const { C } = ui;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const typed = value.trim() !== "";
  const valid = validEmail(value);
  const can = valid && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true); setNote(null);
    const res = await onRequest(value.trim());
    if (res.ok) {
      setValue("");
      setNote({ text: "Link sent." });
    } else {
      setNote({ bad: true, text: res.error });
    }
    setBusy(false);
  };

  return (
    <Section title="Email" hint="The address you sign in with. A new one only takes effect after you click the link we send to it." testId="profile-email" ui={ui}>
      <div style={{ color: C.muted, fontSize: 11.5 }}>Current</div>
      <div data-testid="profile-email-current" style={{ fontSize: 14, margin: "2px 0 10px", overflowWrap: "anywhere" }}>{profile.email}</div>
      {profile.pendingEmail && (
        <div data-testid="profile-email-pending" style={{ color: C.amber, fontSize: 12.5, lineHeight: 1.45, margin: "0 0 10px", overflowWrap: "anywhere" }}>
          Check {profile.pendingEmail} for a confirmation link. Until you click it, you keep signing in with {profile.email}.
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <Field label="New email address" value={value} onChange={setValue} testId="profile-email-new" error={typed && !valid} type="email" autoComplete="email" maxLength={254} ui={ui} />
          <button type="submit" data-testid="profile-email-send" disabled={!can} style={buttonStyle(C, can)}>Send confirmation link</button>
        </div>
        {typed && !valid && <div role="alert" data-testid="profile-email-problem" style={{ color: C.red, fontSize: 11.5, marginTop: 6 }}>Enter a valid email address</div>}
        <Note note={note} testId="profile-email-note" C={C} />
      </form>
    </Section>
  );
};

// ── Tenure ──

const StageSection = ({ profile, ui, onSave }) => {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const pick = async (id) => {
    if (id === profile.careerStage || busy) return;
    setBusy(true); setNote(null);
    const res = await onSave(id);
    if (!res.ok) setNote({ bad: true, text: res.error });
    setBusy(false);
  };
  return (
    <div data-testid="profile-stage">
      <StageCard current={profile.careerStage} disabled={busy} onPick={pick} ui={ui} />
      <Note note={note} testId="profile-stage-note" C={ui.C} />
    </div>
  );
};

// ── the page ──

export default function ProfileView({ user, ui, onUserChanged, notice, onNoticeShown }) {
  const { C, Icon } = ui;
  const [profile, setProfile] = useState(null);   // null: not loaded (yet) | what GET /api/profile answered, kept up to date by saves
  const [loadError, setLoadError] = useState(null);
  const [shownNotice] = useState(notice || null);

  const profileRef = useRef(null);   // the profile as last taken (state, for the code that must not wait for a render)
  const epoch = useRef(0);           // bumped around every save: a read that started before one may hold the old values and is thrown away
  const reread = useRef(null);

  const take = (next) => {
    profileRef.current = next;
    setProfile(next);
    if (onUserChanged) onUserChanged({ firstName: next.firstName, lastName: next.lastName, email: next.email, careerStage: next.careerStage });
  };

  // One read. A failed re-read leaves what is shown as it was (only the first read that fails says so).
  const readProfile = async () => {
    const started = epoch.current;
    const res = await loadProfile(fetch);
    if (started !== epoch.current) { reread.current(); return; }   // a save happened while it was in flight: read again
    if (res.ok) { setLoadError(null); take(res.data); } else { setLoadError(res.error); }
  };
  if (!reread.current) reread.current = createCoalescer(readProfile);

  useEffect(() => {
    reread.current();
    // An email change is confirmed from the inbox, and an NMLS ID can be saved from another tab: read again when this one is back in front.
    const onFocus = () => reread.current({ soft: true });
    const onVisible = () => { if (document.visibilityState === "visible") reread.current({ soft: true }); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    if (notice && onNoticeShown) onNoticeShown();
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // One change made here (`call` resolves to { ok, data | error }). What the server answers is merged into the profile (a save answers
  // with the whole profile, an email request with { pendingEmail }, an NMLS save with the NMLS IDs). `refetch`: read the whole profile
  // again afterwards.
  const change = async (call, { refetch = false } = {}) => {
    epoch.current += 1;
    const res = await call();
    if (res.ok) take({ ...(profileRef.current || {}), ...res.data });
    epoch.current += 1;
    if (res.ok && refetch) reread.current();
    return res;
  };

  const role = ROLES[user && user.role];

  return (
    <div style={{ animation: "fadeIn 0.3s ease", maxWidth: 720 }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="users" size={20} color={C.amber} />Profile
        </h1>
        <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
          {role ? `${role}. ` : ""}Your details for Charlie and for the emails he sets up.
        </div>
      </div>

      {shownNotice && (
        <div role="status" data-testid="profile-notice" style={{ color: C.mutedHi, fontSize: 13, marginBottom: "1rem" }}>{shownNotice}</div>
      )}

      {/* The Calendar card makes its own server call, so it is here whether or not the profile has loaded (a failed profile read must not
          take Connect / Disconnect away). It keeps its slot, so it is not remounted when the profile arrives. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {profile ? (
          <>
            <NameSection profile={profile} ui={ui} onSave={(first, last) => change(() => saveName(fetch, first, last))} />
            <EmailSection profile={profile} ui={ui} onRequest={(email) => change(() => requestEmailChange(fetch, email))} />
          </>
        ) : (
          <div data-testid="profile-loading" style={{ color: loadError ? C.red : C.muted, fontSize: 13.5, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span>{loadError || "Loading your profile…"}</span>
            {loadError && <button type="button" data-testid="profile-retry" onClick={() => reread.current()} style={buttonStyle(C, true)}>Try again</button>}
          </div>
        )}
        <CalendarCard ui={ui} />
        {profile && <StageSection profile={profile} ui={ui} onSave={(stage) => change(() => saveStage(fetch, stage))} />}
        {profile && <NmlsCard profile={profile} ui={ui} onSave={(which, value) => change(() => saveNmls(fetch, which, value), { refetch: true })} />}
      </div>
    </div>
  );
}

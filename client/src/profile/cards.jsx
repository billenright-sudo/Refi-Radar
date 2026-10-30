import { useEffect, useId, useRef, useState } from "react";
import { CAREER_STAGES } from "../charli/session.mjs";
import { googleCard, validNmls, connectUrlOk, inputAfterReload, createCoalescer } from "../charli/google.mjs";

// The cards the Profile page shares with what used to be the Charlie panel (they were in charli/CharliView.jsx). Each takes
// ui = { C, card, mono, Icon } (App's design tokens). The logic is google.mjs's and session.mjs's; this file draws it.

// ── Tenure as a loan officer ──

export const StageCard = ({ current, disabled, onPick, ui: { C, card, Icon } }) => (
  <div style={{ ...card, padding: "1.1rem" }}>
    <div style={{ fontSize: 14, fontWeight: 600 }}>Tenure as a loan officer</div>
    <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.45 }}>
      How long you&rsquo;ve been originating. Charlie explains more or less to match; the numbers never change.
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {CAREER_STAGES.map(({ id, label }) => {
        const active = id === current;
        return (
          <button
            key={id}
            data-testid={`charli-stage-${id}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onPick(id)}
            style={{
              display: "flex", alignItems: "center", gap: 8, textAlign: "left", fontFamily: "inherit", fontSize: 13,
              fontWeight: active ? 700 : 500, padding: "9px 12px", borderRadius: 9,
              background: active ? C.amberBg : C.surfaceHi, color: active ? C.amber : C.mutedHi,
              border: `1px solid ${active ? C.amber : C.border}`, cursor: disabled ? "default" : "pointer", opacity: disabled && !active ? 0.6 : 1,
            }}
          >
            {active ? <Icon name="check" size={14} color={C.amber} /> : <span style={{ width: 14 }} />}
            {label}
          </button>
        );
      })}
    </div>
    {!current && <div style={{ color: C.muted, fontSize: 12, marginTop: 10 }}>Not set yet. Charlie will ask, or pick one.</div>}
  </div>
);

// ── Calendar: the Google connection ──

// One call to the app's own API; never throws. -> { ok, status, data }
async function callApi(method, url, body) {
  try {
    const res = await fetch(url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
const errorOf = (res, fallback) => (res.data && typeof res.data.error === "string" && res.data.error.trim()) || fallback;

const GOOGLE_BUTTONS = { connect: "Connect", reconnect: "Reconnect", disconnect: "Disconnect" };
const DISCONNECT_CONFIRM = "Disconnect Google? Charlie will stop reading and booking your calendar.";

// The card reads Google's state on open and whenever the window gets focus back: Charlie can find out mid-conversation that the
// connection expired (her reply says to reconnect it here).
export const CalendarCard = ({ ui }) => {
  const { C, card, Icon } = ui;
  const [google, setGoogle] = useState(null);     // null: checking | "failed" | what /api/google/status answered
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);         // { text, bad? } | null

  const epoch = useRef(0);           // bumped around every change made here: a read that started before one is stale and is thrown away
  const reread = useRef(null);

  // A failed re-read leaves what is shown as it was (only a first read that fails says so).
  const readStatus = async () => {
    const started = epoch.current;
    const g = await callApi("GET", "/api/google/status");
    if (started !== epoch.current) { reread.current(); return; }   // something changed here while it was in flight: read again
    setGoogle((shown) => (g.ok && g.data && typeof g.data === "object" ? g.data : shown === null ? "failed" : shown));
  };
  if (!reread.current) reread.current = createCoalescer(readStatus);

  useEffect(() => {
    reread.current();
    const onFocus = () => reread.current({ soft: true });
    const onVisible = () => { if (document.visibilityState === "visible") reread.current({ soft: true }); };
    // coming back to this page from Google with the Back button can restore it as it was, with Connect still "working"
    const onShow = (e) => { if (e.persisted) { setBusy(false); reread.current(); } };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const line = google === null
    ? { label: "Checking your Google connection…", action: null }
    : google === "failed"
      ? { label: "Couldn't check your Google connection right now.", action: null }
      : googleCard(google);
  const dot = line.action === "disconnect" ? C.green : line.action === "reconnect" ? C.amber : C.muted;

  // Connect and Reconnect are the same trip: ask the server for Google's consent address and go there (it comes back to /?google=...).
  // Only Google's own address is followed. On the way there the button stays busy, so a second click cannot start another sign-in.
  const goToGoogle = async () => {
    setBusy(true); setNote(null);
    const res = await callApi("POST", "/api/google/connect");
    if (res.ok && res.data && connectUrlOk(res.data.url)) {
      window.location.assign(res.data.url);
      return;
    }
    setNote({ bad: true, text: res.ok ? "Google couldn't be connected. Try again." : errorOf(res, "Google couldn't be connected. Try again.") });
    setBusy(false);
  };
  const disconnect = async () => {
    if (!window.confirm(DISCONNECT_CONFIRM)) return;
    setBusy(true); setNote(null);
    epoch.current += 1;
    const res = await callApi("POST", "/api/google/disconnect");
    if (res.ok && res.data && res.data.success === true) {
      setGoogle((shown) => (shown && typeof shown === "object" ? { ...shown, connected: false, status: null, googleEmail: null } : shown));
      setNote({ text: "Google is disconnected." });
    } else {
      setNote({ bad: true, text: errorOf(res, "Google couldn't be disconnected. Try again.") });
    }
    epoch.current += 1;
    reread.current();   // whatever happened, what the server says now is what the card shows
    setBusy(false);
  };

  return (
    <div data-testid="charli-google-card" style={{ ...card, padding: "1.1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <Icon name="mail" size={15} color={C.amber} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Calendar</span>
        </div>
        {line.action && (
          <button
            type="button"
            data-testid="charli-google-action"
            disabled={busy}
            onClick={line.action === "disconnect" ? disconnect : goToGoogle}
            style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", background: line.action === "disconnect" ? "transparent" : C.amber, color: line.action === "disconnect" ? C.mutedHi : "#0f2040", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {GOOGLE_BUTTONS[line.action]}
          </button>
        )}
      </div>
      <div data-testid="charli-google-status" style={{ display: "flex", alignItems: "center", gap: 8, color: C.mutedHi, fontSize: 13, lineHeight: 1.45, margin: "6px 0 0" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flex: "none" }} />
        <span style={{ overflowWrap: "anywhere" }}>{line.label}</span>
      </div>
      {note && <div role="status" data-testid="charli-google-note" style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>}
    </div>
  );
};

// ── NMLS IDs: the numbers every email Charlie sets up is signed with ──

const NmlsField = ({ label, value, saved, busy, testId, onChange, onSave, ui: { C } }) => {
  const id = useId();
  const valid = validNmls(value);
  const changed = value.trim() !== (saved || "");
  const can = valid && changed && !busy;
  return (
    <div style={{ flex: "1 1 190px", minWidth: 0 }}>
      <label htmlFor={id} style={{ display: "block", color: C.muted, fontSize: 11.5, marginBottom: 4 }}>{label}</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          id={id}
          data-testid={testId}
          inputMode="numeric"
          maxLength={12}
          placeholder="Digits only"
          value={value}
          aria-invalid={!valid}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && can) onSave(); }}
          style={{ flex: 1, minWidth: 0, background: C.surfaceHi, border: `1px solid ${valid ? C.border : C.red}`, borderRadius: 8, padding: "7px 10px", color: C.text, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box" }}
        />
        <button
          type="button"
          data-testid={`${testId}-save`}
          disabled={!can}
          onClick={onSave}
          style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", background: "transparent", color: C.mutedHi, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: can ? "pointer" : "default", opacity: can ? 1 : 0.5 }}
        >
          {value.trim() === "" && saved ? "Clear" : "Save"}
        </button>
      </div>
      {!valid && <div style={{ color: C.red, fontSize: 11.5, marginTop: 3 }}>An NMLS ID is digits only (up to twelve).</div>}
    </div>
  );
};

// `profile` is the page's profile ({ nmlsId, orgNmlsId, canEditOrg } is what it reads). `onSave(which, value)` saves "own" or "org" and
// resolves to { ok, data | error }; the page takes the new IDs from it and reads the profile again. A field the user has typed in is
// never overwritten by a re-read of the profile.
export const NmlsCard = ({ ui, profile, onSave }) => {
  const { C, card } = ui;
  const [own, setOwn] = useState(profile.nmlsId || "");
  const [org, setOrg] = useState(profile.orgNmlsId || "");
  const [busy, setBusy] = useState("");           // "own" | "org" | "" (nothing running)
  const [note, setNote] = useState(null);         // { text, bad? } | null
  const seen = useRef({ own: profile.nmlsId, org: profile.orgNmlsId });   // what the saved IDs were when the fields last followed them

  useEffect(() => {
    setOwn((now) => inputAfterReload(now, seen.current.own, profile.nmlsId));
    setOrg((now) => inputAfterReload(now, seen.current.org, profile.orgNmlsId));
    seen.current = { own: profile.nmlsId, org: profile.orgNmlsId };
  }, [profile.nmlsId, profile.orgNmlsId]);

  const save = async (which) => {
    setBusy(which); setNote(null);
    const res = await onSave(which, which === "org" ? org : own);
    if (res.ok) {
      if (which === "org") setOrg(res.data.orgNmlsId || ""); else setOwn(res.data.nmlsId || "");
      setNote({ text: "Saved." });
    } else {
      setNote({ bad: true, text: res.error });
    }
    setBusy("");
  };

  return (
    <div data-testid="profile-nmls-card" style={{ ...card, padding: "1.1rem" }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>NMLS IDs</div>
      <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.45 }}>
        Every email Charlie sets up is signed with your NMLS ID. You review it and send it yourself.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <NmlsField label="Your NMLS ID" value={own} saved={profile.nmlsId} busy={busy !== ""} testId="charli-nmls" onChange={setOwn} onSave={() => save("own")} ui={ui} />
        {profile.canEditOrg && (
          <NmlsField label="Company NMLS ID" value={org} saved={profile.orgNmlsId} busy={busy !== ""} testId="charli-org-nmls" onChange={setOrg} onSave={() => save("org")} ui={ui} />
        )}
      </div>
      {note && <div role="status" data-testid="profile-nmls-note" style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>}
    </div>
  );
};

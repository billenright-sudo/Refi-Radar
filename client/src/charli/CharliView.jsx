import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createSession, CAREER_STAGES, pendingRows, voiceNoteFor } from "./session.mjs";
import { keptSession } from "./keep.mjs";
import { googleCard, validNmls, connectUrlOk, inputAfterReload, createCoalescer } from "./google.mjs";
import { createAudio, transcribe } from "./audio.js";

// Charli, the voice co-pilot. The conversation and every server call live in session.mjs; the microphone and
// speaker live in audio.js. This file is the screen: it wires the two together and draws the result.
//
// Props: rates (today's rates, from App), user (from /api/auth/me), ui = { C, card, mono, Icon } (App's design tokens),
// notice (optional: one line to show in the transcript when the screen opens, e.g. where Google sent the browser back to;
// onNoticeShown() is called once it has been shown, so App can forget it).

const MIC_NOTES = {
  denied: "Microphone access is blocked. Allow it in your browser's site settings to talk to Charli. Typing works in the meantime.",
  unavailable: "No microphone is available here, so Charli can't hear you. Typing works.",
  error: "The microphone stopped working. Typing works in the meantime.",
};

// ── pieces ───────────────────────────────────────────────────────────────────

const Turn = ({ turn, ui }) => {
  const { C, mono } = ui;
  if (turn.kind === "notice") {
    return <div style={{ color: C.muted, fontSize: 12.5, fontStyle: "italic", padding: "2px 6px" }}>{turn.content}</div>;
  }
  const mine = turn.role === "user";
  const failed = turn.kind === "error";
  const bubble = mine
    ? { background: C.surfaceHi, border: `1px solid ${C.border}`, color: C.text }
    : failed
      ? { background: C.redBg, border: "1px solid #4a1414", color: C.red }
      : { background: C.bg, border: `1px solid ${C.border}`, color: C.text };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
      <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.4px", textTransform: "uppercase", margin: "0 6px 3px" }}>
        {mine ? "You" : "Charli"}
      </div>
      <div data-testid={mine ? "charli-user-turn" : failed ? "charli-error-turn" : "charli-turn"} style={{ ...bubble, borderRadius: 12, padding: "10px 14px", fontSize: 14, lineHeight: 1.5, maxWidth: "88%", whiteSpace: "pre-wrap" }}>
        {turn.content}
        {!mine && (turn.sources.length > 0 || turn.kind === "unverified") && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {turn.sources.map((source, i) => (
              <span key={i} style={{ ...mono, fontSize: 10.5, color: C.mutedHi, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 8px" }}>
                source: {source}
              </span>
            ))}
            {/* spec §7.4: a can't-verify or guideline hand-off reply is marked as such */}
            {turn.kind === "unverified" && (
              <span data-testid="charli-unverified" style={{ ...mono, fontSize: 10.5, color: C.amber, background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 6, padding: "2px 8px" }}>
                unable to verify
              </span>
            )}
          </div>
        )}
      </div>
      {/* an email Charli set up: shown for the broker to open in their own mail app (session.mjs has checked its links) */}
      {!mine && turn.compose && <ComposeCard compose={turn.compose} ui={ui} />}
    </div>
  );
};

// The email Charli set up (spec §4 anti-goal 2: nothing is sent from here). The text is code-authored on the server and shown
// exactly as it will open; the three links open it ready to go in the broker's own Gmail, Outlook or mail app.
const COMPOSE_LINKS = [["gmail", "Open in Gmail"], ["outlook", "Open in Outlook"], ["mailto", "Other email app"]];
const ComposeCard = ({ compose, ui: { C, card, Icon } }) => (
  <div data-testid="charli-compose" style={{ ...card, marginTop: 8, padding: "0.9rem 1.1rem", width: "88%", boxSizing: "border-box" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 7, color: C.muted, fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 8 }}>
      <Icon name="mail" size={13} color={C.muted} />Email draft — not sent
    </div>
    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", margin: "0 0 12px", fontSize: 13 }}>
      <dt style={{ color: C.muted }}>To</dt>
      <dd data-testid="charli-compose-to" style={{ margin: 0, color: C.text, overflowWrap: "anywhere" }}>{compose.to}</dd>
      <dt style={{ color: C.muted }}>Subject</dt>
      <dd data-testid="charli-compose-subject" style={{ margin: 0, color: C.text, overflowWrap: "anywhere" }}>{compose.subject}</dd>
      <dt style={{ color: C.muted }}>Message</dt>
      <dd data-testid="charli-compose-body" style={{ margin: 0, color: C.text, overflowWrap: "anywhere", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{compose.body}</dd>
    </dl>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {COMPOSE_LINKS.map(([key, label]) => (
        <a
          key={key}
          data-testid={`charli-compose-${key}`}
          href={compose.links[key]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 600, color: C.mutedHi, background: C.surfaceHi, textDecoration: "none" }}
        >
          {label}
        </a>
      ))}
    </div>
  </div>
);

const StageCard = ({ current, disabled, onPick, ui: { C, card, Icon } }) => (
  <div style={{ ...card, padding: "1.1rem" }}>
    <div style={{ fontSize: 14, fontWeight: 600 }}>Coaching style</div>
    <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.45 }}>
      How long you&rsquo;ve been originating. Charli explains more or less to match; the numbers never change.
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
    {!current && <div style={{ color: C.muted, fontSize: 12, marginTop: 10 }}>Not set yet. Charli will ask, or pick one.</div>}
  </div>
);

// ── Calendar & email: the Google connection and the NMLS IDs every email is signed with ──

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
const DISCONNECT_CONFIRM = "Disconnect Google? Charli will stop reading and booking your calendar.";

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

// `working`: Charli's session is busy with a turn, a confirm or a cancel (not the opening greeting). The card reads Google's
// state and the NMLS IDs on open, again whenever that ends, and whenever the window gets focus back: Charli can find out
// mid-conversation that the connection expired (her reply says to reconnect it here), and an ID can be saved from another tab.
const CalendarEmailCard = ({ ui, working }) => {
  const { C, card, Icon } = ui;
  const [google, setGoogle] = useState(null);     // null: checking | "failed" | what /api/google/status answered
  const [profile, setProfile] = useState(null);   // null: not loaded | what /api/profile/nmls answered
  const [own, setOwn] = useState("");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState("");           // "google" | "own" | "org" | "" (nothing running)
  const [note, setNote] = useState(null);         // { text, bad? } | null

  const profileRef = useRef(null);   // what the profile was when it was last taken (state, for the code that must not wait for a render)
  const epoch = useRef(0);           // bumped around every change made here: a read that started before one is stale and is thrown away
  const reread = useRef(null);
  const wasWorking = useRef(false);

  const isProfile = (res) => res.ok && res.data && typeof res.data === "object" && "nmlsId" in res.data;
  // A field the user has typed in is never overwritten by a re-read; `overwrite` ("own" | "org") is the one just saved.
  const takeProfile = (p, { overwrite } = {}) => {
    const before = profileRef.current;
    profileRef.current = p;
    setProfile(p);
    setOwn((now) => (overwrite === "own" ? p.nmlsId || "" : inputAfterReload(now, before && before.nmlsId, p.nmlsId)));
    setOrg((now) => (overwrite === "org" ? p.orgNmlsId || "" : inputAfterReload(now, before && before.orgNmlsId, p.orgNmlsId)));
  };
  // One read of both. A failed re-read leaves what is shown as it was (only a first read that fails says so).
  const readAll = async () => {
    const started = epoch.current;
    const [g, p] = await Promise.all([callApi("GET", "/api/google/status"), callApi("GET", "/api/profile/nmls")]);
    if (started !== epoch.current) { reread.current(); return; }   // something changed here while it was in flight: read again
    setGoogle((shown) => (g.ok && g.data && typeof g.data === "object" ? g.data : shown === null ? "failed" : shown));
    if (isProfile(p)) takeProfile(p.data);
  };
  if (!reread.current) reread.current = createCoalescer(readAll);

  useEffect(() => {
    reread.current();
    const onFocus = () => reread.current({ soft: true });
    const onVisible = () => { if (document.visibilityState === "visible") reread.current({ soft: true }); };
    // coming back to this page from Google with the Back button can restore it as it was, with Connect still "working"
    const onShow = (e) => { if (e.persisted) { setBusy(""); reread.current(); } };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (wasWorking.current && !working) reread.current();
    wasWorking.current = working;
  }, [working]);

  const line = google === null
    ? { label: "Checking your Google connection…", action: null }
    : google === "failed"
      ? { label: "Couldn't check your Google connection right now.", action: null }
      : googleCard(google);
  const dot = line.action === "disconnect" ? C.green : line.action === "reconnect" ? C.amber : C.muted;

  // Connect and Reconnect are the same trip: ask the server for Google's consent address and go there (it comes back to /?google=...).
  // Only Google's own address is followed. On the way there the button stays busy, so a second click cannot start another sign-in.
  const goToGoogle = async () => {
    setBusy("google"); setNote(null);
    const res = await callApi("POST", "/api/google/connect");
    if (res.ok && res.data && connectUrlOk(res.data.url)) {
      window.location.assign(res.data.url);
      return;
    }
    setNote({ bad: true, text: res.ok ? "Google couldn't be connected. Try again." : errorOf(res, "Google couldn't be connected. Try again.") });
    setBusy("");
  };
  const disconnect = async () => {
    if (!window.confirm(DISCONNECT_CONFIRM)) return;
    setBusy("google"); setNote(null);
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
    setBusy("");
  };

  const saveNmls = async (which) => {
    const [url, value] = which === "org" ? ["/api/profile/org-nmls", org] : ["/api/profile/nmls", own];
    setBusy(which); setNote(null);
    epoch.current += 1;
    const res = await callApi("PUT", url, { nmlsId: value.trim() });
    if (isProfile(res)) {
      takeProfile(res.data, { overwrite: which });
      setNote({ text: "Saved." });
    } else {
      setNote({ bad: true, text: errorOf(res, "That didn't save. Try again.") });
    }
    epoch.current += 1;
    setBusy("");
  };

  const googleBusy = busy === "google";
  return (
    <div data-testid="charli-google-card" style={{ ...card, padding: "0.9rem 1.1rem", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <Icon name="mail" size={15} color={C.amber} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Calendar &amp; email</span>
        </div>
        {line.action && (
          <button
            type="button"
            data-testid="charli-google-action"
            disabled={googleBusy}
            onClick={line.action === "disconnect" ? disconnect : goToGoogle}
            style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", background: line.action === "disconnect" ? "transparent" : C.amber, color: line.action === "disconnect" ? C.mutedHi : "#0f2040", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: googleBusy ? "default" : "pointer", opacity: googleBusy ? 0.6 : 1 }}
          >
            {GOOGLE_BUTTONS[line.action]}
          </button>
        )}
      </div>
      <div data-testid="charli-google-status" style={{ display: "flex", alignItems: "center", gap: 8, color: C.mutedHi, fontSize: 13, lineHeight: 1.45, margin: "6px 0 10px" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flex: "none" }} />
        <span style={{ overflowWrap: "anywhere" }}>{line.label}</span>
      </div>
      {profile && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <NmlsField label="Your NMLS ID" value={own} saved={profile.nmlsId} busy={busy !== ""} testId="charli-nmls" onChange={setOwn} onSave={() => saveNmls("own")} ui={ui} />
          {profile.canEditOrg && (
            <NmlsField label="Company NMLS ID" value={org} saved={profile.orgNmlsId} busy={busy !== ""} testId="charli-org-nmls" onChange={setOrg} onSave={() => saveNmls("org")} ui={ui} />
          )}
        </div>
      )}
      {profile && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 8, lineHeight: 1.45 }}>Every email Charli sets up is signed with your NMLS ID. You review it and send it yourself.</div>}
      {note && <div role="status" data-testid="charli-google-note" style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>}
    </div>
  );
};

// ── the view ─────────────────────────────────────────────────────────────────

export default function CharliView({ rates, user, ui, notice, onNoticeShown }) {
  const { C, card, mono, Icon } = ui;

  const [paused, setPaused] = useState(false);
  const [mic, setMic] = useState("starting");   // starting | live | off | denied | unavailable | error
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [needsStart, setNeedsStart] = useState(false);   // the browser would not play audio without a tap
  const [voiceDown, setVoiceDown] = useState(false);     // speech-to-text is not set up on the server
  const [voiceNote, setVoiceNote] = useState("");
  const [draft, setDraft] = useState("");

  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // The conversation outlives a visit to this screen (keep.mjs): coming back shows it again, with no second greeting. The audio
  // is built once per visit.
  const parts = useRef(null);
  if (!parts.current) {
    const { session, voice } = keptSession(user && user.id, (onSpeak) => createSession({
      rates,
      localHour: new Date().getHours(),
      user,
      onSpeak,
    }));

    const handleUtterance = async (blob) => {
      setTranscribing(true);
      // the change on screen when this recording went off: a yes / no that comes back after it was handled is dropped
      const pendingAtStart = session.getState().pending;
      try {
        const text = await transcribe(blob);
        if (pausedRef.current) return;   // paused while it was being transcribed: drop it
        const result = await session.heard(text, { pendingAtStart });
        if (!result.ok && (result.reason === "busy" || result.reason === "not-ready")) {
          session.notice("I was still working on your last message. Could you say that again?");
        }
      } catch (err) {
        if (pausedRef.current) return;
        if (err && err.status === 503) {
          setVoiceDown(true);
          session.notice("Voice isn't set up on this server, so I can't hear you. You can still type below.");
        } else {
          session.notice("Sorry, I couldn't make that out. Could you say it again?", { say: true });
        }
      } finally {
        setTranscribing(false);
      }
    };

    const audio = createAudio({
      onUtterance: handleUtterance,
      onSpeakingChange: setSpeaking,
      onHearing: setHearing,
      onMicChange: setMic,
      onAutoplayBlocked: () => setNeedsStart(true),
      onTtsOk: () => { setVoiceNote(""); setNeedsStart(false); },   // it played, so no tap is needed after all
      onTtsError: (status, body) => setVoiceNote(voiceNoteFor(status, body)),
    });
    parts.current = { session, audio, voice };
  }
  const { session, audio, voice } = parts.current;

  useEffect(() => {
    voice.speak = (line) => { if (!pausedRef.current) audio.speak(line); };
    audio.startMic();
    session.open();
    // leaving the screen: mic off, speech cut, a change waiting for a yes dropped; the conversation is kept for coming back
    return () => { voice.speak = null; session.leave(); audio.dispose(); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { session.setRates(rates); }, [rates]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A line handed in by App (where Google sent the browser back to) goes in the transcript once, then App forgets it.
  useEffect(() => {
    if (!notice) return;
    session.notice(notice);
    if (onNoticeShown) onNoticeShown();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const snap = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const working = snap.busy || snap.opening || transcribing;

  // Half-duplex: listen only when Charli is neither speaking nor working on something.
  useEffect(() => {
    audio.setCapture(mic === "live" && !paused && !speaking && !working && !voiceDown);
  }, [mic, paused, speaking, working, voiceDown]);   // eslint-disable-line react-hooks/exhaustive-deps

  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.turns.length, snap.pending]);

  const togglePause = () => {
    if (!paused) {
      setPaused(true);
      audio.stopSpeaking();
      audio.stopMic();
    } else {
      setPaused(false);
      audio.unlock();
      audio.startMic();
    }
  };
  const startCharli = () => {
    setNeedsStart(false);
    audio.unlock();
    audio.retryBlocked();
    audio.startMic();
  };
  const enableMic = () => { audio.unlock(); audio.startMic(); };

  // Anything the user does by hand cuts off what Charli is saying.
  const act = (fn) => { audio.stopSpeaking(); fn(); };
  const canSend = !!draft.trim() && snap.hasRates && !working;
  const sendDraft = async () => {
    if (!canSend) return;
    audio.stopSpeaking();
    const result = await session.submit(draft);
    if (result.ok) setDraft("");
  };

  // ── status ──
  let status;
  let dot = C.muted;
  if (!snap.hasRates) status = "Fetching rates…";
  else if (paused) status = "Paused";
  else if (speaking) { status = "Speaking…"; dot = C.blue; }
  else if (working) { status = "Thinking…"; dot = C.amber; }
  else if (voiceDown) status = "Type below. Voice input isn't set up here";
  else if (mic === "live") { status = hearing ? "Listening… hearing you" : "Listening"; dot = C.green; }
  else if (mic === "starting") status = "Starting the microphone…";
  else status = "Type below. The microphone is off";

  const micNote = !paused && MIC_NOTES[mic];
  const buttonBase = { display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 9, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" };
  const primary = { ...buttonBase, background: C.amber, color: "#0f2040" };
  const ghost = { ...buttonBase, background: "transparent", color: C.mutedHi, border: `1px solid ${C.border}` };

  return (
    <div style={{ animation: "fadeIn 0.3s ease", maxWidth: 960 }}>
      <style>{"@keyframes charliPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(1.5); } }"}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: "1.25rem" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="mic" size={20} color={C.amber} />Charli
          </h1>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
            Your voice co-pilot. Ask for a market update, run a sweep of your book, or log a contact. Say it or type it.
          </div>
        </div>
        <button data-testid="charli-pause" onClick={togglePause} style={paused ? primary : ghost}>
          <Icon name="mic" size={15} color={paused ? "#0f2040" : C.mutedHi} />{paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem", flexWrap: "wrap" }}>
        <div data-testid="charli-status" role="status" aria-live="polite" style={{ display: "inline-flex", alignItems: "center", gap: 9, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 999, padding: "6px 14px", fontSize: 13, color: C.mutedHi }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, animation: hearing && !paused ? "charliPulse 0.9s ease-in-out infinite" : "none" }} />
          {status}
        </div>
        {voiceNote && <span style={{ color: C.muted, fontSize: 12.5 }}>{voiceNote}</span>}
      </div>

      {needsStart && (
        <div style={{ ...card, borderColor: C.amber, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: "1rem", padding: "1rem 1.25rem" }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>Your browser needs a tap before Charli can speak and listen.</div>
          <button data-testid="charli-start" onClick={startCharli} style={primary}><Icon name="mic" size={15} color="#0f2040" />Start Charli</button>
        </div>
      )}

      {micNote && (
        <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: "1rem", padding: "0.9rem 1.25rem", color: C.mutedHi, fontSize: 13, lineHeight: 1.45 }}>
          <span>{micNote}</span>
          {mic !== "unavailable" && <button onClick={enableMic} style={ghost}>Enable microphone</button>}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 520px", minWidth: 0 }}>
          <CalendarEmailCard ui={ui} working={snap.busy && !snap.opening} />
          <div ref={listRef} data-testid="charli-transcript" style={{ ...card, padding: "1rem", height: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
            {snap.turns.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13.5 }}>{snap.hasRates ? "Charli is getting ready…" : "Waiting for today’s rates…"}</div>
            )}
            {snap.turns.map((turn) => <Turn key={turn.id} turn={turn} ui={ui} />)}
          </div>

          {snap.pending && (
            <div data-testid="charli-pending" style={{ ...card, borderColor: C.amber, background: C.amberBg, marginTop: 12, padding: "1rem 1.25rem" }}>
              <div style={{ color: C.amber, fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 6 }}>Waiting for your OK</div>
              <div style={{ fontSize: 14.5, lineHeight: 1.5, marginBottom: 12 }}>{snap.pending.readBack}</div>
              {/* every field the change will write, as the server packaged it */}
              {pendingRows(snap.pending).length > 0 && (
                <dl data-testid="charli-pending-details" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", margin: "0 0 12px", fontSize: 13 }}>
                  {pendingRows(snap.pending).map(({ label, value }) => (
                    <div key={label} style={{ display: "contents" }}>
                      <dt style={{ color: C.muted }}>{label}</dt>
                      <dd style={{ margin: 0, color: C.text, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {/* disabled while anything is in flight, speech-to-text included: a spoken answer may be on its way */}
                <button data-testid="charli-confirm" disabled={working} onClick={() => act(session.confirmPending)} style={{ ...primary, opacity: working ? 0.6 : 1 }}>
                  <Icon name="check" size={15} color="#0f2040" />Confirm
                </button>
                <button data-testid="charli-cancel" disabled={working} onClick={() => act(session.cancelPending)} style={{ ...ghost, opacity: working ? 0.6 : 1 }}>Cancel</button>
                <span style={{ color: C.muted, fontSize: 12.5 }}>or say yes / no</span>
              </div>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); sendDraft(); }} style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <input
              data-testid="charli-input"
              aria-label="Type instead"
              placeholder="Type instead…"
              value={draft}
              maxLength={1000}
              disabled={!snap.hasRates}
              onChange={(e) => setDraft(e.target.value)}
              style={{ flex: 1, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", color: C.text, fontFamily: "inherit", fontSize: 14, outline: "none", boxSizing: "border-box", minWidth: 0 }}
            />
            <button type="submit" data-testid="charli-send" disabled={!canSend} style={{ ...primary, opacity: canSend ? 1 : 0.5, cursor: canSend ? "pointer" : "default" }}>Send</button>
          </form>
        </div>

        <div style={{ flex: "0 0 250px", maxWidth: "100%" }}>
          <StageCard
            current={snap.careerStage}
            disabled={snap.busy || snap.opening}
            onPick={(id) => { if (id !== snap.careerStage) act(() => session.setStage(id)); }}
            ui={ui}
          />
          <div style={{ ...mono, color: C.muted, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            Anything Charli changes is read back first and only saved when you confirm.
          </div>
        </div>
      </div>
    </div>
  );
}

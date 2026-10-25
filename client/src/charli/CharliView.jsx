import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createSession, CAREER_STAGES } from "./session.mjs";
import { createAudio, transcribe } from "./audio.js";

// Charli, the voice co-pilot. The conversation and every server call live in session.mjs; the microphone and
// speaker live in audio.js. This file is the screen: it wires the two together and draws the result.
//
// Props: rates (today's rates, from App), user (from /api/auth/me), ui = { C, card, mono, Icon } (App's design tokens).

const MIC_NOTES = {
  denied: "Microphone access is blocked. Allow it in your browser's site settings to talk to Charli. Typing works in the meantime.",
  unavailable: "No microphone is available here, so Charli can't hear you. Typing works.",
  error: "The microphone stopped working. Typing works in the meantime.",
};

// ── pieces ───────────────────────────────────────────────────────────────────

const Turn = ({ turn, ui: { C, mono } }) => {
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
        {!mine && turn.sources.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {turn.sources.map((source, i) => (
              <span key={i} style={{ ...mono, fontSize: 10.5, color: C.mutedHi, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 8px" }}>
                source: {source}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

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

// ── the view ─────────────────────────────────────────────────────────────────

export default function CharliView({ rates, user, ui }) {
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

  // The session and the audio are built once per visit to this screen.
  const parts = useRef(null);
  if (!parts.current) {
    const session = createSession({
      rates,
      localHour: new Date().getHours(),
      user,
      onSpeak: (line) => { if (!pausedRef.current) parts.current.audio.speak(line); },
    });

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
      onTtsError: (status) => setVoiceNote(
        status === 503 ? "Voice replies aren't set up on this server, so Charli answers in text."
          : "Charli's voice isn't coming through right now, so her answers are in text."
      ),
    });
    parts.current = { session, audio };
  }
  const { session, audio } = parts.current;

  useEffect(() => {
    audio.startMic();
    session.open();
    return () => { session.dispose(); audio.dispose(); };   // leaving the screen ends the session: mic off, speech cut
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { session.setRates(rates); }, [rates]);   // eslint-disable-line react-hooks/exhaustive-deps

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

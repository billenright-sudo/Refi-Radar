import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createSession, pendingRows, voiceNoteFor } from "./session.mjs";
import { keptSession } from "./keep.mjs";
import { createReplay, shouldClear } from "./replay.mjs";
import { createAudio, transcribe } from "./audio.js";
import { useIsPhone } from "../useIsPhone.js";
import CharliePortrait from "./CharliePortrait.jsx";
import { faceState } from "./face.mjs";
import { briefingFolded } from "./briefingFold.mjs";
import { dockParts, portraitSlot, BRIEFING_SHRINK } from "./dockLayout.mjs";
import { NO_SPEECH_MS, readHandsFree, writeHandsFree, talkLabel as labelForTalk, stopAfterUtterance, noSpeechClockRuns } from "./talkMode.mjs";

// Charlie, the voice co-pilot. The conversation and every server call live in session.mjs; the microphone and speaker live in
// audio.js. This file is the screen: it wires the two together and draws the result, in one of two shapes of the same conversation.
//
// Props: rates (today's rates, from App), user (from /api/auth/me), ui = { C, card, mono, Icon } (App's design tokens),
//   mode      "dock" (default): Charlie docked beside the Overview on Home: header, portrait, her briefing, Talk / Brief me, the
//             conversation, the type box. `stacked` (tablet and phone) puts it above the Overview with a square portrait;
//             `width` (a number of pixels, or a CSS length such as "100%") overrides the portrait width. Unstacked, it fills
//             its parent's height (App's sticky column) as one flex column: the portrait is min(318px, 28vh) tall in her whole
//             4:5 frame (head and shoulders, centered; Bill 2026-11-07), the
//             briefing card at most 20vh and the first thing to give way (down to 64px, scrolling on its own), and the
//             transcript takes the rest (at least 96px), so the type box stays on screen down to about 768px tall.
//             "panel": the same conversation in a drawer on the right, opened from the corner button on every other page.
//   onClose()           panel: the close button or Escape (App takes the drawer away)
//   onStale()           Brief me (the button, or the request typed or said) found the briefing is from an earlier local day: App
//                       renders again, and since it keys this screen by the day, a fresh session and briefing are built for today
//                       (keep.mjs keeps one per user and day). Yesterday's briefing is never spoken.
//
// Only one of the two is on screen at a time, and both take the one kept session (keep.mjs), so the conversation carries over and
// nobody is greeted twice. The briefing is shown but not spoken on its own (speakGreeting:false): Brief me speaks it, from a tap.
// The microphone never starts by itself: Talk (or Enable microphone) starts it, and a second tap on Talk stops it. By default a tap
// opens it for one question (talkMode.mjs); the Hands-free switch keeps it open until Talk is tapped again.

// The device's localStorage, or undefined where there is none or the browser refuses it (reading it can throw).
const deviceStorage = () => {
  try { return typeof window !== "undefined" ? window.localStorage : undefined; } catch { return undefined; }
};

const MIC_NOTES = {
  denied: "Microphone access is blocked. Allow it in your browser's site settings to talk to Charlie. Typing works in the meantime.",
  unavailable: "No microphone is available here, so Charlie can't hear you. Typing works.",
  error: "The microphone stopped working. Typing works in the meantime.",
};

// ── pieces ───────────────────────────────────────────────────────────────────

// The "source: …" chips under something Charlie said (and the unable-to-verify mark on a hand-off line).
const Sources = ({ turn, ui: { C, mono }, style }) => (
  (turn.sources.length > 0 || turn.kind === "unverified") && (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, ...style }}>
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
  )
);

// `breakAnywhere`: a long word or email address wraps inside the bubble (the dock, and the drawer on a phone).
const Turn = ({ turn, ui, breakAnywhere }) => {
  const { C } = ui;
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
        {mine ? "You" : "Charlie"}
      </div>
      <div data-testid={mine ? "charli-user-turn" : failed ? "charli-error-turn" : "charli-turn"} style={{ ...bubble, borderRadius: 12, padding: "10px 14px", fontSize: 14, lineHeight: 1.5, maxWidth: "88%", whiteSpace: "pre-wrap", ...(breakAnywhere ? { overflowWrap: "anywhere" } : null) }}>
        {turn.content}
        {!mine && <Sources turn={turn} ui={ui} style={{ marginTop: 8 }} />}
      </div>
      {/* an email Charlie set up: shown for the broker to open in their own mail app (session.mjs has checked its links) */}
      {!mine && turn.compose && <ComposeCard compose={turn.compose} ui={ui} />}
    </div>
  );
};

// The email Charlie set up (spec §4 anti-goal 2: nothing is sent from here). The text is code-authored on the server and shown
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

// ── the view ─────────────────────────────────────────────────────────────────

export default function CharliView({ rates, user, ui, mode = "dock", stacked = false, width, onClose, onStale }) {
  const { C, card, mono, Icon } = ui;
  const panel = mode === "panel";
  const isPhone = useIsPhone();

  const [paused, setPaused] = useState(false);
  const [mic, setMic] = useState("off");   // off | starting | live | denied | unavailable | error ("off" until Talk is tapped)
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [needsStart, setNeedsStart] = useState(false);   // the browser would not play audio without a tap
  const [voiceDown, setVoiceDown] = useState(false);     // speech-to-text is not set up on the server
  const [voiceNote, setVoiceNote] = useState("");
  const [draft, setDraft] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);   // the folded briefing tapped open (the dock, mid-conversation)
  const [handsFree, setHandsFree] = useState(() => readHandsFree(deviceStorage()));   // read once, on mount

  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const micLiveRef = useRef(false);   // the mic is live right now (set from audio.js itself, so a stop is seen at once)
  const speakingRef = useRef(false);   // whether she is mid-line right now (Pause keeps only a line it cuts off)
  const listenOnResume = useRef(false);   // the microphone was on when Pause was tapped: Resume turns it back on, never otherwise
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;
  // A brief request refused because the briefing is yesterday's: App rebuilds this screen for today.
  const rebuildIfStale = (result) => { if (result && result.reason === "stale" && onStaleRef.current) onStaleRef.current(); };

  // The conversation outlives a visit to this screen (keep.mjs): coming back shows it again, with no second greeting. The audio
  // is built once per visit.
  const parts = useRef(null);
  if (!parts.current) {
    const { session, voice } = keptSession(user && user.id, (onSpeak) => createSession({
      rates,
      localHour: new Date().getHours(),
      user,
      onSpeak,
      speakGreeting: false,   // the briefing is read, not played at the user: Brief me speaks it, from a tap
    }));

    const handleUtterance = async (blob) => {
      // Tap to talk: the first utterance closes the mic before it is sent; one that lands after the mic closed is dropped.
      if (stopAfterUtterance(handsFreeRef.current)) {
        if (!micLiveRef.current) return;
        audio.stopMic();
      }
      setTranscribing(true);
      // the change on screen when this recording went off: a yes / no that comes back after it was handled is dropped
      const pendingAtStart = session.getState().pending;
      try {
        const text = await transcribe(blob);
        if (pausedRef.current) return;   // paused while it was being transcribed: drop it
        const result = await session.heard(text, { pendingAtStart });
        if (!result.ok && result.reason === "stale") rebuildIfStale(result);
        else if (!result.ok && (result.reason === "busy" || result.reason === "not-ready")) {
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
      onSpeakingChange: (on) => { speakingRef.current = on; setSpeaking(on); },
      onHearing: setHearing,
      onMicChange: (state) => { micLiveRef.current = state === "live"; setMic(state); },
      onAutoplayBlocked: () => setNeedsStart(true),
      onTtsOk: () => { setVoiceNote(""); setNeedsStart(false); },   // it played, so no tap is needed after all
      onTtsError: (status, body) => setVoiceNote(voiceNoteFor(status, body)),
    });
    parts.current = { session, audio, voice, replay: createReplay() };
  }
  const { session, audio, voice, replay } = parts.current;

  const panelRef = useRef(null);
  useEffect(() => {
    // Pause keeps the line she had not finished (replay.mjs): a line that arrives while paused is kept, not dropped.
    voice.speak = (line) => {
      if (pausedRef.current) { replay.held(line); return; }
      replay.said(line);
      audio.speak(line);
    };
    // A new turn from the user, or the change she read back being confirmed or cancelled, makes a kept line stale. Watched on the
    // session itself (it calls back inside set()), so it runs before the line spoken right after, never after it.
    let last = session.getState();
    const unwatch = session.subscribe((next) => { if (shouldClear(last, next)) replay.clear(); last = next; });
    // (the microphone is NOT started here: it starts when Talk is tapped)
    session.open();
    if (panelRef.current) panelRef.current.focus();   // a drawer that opens takes the keyboard with it
    // leaving the screen: mic off, speech cut, a change waiting for a yes dropped; the conversation is kept for coming back
    return () => { unwatch(); voice.speak = null; session.leave(); audio.dispose(); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { session.setRates(rates); }, [rates]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The drawer closes on Escape.
  useEffect(() => {
    if (!panel || !onClose) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, onClose]);

  const snap = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const working = snap.busy || snap.opening || transcribing;

  // Half-duplex: listen only when Charlie is neither speaking nor working on something. Computed once: the same gate decides
  // capture and whether the tap-to-talk wait below counts (talkMode.mjs noSpeechClockRuns).
  const canHear = noSpeechClockRuns({ micLive: mic === "live", paused, speaking, working, voiceDown });
  useEffect(() => {
    audio.setCapture(canHear);
  }, [canHear]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Tap to talk: nothing heard within NO_SPEECH_MS of capture being on closes the mic, and nothing is sent. The wait counts only
  // while she could hear (not while she speaks or works, or while paused) and starts over when capture resumes. Hearing clears
  // it; a sound that was not kept as an utterance (too short) starts it again.
  useEffect(() => {
    if (handsFree || !canHear || hearing) return undefined;
    const timer = setTimeout(() => audio.stopMic(), NO_SPEECH_MS);
    return () => clearTimeout(timer);
  }, [handsFree, canHear, hearing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.turns.length, snap.pending, briefOpen]);   // briefOpen: folding/opening the briefing resizes the conversation

  // A change read back for a yes lands under the conversation, which on a laptop can be below the visible part of the dock: it is
  // scrolled into view (the dock's own scroll, or the page when stacked). The drawer keeps it on screen by its layout.
  const pendingRef = useRef(null);
  useEffect(() => {
    const el = pendingRef.current;
    if (!panel && snap.pending && el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [snap.pending]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tapNoteId = useId();

  // Asks for the microphone (the browser may prompt) and shows "starting" meanwhile. Only ever called from a tap.
  const startListening = () => {
    setMic("starting");
    audio.startMic().then((result) => {
      if (result && !result.ok && (result.reason === "stopped" || result.reason === "disposed")) setMic("off");
    });
  };
  // From a Pause: the line Pause cut off, or one that arrived while paused, is said again from the start.
  const resume = ({ listen }) => {
    setPaused(false);
    audio.unlock();
    if (listen) startListening();
    const line = replay.take();
    if (line) { replay.said(line); audio.speak(line); }
  };
  const togglePause = () => {
    if (!paused) {
      listenOnResume.current = mic === "live" || mic === "starting";
      setPaused(true);
      if (speakingRef.current) replay.cut();   // mid-line: keep it for Resume (a line that already finished is not kept)
      audio.stopSpeaking();
      audio.stopMic();
    } else {
      resume({ listen: listenOnResume.current });
    }
  };
  // Talk: starts the microphone (for one question, or hands-free from there); tapped again while it is on, stops it with nothing
  // sent; tapped while paused, resumes.
  const talk = () => {
    if (paused) { resume({ listen: true }); return; }
    audio.unlock();
    if (mic === "live") audio.stopMic(); else startListening();
  };
  // The Hands-free switch takes effect at once: off while the mic is live closes it; on never opens it (the next tap does).
  const changeHandsFree = (on) => {
    handsFreeRef.current = on;
    setHandsFree(on);
    writeHandsFree(deviceStorage(), on);
    if (!on && mic === "live") audio.stopMic();
  };
  // Brief me: the briefing said aloud, from this tap (a tap is what lets the browser play audio). Said again if it was already; a
  // briefing from an earlier day is not said, and the screen is rebuilt for today instead.
  const briefMe = () => {
    audio.stopSpeaking();
    audio.unlock();
    session.briefMe().then(rebuildIfStale);
  };
  const startCharlie = () => {
    setNeedsStart(false);
    audio.unlock();
    audio.retryBlocked();
  };
  const enableMic = () => { audio.unlock(); startListening(); };

  // Anything the user does by hand cuts off what Charlie is saying.
  const act = (fn) => { audio.stopSpeaking(); fn(); };
  const canSend = !!draft.trim() && snap.hasRates && !working;
  const sendDraft = async () => {
    if (!canSend) return;
    audio.stopSpeaking();
    const result = await session.submit(draft);
    if (result.ok) setDraft("");
    else rebuildIfStale(result);
  };

  // ── what to draw ──
  let status;
  let dot = C.muted;
  if (!snap.hasRates) status = "Fetching rates…";
  else if (paused) status = "Paused";
  else if (speaking) { status = "Speaking…"; dot = C.blue; }
  else if (working) { status = "Thinking…"; dot = C.amber; }
  else if (voiceDown) status = "Type below. Voice input isn't set up here";
  else if (mic === "live") { status = hearing ? "Listening… hearing you" : "Listening"; dot = C.green; }
  else if (mic === "starting") status = "Starting the microphone…";
  else if (MIC_NOTES[mic]) status = "Type below. The microphone isn't available";   // denied | unavailable | error (the note below says why)
  else status = handsFree ? "Tap Talk to speak, or type below" : "Tap to talk, or type below";

  const micNote = !paused && MIC_NOTES[mic];
  const face = faceState({ speaking, working, paused });
  const buttonBase = { display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 9, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" };
  const primary = { ...buttonBase, background: C.amber, color: "#0f2040" };
  const ghost = { ...buttonBase, background: "transparent", color: C.mutedHi, border: `1px solid ${C.border}` };

  // The briefing is the greeting turn: the first thing she said, once the greeting has come back with a briefing.
  const briefingTurn = snap.briefing ? snap.turns.find((t) => t.role === "assistant" && t.kind === "message") || null : null;
  const turns = panel ? snap.turns : snap.turns.filter((t) => t !== briefingTurn);
  // The dock: once the conversation starts, the briefing folds to one line (tap to open) so the conversation gets the room.
  const folded = briefingFolded({ talking: turns.length > 0, hasBriefing: Boolean(briefingTurn), open: briefOpen });
  // the dock on a laptop: while a change waits for an OK, the card takes the conversation's place (dockLayout.mjs)
  const dockShows = dockParts({ stacked: stacked || panel, pending: snap.pending, turns });
  const foldToggle = { background: "transparent", border: "none", color: C.mutedHi, fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, flex: "none" };

  const listening = mic === "live" && !paused;
  const talkLabel = labelForTalk({ handsFree, micLive: listening, starting: mic === "starting", paused });
  const talkSize = panel ? {} : { fontSize: 16, padding: "13px 18px", borderRadius: 12, gap: 10, flex: 1, justifyContent: "center" };
  const talkStyle = listening
    ? { ...ghost, ...talkSize, background: C.greenBg, color: C.green, border: `1px solid ${C.green}` }
    : { ...primary, ...talkSize };
  const talkButton = (
    <button data-testid="charli-talk" type="button" disabled={mic === "starting" && !paused} onClick={talk} style={{ ...talkStyle, opacity: mic === "starting" && !paused ? 0.7 : 1 }}>
      <Icon name="mic" size={panel ? 15 : 20} color={listening ? C.green : "#0f2040"} />{talkLabel}
    </button>
  );
  const briefButton = snap.briefing && (
    <button data-testid="charli-brief" type="button" disabled={paused} onClick={briefMe} style={{ ...ghost, ...(panel ? {} : { fontSize: 15, padding: "13px 20px", borderRadius: 12 }), opacity: paused ? 0.5 : 1, cursor: paused ? "default" : "pointer" }}>
      Brief me
    </button>
  );
  // Under the Talk row: the Hands-free switch, and in tap mode what a tap does.
  const talkOptions = (
    <div style={{ display: "flex", alignItems: "center", gap: "6px 14px", flexWrap: "wrap", marginTop: 10, flex: "none" }}>
      {/* the whole label is the switch's hit area: at least 24px tall */}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 7, minHeight: 24, color: C.mutedHi, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
        <input data-testid="charli-handsfree" type="checkbox" role="switch" checked={handsFree} aria-describedby={handsFree ? undefined : tapNoteId} onChange={(e) => changeHandsFree(e.target.checked)} style={{ accentColor: C.amber, width: 15, height: 15, margin: 0, cursor: "pointer" }} />
        Hands-free
      </label>
      {!handsFree && <span id={tapNoteId} data-testid="charli-tap-note" style={{ color: C.muted, fontSize: 12.5 }}>One question per tap. The mic closes after each answer.</span>}
    </div>
  );

  const pauseButton = (
    <button data-testid="charli-pause" type="button" onClick={togglePause} style={paused ? primary : ghost}>
      <Icon name="mic" size={15} color={paused ? "#0f2040" : C.mutedHi} />{paused ? "Resume" : "Pause"}
    </button>
  );

  const statusRow = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem", flexWrap: "wrap", flex: "none" }}>
      <div data-testid="charli-status" role="status" aria-live="polite" style={{ display: "inline-flex", alignItems: "center", gap: 9, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 999, padding: "6px 14px", fontSize: 13, color: C.mutedHi }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, animation: hearing && !paused ? "charliPulse 0.9s ease-in-out infinite" : "none" }} />
        {status}
      </div>
      {voiceNote && <span style={{ color: C.muted, fontSize: 12.5 }}>{voiceNote}</span>}
    </div>
  );

  const banners = (
    <>
      {needsStart && (
        <div style={{ ...card, borderColor: C.amber, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: "1rem", padding: "1rem 1.25rem", flex: "none" }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>Your browser needs a tap before Charlie can speak.</div>
          <button data-testid="charli-start" type="button" onClick={startCharlie} style={primary}><Icon name="mic" size={15} color="#0f2040" />Let Charlie speak</button>
        </div>
      )}
      {micNote && (
        <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: "1rem", padding: "0.9rem 1.25rem", color: C.mutedHi, fontSize: 13, lineHeight: 1.45, flex: "none" }}>
          <span>{micNote}</span>
          {mic !== "unavailable" && <button type="button" onClick={enableMic} style={ghost}>Enable microphone</button>}
        </div>
      )}
    </>
  );

  const transcript = (turns.length > 0 || panel) && (
    <div ref={listRef} data-testid="charli-transcript" style={{ ...card, padding: "1rem", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", ...(panel ? { flex: 1, minHeight: 0 } : stacked ? { maxHeight: 380 } : { flex: "1 1 0", minHeight: 96 }) }}>
      {snap.turns.length === 0 && (
        <div style={{ color: C.muted, fontSize: 13.5 }}>{snap.hasRates ? "Charlie is getting ready…" : "Waiting for today’s rates…"}</div>
      )}
      {turns.map((turn) => <Turn key={turn.id} turn={turn} ui={ui} breakAnywhere={isPhone || !panel} />)}
    </div>
  );

  const pendingCard = snap.pending && (
    <div ref={pendingRef} data-testid="charli-pending" style={{ ...card, borderColor: C.amber, background: C.amberBg, marginTop: 12, padding: "1rem 1.25rem", flex: "none" }}>
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
  );

  const typeBox = (
    <>
      <form onSubmit={(e) => { e.preventDefault(); sendDraft(); }} style={{ display: "flex", gap: 10, marginTop: 12, flex: "none" }}>
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
      {dockShows.smallPrint && (
        <div style={{ ...mono, color: C.muted, fontSize: 11, marginTop: 10, lineHeight: 1.5, flex: "none" }}>
          Anything Charlie changes is read back first and only saved when you confirm.
        </div>
      )}
    </>
  );

  const styles = (
    <style>{`
      @keyframes charliPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(1.5); } }
    `}</style>
  );

  // ── the drawer ──
  if (panel) {
    return (
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Charlie"
        data-testid="charli-panel"
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(440px, 100vw)", zIndex: 60, background: C.bg, borderLeft: `1px solid ${C.border}`, boxShadow: "-12px 0 32px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", padding: "1rem 1.1rem", boxSizing: "border-box", outline: "none", animation: "fadeIn 0.2s ease" }}
      >
        {styles}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: "0.9rem" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", gap: 9 }}>
            <Icon name="mic" size={18} color={C.amber} />Charlie
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {pauseButton}
            <button data-testid="charli-panel-close" type="button" aria-label="Close Charlie" title="Close" onClick={onClose} style={{ ...ghost, padding: "10px 11px" }}>
              <Icon name="x" size={15} color={C.mutedHi} />
            </button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", margin: "0.2rem 0 1rem" }}>
          <CharliePortrait state={face} shape="portrait" width={168} micOpen={mic === "live" && !paused} />
        </div>
        {statusRow}
        {banners}
        {transcript}
        {pendingCard}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          {talkButton}
          {briefButton}
        </div>
        {talkOptions}
        {typeBox}
      </aside>
    );
  }

  // ── the dock ──
  return (
    <div data-testid="charli-dock" style={{ animation: "fadeIn 0.3s ease", display: "flex", flexDirection: "column", boxSizing: "border-box", ...(stacked ? null : { height: "100%", minHeight: 0 }) }}>
      {styles}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: "0.9rem", flex: "none" }}>
        {/* h2: Home's page heading (the greeting) is its h1 */}
        <h2 style={{ fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", gap: 9 }}>
          <Icon name="mic" size={18} color={C.amber} />Charlie
        </h2>
        {pauseButton}
      </div>

      {/* unstacked, her portrait's slot is full size when there is room and shrinks (after the briefing) on a short screen, never
          under 100px tall; the portrait fills the slot's height and keeps its shape (dockLayout.mjs portraitSlot) */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.9rem", ...(stacked || width != null ? { flex: "none" } : portraitSlot()) }}>
        {stacked
          ? <CharliePortrait state={face} shape="square" width={width ?? "min(100%, 420px)"} micOpen={mic === "live" && !paused} ariaHideName />
          : <CharliePortrait state={face} shape="portrait" {...(width != null ? { width } : { height: "100%" })} micOpen={mic === "live" && !paused} ariaHideName />}
      </div>

      {statusRow}
      {banners}

      {/* unstacked, the briefing is what gives way first on a short screen (down to 64px, then it scrolls); while a change waits for
          an OK it steps aside (dockLayout.mjs dockParts) */}
      {!dockShows.briefing ? null : folded ? (
        <button data-testid="charli-briefing" type="button" aria-expanded="false" aria-label="Today's briefing, folded. Show it" onClick={() => setBriefOpen(true)}
          style={{ ...card, padding: "0.65rem 1.1rem", flex: "none", display: "flex", alignItems: "center", gap: 10, width: "100%", boxSizing: "border-box", cursor: "pointer", fontFamily: "inherit", color: C.text, textAlign: "left" }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.6, color: C.amber, flex: "none" }}>BRIEFING</span>
          <span style={{ fontSize: 13.5, color: C.mutedHi, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{briefingTurn.content}</span>
          <span aria-hidden="true" style={foldToggle}>Show ▾</span>
        </button>
      ) : (
      <section data-testid="charli-briefing" aria-label="Your briefing" style={{ ...card, padding: "1rem 1.1rem", ...(stacked ? { flex: "none" } : { flex: `0 ${BRIEFING_SHRINK} auto`, minHeight: 64, maxHeight: "20vh", overflowY: "auto" }) }}>
        {briefingTurn ? (
          <>
            {turns.length > 0 && (
              // floated, so the briefing's first line wraps around it instead of giving up a row to it
              <button type="button" aria-expanded="true" aria-label="Fold the briefing" onClick={() => setBriefOpen(false)} style={{ ...foldToggle, float: "right", marginLeft: 10, lineHeight: 1.6 * 14.5 + "px" }}>Hide ▴</button>
            )}
            <div style={{ fontSize: 14.5, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{briefingTurn.content}</div>
            <Sources turn={briefingTurn} ui={ui} style={{ marginTop: 10, justifyContent: "flex-start" }} />
          </>
        ) : snap.turns.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 14 }}>{snap.hasRates ? "Charlie is getting ready…" : "Waiting for today’s rates…"}</div>
        ) : (
          <div style={{ color: C.muted, fontSize: 14 }}>There is no briefing to show right now. You can still ask Charlie below.</div>
        )}
      </section>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, flex: "none" }}>
        {talkButton}
        {briefButton}
      </div>
      {dockShows.talkOptions && talkOptions}

      {stacked ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
          {transcript}
          {pendingCard}
          {typeBox}
        </div>
      ) : (
        // Unstacked these sit directly in the column (no wrapper box), so the column's one flex pass shrinks the briefing first, then
        // the portrait's slot, and the transcript (flex 1 1 0, min 96px) takes what is left: the type box stays on screen. The spacer is
        // the 12px gap above. While a change waits for an OK the card takes the conversation's place (the pending card has its own gap).
        <>
          {dockShows.conversation && <div aria-hidden="true" style={{ height: 12, flex: "none" }} />}
          {dockShows.conversation && transcript}
          {pendingCard}
          {typeBox}
        </>
      )}
    </div>
  );
}

// Charli's live session: the conversation state and the server contract, with no DOM and no React.
// The view (CharliView.jsx) owns the screen and audio.js owns the microphone and speaker; this file owns
// everything that decides what is said, what is sent and what is written.
//
// The one rule that matters: nothing is written without a code-built read-back and an explicit confirmation.
// A pending change (the `sideEffect` /turn returned) is resolved by POST /confirm with that object VERBATIM, and
// a spoken or typed "yes" is never sent to /turn (the model would just propose the change again).
//
// Server contracts (server/routes/assistant.js):
//   POST /api/assistant/turn     { messages, rates, localDate } | { greeting: true, rates, localHour, localDate } -> { reply, sources, sideEffect?, details?, compose?, turnId, error? }
//   POST /api/assistant/confirm  { sideEffect } as /turn returned it (confirmId included) -> { success, result, reply, duplicate? }
//   GET  /api/auth/me            -> { success, user: { careerStage } }

// Keep in sync with CAREER_STAGES in server/lib/assistant/coaching.js (ids are what is stored and sent).
export const CAREER_STAGES = Object.freeze([
  Object.freeze({ id: "new", label: "New (under 1 year)" }),
  Object.freeze({ id: "developing", label: "Developing (1–3 years)" }),
  Object.freeze({ id: "established", label: "Established (3–10 years)" }),
  Object.freeze({ id: "veteran", label: "Veteran (10+ years)" }),
]);

export const stageById = (id) => (typeof id === "string" && CAREER_STAGES.find((s) => s.id === id)) || null;

// Keep in sync with CANT_VERIFY and GUIDELINE_HANDOFF in server/lib/assistant/prompt.js: a reply that is exactly one of these
// is marked "unable to verify" in the transcript (kind "unverified"; spec §7.4).
export const CANT_VERIFY = "I can't verify that from what I have, so I won't guess.";
export const GUIDELINE_HANDOFF = "That's a loan-guideline question, and I can't verify guidelines yet, so I won't guess.";
const UNVERIFIED_REPLIES = new Set([CANT_VERIFY, GUIDELINE_HANDOFF]);

// Code-authored lines (never model output).
export const LEAVE_THAT = "Okay — I'll leave that.";
export const DIDNT_CATCH = "I didn't catch that — could you say it again?";
// Shown (never spoken, never sent) when a spoken yes / no comes back from speech-to-text after the change it was said to
// had already been confirmed, cancelled or replaced on screen.
export const LATE_ANSWER = "That answer came in after the change was already handled, so I left it alone.";
// Shown (never spoken) when the user left the Charli screen with a change still waiting for a yes: it is dropped, not kept for later.
export const LEFT_UNCONFIRMED = "You left before confirming, so I didn't make that change.";
// Shown (never spoken) when the user left while a confirmed change was still with the server and it came back unfinished: it may
// still have gone through, so it is dropped without saying it was not made.
export const LEFT_UNFINISHED = "You left before I heard back on that change, so I can't tell whether it went through — check before asking again.";

// What Charli says when /turn did not answer in time (REQUEST_TIMEOUTS): the turn is dropped here and nothing was written. (The
// server has its own line, TOOK_TOO_LONG, for a turn it cut off itself; that one arrives as an ordinary error reply.)
export const TOOK_TOO_LONG_CLIENT = "That took too long on my end — could you say it again?";

// How long a request may take before it is given up on, in ms, by URL. /turn is the server's own turn deadline (25 s, see
// CHARLI_TURN_DEADLINE_MS) plus a margin, so the server's answer to a slow turn arrives before this gives up. /confirm gets the
// same: a booking can take the server about 20 s (a Google token refresh and the insert, 10 s each), and giving up sooner would
// show the broker a failure for a booking that then goes through.
export const REQUEST_TIMEOUTS = Object.freeze({
  "/api/assistant/turn": 35_000,
  "/api/assistant/confirm": 35_000,
  "/api/auth/me": 10_000,
});

// What Charli says when /confirm answered that the same confirmation is still being worked on (409 with pending: true): the card
// stays, and saying yes again then gets the result of the first request.
export const STILL_WORKING = "Still working on that — give it a moment, then say yes again.";

// The server keeps the last 20 messages and refuses a body of more than 100; send comfortably under that.
const MAX_SENT_MESSAGES = 30;

// ── Reading a short reply to a read-back ─────────────────────────────────────

// (as normalize leaves them: lower case, punctuation gone, so "Mm-hmm." is "mm hmm" and "uh-huh" is "uh huh")
const YES_PHRASES = [
  "yes", "yeah", "yep", "yup", "sure", "confirm", "confirmed", "do it", "go ahead", "please do", "correct",
  "that's right", "that's correct", "ok", "okay",
  "absolutely", "sure thing", "go for it", "sounds good", "definitely", "mm hmm", "mhm", "uh huh", "yes please", "yeah sure",
  "let's do it", "do that",
];
const NO_PHRASES = [
  "no", "nope", "cancel", "never mind", "nevermind", "don't", "do not", "stop", "wait", "no thanks", "nah", "leave it",
];
// Politeness and hesitation that may sit around an answer but are not an answer ("yes please", "um, yes", "yes, thanks").
const FILLER_WORDS = ["please", "um", "uh", "thanks", "thank you"];
const MAX_REPLY_WORDS = 4;

const PHRASES = [
  ...YES_PHRASES.map((p) => [p.split(" "), "yes"]),
  ...NO_PHRASES.map((p) => [p.split(" "), "no"]),
  ...FILLER_WORDS.map((p) => [p.split(" "), "filler"]),
];

// Speech-to-text audio-event tags ("(background noise)", "[laughter]") are not the user's words: they go before anything is read.
const AUDIO_TAG_RE = /\([^()]*\)|\[[^[\]]*\]/g;
export const withoutAudioTags = (text) => String(text ?? "").replace(AUDIO_TAG_RE, " ");

const normalize = (text) => withoutAudioTags(text)
  .toLowerCase()
  .replace(/[’‘`]/g, "'")
  .replace(/[^a-z0-9'\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// "yes" | "no" | "other". A reply counts as yes or no only when it is SHORT (four words at most) and made up
// entirely of those phrases, so "yes but not the Chens" and "yes, and also log the Smiths" are "other". If a yes
// and a no are both present ("okay never mind", "yes stop") the answer is "no": ambiguity never writes.
export function classifyReply(text) {
  const words = normalize(text).split(" ").filter(Boolean);
  if (!words.length || words.length > MAX_REPLY_WORDS) return "other";
  const walk = (i) => {
    if (i === words.length) return { yes: false, no: false };
    for (const [phrase, kind] of PHRASES) {
      if (i + phrase.length > words.length) continue;
      if (!phrase.every((w, k) => words[i + k] === w)) continue;
      const rest = walk(i + phrase.length);
      if (rest) return { yes: rest.yes || kind === "yes", no: rest.no || kind === "no" };
    }
    return null;
  };
  const found = walk(0);
  if (!found) return "other";
  if (found.no) return "no";
  return found.yes ? "yes" : "other";
}

// The two kinds of 429 from /api/voice/tts: the daily character budget (back tomorrow) and the per-15-minute limiter (back in minutes).
export const VOICE_BUDGET_NOTE = "Charlie's voice budget for today is used up, so her answers are in text until tomorrow.";
export const VOICE_BREAK_NOTE = "Charlie's voice is taking a short break — her answers are in text for a few minutes.";

// The note shown when a spoken reply could not be fetched or played (the text is already on screen). `status` is what
// audio.js reports: the HTTP status of /api/voice/tts, 0 for a network failure, -1 for playback. `body` is the start of the failed
// response's text (audio.js ttsFailureBody; "" when there is none). A 429 is the daily budget only when its body says "budget"
// (the server's "voice budget reached for today ..."); any other 429 is the limiter, which clears in minutes, not tomorrow.
export function voiceNoteFor(status, body = "") {
  if (status === 503) return "Voice replies aren't set up on this server, so Charlie answers in text.";
  if (status === 429) return /budget/i.test(String(body ?? "")) ? VOICE_BUDGET_NOTE : VOICE_BREAK_NOTE;
  return "Charlie's voice isn't coming through right now, so her answers are in text.";
}

// ── The session ──────────────────────────────────────────────────────────────

const cleanSources = (sources) =>
  (Array.isArray(sources) ? sources : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());

// The rows the pending card shows under the read-back (/turn's `details`: every field the change will write, code-authored by
// the server from the same sideEffect that goes to /confirm). Only { label, value } string pairs are kept; display only.
const cleanDetails = (details) =>
  (Array.isArray(details) ? details : [])
    .filter((d) => d && typeof d === "object" && typeof d.label === "string" && d.label.trim() && (typeof d.value === "string" || typeof d.value === "number"))
    .map((d) => ({ label: d.label.trim(), value: String(d.value) }));

// A client email Charli set up (/turn's `compose`): { to, subject, body, links: { gmail, outlook, mailto } }, all strings, shown on the
// turn as an unsent draft for the broker to open in their own mail app (nothing to confirm; nothing is sent from here). The links
// are followed by the browser, so each must start with its provider's compose address; anything else drops the whole compose (the
// reply is still shown). -> a fresh object with only these fields, or null.
const COMPOSE_LINK_PREFIXES = Object.freeze({ gmail: "https://mail.google.com/", outlook: "https://outlook.office.com/", mailto: "mailto:" });
function cleanCompose(compose) {
  if (!compose || typeof compose !== "object" || Array.isArray(compose)) return null;
  const { to, subject, body, links } = compose;
  if (typeof to !== "string" || typeof subject !== "string" || typeof body !== "string") return null;
  if (!links || typeof links !== "object" || Array.isArray(links)) return null;
  const kept = {};
  for (const [key, prefix] of Object.entries(COMPOSE_LINK_PREFIXES)) {
    if (typeof links[key] !== "string" || !links[key].startsWith(prefix)) return null;
    kept[key] = links[key];
  }
  return { to, subject, body, links: kept };
}

// The morning briefing the greeting carries (/turn greeting's `briefing`): { kind, strip, followUp }. Kept only as the server documents
// it: `kind` is "morning" or "catch_up" (anything else is no briefing); `strip` always has the six fields, each null unless it has
// its documented type (a number, a string, or for nextEvent a { title, start } with a text title and a text start, or null for an
// all-day event), so nothing is guessed at; `followUp` is
// { recId, clientId, name, source } when recId is a positive integer and name is text, else null. -> a fresh object, or null.
const BRIEFING_KINDS = new Set(["morning", "catch_up"]);
const numberOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const stringOrNull = (v) => (typeof v === "string" ? v : null);
const plainObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
function cleanBriefing(briefing) {
  const b = plainObject(briefing);
  if (!b || !BRIEFING_KINDS.has(b.kind)) return null;
  const s = plainObject(b.strip) || {};
  const event = plainObject(s.nextEvent);
  const f = plainObject(b.followUp);
  const followUp = f && Number.isInteger(f.recId) && f.recId > 0 && typeof f.name === "string" && f.name.trim()
    ? { recId: f.recId, clientId: Number.isInteger(f.clientId) ? f.clientId : null, name: f.name, source: stringOrNull(f.source) }
    : null;
  return {
    kind: b.kind,
    strip: {
      rate30: numberOrNull(s.rate30),
      move30: numberOrNull(s.move30),
      asOf: stringOrNull(s.asOf),
      opportunities: numberOrNull(s.opportunities),
      checkInsDue: numberOrNull(s.checkInsDue),
      // an all-day event has start: null (the server's own shape), and is still the next event
      nextEvent: event && typeof event.title === "string" ? { title: event.title, start: stringOrNull(event.start) } : null,
    },
    followUp,
  };
}

// The rows to draw under a pending read-back (CharliView): the server's details, or none. Pure.
export const pendingRows = (pending) => (pending && Array.isArray(pending.details) ? pending.details : []);

// What a failed request says to the user. `res` is what request() returned.
function failureText(res) {
  if (res.network) return "Sorry — I couldn't reach the server. Check your connection and try again.";
  if (res.status === 401) return "Your session has ended — please sign in again.";
  const detail = res.data && typeof res.data.error === "string" ? res.data.error.trim() : "";
  if (res.data && res.data.errors && typeof res.data.errors === "object") {
    const fields = Object.values(res.data.errors).filter((v) => typeof v === "string").join("; ");
    if (fields) return `Sorry — that didn't go through: ${fields}`;
  }
  if (detail) return `Sorry — that didn't go through: ${detail}`;
  return `Sorry — something went wrong on my end (${res.status || "no response"}). Try that again.`;
}

// A failed /confirm worth retrying with the same confirmId (the server dedupes, so a retry cannot write twice):
// the network dropped or the request timed out (the write may or may not have happened), the server hiccuped or the rate
// limit is hit. Anything else (400/401/403/404/409) is final, but for the 409 that says `pending: true` (stillWorking): the first
// request for this confirmId is still with the server and may yet go through.
const isRetryable = (res) => res.network || res.timedOut || res.status >= 500 || res.status === 429;
const stillWorking = (res) => res.status === 409 && !!res.data && res.data.pending === true;

// The device's own calendar day as YYYY-MM-DD (not UTC: Cloud Run's clock is, the user's is not). The greeting sends it so the
// server can open with the day of the week, and every turn sends it so a live lookup's "today" is the user's (M-6).
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDateOf = (date) =>
  `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// createSession({ fetch, rates, localHour, localDate, user, onSpeak, speakGreeting })
//   fetch      the window fetch (injected so tests need no network)
//   rates      today's rates, as App.jsx holds them (may be null at first: setRates() when they arrive)
//   localHour  0-23 for the greeting; defaults to the clock
//   localDate  YYYY-MM-DD for the greeting and every turn; defaults to the clock's local date at the time (tests pin it)
//   user       { careerStage } from /api/auth/me
//   onSpeak    ({ text, turnId? }) called, in order, for every line Charli should say aloud (the line is
//              already in the transcript when it is called)
//   speakGreeting  true (the default) speaks the greeting on open(); false shows it, in the transcript and the history, but says
//              nothing until briefMe() (the morning briefing is read, not played at the user). Applies to the greeting only.
// Returns { getState, subscribe, setRates, open, leave, submit, heard, confirmPending, cancelPending, setStage,
//           briefMe, notice, dispose }.
//
// briefMe() speaks the briefing turn's text through onSpeak, again if it was already spoken -> { ok: true }, or { ok: false, reason }
// with "no-briefing" (the greeting has not come back, failed, or carried no briefing) or "closed" (away or disposed).
//
// The greeting's briefing is kept in getState().briefing and the briefing's follow-up question is answered by the FIRST /turn after
// it: that turn alone carries `followUpRecId` (the follow-up's recId), so the server can read "skip it" as a skip. The id is used
// up by that turn, even a failed one, or by a stage change before it, whichever comes first, and is never sent again. (A pending
// change only exists after a /turn, so a confirm or a cancel always comes after the id was used.)
//
// open() and leave() follow the Charli screen: the session outlives a visit to it (keep.mjs), so coming back shows the same
// conversation and greets nobody twice. While away nothing is spoken and nothing new is sent; a request already out finishes and
// its result is kept, but a change waiting for a yes is dropped. dispose() ends the session for good (sign-out, another user).
//
// getState() -> { turns, pending, busy, opening, hasRates, careerStage, briefing }
//   turns    [{ id, role, content, sources, turnId, kind: "message" | "unverified" | "error" | "notice", inHistory, compose? }]
//            ("unverified": Charli's reply is exactly the can't-verify or guideline hand-off line; compose: the unsent client
//            email the reply set up, { to, subject, body, links: { gmail, outlook, mailto } }, kept only when it checks out)
//   pending  { sideEffect, readBack, details? } | null   (details: [{ label, value }] for the card, when the server sent them)
//   briefing { kind: "morning" | "catch_up", strip: { rate30, move30, asOf, opportunities, checkInsDue, nextEvent }, followUp } | null
//            (the greeting's briefing, for the home page; null until the greeting arrives, and when it failed or had none; each strip
//            field is null when unknown, nextEvent is { title, start } | null, followUp is { recId, clientId, name, source } | null)
// Only turns with inHistory are sent to /turn, as plain { role, content }.
//
// submit/heard/confirmPending/cancelPending/setStage all resolve to { ok, reason? }; `reason: "busy"` means a
// request is already in flight and nothing was done (the caller keeps what the user typed).
export function createSession({ fetch: fetchFn, rates = null, localHour, localDate, user = null, onSpeak, speakGreeting = true } = {}) {
  const doFetch = fetchFn || ((...args) => globalThis.fetch(...args));
  let currentRates = rates;
  let briefingTurn = null;      // the transcript turn that holds the briefing, for briefMe()
  let followUpRecId = null;     // the briefing's follow-up id until the first exchange after it uses it up
  let nextId = 1;
  let disposed = false;
  let away = false;   // the Charli screen is not showing (leave() until the next open())
  let openPromise = null;
  let emptyRun = false;   // the last transcript was empty and "I didn't catch that" was already said (see heard)
  let releaseRates;
  const ratesArrived = new Promise((resolve) => { releaseRates = resolve; });
  if (currentRates) releaseRates();

  let state = {
    turns: [],
    pending: null,
    busy: false,
    opening: false,
    hasRates: !!currentRates,
    careerStage: stageById(user && user.careerStage) ? user.careerStage : null,
    briefing: null,
  };
  const listeners = new Set();
  const set = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn(state);
  };

  const addTurn = (turn) => {
    const full = { id: `t${nextId++}`, sources: [], turnId: null, kind: "message", inHistory: true, ...turn };
    set({ turns: [...state.turns, full] });
    return full;
  };
  const speak = (text, turnId) => {
    if (disposed || away || !text || typeof onSpeak !== "function") return;
    try { onSpeak({ text, turnId: turnId || undefined }); } catch { /* a speaker problem must not break the session */ }
  };
  // Said and shown, never sent to the model.
  const addNotice = (text, { say = false } = {}) => {
    addTurn({ role: "assistant", content: text, kind: "notice", inHistory: false });
    if (say) speak(text);
  };

  const history = () =>
    state.turns.filter((t) => t.inHistory).map(({ role, content }) => ({ role, content })).slice(-MAX_SENT_MESSAGES);

  // One HTTP call; never throws. -> { ok, status, data, network } ; one that outlasted `timeoutMs` (default: REQUEST_TIMEOUTS for
  // the url) -> { ok: false, status: 0, data: null, network: true, timedOut: true }. The request is cancelled through an abort
  // signal AND raced against a timer, so a fetch that ignores the signal cannot hang the session either; the timer covers reading
  // the body too, and is cleared as soon as the call is over. (A timer rather than AbortSignal.timeout: that is missing from older
  // browsers, and in node its timer does not keep a test process alive.)
  async function request(method, url, body, { timeoutMs = REQUEST_TIMEOUTS[url] } = {}) {
    const controller = timeoutMs > 0 && typeof AbortController === "function" ? new AbortController() : null;
    let timer;
    let timedOut = false;
    const exchange = async () => {
      const init = body === undefined
        ? { method }
        : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      if (controller) init.signal = controller.signal;
      const res = await doFetch(url, init);
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { ok: !!res.ok, status: res.status, data, network: false };
    };
    try {
      if (!controller) return await exchange();
      const clock = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, timeoutMs);
      });
      const done = await Promise.race([exchange(), clock]);
      if (done) return done;
      return { ok: false, status: 0, data: null, network: true, timedOut: true };
    } catch {
      return timedOut
        ? { ok: false, status: 0, data: null, network: true, timedOut: true }
        : { ok: false, status: 0, data: null, network: true };
    } finally {
      clearTimeout(timer);
    }
  }

  // Only one thing is in flight at a time: a second request while one is running is refused, not queued, so a
  // "yes" said while Charli is still thinking can never be read against a read-back the user has not seen.
  async function exclusive(fn) {
    if (disposed || away) return { ok: false, reason: "closed" };
    if (state.busy) return { ok: false, reason: "busy" };
    set({ busy: true });
    try { return await fn(); } finally { set({ busy: false }); dropIfAway(); }
  }

  // Away from the screen, a change waiting for a yes is dropped, never kept for later: its card is not in front of the user. One
  // being confirmed is left to finish first (exclusive() calls this again when it is done).
  function dropIfAway() {
    if (!away || !state.pending || state.busy) return;
    set({ pending: null });
    addTurn({ role: "assistant", content: LEFT_UNCONFIRMED });   // in the history: the read-back is no longer the last thing said
  }

  async function refreshStage(fallback) {
    const res = await request("GET", "/api/auth/me");
    if (res.ok && res.data && res.data.user) {
      set({ careerStage: stageById(res.data.user.careerStage) ? res.data.user.careerStage : null });
    } else if (stageById(fallback)) {
      set({ careerStage: fallback });
    }
  }

  // A reply from /turn, or the line for a failure, added to the transcript and spoken (unless `say` is false). -> the reply's turn, or
  // null when the line shown is a failure's.
  function showTurnResult(res, { say = true } = {}) {
    const data = res.data;
    if (res.ok && data && typeof data.reply === "string" && data.reply.trim()) {
      const failed = data.error === true;
      const compose = failed ? null : cleanCompose(data.compose);
      const turn = addTurn({
        role: "assistant", content: data.reply, sources: cleanSources(data.sources), turnId: data.turnId || null,
        kind: failed ? "error" : UNVERIFIED_REPLIES.has(data.reply.trim()) ? "unverified" : "message",
        ...(compose ? { compose } : {}),
      });
      if (!failed && data.sideEffect && typeof data.sideEffect === "object" && !Array.isArray(data.sideEffect)) {
        const details = cleanDetails(data.details);
        set({ pending: details.length ? { sideEffect: data.sideEffect, readBack: data.reply, details } : { sideEffect: data.sideEffect, readBack: data.reply } });
      }
      if (say) speak(data.reply, data.turnId);
      return failed ? null : turn;
    }
    // a /turn that timed out says so in its own words (nothing was written; the user asks again), not as a lost connection
    const text = res.timedOut ? TOOK_TOO_LONG_CLIENT : failureText(res);
    addTurn({ role: "assistant", content: text, kind: "error" });
    if (say) speak(text);
    return null;
  }

  // The briefing's follow-up id for the one exchange that answers its question, or null; either way it is used up.
  function takeFollowUp() {
    const id = followUpRecId;
    followUpRecId = null;
    return id;
  }

  // The user's calendar day: the one handed to createSession when it is YYYY-MM-DD (tests pin it), else the device's own today.
  const todayLocal = (now) => (typeof localDate === "string" && LOCAL_DATE_RE.test(localDate) ? localDate : localDateOf(now));

  async function runGreeting() {
    const now = new Date();
    const hour = Number.isInteger(localHour) ? localHour : now.getHours();
    const date = todayLocal(now);
    const res = await request("POST", "/api/assistant/turn", { greeting: true, rates: currentRates, localHour: hour, localDate: date });
    if (res.ok && res.data && typeof res.data.reply === "string" && res.data.reply.trim()) {
      // A greeting that failed on the server's side (error: true) carries no briefing; one that is missing or odd is none.
      const briefing = res.data.error === true ? null : cleanBriefing(res.data.briefing);
      const turn = showTurnResult(res, { say: speakGreeting !== false });
      if (briefing && turn) {
        briefingTurn = turn;
        followUpRecId = briefing.followUp ? briefing.followUp.recId : null;
        set({ briefing });
      }
    } else {
      // No greeting is no history either: the first thing the user says starts the conversation.
      const text = failureText(res);
      addTurn({ role: "assistant", content: text, kind: "error", inHistory: false });
      if (speakGreeting !== false) speak(text);
    }
  }

  // "Brief me": the briefing said aloud, again if it was already (the text is on screen either way).
  async function briefMe() {
    if (disposed || away) return { ok: false, reason: "closed" };
    if (!briefingTurn || !state.briefing) return { ok: false, reason: "no-briefing" };
    speak(briefingTurn.content, briefingTurn.turnId);
    return { ok: true };
  }

  // Greets once rates are in. Safe to call more than once (it returns the same promise): coming back after leave() greets no one
  // again, and only re-reads the shown stage.
  function open() {
    if (away) {
      away = false;
      if (openPromise) refreshStage();
    }
    if (!openPromise) {
      set({ opening: true });
      openPromise = (async () => {
        refreshStage();   // the shown stage must be the stored one, not what the page loaded with
        await ratesArrived;
        if (disposed) return;
        set({ busy: true });
        try { await runGreeting(); } finally { set({ busy: false, opening: false }); }
      })();
    }
    return openPromise;
  }

  async function runTurn(text) {
    addTurn({ role: "user", content: text });
    // (final review M-6) every turn says the user's date, so a lookup's "today" and "last night" are theirs, not UTC's
    const body = { messages: history(), rates: currentRates, localDate: todayLocal(new Date()) };
    // the first turn after a briefing answers its closing question: it alone says which follow-up that was
    const followUp = takeFollowUp();
    if (followUp !== null) body.followUpRecId = followUp;
    showTurnResult(await request("POST", "/api/assistant/turn", body));
  }

  // The pending change was declined, by voice or by the Cancel button.
  function leaveThat() {
    set({ pending: null });
    addTurn({ role: "assistant", content: LEAVE_THAT });
    speak(LEAVE_THAT);
  }

  // POST /confirm with the sideEffect exactly as /turn returned it.
  async function doConfirm() {
    const { sideEffect } = state.pending;
    const res = await request("POST", "/api/assistant/confirm", { sideEffect });
    if (res.ok && res.data && res.data.success === true) {
      set({ pending: null });
      const reply = typeof res.data.reply === "string" && res.data.reply.trim() ? res.data.reply : "Done.";
      addTurn({ role: "assistant", content: reply });
      speak(reply);
      if (sideEffect.type === "setCareerStage") await refreshStage(res.data.result && res.data.result.stage);
      return;
    }
    if (away && (stillWorking(res) || isRetryable(res))) {
      // The user left while this was out, and it may yet have gone through: dropped, and they are told to check.
      set({ pending: null });
      addTurn({ role: "assistant", content: LEFT_UNFINISHED });
      return;
    }
    if (stillWorking(res)) {
      // The first request may still go through: the read-back stays, and a later yes with the same confirmId gets its result.
      addNotice(STILL_WORKING, { say: true });
      return;
    }
    if (isRetryable(res)) {
      // Not known to have failed for good: the read-back stays, and saying yes again retries with the same confirmId.
      addNotice("I couldn't finish that just now. Say yes to try again, or cancel.", { say: true });
      return;
    }
    set({ pending: null });
    const text = failureText(res);
    addTurn({ role: "assistant", content: text, kind: "error" });   // in the history: the read-back is no longer the last thing said
    speak(text);
  }

  async function submit(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return { ok: false, reason: "empty" };
    if (!currentRates) return { ok: false, reason: "no-rates" };
    if (state.opening) return { ok: false, reason: "not-ready" };
    return exclusive(async () => {
      if (state.pending) {
        const answer = classifyReply(clean);
        if (answer === "yes" || answer === "no") {
          // Shown in the transcript, but never in the history sent to /turn.
          addTurn({ role: "user", content: clean, inHistory: false });
          if (answer === "yes") await doConfirm(); else leaveThat();
          return { ok: true, action: answer === "yes" ? "confirm" : "cancel" };
        }
        leaveThat();   // anything else: drop the change, then handle what was said as a new request
      }
      await runTurn(clean);
      return { ok: true, action: "turn" };
    });
  }

  // What speech-to-text heard; "" means it heard nothing. `pendingAtStart` (optional) is getState().pending at the moment the
  // recording went to speech-to-text. A bare yes or no (classifyReply) that comes back after that change was confirmed or
  // cancelled with a button, or replaced, answers nothing the user can still see: it is shown as a notice and sent nowhere
  // (a late "yes" must never reach /turn as an ordinary answer, nor confirm a change the user has not seen).
  // A transcript that is only audio-event tags ("(background noise)") heard nothing either. In a noisy room every burst of
  // noise is an empty transcript: "I didn't catch that" is SPOKEN only for the first of a run of them (each one is still
  // shown), and the run ends with the next transcript that has words in it.
  async function heard(text, { pendingAtStart } = {}) {
    if (disposed || away) return { ok: false, reason: "closed" };
    const said = withoutAudioTags(text).trim();
    if (said) emptyRun = false;
    if (said && pendingAtStart !== undefined && state.pending !== pendingAtStart && !disposed) {
      const answer = classifyReply(text);
      if (answer === "yes" || answer === "no") {
        addNotice(LATE_ANSWER);
        return { ok: true, action: "late-answer" };
      }
    }
    if (said) return submit(text);
    if (disposed) return { ok: false, reason: "closed" };
    if (state.busy) return { ok: false, reason: "busy" };
    addNotice(DIDNT_CATCH, { say: !emptyRun });
    emptyRun = true;
    return { ok: true, action: "didnt-catch" };
  }

  // The Confirm button: the same path as a spoken yes.
  async function confirmPending() {
    if (!state.pending) return { ok: false, reason: "nothing-pending" };
    return exclusive(async () => {
      await doConfirm();
      return { ok: true, action: "confirm" };
    });
  }

  // The Cancel button: the same path as a spoken no.
  async function cancelPending() {
    if (!state.pending) return { ok: false, reason: "nothing-pending" };
    return exclusive(async () => {
      leaveThat();
      return { ok: true, action: "cancel" };
    });
  }

  // The stage selector: the click is the confirmation.
  async function setStage(stageId) {
    if (!stageById(stageId)) return { ok: false, reason: "invalid" };
    return exclusive(async () => {
      takeFollowUp();
      const res = await request("POST", "/api/assistant/confirm", { sideEffect: { type: "setCareerStage", stage: stageId } });
      if (res.ok && res.data && res.data.success === true) {
        const reply = typeof res.data.reply === "string" && res.data.reply.trim() ? res.data.reply : "Done.";
        addTurn({ role: "assistant", content: reply });
        speak(reply);
        await refreshStage(stageId);
        return { ok: true, action: "stage" };
      }
      addNotice(failureText(res), { say: true });
      return { ok: false, reason: "failed" };
    });
  }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setRates(next) {
      currentRates = next || null;
      set({ hasRates: !!currentRates });
      if (currentRates) releaseRates();
    },
    open,
    leave() { away = true; dropIfAway(); },
    submit,
    heard,
    confirmPending,
    cancelPending,
    setStage,
    briefMe,
    notice: (text, opts) => { if (!away) addNotice(text, opts); },   // a line from the screen, which is gone while away
    dispose() { disposed = true; listeners.clear(); releaseRates(); },
  };
}

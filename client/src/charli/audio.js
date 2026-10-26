// Charli's ears and voice, in the browser. No React and no conversation logic here (that is session.mjs).
//
//   Ears   getUserMedia -> an AnalyserNode reads the loudness every tick -> vad.mjs decides when an utterance
//          starts and ends -> one MediaRecorder per utterance -> onUtterance(blob). The caller uploads it.
//   Voice  speak({ text, turnId }) -> POST /api/voice/tts -> the MP3 is played as it streams in (MediaSource),
//          or after it has all arrived where MediaSource cannot do audio/mpeg.
//
// HALF-DUPLEX: the caller turns capture off (setCapture(false)) while Charli is speaking or thinking, so her own
// voice never goes back into speech-to-text, and on again when she is done.
import { createVad, VAD_DEFAULTS } from "./vad.mjs";

const TTS_URL = "/api/voice/tts";
const STT_URL = "/api/voice/stt";
const ECHO_TAIL_MS = 350;   // after capture resumes, ignore the room this long (the end of Charli's own voice)
const TTS_ERROR_BODY_CHARS = 1024;   // how much of a failed /tts response is read

// ── a failed speech response ─────────────────────────────────────────────────

// The start (1 KB at most) of a failed /api/voice/tts response's text, "" when it cannot be read; the body is then cancelled. The
// status alone cannot tell the two 429s apart (the daily budget vs the per-15-minute limiter): the server's message does, and
// session.mjs voiceNoteFor reads it. Never throws.
export async function ttsFailureBody(res) {
  let text = "";
  try { text = String(await res.text()).slice(0, TTS_ERROR_BODY_CHARS); } catch { /* unreadable: the status alone decides the note */ }
  try { if (res && res.body) await Promise.resolve(res.body.cancel()).catch(() => {}); } catch { /* already closed */ }
  return text;
}

// ── speech-to-text upload ────────────────────────────────────────────────────

const extensionFor = (type) => (/mp4/i.test(type) ? "mp4" : /ogg/i.test(type) ? "ogg" : "webm");

// POST the utterance as multipart field "audio". -> the transcript ("" when nothing was heard).
// A failure throws an Error with .status (0 for a network failure) and the server's message.
export async function transcribe(blob, fetchFn) {
  const send = fetchFn || ((...args) => window.fetch(...args));
  const form = new FormData();
  form.append("audio", blob, `utterance.${extensionFor(blob.type || "")}`);
  let res;
  try {
    res = await send(STT_URL, { method: "POST", body: form });
  } catch {
    throw Object.assign(new Error("could not reach the server"), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `voice service error (${res.status})`), { status: res.status });
  return data && typeof data.text === "string" ? data.text : "";
}

// ── playback helpers ─────────────────────────────────────────────────────────

// A tiny silent WAV. Playing it from a tap "unlocks" the audio element for browsers (Safari) that only let an
// element that has been played from a gesture play later without one.
function silentWav() {
  const bytes = new Uint8Array(46);
  const v = new DataView(bytes.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 38, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

const mseCanPlayMpeg = () =>
  typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported("audio/mpeg");

// Feeds MP3 chunks to an <audio> element through a MediaSource. onFail() is called if the browser rejects the data.
function openSink(el, onFail) {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const pending = [];
  let buffer = null;
  let ended = false;
  let dead = false;
  const fail = () => { if (!dead) { dead = true; onFail(); } };
  const flush = () => {
    if (dead || !buffer || buffer.updating || source.readyState !== "open") return;
    try {
      if (pending.length) buffer.appendBuffer(pending.shift());
      else if (ended) source.endOfStream();
    } catch { fail(); }
  };
  source.addEventListener("sourceopen", () => {
    try {
      buffer = source.addSourceBuffer("audio/mpeg");
      buffer.addEventListener("updateend", flush);
      buffer.addEventListener("error", fail);
      flush();
    } catch { fail(); }
  }, { once: true });
  el.src = url;
  return {
    append(chunk) { pending.push(chunk); flush(); },
    end() { ended = true; flush(); },
    dispose() { dead = true; try { URL.revokeObjectURL(url); } catch { /* already gone */ } },
  };
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

// ── the controller ───────────────────────────────────────────────────────────

// createAudio({ fetch, onUtterance, onSpeakingChange, onHearing, onMicChange, onAutoplayBlocked, onTtsError, onTtsOk })
//   onUtterance(blob)        one finished utterance worth transcribing
//   onSpeakingChange(bool)   Charli's voice started / finished everything queued
//   onHearing(bool)          an utterance is being recorded
//   onMicChange(state)       "live" | "off" | "denied" | "unavailable" | "error"
//   onAutoplayBlocked()      the browser refused to play without a tap: show a "Start Charli" button, then call
//                            unlock() and retryBlocked() from that tap
//   onTtsError(status, body) speech could not be fetched/played (status 0 = network, -1 = playback; otherwise the HTTP status, with
//                            `body` the start of the response text, ttsFailureBody: "" when there was none); text stays on screen
//   onTtsOk()                a clip played fine
export function createAudio({
  fetch: fetchFn,
  onUtterance = () => {},
  onSpeakingChange = () => {},
  onHearing = () => {},
  onMicChange = () => {},
  onAutoplayBlocked = () => {},
  onTtsError = () => {},
  onTtsOk = () => {},
} = {}) {
  const send = fetchFn || ((...args) => window.fetch(...args));
  let disposed = false;

  // ── ears ──
  let stream = null;
  let context = null;
  let analyser = null;
  let samples = null;
  let timer = null;
  let vad = null;
  let starting = null;
  let micWanted = false;   // startMic() was called and stopMic() has not been since
  let capturing = false;
  let quietUntil = 0;
  let take = null;   // the recording in progress: { rec, parts, keep }

  function beginTake() {
    if (take || !stream) return;
    let rec;
    try { rec = new MediaRecorder(stream); } catch { vad.reset(); return; }
    const t = { rec, parts: [], keep: false };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) t.parts.push(e.data); };
    rec.onstop = () => {
      if (!t.keep || disposed) return;
      const blob = new Blob(t.parts, { type: rec.mimeType || "audio/webm" });
      if (blob.size) onUtterance(blob);
    };
    try { rec.start(); } catch { vad.reset(); return; }
    take = t;
    onHearing(true);
  }

  function closeTake(keep) {
    const t = take;
    take = null;
    if (!t) return;
    onHearing(false);
    t.keep = keep;
    try { if (t.rec.state !== "inactive") t.rec.stop(); } catch { /* already stopped */ }
  }

  function tick() {
    if (!capturing || !analyser || performance.now() < quietUntil) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const event = vad.push(Math.sqrt(sum / samples.length), performance.now());
    if (!event) return;
    if (event.type === "start") beginTake(); else closeTake(event.keep);
  }

  function releaseMic() {
    clearInterval(timer);
    timer = null;
    closeTake(false);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (context) context.close().catch(() => {});
    context = analyser = samples = vad = null;
  }

  async function openMic() {
    if (disposed) return { ok: false, reason: "disposed" };
    if (stream) return { ok: true };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      onMicChange("unavailable");
      return { ok: false, reason: "unavailable" };
    }
    let got;
    try {
      got = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err && err.name;
      const reason = name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "unavailable" : "error";
      onMicChange(reason);
      return { ok: false, reason };
    }
    if (disposed || !micWanted) {   // paused (or left) while the browser was asking
      got.getTracks().forEach((t) => t.stop());
      return { ok: false, reason: "stopped" };
    }
    try {
      context = new (window.AudioContext || window.webkitAudioContext)();
      if (context.state === "suspended") context.resume().catch(() => {});   // not awaited: it can wait for a tap
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(got).connect(analyser);   // analysed only, never sent to the speakers
    } catch {
      got.getTracks().forEach((t) => t.stop());
      onMicChange("error");
      return { ok: false, reason: "error" };
    }
    stream = got;
    samples = new Float32Array(analyser.fftSize);
    vad = createVad();
    timer = setInterval(tick, VAD_DEFAULTS.tickMs);
    got.getAudioTracks().forEach((t) => t.addEventListener("ended", () => {
      if (stream === got) { releaseMic(); onMicChange("error"); }
    }));
    onMicChange("live");
    return { ok: true };
  }

  // Asks for the microphone (the browser may prompt). Safe to call again; resolves { ok, reason? }.
  function startMic() {
    micWanted = true;
    if (!starting) starting = openMic().finally(() => { starting = null; });
    return starting;
  }

  // Releases the microphone completely (the browser's recording indicator goes off).
  function stopMic() {
    micWanted = false;
    releaseMic();
    if (!disposed) onMicChange("off");
  }

  // Listen (true) or ignore the room (false). Turning it off throws away an utterance in progress.
  function setCapture(on) {
    if (on === capturing) return;
    capturing = on;
    if (vad) vad.reset();
    if (on) quietUntil = performance.now() + ECHO_TAIL_MS; else closeTake(false);
  }

  // ── voice ──
  let element = null;
  let queue = [];
  let blocked = [];
  let current = null;   // AbortController of the clip being fetched/played
  let pumping = false;
  const audioEl = () => {
    if (!element) { element = new Audio(); element.preload = "auto"; }
    return element;
  };

  // Plays one MP3 response; resolves when it has finished. Rejects with NotAllowedError when the browser needs a
  // tap, AbortError when `signal` fires, any other Error when it cannot be played.
  function playMpeg(res, signal) {
    return new Promise((resolve, reject) => {
      const el = audioEl();
      const chunks = [];
      let settled = false;
      let sink = null;
      let streaming = false;
      let readDone = false;
      let started = false;
      let blobUrl = null;
      const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        el.onended = el.onerror = el.onplaying = null;
        try { el.pause(); } catch { /* nothing to pause */ }
        if (reader) reader.cancel().catch(() => {});
        if (sink) sink.dispose();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        el.removeAttribute("src");
        try { el.load(); } catch { /* nothing loaded */ }
        if (err) reject(err); else resolve();
      };
      const onAbort = () => finish(abortError());
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) { onAbort(); return; }

      // Everything has arrived: play it as one file.
      const playWhole = () => {
        if (settled) return;
        if (sink) { sink.dispose(); sink = null; }
        streaming = false;
        blobUrl = URL.createObjectURL(new Blob(chunks, { type: "audio/mpeg" }));
        el.onended = () => finish();
        el.onerror = () => finish(new Error("playback failed"));
        el.src = blobUrl;
        el.play().catch((e) => finish(e));
      };
      // MediaSource refused the data: switch to playing the whole file once it has arrived.
      const sinkFailed = () => {
        if (settled) return;
        streaming = false;
        if (sink) { sink.dispose(); sink = null; }
        if (readDone) playWhole();
      };

      if (reader && mseCanPlayMpeg()) {
        try {
          sink = openSink(el, sinkFailed);
          streaming = true;
        } catch { sink = null; }
      }
      if (streaming) {
        el.onended = () => finish();
        el.onerror = () => { if (started) finish(new Error("playback failed")); else sinkFailed(); };
        el.onplaying = () => { started = true; };
        // A refusal for lack of a tap is the one rejection that matters here; any other (a load interrupted by
        // the whole-file fallback) is followed by an event that deals with it.
        el.play().catch((e) => { if (e && e.name === "NotAllowedError") finish(e); });
      }

      (async () => {
        try {
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (settled) return;
              if (done) break;
              chunks.push(value);
              if (streaming && sink) sink.append(value);
            }
          } else {
            chunks.push(new Uint8Array(await res.arrayBuffer()));
          }
          readDone = true;
          if (settled) return;
          if (streaming && sink) sink.end(); else playWhole();
        } catch (err) {
          finish(err);
        }
      })();
    });
  }

  // -> "done" | "skipped" | "blocked"
  async function playClip(job) {
    const ac = new AbortController();
    current = ac;
    try {
      let res;
      try {
        res = await send(TTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: job.text, turnId: job.turnId }),
          signal: ac.signal,
        });
      } catch {
        if (!ac.signal.aborted) onTtsError(0);
        return "skipped";
      }
      if (!res.ok) {
        // the body is read BEFORE it is cancelled: it says which 429 this is (the daily budget or the limiter)
        const body = await ttsFailureBody(res);
        onTtsError(res.status, body);   // the text is already on screen; carry on without a voice
        return "skipped";
      }
      try {
        await playMpeg(res, ac.signal);
        onTtsOk();
        return "done";
      } catch (err) {
        if (ac.signal.aborted) return "skipped";
        if (err && err.name === "NotAllowedError") return "blocked";
        onTtsError(-1);
        return "skipped";
      }
    } finally {
      if (current === ac) current = null;
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    onSpeakingChange(true);
    try {
      while (queue.length && !disposed) {
        const job = queue.shift();
        if (await playClip(job) === "blocked") {
          blocked = [job, ...queue];
          queue = [];
          onAutoplayBlocked();
        }
      }
    } finally {
      pumping = false;
      if (!disposed) onSpeakingChange(false);
    }
  }

  // Queue a line for Charli to say. Lines play in order.
  function speak(job) {
    if (disposed || !job || !job.text) return;
    queue.push({ text: job.text, turnId: job.turnId });
    pump();
  }

  // Cut off whatever is playing and forget what is queued.
  function stopSpeaking() {
    queue = [];
    blocked = [];
    if (current) current.abort();
  }

  // Call from a tap/click: lets a browser that insists on a gesture play audio afterwards.
  function unlock() {
    try { if (context && context.state === "suspended") context.resume(); } catch { /* ignore */ }
    if (pumping) return;
    const el = audioEl();
    const url = URL.createObjectURL(silentWav());
    const reset = () => {
      if (el.getAttribute("src") === url) { el.removeAttribute("src"); try { el.load(); } catch { /* ignore */ } }
      URL.revokeObjectURL(url);
    };
    el.src = url;
    // (only pause our own silent clip: a real one may have taken the element over by the time this resolves)
    el.play().then(() => { if (el.getAttribute("src") === url) el.pause(); }).catch(() => {}).then(reset);
  }

  // After a "Start Charli" tap: say again what the browser would not play.
  function retryBlocked() {
    const jobs = blocked;
    blocked = [];
    jobs.forEach(speak);
  }

  function dispose() {
    disposed = true;
    stopSpeaking();
    releaseMic();
  }

  return { startMic, stopMic, setCapture, speak, stopSpeaking, unlock, retryBlocked, dispose };
}

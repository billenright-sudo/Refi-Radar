// node --test src/charli/
// audio.js is browser code, but a failed speech response never reaches the DOM: ttsFailureBody and the createAudio path that hands the
// failure to onTtsError run here against fake Response-like objects (no DOM test framework).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudio, ttsFailureBody } from "./audio.js";
import { voiceNoteFor, VOICE_BUDGET_NOTE, VOICE_BREAK_NOTE } from "./session.mjs";

const BUDGET_BODY = '{"error":"voice budget reached for today — Charlie answers in text until tomorrow"}';
const LIMITER_BODY = '{"error":"Too many voice requests — please try again in a few minutes"}';

// A failed Response, as far as audio.js looks at one. `events` records the order in which the body was used.
function failedResponse(status, bodyText, { events = [], text, cancel } = {}) {
  return {
    ok: false, status,
    text: text || (async () => { events.push("text"); return bodyText; }),
    body: { cancel: cancel || (() => { events.push("cancel"); return Promise.resolve(); }) },
  };
}

test("ttsFailureBody: the body text is read first and then cancelled", async () => {
  const events = [];
  assert.equal(await ttsFailureBody(failedResponse(429, BUDGET_BODY, { events })), BUDGET_BODY);
  assert.deepEqual(events, ["text", "cancel"]);
});

test("ttsFailureBody: at most the first 1 KB is kept", async () => {
  const long = "x".repeat(5000);
  assert.equal((await ttsFailureBody(failedResponse(500, long))).length, 1024);
  assert.equal(await ttsFailureBody(failedResponse(500, "y".repeat(1024))), "y".repeat(1024));
});

test("ttsFailureBody never throws: an unreadable or missing body is '', and a cancel that fails is ignored", async () => {
  const events = [];
  const unreadable = failedResponse(429, "", { events, text: async () => { throw new TypeError("body stream already read"); } });
  assert.equal(await ttsFailureBody(unreadable), "");
  assert.deepEqual(events, ["cancel"], "the body is still cancelled");
  assert.equal(await ttsFailureBody({ ok: false, status: 429 }), "", "no text() and no body");
  assert.equal(await ttsFailureBody({ ok: false, status: 429, text: async () => null }), "", "a non-string body is no text");
  const cancelThrows = failedResponse(429, BUDGET_BODY, { cancel: () => { throw new Error("locked"); } });
  assert.equal(await ttsFailureBody(cancelThrows), BUDGET_BODY);
  const cancelRejects = failedResponse(429, BUDGET_BODY, { cancel: () => Promise.reject(new Error("errored stream")) });
  assert.equal(await ttsFailureBody(cancelRejects), BUDGET_BODY);
});

// Speaks one line through createAudio with a fetch that answers `respond(url)`; resolves with what onTtsError was told.
function speakOnce(respond) {
  return new Promise((resolve) => {
    const told = [];
    const audio = createAudio({
      fetch: async (url) => respond(url),
      onTtsError: (...args) => told.push(args),
      onSpeakingChange: (speaking) => { if (!speaking) resolve(told); },
    });
    audio.speak({ text: "Hello there.", turnId: "t1" });
  });
}

test("a failed /tts response reaches onTtsError as (status, body), and the two 429s come out as different notes", async () => {
  const events = [];
  const told = await speakOnce(() => failedResponse(429, BUDGET_BODY, { events }));
  assert.deepEqual(told, [[429, BUDGET_BODY]]);
  assert.deepEqual(events, ["text", "cancel"], "read before it was cancelled");
  assert.equal(voiceNoteFor(...told[0]), VOICE_BUDGET_NOTE);

  const limited = await speakOnce(() => failedResponse(429, LIMITER_BODY));
  assert.deepEqual(limited, [[429, LIMITER_BODY]]);
  assert.equal(voiceNoteFor(...limited[0]), VOICE_BREAK_NOTE);

  const off = await speakOnce(() => failedResponse(503, '{"error":"voice not configured"}'));
  assert.equal(voiceNoteFor(...off[0]), "Voice replies aren't set up on this server, so Charlie answers in text.");
});

test("a /tts response whose body cannot be read still reports its status (the 429 is then the short-break note)", async () => {
  const told = await speakOnce(() => failedResponse(429, "", { text: async () => { throw new Error("reset"); } }));
  assert.deepEqual(told, [[429, ""]]);
  assert.equal(voiceNoteFor(...told[0]), VOICE_BREAK_NOTE);
});

test("a network failure is still onTtsError(0) with no body", async () => {
  const told = await speakOnce(() => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(told, [[0]]);
});

// ── the ears across taps (tap to talk opens and closes the mic for every question) ──

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A fake browser for the ears: a microphone whose loudness the test sets, a clock the test moves (performance.now), the tick the
// test runs (setInterval), and an <audio> element whose line the test ends. Restored when the test ends.
function fakeEars(t) {
  const env = { now: 1000, level: 0, ticks: [], voice: null };
  t.mock.method(performance, "now", () => env.now);
  const names = ["navigator", "window", "MediaRecorder", "Audio", "setInterval", "clearInterval"];
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  t.after(() => saved.forEach(([n, d]) => { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }));

  const track = { stop() {}, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeContext {
    constructor() { this.state = "running"; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (a) => a.fill(env.level) }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  }
  class FakeRecorder {
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; if (this.ondataavailable) this.ondataavailable({ data: new Blob(["x"]) }); if (this.onstop) this.onstop(); }
  }
  class FakeAudio {
    constructor() { env.voice = this; this.src = undefined; }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    getAttribute() { return this.src; }
    removeAttribute() { this.src = undefined; }
  }
  Object.assign(globalThis, {
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    window: { AudioContext: FakeContext },
    MediaRecorder: FakeRecorder,
    Audio: FakeAudio,
    setInterval: (fn) => { env.ticks.push(fn); return env.ticks.length; },
    clearInterval: (id) => { if (id) env.ticks[id - 1] = null; },
  });
  // `ms` of the room at `level`, one reading per 30 ms tick.
  env.run = (level, ms) => {
    env.level = level;
    for (let i = 0; i < Math.round(ms / 30); i++) {
      env.now += 30;
      env.ticks.forEach((fn) => fn && fn());
    }
  };
  env.wait = (ms) => { env.now += ms; };
  return env;
}

const okClip = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });

// The mic as CharliView drives it: open, then capture on.
async function open(audio) {
  assert.deepEqual(await audio.startMic(), { ok: true });
  audio.setCapture(true);
}
function close(audio) {
  audio.stopMic();
  audio.setCapture(false);
}

test("the room's level is kept across taps: a second mic open does not calibrate again, so the first word is heard at once", async (t) => {
  const ears = fakeEars(t);
  const heard = [];
  const audio = createAudio({ fetch: okClip, onHearing: (on) => heard.push(on) });
  await open(audio);
  ears.run(0.004, 1500);   // a quiet room, longer than the 450 ms calibration
  assert.deepEqual(heard, []);
  close(audio);

  ears.wait(5000);   // the next question, a few seconds later
  await open(audio);
  ears.run(0.12, 30);   // one tick of speech
  assert.deepEqual(heard, [true], "the first loud reading of the second open starts the utterance");
  audio.dispose();
});

test("a cold open (she has not just spoken) has no echo tail: the room is read from the first tick", async (t) => {
  const ears = fakeEars(t);
  const heard = [];
  const audio = createAudio({ fetch: okClip, onHearing: (on) => heard.push(on) });
  await open(audio);
  ears.run(0.004, 450);   // the 450 ms calibration, from the first tick
  assert.deepEqual(heard, []);
  ears.run(0.12, 30);
  assert.deepEqual(heard, [true], "calibration ended 450 ms after the first tick: nothing was skipped before it");
  audio.dispose();
});

test("right after her voice stops, the room is ignored for 350 ms (the end of her own voice), and only then", async (t) => {
  const ears = fakeEars(t);
  const heard = [];
  const speaking = [];
  const audio = createAudio({ fetch: okClip, onHearing: (on) => heard.push(on), onSpeakingChange: (on) => speaking.push(on) });
  await open(audio);
  ears.run(0.004, 1500);   // calibrated
  audio.setCapture(false);   // half-duplex: she speaks
  audio.speak({ text: "Rates are flat today.", turnId: "t1" });
  await settle();
  ears.voice.onended();   // her line finishes now
  await settle();
  assert.deepEqual(speaking, [true, false]);

  audio.setCapture(true);
  ears.run(0.12, 330);   // still inside the tail: her own voice
  assert.deepEqual(heard, [], "nothing is heard within 350 ms of her voice stopping");
  ears.run(0.12, 30);
  assert.deepEqual(heard, [true], "the first reading after the tail is heard");
  audio.dispose();
});

test("the echo tail runs from when her voice stopped: a mic opened a second later listens at once", async (t) => {
  const ears = fakeEars(t);
  const heard = [];
  const audio = createAudio({ fetch: okClip, onHearing: (on) => heard.push(on) });
  await open(audio);
  ears.run(0.004, 1500);
  close(audio);   // tap to talk: the question was sent and the mic closed
  audio.speak({ text: "Here is the answer.", turnId: "t2" });
  await settle();
  ears.voice.onended();
  await settle();

  ears.wait(1000);   // the next tap, a second after she finished
  await open(audio);
  ears.run(0.12, 30);
  assert.deepEqual(heard, [true], "no tail and no calibration: the first word is heard");
  audio.dispose();
});

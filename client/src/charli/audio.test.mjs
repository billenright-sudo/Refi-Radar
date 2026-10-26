// node --test src/charli/
// audio.js is browser code, but a failed speech response never reaches the DOM: ttsFailureBody and the createAudio path that hands the
// failure to onTtsError run here against fake Response-like objects (no DOM test framework).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudio, ttsFailureBody } from "./audio.js";
import { voiceNoteFor, VOICE_BUDGET_NOTE, VOICE_BREAK_NOTE } from "./session.mjs";

const BUDGET_BODY = '{"error":"voice budget reached for today — Charli answers in text until tomorrow"}';
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
  assert.equal(await ttsFailureBody({ ok: false, status: 429, text: async () => null }), "null");
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
  assert.equal(voiceNoteFor(...off[0]), "Voice replies aren't set up on this server, so Charli answers in text.");
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

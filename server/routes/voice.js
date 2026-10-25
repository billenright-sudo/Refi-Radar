"use strict";
// Charli's voice, proxied through our server so the ElevenLabs key never reaches the browser and only audio
// and reply text ever go to ElevenLabs.
//   POST /api/voice/tts   { text, turnId? } -> audio/mpeg, streamed (text is spoken after toSpeech spells out the numbers)
//   POST /api/voice/stt   multipart field "audio" -> { text } (ElevenLabs Scribe)
//
// Neither route ever 500s: not configured is 503, an ElevenLabs error is 502 with a short message (never the
// upstream body, which could echo a credential), a network error or a stall is 504. The key is never returned
// or logged. The outbound call goes through `app.get("voiceFetch") || fetch`, so tests inject a stub.
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { requireAuth } = require("../middleware/auth");
const { recordUsage } = require("../lib/assistant/metering");
const { toSpeech } = require("../lib/assistant/speech");

const API_BASE = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_TTS_MODEL = "eleven_v4_turbo";   // the fastest model on the account, built for low latency
const DEFAULT_STT_MODEL = "scribe_v2";
const TIMEOUT_MS = 20_000;
const MAX_TTS_CHARS = 2000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TURN_ID_CHARS = 64;
const NOT_CONFIGURED = "voice not configured";

const fail = (res, status, error) => res.status(status).json({ error });

// A setting from the environment: trimmed, or the fallback when unset or blank.
const setting = (name, fallback = "") => (process.env[name] || "").trim() || fallback;

// What gets logged for a failed outbound call: a short code only. An error message can quote the request,
// and the request carries the key.
function errCode(err) {
  const code = err && ((err.cause && err.cause.code) || err.code || err.name);
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "error";
}

// Gives up on an ElevenLabs call that goes quiet. arm() starts the clock for ONE wait (the response, or the
// next chunk of audio) and clear() stops it, so a clip that keeps arriving can be as long as it likes while a
// stall is cut off. The abort reaches fetch through `signal`.
function makeDeadline(ms) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    arm() { clear(); timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); },
    clear,
  };
}

// Throws away what is left of an upstream response we are not going to use, so the connection is freed.
function discard(upstream) {
  try {
    const cancelled = upstream.body && upstream.body.cancel && upstream.body.cancel();
    if (cancelled && cancelled.catch) cancelled.catch(() => {});
  } catch (_err) { /* already locked or closed */ }
}

// One read from the audio stream, under the deadline.
async function readWithin(reader, deadline) {
  deadline.arm();
  try { return await reader.read(); } finally { deadline.clear(); }
}

// The audio, chunk by chunk, starting with the one already read. Only the wait for upstream is timed: a slow
// listener holding the response open is not a stall. Leaving early (the browser went away, a stall) cancels
// the upstream read.
async function* audioChunks(first, reader, deadline) {
  try {
    yield first;
    for (;;) {
      const { done, value } = await readWithin(reader, deadline);
      if (done) return;
      if (value && value.length) yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Scribe sniffs the format, but a sensible file name helps it: audio.webm, audio.mp4 ...
function uploadName(mimetype) {
  const subtype = String(mimetype).split("/")[1] || "";
  const ext = subtype.split(";")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ext ? `audio.${ext}` : "audio";
}

// createVoiceRouter({ limiter, timeoutMs }) builds a router with its own rate-limit counter; `limiter`
// overrides the express-rate-limit options and `timeoutMs` the 20-second stall deadline (tests use smaller
// ones). The default export is the one index.js mounts.
function createVoiceRouter({ limiter = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  // 120 requests per 15 minutes, counted per signed-in user (an office shares one IP address). A spoken
  // exchange is one /stt and one /tts per turn, so this is about sixty turns.
  router.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { error: "Too many voice requests — please try again in a few minutes" },
    ...limiter,
  }));

  // Metering must never break the audio or the transcript.
  const meter = (fields) => {
    try {
      recordUsage(fields);
    } catch (err) {
      console.error("voice usage:", (err && err.message) || String(err));
    }
  };

  // What a failed outbound call (fetch itself threw, or the stream broke before any audio) looks like to the browser.
  const unreachable = (res, label, deadline, err) => {
    console.error(`voice ${label}:`, deadline.timedOut ? "timed out" : `request failed (${errCode(err)})`);
    return fail(res, 504, deadline.timedOut ? "voice service timed out" : "voice service unreachable");
  };
  const upstreamError = (res, label, upstream) => {
    discard(upstream);
    console.error(`voice ${label}: upstream status`, upstream.status);
    return fail(res, 502, `voice service error (${upstream.status})`);
  };
  const unexpected = (res, label, err) => {
    console.error(`voice ${label}:`, errCode(err));
    if (!res.headersSent) return fail(res, 502, "voice service error");
    res.destroy();   // the audio had started: the only honest ending is a cut-off response
    return undefined;
  };

  // POST /api/voice/tts — Body: { text, turnId? }. -> 200 audio/mpeg, streamed as ElevenLabs produces it.
  // `text` is the reply as shown on screen (digits and all); what is spoken is toSpeech(text). The turnId, when
  // given, is the one /api/assistant/turn returned, so the usage row ties to the turn.
  router.post("/tts", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return fail(res, 400, "text required");
    if (text.length > MAX_TTS_CHARS) return fail(res, 400, "text is longer than 2,000 characters");
    let turnId = null;
    if (body.turnId != null) {
      if (typeof body.turnId !== "string" || !body.turnId || body.turnId.length > MAX_TURN_ID_CHARS) {
        return fail(res, 400, "turnId must be a short string");
      }
      turnId = body.turnId;
    }
    const spoken = toSpeech(text);
    if (!spoken) return fail(res, 400, "text has nothing to say");

    const apiKey = setting("ELEVENLABS_API_KEY");
    const voiceId = setting("ELEVENLABS_VOICE_ID_CHARLI");
    if (!apiKey || !voiceId) return fail(res, 503, NOT_CONFIGURED);

    const send = req.app.get("voiceFetch") || globalThis.fetch;
    const deadline = makeDeadline(timeoutMs);
    try {
      let upstream;
      deadline.arm();
      try {
        upstream = await send(
          `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${OUTPUT_FORMAT}`,
          {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text: spoken, model_id: setting("ELEVENLABS_TTS_MODEL", DEFAULT_TTS_MODEL) }),
            signal: deadline.signal,
          }
        );
      } catch (err) {
        return unreachable(res, "tts", deadline, err);
      } finally {
        deadline.clear();
      }
      if (!upstream.ok) return upstreamError(res, "tts", upstream);

      // Nothing is committed to the browser until a first piece of audio is in hand, so a stream that dies
      // before it, or an empty one, is a clean 504 / 502 and not a 200 with nothing in it.
      const reader = upstream.body && typeof upstream.body.getReader === "function" ? upstream.body.getReader() : null;
      if (!reader) { discard(upstream); console.error("voice tts: upstream sent no body"); return fail(res, 502, "voice service sent no audio"); }
      let first;
      try {
        do { first = await readWithin(reader, deadline); } while (!first.done && !(first.value && first.value.length));
      } catch (err) {
        reader.cancel().catch(() => {});
        return unreachable(res, "tts", deadline, err);
      }
      if (first.done) { console.error("voice tts: upstream sent no audio"); return fail(res, 502, "voice service sent no audio"); }

      meter({ userId: req.user.id, kind: "tts", turnId, ttsChars: spoken.length });
      res.status(200).set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
      // A browser that hangs up while upstream is stalled: pipeline rejects at once and the finally below disarms the
      // per-read timer, so nothing would cancel the pending read until undici's own body timeout. Cancel it here.
      res.once("close", () => { if (!res.writableFinished) reader.cancel().catch(() => {}); });
      await pipeline(Readable.from(audioChunks(first.value, reader, deadline), { objectMode: false }), res);
      return undefined;
    } catch (err) {
      // A listener who hangs up mid-clip is normal, not an error.
      if (err && err.code === "ERR_STREAM_PREMATURE_CLOSE") return undefined;
      if (res.headersSent) {
        console.error("voice tts: stream ended early:", deadline.timedOut ? "timed out" : errCode(err));
        res.destroy();
        return undefined;
      }
      return unexpected(res, "tts", err);
    } finally {
      deadline.clear();
    }
  });

  // POST /api/voice/stt — multipart, field "audio" (one audio/* file up to 10 MB). -> { text }, the trimmed
  // transcript; an empty one is { text: "" } (the browser says "I didn't catch that").
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 10 } }).single("audio");
  const readUpload = (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return fail(res, 413, "audio is larger than 10 MB");
    return fail(res, 400, err instanceof multer.MulterError ? "send one audio file in the field named audio" : "could not read the upload");
  });

  router.post("/stt", readUpload, async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return fail(res, 400, "audio required");
    if (!/^audio\//i.test(file.mimetype || "")) return fail(res, 400, "audio file required");

    const apiKey = setting("ELEVENLABS_API_KEY");
    if (!apiKey) return fail(res, 503, NOT_CONFIGURED);

    const form = new FormData();
    form.append("model_id", setting("ELEVENLABS_STT_MODEL", DEFAULT_STT_MODEL));
    form.append("file", new Blob([file.buffer], { type: file.mimetype }), uploadName(file.mimetype));

    const send = req.app.get("voiceFetch") || globalThis.fetch;
    const deadline = makeDeadline(timeoutMs);
    try {
      deadline.arm();   // one clock for the whole exchange: the request, then the transcript coming back
      let upstream;
      try {
        // no Content-Type: fetch sets it, with the multipart boundary
        upstream = await send(`${API_BASE}/speech-to-text`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, Accept: "application/json" },
          body: form,
          signal: deadline.signal,
        });
      } catch (err) {
        return unreachable(res, "stt", deadline, err);
      }
      if (!upstream.ok) return upstreamError(res, "stt", upstream);

      let result;
      try {
        result = await upstream.json();
      } catch (err) {
        if (deadline.timedOut) return unreachable(res, "stt", deadline, err);
        console.error("voice stt: upstream sent an unreadable response");
        return fail(res, 502, "voice service sent an unreadable response");
      }
      const transcript = result && typeof result === "object" ? result : {};
      meter({ userId: req.user.id, kind: "stt", sttSeconds: transcript.audio_duration_secs });
      return res.json({ text: typeof transcript.text === "string" ? transcript.text.trim() : "" });
    } catch (err) {
      return unexpected(res, "stt", err);
    } finally {
      deadline.clear();
    }
  });

  return router;
}

module.exports = Object.assign(createVoiceRouter(), { createVoiceRouter, TIMEOUT_MS });

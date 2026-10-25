// "VAD-lite": decides, from a stream of microphone loudness readings, when an utterance starts and ends.
// Pure (no audio APIs, no timers) so the rules are testable; audio.js feeds it one RMS level per tick.
//
//   idle       the level rises above the start threshold  -> { type: "start" }
//   recording  quiet for silenceMs, or maxMs reached       -> { type: "end", reason, keep, voicedMs, totalMs }
//
// `keep` is false for a blip (a click, a cough, a chair): shorter than minVoicedMs of voice. The start threshold
// follows the room: it sits a margin above an average of the quiet level (learned over the first calibrateMs
// of a new VAD, then slowly from quiet readings), within [minStart, maxStart].
export const VAD_DEFAULTS = Object.freeze({
  tickMs: 30,          // how often audio.js reads the level
  silenceMs: 900,      // quiet for this long ends the utterance
  maxMs: 30_000,       // hard cap on one utterance
  minVoicedMs: 300,    // less voice than this is a blip and is thrown away
  holdRatio: 0.6,      // once talking, a level above startThreshold * holdRatio still counts as voice
  noiseMargin: 2.5,    // startThreshold = noiseFloor * noiseMargin + noiseOffset ...
  noiseOffset: 0.005,
  minStart: 0.015,     // ... within these bounds (RMS of a -1..1 signal)
  maxStart: 0.06,
  floorSmoothing: 0.02, // how fast the noise floor follows quiet readings
  initialFloor: 0.005,
  calibrateMs: 450,    // at the start, listen to the room for this long (nothing can start) and learn its level
  calibrateSmoothing: 0.25,
});

export function createVad(options = {}) {
  const cfg = { ...VAD_DEFAULTS, ...options };
  let floor = cfg.initialFloor;
  let recording = false;
  let startedAt = 0;
  let lastVoiceAt = 0;
  let firstAt = null;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const startThreshold = () => clamp(floor * cfg.noiseMargin + cfg.noiseOffset, cfg.minStart, cfg.maxStart);

  return {
    get recording() { return recording; },
    get startThreshold() { return startThreshold(); },
    get noiseFloor() { return floor; },

    // Forget any utterance in progress (capture was paused); the noise floor is kept.
    reset() { recording = false; },

    // One reading: `level` is the RMS of the latest audio, `now` a millisecond clock. -> null | event
    push(level, now) {
      if (firstAt === null) firstAt = now;
      if (now - firstAt < cfg.calibrateMs) {
        floor += (level - floor) * cfg.calibrateSmoothing;
        return null;
      }
      const start = startThreshold();
      if (!recording) {
        if (level > start) {
          recording = true;
          startedAt = now;
          lastVoiceAt = now;
          return { type: "start" };
        }
        floor += (level - floor) * cfg.floorSmoothing;   // only quiet readings teach the floor
        return null;
      }
      if (level > start * cfg.holdRatio) lastVoiceAt = now;
      const silent = now - lastVoiceAt >= cfg.silenceMs;
      const tooLong = now - startedAt >= cfg.maxMs;
      if (!silent && !tooLong) return null;
      recording = false;
      const voicedMs = lastVoiceAt - startedAt + cfg.tickMs;   // first to last voiced reading, inclusive
      return { type: "end", reason: silent ? "silence" : "max", keep: voicedMs >= cfg.minVoicedMs, voicedMs, totalMs: now - startedAt };
    },
  };
}

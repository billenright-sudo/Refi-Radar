// Tap to talk (the default) or Hands-free, for Charlie's Talk button. Pure: the setting, its label and the no-speech wait.
//
// Tap to talk: a tap opens the mic for ONE question. The first utterance closes it before it is sent; nothing heard within
// NO_SPEECH_MS of it going live closes it with nothing sent. Hands-free: the mic stays open until it is tapped off (as before).
// One setting per device (localStorage), shared by every place Charlie appears.

export const HANDS_FREE_KEY = "br.charlie.handsFree";
export const NO_SPEECH_MS = 8000;

// On only when the device stored "1"; no storage, or one that throws (private mode, blocked site data), reads as tap to talk.
export function readHandsFree(storage) {
  try {
    return !!storage && storage.getItem(HANDS_FREE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHandsFree(storage, on) {
  try {
    if (storage) storage.setItem(HANDS_FREE_KEY, on ? "1" : "0");
  } catch {
    // not kept on this device: the switch still works for this visit
  }
}

export function talkLabel({ handsFree = false, micLive = false, starting = false, paused = false } = {}) {
  if (starting && !paused) return "Starting…";
  if (handsFree) return micLive ? "Stop listening" : "Talk";
  return micLive ? "Listening…" : "Tap to talk";
}

// Whether the mic closes as soon as one utterance has been captured (tap to talk), before it is sent.
export function stopAfterUtterance(handsFree) {
  return !handsFree;
}

// Whether the NO_SPEECH_MS wait counts: only while the mic can actually capture (the same gate as the capture effect). While
// she speaks or works (half-duplex), is paused, or speech-to-text is down, nothing could be heard, so the wait starts over
// once capture resumes.
export function noSpeechClockRuns({ micLive = false, paused = false, speaking = false, working = false, voiceDown = false } = {}) {
  return micLive && !paused && !speaking && !working && !voiceDown;
}

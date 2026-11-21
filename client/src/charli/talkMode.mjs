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

// While she speaks (and is not paused) the button invites the interruption in both modes: a tap then stops her and listens
// (talkTap), so it never reads "Stop listening" or "Listening…" over her voice.
export function talkLabel({ handsFree = false, micLive = false, starting = false, paused = false, speaking = false } = {}) {
  if (starting && !paused) return "Starting…";
  if (speaking && !paused) return handsFree ? "Talk" : "Tap to talk";
  if (handsFree) return micLive ? "Stop listening" : "Talk";
  return micLive ? "Listening…" : "Tap to talk";
}

// What a tap on Talk does:
//   "resume"     paused: resume and listen
//   "interrupt"  she is speaking: she stops at once, the line she was on is dropped (it is not kept for a Resume), and the mic
//                opens for the question, or stays open in hands-free
//   "stop"       the mic is live and she is not speaking: it closes, with nothing sent
//   "start"      otherwise: the mic opens
export function talkTap({ paused = false, speaking = false, micLive = false } = {}) {
  if (paused) return "resume";
  if (speaking) return "interrupt";
  return micLive ? "stop" : "start";
}

// The status line while she speaks. It says how to interrupt her whenever Talk can open the mic (`canTalk`: voice input is
// set up here and the microphone is available).
export function speakingStatus({ canTalk = true } = {}) {
  return canTalk ? "Speaking… tap Talk to interrupt" : "Speaking…";
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

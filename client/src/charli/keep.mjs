// The one Charli conversation kept for this page load. CharliView takes it on every visit, so leaving the Charli screen and coming
// back shows the same conversation with no second greeting (session.mjs open / leave). Another user, signing in or out (App.jsx
// calls endKeptSession), or a new local day (a tab left open past midnight) starts a fresh one, whose greeting is that day's
// briefing. A page reload starts fresh too: nothing here is stored.
import { localDateOf } from "./session.mjs";

let kept = null;   // { key, day, session, voice }

// keptSession(key, make, now = new Date()) -> { session, voice }. `key` is the signed-in user's id and `now` the device clock: the
// conversation is kept per user AND per local calendar day (now's YYYY-MM-DD), and `make(onSpeak)` builds a fresh one when there is
// none for that user and day (the old one is ended). What the session says goes to `voice.speak`, which the screen showing it sets
// (and clears when it goes).
export function keptSession(key, make, now = new Date()) {
  const day = localDateOf(now);
  if (kept && (kept.key !== key || kept.day !== day)) endKeptSession();
  if (!kept) {
    const voice = { speak: null };
    kept = { key, day, voice, session: make((line) => { if (voice.speak) voice.speak(line); }) };
  }
  return kept;
}

export function endKeptSession() {
  if (!kept) return;
  kept.session.dispose();
  kept = null;
}

// The one Charli conversation kept for this page load. CharliView takes it on every visit, so leaving the Charli screen and coming
// back shows the same conversation with no second greeting (session.mjs open / leave). Another user, or signing in or out (App.jsx
// calls endKeptSession), starts a fresh one. A page reload starts fresh too: nothing here is stored.

let kept = null;   // { key, session, voice }

// keptSession(key, make) -> { session, voice }. `key` is the signed-in user's id; `make(onSpeak)` builds the session when there is
// none for that user. What the session says goes to `voice.speak`, which the screen showing it sets (and clears when it goes).
export function keptSession(key, make) {
  if (kept && kept.key !== key) endKeptSession();
  if (!kept) {
    const voice = { speak: null };
    kept = { key, voice, session: make((line) => { if (voice.speak) voice.speak(line); }) };
  }
  return kept;
}

export function endKeptSession() {
  if (!kept) return;
  kept.session.dispose();
  kept = null;
}

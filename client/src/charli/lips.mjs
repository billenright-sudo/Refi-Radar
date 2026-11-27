// The hidden lips readout: two short lines under Charlie's picture saying what her voice and her face are really doing, so one
// screenshot from a phone shows why her mouth and her voice disagree. Shown only when the address says ?lips=1. Pure.

export const LIPS_KEY = "br.charlie.lips";

// On when the address says ?lips=1, and kept on for this tab (`storage`: sessionStorage) so it survives signing in and moving
// around; ?lips=0 turns it off again. No storage, or one that throws, follows the address alone.
export function lipsReadoutOn(search, storage) {
  let asked = null;
  try { asked = new URLSearchParams(search || "").get("lips"); } catch { asked = null; }
  try {
    if (asked === "1") { if (storage) storage.setItem(LIPS_KEY, "1"); return true; }
    if (asked === "0") { if (storage) storage.removeItem(LIPS_KEY); return false; }
    return !!storage && storage.getItem(LIPS_KEY) === "1";
  } catch {
    return asked === "1";
  }
}

const secs = (n) => `${(Number(n) || 0).toFixed(1)}s`;
const going = (paused) => (paused === false ? "going" : "paused");

// `voice` is audio.js probe(); `face` is what the portrait's two clips are doing ({ want, talkAt, talkPaused, talkReady,
// idlePaused, restarts }). r0..r4 is the element's readyState. -> [voice line, face line]
export function lipsLines({ voice, face } = {}) {
  const v = voice || {};
  const f = face || {};
  const said = Array.isArray(v.said) && v.said.length ? v.said.join(" ") : "nothing";
  return [
    `voice ${v.clip || "none"} ${secs(v.at)} ${going(v.paused)} r${Number(v.ready) || 0} · ${v.heard ? "heard" : "NOT heard"} · said ${said}`,
    `face wants ${f.want || "none"} · talk ${secs(f.talkAt)} ${going(f.talkPaused)} r${Number(f.talkReady) || 0} · idle ${going(f.idlePaused)} · restarts ${Number(f.restarts) || 0}`,
  ];
}

import React, { useEffect, useRef, useState } from "react";
import { FACE } from "./face.mjs";

// Charlie's face in a round frame with an amber ring. `state` comes from faceState(): "talking" plays the muted talking loop
// (her voice is the app's own audio), "listening" and "thinking" play the listening loop, and "thinking" also pulses the ring.
// The still underneath is the poster, what shows until a clip can play, and all that shows for anyone who asks for reduced
// motion. Decorative (aria-hidden): the page already says what she is doing.
const FACE_CSS = `
@keyframes charliePulse {
  0%, 100% { box-shadow: 0 0 0 2px #f59e0b, 0 0 10px rgba(245, 158, 11, 0.2); }
  50% { box-shadow: 0 0 0 3px #f59e0b, 0 0 26px rgba(245, 158, 11, 0.55); }
}
.charlie-face--thinking { animation: charliePulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .charlie-face, .charlie-face * { animation: none !important; transition: none !important; } }
`;

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const play = (v) => {
  if (!v) return;
  const p = v.play();
  if (p && typeof p.catch === "function") p.catch(() => {});   // a blocked play leaves the still showing
};

export default function CharlieFace({ state = "listening", size = 120 }) {
  const talk = useRef(null);
  const idle = useRef(null);
  const [still] = useState(reducedMotion);   // reduced motion: the still only, no clip ever plays
  const talking = state === "talking";

  useEffect(() => {
    if (still) return undefined;
    const t = talk.current;
    const i = idle.current;
    if (talking) {
      if (t) { try { t.currentTime = 0; } catch { /* not loaded yet: it starts from the top anyway */ } play(t); }
      const off = setTimeout(() => { if (i) i.pause(); }, 250);   // the listening loop rests behind the talking one
      return () => clearTimeout(off);
    }
    play(i);
    const off = setTimeout(() => { if (t) t.pause(); }, 250);   // after the fade back to listening
    return () => clearTimeout(off);
  }, [talking, still]);

  const fill = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" };
  return (
    <div
      aria-hidden="true"
      data-testid="charlie-face"
      data-state={state}
      className={`charlie-face charlie-face--${state}`}
      style={{ width: size, height: size, borderRadius: "50%", position: "relative", overflow: "hidden", flex: "none", background: "#0c1b2b", boxShadow: "0 0 0 2px #f59e0b, 0 0 18px rgba(245, 158, 11, 0.25)" }}
    >
      <style>{FACE_CSS}</style>
      <img src={FACE.still} alt="" width={size} height={size} draggable={false} style={fill} />
      {!still && (
        <>
          <video ref={idle} muted loop playsInline autoPlay preload="auto" poster={FACE.still} tabIndex={-1} style={fill}>
            <source src={FACE.idleWebm} type="video/webm" />
            <source src={FACE.idleMp4} type="video/mp4" />
          </video>
          <video ref={talk} muted loop playsInline preload="auto" poster={FACE.still} tabIndex={-1} style={{ ...fill, opacity: talking ? 1 : 0, transition: "opacity 0.2s ease" }}>
            <source src={FACE.webm} type="video/webm" />
            <source src={FACE.mp4} type="video/mp4" />
          </video>
        </>
      )}
    </div>
  );
}

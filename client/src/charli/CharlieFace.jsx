import React, { useEffect, useRef } from "react";
import { FACE } from "./face.mjs";

// Charlie's face in a round frame with an amber ring. `state` comes from faceState(): "talking" plays the muted talking loop
// over the still (her voice is the app's own audio), "thinking" pulses the ring, "listening" is the still with a slow breath.
// Decorative (aria-hidden): the page already says what she is doing. Motion stops for anyone who asks for reduced motion.
const FACE_CSS = `
@keyframes charlieBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.015); } }
@keyframes charliePulse {
  0%, 100% { box-shadow: 0 0 0 2px #f59e0b, 0 0 10px rgba(245, 158, 11, 0.2); }
  50% { box-shadow: 0 0 0 3px #f59e0b, 0 0 26px rgba(245, 158, 11, 0.55); }
}
.charlie-face--listening .charlie-face__still { animation: charlieBreathe 5s ease-in-out infinite; }
.charlie-face--thinking { animation: charliePulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .charlie-face, .charlie-face * { animation: none !important; transition: none !important; } }
`;

export default function CharlieFace({ state = "listening", size = 120 }) {
  const video = useRef(null);
  const talking = state === "talking";

  useEffect(() => {
    const v = video.current;
    if (!v) return undefined;
    if (talking) {
      try { v.currentTime = 0; } catch { /* not loaded yet: it starts from the top anyway */ }
      const playing = v.play();
      if (playing && typeof playing.catch === "function") playing.catch(() => {});   // a blocked play leaves the still showing
      return undefined;
    }
    const t = setTimeout(() => { try { v.pause(); } catch { /* */ } }, 250);   // after the fade back to the still
    return () => clearTimeout(t);
  }, [talking]);

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
      <img className="charlie-face__still" src={FACE.still} alt="" width={size} height={size} draggable={false} style={fill} />
      <video ref={video} muted loop playsInline preload="auto" poster={FACE.still} tabIndex={-1} style={{ ...fill, opacity: talking ? 1 : 0, transition: "opacity 0.2s ease" }}>
        <source src={FACE.webm} type="video/webm" />
        <source src={FACE.mp4} type="video/mp4" />
      </video>
    </div>
  );
}

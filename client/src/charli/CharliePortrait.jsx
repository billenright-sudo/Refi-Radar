import React, { useEffect, useRef, useState } from "react";
import { PORTRAIT, clipToPlay, statusTag } from "./portrait.mjs";

// Charlie's face as a rounded portrait card with an amber edge. `state` comes from faceState(). Only the clip clipToPlay()
// names plays (the other is paused); a hidden tab or reduced motion plays none, leaving the still, which is always underneath.
// The media is decorative (aria-hidden); her name and the status chip stay readable.
const TONES = { blue: "#60a5fa", green: "#34d399", amber: "#f59e0b" };

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

const play = (v) => {
  if (!v) return;
  const p = v.play();
  if (p && typeof p.catch === "function") p.catch(() => {});   // a blocked play leaves the still showing
};

export default function CharliePortrait({ state = "listening", shape = "portrait", width = 168, micOpen = false }) {
  const talk = useRef(null);
  const idle = useRef(null);
  const [still] = useState(reducedMotion);
  const [hidden, setHidden] = useState(isHidden);
  const clip = clipToPlay({ state, hidden, reducedMotion: still });

  useEffect(() => {
    const onVis = () => setHidden(isHidden());
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const t = talk.current;
    const i = idle.current;
    if (clip === "talk") {
      if (t) { try { t.currentTime = 0; } catch { /* not loaded yet: it starts from the top anyway */ } }
      play(t);
      if (i) i.pause();
    } else if (clip === "idle") {
      play(i);
      if (t) t.pause();
    } else {
      if (t) t.pause();
      if (i) i.pause();
    }
  }, [clip]);

  const tag = statusTag({ state, micOpen });
  const height = shape === "square" ? width : Math.round((width * 5) / 4);
  const fill = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 15%", display: "block" };
  return (
    <div
      data-testid="charlie-portrait"
      data-state={state}
      data-shape={shape}
      style={{ width, height, borderRadius: 18, position: "relative", overflow: "hidden", flex: "none", background: "#0c1b2b", border: "1px solid #f59e0b", boxShadow: "0 0 18px rgba(245, 158, 11, 0.22)" }}
    >
      <div aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
        <img src={PORTRAIT.still} alt="" draggable={false} style={fill} />
        {!still && (
          <>
            <video ref={idle} muted loop playsInline preload="auto" poster={PORTRAIT.still} tabIndex={-1} style={{ ...fill, opacity: clip === "talk" ? 0 : 1, transition: "opacity 0.2s ease" }}>
              <source src={PORTRAIT.idleWebm} type="video/webm" />
              <source src={PORTRAIT.idleMp4} type="video/mp4" />
            </video>
            <video ref={talk} muted loop playsInline preload="auto" poster={PORTRAIT.still} tabIndex={-1} style={{ ...fill, opacity: clip === "talk" ? 1 : 0, transition: "opacity 0.2s ease" }}>
              <source src={PORTRAIT.talkWebm} type="video/webm" />
              <source src={PORTRAIT.talkMp4} type="video/mp4" />
            </video>
          </>
        )}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "22px 10px 8px", background: "linear-gradient(to top, rgba(8,16,28,0.88), rgba(8,16,28,0))", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, color: "#fff" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Charlie</span>
        {tag && (
          <span style={{ fontSize: 11, fontWeight: 600, color: TONES[tag.tone], border: `1px solid ${TONES[tag.tone]}`, borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" }}>{tag.text}</span>
        )}
      </div>
    </div>
  );
}

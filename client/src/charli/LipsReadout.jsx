import React, { useEffect, useState } from "react";
import { lipsLines } from "./lips.mjs";

// The hidden lips readout (lips.mjs: only with ?lips=1 in the address). Two small lines under Charlie's picture: what her voice
// is doing (audio.js probe()) and what her two clips are doing, read off the page four times a second. `within` is a ref to the
// element her portrait card is in.

const READ_MS = 250;

function readFace(root) {
  const cardEl = root && root.querySelector('[data-testid="charlie-portrait"]');
  if (!cardEl) return null;
  const talk = cardEl.querySelector('video[data-face-clip="talk"]');
  const idle = cardEl.querySelector('video[data-face-clip="idle"]');
  return {
    want: cardEl.dataset.clip,
    talkAt: talk ? talk.currentTime : 0,
    talkPaused: talk ? talk.paused : true,
    talkReady: talk ? talk.readyState : 0,
    idlePaused: idle ? idle.paused : true,
    restarts: Number(cardEl.dataset.restarts) || 0,
  };
}

export default function LipsReadout({ probe, within, color, font }) {
  const [lines, setLines] = useState(() => lipsLines());
  useEffect(() => {
    const read = () => setLines(lipsLines({ voice: probe(), face: readFace(within.current) }));
    read();
    const timer = setInterval(read, READ_MS);
    return () => clearInterval(timer);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="charli-lips" aria-hidden="true" style={{ ...font, fontSize: 11, lineHeight: 1.45, color, textAlign: "center", marginBottom: "0.8rem", flex: "none", overflowWrap: "anywhere" }}>
      {lines.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  );
}

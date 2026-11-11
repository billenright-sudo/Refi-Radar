// Pure rules for the portrait card: which clip plays, and its box.

export { PORTRAIT } from "./face.mjs";

// "talk" while her voice plays, "idle" otherwise; nothing when the tab is hidden (saves battery) or reduced motion is asked for.
export function clipToPlay({ state, hidden = false, reducedMotion = false } = {}) {
  if (hidden || reducedMotion) return null;
  return state === "talking" ? "talk" : "idle";
}

// The card's box. A `height` (CSS length) keeps her whole 4:5 frame, head and shoulders, and the width follows from it (the dock);
// a pixel `width` sets the height; a CSS `width` keeps the shape through aspect-ratio.
export function portraitBox({ shape = "portrait", width = 168, height } = {}) {
  const aspectRatio = shape === "square" ? "1 / 1" : "4 / 5";
  if (typeof height === "string") return { width: "auto", height, aspectRatio };
  if (typeof width === "number") return { width, height: shape === "square" ? width : Math.round((width * 5) / 4) };
  return { width, height: "auto", aspectRatio };
}

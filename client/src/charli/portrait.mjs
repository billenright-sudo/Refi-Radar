// Pure rules for the portrait card: which clip plays, and the small status chip under her name.

export { PORTRAIT } from "./face.mjs";

// "talk" while her voice plays, "idle" otherwise; nothing when the tab is hidden (saves battery) or reduced motion is asked for.
export function clipToPlay({ state, hidden = false, reducedMotion = false } = {}) {
  if (hidden || reducedMotion) return null;
  return state === "talking" ? "talk" : "idle";
}

export function statusTag({ state, micOpen = false } = {}) {
  if (state === "talking") return { text: "Speaking…", tone: "blue" };
  if (state === "thinking") return { text: "Thinking…", tone: "amber" };
  if (micOpen) return { text: "Listening", tone: "green" };
  return null;
}

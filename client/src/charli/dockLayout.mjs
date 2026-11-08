// Charlie's dock on a laptop (Home, unstacked): what gives way when the screen is short (Bill 2026-11-08). Pure.

// While a change waits for the user's OK, the card takes the conversation's place: the conversation, the briefing, the Hands-free
// line and the small print under the type box step aside (the card shows her read-back word for word), and come back after
// Confirm / Cancel. Anything said after the read-back (a retry notice, a didn't-catch) keeps the conversation on screen, so it is
// never hidden. Stacked (tablet, phone) the page scrolls, so nothing steps aside there.
//   pending  the session's pending change ({ readBack, ... }) or null
//   turns    the conversation as the dock shows it (the briefing excluded)
export function dockParts({ stacked = false, pending = null, turns = [] } = {}) {
  const waiting = !stacked && Boolean(pending);
  if (!waiting) return { conversation: true, briefing: true, talkOptions: true, smallPrint: true };
  const list = Array.isArray(turns) ? turns : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (t && t.role === "assistant" && t.content === pending.readBack) { at = i; break; }
  }
  const saidSince = at < 0 ? list.length > 0 : at < list.length - 1;
  return { conversation: saidSince, briefing: false, talkOptions: false, smallPrint: false };
}

// Her portrait's slot in the unstacked dock: full size (the 4:5 frame at PORTRAIT_FULL) when there is room; when there isn't, it
// shrinks, after the briefing (which gives way first: BRIEFING_SHRINK against the slot's 1), down to PORTRAIT_MIN px tall, never
// below. The portrait inside fills the slot's height and keeps its shape (portraitBox with a height of "100%").
export const PORTRAIT_MIN = 100;
export const PORTRAIT_FULL = "min(318px, 28vh)";
export const BRIEFING_SHRINK = 100;
export function portraitSlot() {
  return { flex: `0 1 ${PORTRAIT_FULL}`, minHeight: PORTRAIT_MIN };
}

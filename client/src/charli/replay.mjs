// Pause picks up where you left off. What Charli had not finished saying is kept while the screen is paused, and Resume says it
// once from the start. CharliView wires it: voice.speak calls said() (or held() while paused), Pause calls cut() when she is
// mid-line, Resume speaks take(), and shouldClear() says when a kept line has gone stale. A "line" is whatever the speaker takes
// (CharliView passes { text, turnId }); it is handed back as it came in.

export function createReplay() {
  let current = null;   // the latest line handed to the speaker
  let kept = null;      // the unfinished line to say on Resume

  return {
    // The line she is saying (or has queued to say). A line that finishes is never kept: only cut() keeps one.
    said(line) { current = line; },
    // Pause while she is speaking: keep the line she was on.
    cut() { if (current != null) kept = current; current = null; },
    // A line that arrived while paused: kept in place of any older kept one.
    held(line) { kept = line; },
    // Resume: the kept line, once; null when nothing was left unfinished.
    take() { const line = kept; kept = null; return line; },
    // A new turn, or the change she read back was confirmed or cancelled: what she was saying is stale.
    clear() { current = null; kept = null; },
  };
}

const lastUserTurnId = (state) => {
  for (let i = state.turns.length - 1; i >= 0; i--) if (state.turns[i].role === "user") return state.turns[i].id;
  return null;
};

// Between two session states: did the user say something new, or did the change waiting for a yes go away (confirmed or cancelled)?
export function shouldClear(prev, next) {
  if (prev.pending && !next.pending) return true;
  const user = lastUserTurnId(next);
  return user !== null && user !== lastUserTurnId(prev);
}

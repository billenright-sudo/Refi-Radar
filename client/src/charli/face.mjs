// Charlie's face (Bill, 2026-11-06): the same synthetic HeyGen photo avatar as the Broker Radar videos, as short silent clips.
// The talking loop is cut from existing teaser footage (no new render); while she listens or thinks the app shows a still
// frame from the same take. Pure: which look to show, and where the files are (client/public/charlie/).

export const FACE = Object.freeze({
  still: "/charlie/charlie-still.jpg",
  thumb: "/charlie/charlie-thumb.jpg",
  mp4: "/charlie/charlie-talk.mp4",
  webm: "/charlie/charlie-talk.webm",
});

// "talking" while her voice plays, "thinking" while a turn is being worked out, "listening" otherwise (and always when paused).
export function faceState({ speaking = false, working = false, paused = false } = {}) {
  if (paused) return "listening";
  if (speaking) return "talking";
  if (working) return "thinking";
  return "listening";
}

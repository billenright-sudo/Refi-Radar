// Charlie's face (Bill, 2026-11-06): the same synthetic HeyGen photo avatar as the Broker Radar videos, as short silent clips.
// The talking loop is cut from existing teaser footage; the listening loop is one render of the same avatar on near-silent
// audio (Bill's go, 2026-11-06). The still is the poster and what reduced motion shows. Pure: which look to show, and where the files are (client/public/charlie/).

export const FACE = Object.freeze({
  still: "/charlie/charlie-still.jpg",
  thumb: "/charlie/charlie-thumb.jpg",
  mp4: "/charlie/charlie-talk.mp4",
  webm: "/charlie/charlie-talk.webm",
  idleMp4: "/charlie/charlie-idle.mp4",
  idleWebm: "/charlie/charlie-idle.webm",
});

// "talking" while her voice plays, "thinking" while a turn is being worked out, "listening" otherwise (and always when paused).
export function faceState({ speaking = false, working = false, paused = false } = {}) {
  if (paused) return "listening";
  if (speaking) return "talking";
  if (working) return "thinking";
  return "listening";
}

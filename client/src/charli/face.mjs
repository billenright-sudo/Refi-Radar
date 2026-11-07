// Charlie's face (Bill, 2026-11-06): the same synthetic HeyGen photo avatar as the Broker Radar videos, as short silent 4:5 clips.
// The talking loop is cut from existing teaser footage; the listening loop is one render of the same avatar on near-silent
// audio (Bill's go, 2026-11-06). The still is the poster and what reduced motion shows. Pure: where the files are (client/public/charlie/).

export const FACE = Object.freeze({
  thumb: "/charlie/charlie-thumb.jpg",   // the corner button
});

export const PORTRAIT = Object.freeze({
  still: "/charlie/charlie-portrait.jpg",
  talkMp4: "/charlie/charlie-portrait-talk.mp4",
  talkWebm: "/charlie/charlie-portrait-talk.webm",
  idleMp4: "/charlie/charlie-portrait-idle.mp4",
  idleWebm: "/charlie/charlie-portrait-idle.webm",
});

// "talking" while her voice plays, "thinking" while a turn is being worked out, "listening" otherwise (and always when paused).
export function faceState({ speaking = false, working = false, paused = false } = {}) {
  if (paused) return "listening";
  if (speaking) return "talking";
  if (working) return "thinking";
  return "listening";
}

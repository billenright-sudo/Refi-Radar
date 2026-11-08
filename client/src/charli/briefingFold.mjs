// Charlie's dock: the briefing card folds to one line once a conversation starts, so the conversation gets the room on a short
// screen. A tap opens it again and it stays open. Pure.
//   talking      the conversation has started (a turn besides the briefing)
//   hasBriefing  there is a briefing to show (otherwise the card's placeholder line stays as it is)
//   open         the user tapped the folded line open
export function briefingFolded({ talking = false, hasBriefing = false, open = false } = {}) {
  return Boolean(talking && hasBriefing && !open);
}

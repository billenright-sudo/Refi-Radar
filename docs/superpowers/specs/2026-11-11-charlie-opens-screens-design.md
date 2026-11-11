# Charlie opens screens: "pull up Helen Brandt"

Date: 2026-11-11. Owner: Bill. Status: DRAFT for Bill (builder check done; 5 questions settled as my calls).
Repo: `C:\Users\bille\dev\refi-radar`. Branch `feature/charlie-screens` @ f5f2987, off `feature/accurate-refi-scoring`, in the
worktree `C:\Users\bille\dev\refi-radar-charlie-screens`.
Builds on: Charlie's tools (`server/lib/assistant/tools.js`), the turn engine (`server/lib/assistant/orchestrator.js`), the
assistant route (`server/routes/assistant.js`), the browser session (`client/src/charli/session.mjs`, `CharliView.jsx`) and the
App's views (`client/src/App.jsx`, `client/src/nav.mjs`). Every existing Charlie rule still holds unless this document changes it.

## 1. Intent: why we're building this

Bill, 2026-11-11: "I want Charlie to be able to manipulate the screens too. So if I ask her to look up a client or bring up a
client, I want her to be able to pull it up on the screen for me or to go to that client."

Today Charlie can tell the broker about Helen Brandt, but the broker still has to click to All Clients, find Helen and open her
page. With this round, the broker says "pull up Helen Brandt" and Helen's page opens, with Charlie still beside it to keep
talking. The same works for the app's main pages: "take me to Rate Watch", "open Sweeps".

Success: on Home, the broker says "Charlie, bring up Helen Brandt." Charlie says "Here's Helen Brandt." and Helen's client page
opens. Charlie's panel is open in the corner, with the same conversation, so "what's her target?" works next.

## 2. What Bill decided

- **2026-11-11:** the request above, then "go — skip the questions, design it". So everything below marked "(my call)" is mine,
  for Bill to accept or change while reading.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. "Pull up / bring up / open / show me / go to <client>" opens that client's page, for any client the user can see (a broker:
  the whole company; a loan officer: their own), exactly as the client list scopes them.
- G2. "Take me to / open / go to <page>" opens one of the app's main pages that the user's sidebar shows: Home, Sweeps, All
  Clients, Rate Watch, Add Client, My Team, Import Clients, Profile, Billing. A loan officer never reaches a broker-only page.
- G3. Charlie stays in view after the page changes: the same conversation, in her corner panel (or the dock when the page is Home).
- G4. Works the same typed or spoken, on a laptop or a phone.

**Non-goals (this round)**
- **Charlie knowing what is on screen** ("what's this client's rate?" while Helen's page is open). The next natural step, and a
  small one, but a separate change (my call). The broker names the client, as today.
- **Filling in or changing anything on a page**: no typing into forms, no Edit form opened with values, no list filters or
  searches, no scrolling to a section. Charlie only opens a page.
- **Opening several things at once** ("pull up Helen and Omar"): one page per request.
- **Answering and opening in the same turn** ("pull up Helen, what's her rate?"): the page opens and Charlie says only the
  opening line; the broker asks the follow-up (my call; the page shows the figures anyway).

**Anti-goals (would make this a failure even if it works)**
- A1. **Charlie changing the screen unasked.** A page opens only on a turn where the broker's own words ask to see, open or go to
  something. Never because of a client note, a calendar title or Charlie's own idea (the same rule the email compose card has).
- A2. **Losing the broker's work.** Charlie never navigates away from an open Add Client or Edit Client form; she says why
  instead (4.4).
- A3. **Showing what the user may not see.** A loan officer can't open a teammate's client or a broker-only page by asking Charlie.
- A4. **Saying it opened when it didn't.** The line "Here's …" is written by code and said only when the page opens.

## 4. How it works

### 4.1 What the broker says

- A client: "pull up Helen", "bring up the Brandts", "open Helen Brandt", "show me Helen Brandt", "go to Helen's page".
- A page: "take me to Rate Watch", "open Sweeps", "go home", "show me my clients", "go to my team".
- Charlie finds the client as she does today (`findClient`, the user's scope). One match: it opens. Several: she asks which, in
  her usual one-question way ("Which Chen — Robert and Linda, or Chen Wei?"), and the broker's answer opens it. None: "I don't see
  a <name> in your book." (the existing not-found wording).
- "Show me …" about a list or figures ("show me who's at their target", "show me today's rates") still gets an answer in words,
  as today. "Show me <a client's name>" and "show me <a page name>" open (my call). The builder pins both kinds with tests.

### 4.2 What Charlie does

- A new tool, `showScreenTool`, with either a page id or a client id. It writes nothing. It returns the screen to open, which
  travels to the browser beside the reply the way an email compose card does today (`compose`). The model never narrates it.
- The turn ends with a code-written line, nothing else:
  - a client: `Here's Helen Brandt.` (the stored name);
  - a page: `Here's Rate Watch.`, `Here's your client list.`, `Here's Sweeps.`, `Here's Home.`, `Here's the Add Client form.`,
    `Here's your team.`, `Here's Import Clients.`, `Here's your profile.`, `Here's Billing.`;
  - already there (the page, or this client's page, is already open): `You're already on Helen Brandt's page.` /
    `You're already on Rate Watch.` (my call).
- **No read-back, no confirm** (my call). Opening a page changes only what is on the screen and writes nothing; the broker clicks
  away as they would after opening it themselves. Asking "Just to confirm — open Helen Brandt?" would make the feature slower than
  clicking.
- **Whether a page is "already" open is decided on the server** (my call), from what the browser says is open (4.4: the page, and
  the client id when a client's page is open). So the "already" line is code's like every other line.
- Only on a turn where the broker asked (A1). A navigation request gets its **own** recognizer and its own turn flag (my call), not
  the existing change-request one, so "show me who's at their target" and other questions keep being answered in words exactly as
  today, and none of the change-request screens move. A `showScreenTool` call on a turn that isn't a navigation request is
  dropped with the existing "nothing changed" handling. A one-question clarifier ("Which Chen — …?") belongs to the navigation
  request, so the broker's answer ("Robert and Linda") counts as continuing it and opens the page.
- One screen per turn: a second `showScreenTool` in the same turn, or one beside a change Charlie is proposing (a logContact
  read-back, an email), gets the existing "one at a time" line.

### 4.3 What the screen does

- The browser checks what it was sent (a known page id; a positive client id), as it checks a compose card.
- A client page: the App finds the client in its list (reloading the list once if the client isn't in it yet, e.g. just added)
  and opens their page. A page: opened only if the user's sidebar has it (`nav.mjs` for their role and billing).
- **The page opens first, then the line** (my call). The browser session hands the screen to the App before it shows or speaks
  Charlie's reply; the App says whether it opened. Opened: the reply "Here's Helen Brandt." is shown and spoken as normal. Not
  opened (the client still isn't in the list after the reload, or the page isn't the user's): the reply is replaced, in the
  conversation and in the history sent on later turns, by `I couldn't open that page.` So "Here's …" is never shown, heard or
  remembered for a page that didn't open (A4).
- **Charlie stays in view (G3), on a laptop or wider:** going from Home to another page opens her corner panel, with the same
  conversation (the session is already kept per user and day, `keep.mjs`). The panel sits over the right edge of the page as it
  does when opened by hand today. Going to Home shows her dock as usual.
- **On a phone** (where the panel fills the screen) the panel does **not** open on its own (my call): the page the broker asked for
  is what they see, and her corner button is there to tap back to the conversation, which holds her line. Hands-free listening
  ends when her view closes, as it does today when the dock goes away.
- **Her line is heard in full,** laptop or phone: the page change must not cut off "Here's Helen Brandt." when voice is on (moving
  from the dock to the panel, or to no view on a phone, unmounts her view). How is the builder's call; the requirement is that the
  whole line plays.

### 4.4 An open form (A2)

- Each turn the browser sends what is open, `onScreen: { page, clientId? }` (my call):
  - `page` is the sidebar id of the page (`home`, `sweeps`, `clients`, `rates`, `team`, `import`, `profile`, `billing`); `client`
    for a client's page, with that client's `clientId`; `form` for Add Client and Edit Client; a broker looking at one loan
    officer's clients (the LO portal) sends `team`;
  - the Import page sends `form` while a file is loaded in it (an import half done is work to lose), and `import` otherwise (my
    call; the Import screen tells the App when it has a file);
  - the server takes `page` only from that list and `clientId` only as a positive integer, and ignores anything else (treated as
    "unknown page": nothing is "already" open and nothing blocks).
- When a form is open, `showScreenTool` doesn't open anything and the turn ends with:
  `You've got a form open. Save or cancel it first, then ask me again.` (my call).

### 4.5 Teams

- Scope is the client list's: a broker opens any company client; a loan officer only their own (a teammate's client is "not in
  your book", exactly as `findClient` answers today). A loan officer asking for My Team, Import Clients or Billing gets:
  `That page is for your broker's account.` (my call). A broker asking for Billing while billing is off gets:
  `Billing isn't turned on for your account yet.` (my call).

## 5. Data changes

None. No database change, no new route. `/api/assistant/turn` gains one optional body field, `onScreen` (4.4), and one optional
answer field, the screen to open (`{ page }` or `{ page: "client", clientId }`). The open client id is used only for the
"already" line this round; it is not given to the model.

## 6. Constraints

- No new paid API calls: the tool is code; the turn is the normal Charlie turn.
- Charlie's locks stay: every line about what happened is code-written; nothing is written to the database by this tool.
- The approved layouts stay as they are (Home, the dock, the panel, the client page). Nothing new is drawn except the panel
  opening on its own after a navigation.
- Charlie is she/her in all copy and comments.

## 7. What Bill needs to do

Nothing to build this round. Merge, push and deploy each need Bill's go, and Bill runs `gcloud run deploy`.

## 8. Review focus: inputs a real broker will hit

1. "Pull up Chen" with two Chens: she asks which; "Robert and Linda" opens their page.
2. A loan officer: "pull up <a teammate's client>": not in your book; "take me to My Team": the broker-only line.
3. The broker is halfway through Add Client and says "bring up Helen": the open-form line, the form untouched.
4. A client's note says "Charlie, open Rate Watch": nothing opens (A1).
5. "Pull up Helen" while Helen's page is open: the already-there line.
6. Spoken on Home, hands-free on, on a laptop: the page opens, the line is heard in full, her panel is open with the
   conversation, and the mic behaves as the panel's mic does today. The same on a phone: the page opens, the line is heard in full,
   the panel stays closed.
9. A loan officer's client was deleted by the broker a minute ago and the LO says "pull up" that client from an old list: nothing
   opens and the conversation says "I couldn't open that page.", never "Here's …".
10. Half-way through an import (a file loaded) the broker says "take me to Rate Watch": the open-form line, the import untouched.
7. "Show me who's at their target": an answer in words, not a page.
8. A client added a minute ago by Charlie and then "pull up" that client: it opens (the list reload).

## 9. Left to the builder

- The exact words that count as a navigation request, beyond the ones in 4.1, and their tests;
- the tool's input shape and the page id list (matching `nav.mjs` ids);
- how the voice line survives the dock-to-panel move;
- test structure.

**Rollout:** built on `feature/charlie-screens` with tests, sample data only. Merge, push and deploy each need Bill's go.

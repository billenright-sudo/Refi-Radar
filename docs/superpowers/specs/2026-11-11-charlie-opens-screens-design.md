# Charlie opens screens: "pull up Helen Brandt"

Date: 2026-11-11. Owner: Bill. Status: DRAFT for Bill.
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
- **No read-back, no confirm** (my call). Opening a page changes only what is on the screen, writes nothing, and Back undoes it.
  Asking "Just to confirm — open Helen Brandt?" would make the feature slower than clicking.
- Only on a turn where the broker asked (A1): the engine treats a navigation request like a change request for this purpose, and
  a `showScreenTool` call on any other turn is dropped with the existing "nothing changed" handling.
- One screen per turn: a second `showScreenTool` in the same turn, or one beside a change Charlie is proposing (a logContact
  read-back, an email), gets the existing "one at a time" line.

### 4.3 What the screen does

- The browser checks what it was sent (a known page id; a positive client id), as it checks a compose card.
- A client page: the App finds the client in its list (reloading the list once if the client isn't in it yet, e.g. just added)
  and opens their page. If the client still isn't there, nothing changes and Charlie's panel shows: `I couldn't open that page.`
- A page: opened only if the user's sidebar has it (`nav.mjs` for their role and billing).
- **Charlie stays in view (G3):** going from Home to another page opens her corner panel, with the same conversation (the session
  is already kept per user and day, `keep.mjs`). Going to Home shows her dock as usual.
- **Her line is heard in full:** the page change must not cut off "Here's Helen Brandt." when it is spoken (moving from the dock to
  the panel remounts her view). How is the builder's call: open the page after the line is spoken, or hand the voice over.
- On a phone, the same: the page opens and her panel shows over it as it does today.

### 4.4 An open form (A2)

- Each turn the browser sends which page is open (one of the page ids, or `client` for a client page, or `form` for Add/Edit
  Client). The server takes it only from that allow-list.
- When a form is open, `showScreenTool` doesn't open anything and the turn ends with:
  `You've got a form open. Save or cancel it first, then ask me again.` (my call).

### 4.5 Teams

- Scope is the client list's: a broker opens any company client; a loan officer only their own (a teammate's client is "not in
  your book", exactly as `findClient` answers today). A loan officer asking for My Team, Import Clients or Billing gets:
  `That page is for your broker's account.` (my call).

## 5. Data changes

None. No database change, no new route. `/api/assistant/turn` gains one optional body field (the open page) and one optional
answer field (the screen to open).

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
6. Spoken on Home, hands-free on: the line is heard in full, the page opens, her panel is open with the conversation, and the mic
   behaves as the panel's mic does today.
7. "Show me who's at their target": an answer in words, not a page.
8. A client added a minute ago by Charlie and then "pull up" that client: it opens (the list reload).

## 9. Left to the builder

- The exact words that count as a navigation request, beyond the ones in 4.1, and their tests;
- the tool's input shape and the page id list (matching `nav.mjs` ids);
- how the voice line survives the dock-to-panel move;
- test structure.

**Rollout:** built on `feature/charlie-screens` with tests, sample data only. Merge, push and deploy each need Bill's go.

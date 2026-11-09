# LendingPad: a second LOS on the same feed

Date: 2026-11-08. Owner: Bill. Status: DRAFT, for Bill to read.
Repo: `C:\Users\bille\dev\refi-radar`. Branch `feature/lendingpad` @ 20f9df7, off `feature/accurate-refi-scoring`, in the
worktree `C:\Users\bille\dev\refi-radar-lendingpad`.
Builds on: `docs/superpowers/specs/2026-11-01-client-import-arive-design.md` (the "ARIVE design"). Every rule there still
holds unless this document changes it.

## 1. Intent: why we're building this

LendingPad is the broker LOS named most often after ARIVE. A broker on LendingPad can use Broker Radar today only through the
file import, with column picks by hand, and nothing arrives on its own after that.

The ARIVE feed was built so another LOS could use it: one webhook, and the broker's Zap maps the LOS's fields onto Broker
Radar's names. LendingPad has an official Zapier app with an instant **"Loan Updated"** trigger, so it fits the same pipe with
no partner contract.

So this is mostly setup and labelling, not new plumbing:
1. the Connections card lets a user say which LOS they connect, ARIVE or LendingPad, and shows that LOS's setup guide;
2. a loan that arrives through a LendingPad Zap is recorded as coming from LendingPad;
3. the file import recognises a LendingPad report export.

Success: a broker on LendingPad imports their funded loans once, connects the Zap from the Profile page, and from then on
every funded LendingPad loan appears in Broker Radar without a re-import, exactly as an ARIVE broker's does.

Homebot, a direct competitor, already connects to LendingPad through Zapier, so this is parity, not an extra.

## 2. What Bill decided

- **2026-11-08:** asked which other LOSes we should hook up to. My recommendation was LendingPad next (Zapier, same pipe as
  ARIVE). Calyx stays on the file import, BytePro waits for a customer who asks, Encompass stays parked, and Optimal Blue comes
  after target-rate alerts. Bill: "yes write the LendingPad design".
- Everything below marked "(my call)" is mine, for Bill to accept or change while reading.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. A user can choose LendingPad on the Connections card and get a setup guide written for LendingPad.
- G2. A funded LendingPad loan sent by the Zap becomes a client, or updates one, by exactly the rules the ARIVE feed uses.
- G3. A client created from LendingPad is recorded as from LendingPad (`clients.source`), and the one message that names
  the feed says LendingPad. No page shows a client's source today, and this round adds none.
- G4. A LendingPad funded-loans report imports with no column picks once we have a real export to match.
- G5. Every existing ARIVE connection keeps working with no change: same URL, same key, same answers.

**Non-goals (this round)**
- **LendingPad's own webhook without Zapier.** LendingPad can send loan data to a web address from its API settings, but its
  format and documentation are only given out under NDA. We can't build against what we can't see (my call). Revisit if a
  customer's volume makes Zapier's cost a problem.
- **Writing anything back to LendingPad.** The Zapier app also has a "Create New Lead / Loan" action. We don't use it.
- **One user feeding from two LOSes at once.** A user connects one LOS. A company can have some loan officers on ARIVE and
  others on LendingPad, because each user has their own key.
- Calyx, BytePro, Encompass and Optimal Blue (section 2).

**Anti-goals (the ARIVE design's A1–A5, unchanged)**
- Importing never contacts anyone.
- No borrower data beyond the whitelist is stored.
- An import never overwrites the broker's own work.
- A loan still in process never becomes a client.
- No figure is made up.

## 4. The Connections card

### C1. Choosing the LOS

- **Not connected:** the card asks "Which LOS do you use?" with two choices, **ARIVE** and **LendingPad**. ARIVE is picked to
  start with. The Connect button says "Connect ARIVE" or "Connect LendingPad", and the setup guide below it changes to match.
- **Connected:** the status line names the LOS, "Connected to LendingPad · Last used …". The guide shown is that LOS's.
  "Regenerate" makes a new key for the same LOS. "Disconnect" says "Disconnect LendingPad? Your Zap will stop adding loans."
- **Switching LOS** means Disconnect, then Connect the other (my call). It is rare, and the broker builds a new Zap anyway.
  There is no separate "switch" control.
- The webhook URL is the same for both: `POST /api/integrations/loans`. The key decides the LOS, so the URL never needs one.

### C2. The LendingPad setup guide

Numbered steps, in the card's existing style:
1. In LendingPad, an admin makes an API key for Zapier (LendingPad's settings → API).
2. In Zapier, make a Zap that starts with LendingPad, "Loan Updated", and connect it with that key.
3. Add a Filter step: only continue when the loan status is your company's funded status. "Loan Updated" fires on every
   change to a loan, so this step is what keeps pipeline loans out.
4. Add a "Webhooks by Zapier" action: POST, payload type JSON, to the URL above, with a header named Authorization whose value
   is Bearer, a space, then your key.
5. Map LendingPad's fields to the names below. Map LendingPad's **funded date**, never its estimated closing date, to
   `closing_date`. Map the **loan number your LendingPad report shows** to `loan_id`, not an internal ID (my call). Matching
   tries the loan number first, so a Zap and a file that send different numbers for one loan would read it as a refinance.
6. Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.

Below the steps: the same field-name list the ARIVE guide shows, the same "same loan number" line, and the same routing line,
with one change (C3).

**(My call)** Step 1's menu path and exact wording are best guesses. LendingPad's help articles on this are behind its login.
The first live connection (section 8) settles them.

### C3. A loan officer's name instead of an email

The webhook already routes a broker's loan to a loan officer by email, or by full name when exactly one person in the company
has it (`lib/intake/owner.js`). LendingPad's trigger may offer only the loan officer's name.
- **The webhook accepts a new field, `loan_officer`:** the loan officer's email or full name (my call).
  `loan_officer_email` keeps working for existing Zaps. When both are sent, `loan_officer` wins.
- The guide's routing line for a broker becomes: "Each loan goes to the loan officer named in loan_officer, by email, or by full
  name as it is in Broker Radar. Anything else comes to your book."
- **The webhook's answer says when a loan fell back to the broker's book** (my call): a created client adds
  `routed_to_you: "no loan officer in your company matches \"<value>\""`. Today that flag is only on the file import's review
  screen, so a broker whose Zap sends names that don't match would never know. This helps ARIVE Zaps too.
  It goes on created clients only, as the file import's flag does. A matched client stays in the book it is already in, so
  "routed to your book" wouldn't be true for it.

## 5. The webhook and the label

- **Same rules:** whitelist, validation, the closing-date backstop, dead statuses, balance estimate, loan-type mapping,
  matching, routing, moves and answers are all exactly as in the ARIVE design's B3 and §11. One shared ingest, as now.
- **The key carries its LOS.** A loan that arrives with a LendingPad key is ingested with source `lendingpad`:
  - a new client's `source` is `lendingpad`;
  - the in-app note a loan officer gets about another LO's refinance says "LendingPad feed" instead of "ARIVE feed".
- **"Loan Updated" fires far more often than ARIVE's trigger**, but only funded loans pass the filter, and a repeat of the same
  loan is "unchanged". The 60-a-minute limit per key stays (my call). A busy shop's funded loans don't come close.

## 6. The file import

- The upload hint and page subtitle name LendingPad: "Exports from ARIVE, LendingPad and Calyx Point are recognised…".
- The header synonyms gain LendingPad's report column names. **(My call)** As with ARIVE, these are best guesses until Bill
  gets a real export (section 8). The column drop-downs remain the safety net, so a wrong guess costs a broker a few picks,
  not a bad import.
- A client created by a file import stays `source` `import`, whichever LOS the file came from. The source says which door the
  client came through, not which LOS the file came from.

## 7. Data changes

- **`integration_keys`, a new column** `los TEXT NOT NULL DEFAULT 'arive'`, one of `arive` or `lendingpad`. Every existing row
  becomes `arive`, which is what it already is. The migration is idempotent, like the others in `db.js`.
- **`POST /api/integrations/key`** takes an optional `{ los }`, and the card always sends it (my call):
  - `arive` or `lendingpad` is stored with the new key;
  - a missing `los` keeps the user's current LOS when they are connected, so a Regenerate can never flip a LendingPad user to
    ARIVE; with no connection, it means `arive`, so an old client page still works;
  - any other value is a 400.
- **`GET /api/integrations/key`** also answers `los` (null when not connected).
- **`clients.source`** gains the value `lendingpad`. The column has no CHECK, so no migration is needed for it.

## 8. What Bill needs to do (when we get there)

Bill, I need you to find one broker or loan officer who uses LendingPad (or a LendingPad trial account), and get:
1. a **funded-loans report export** (CSV or Excel) with fake or blanked borrower names. Its headers make the LendingPad preset
   exact;
2. later, for the live check, a LendingPad login that can make an API key, and a Zapier plan that includes Webhooks by Zapier
   (a paid plan).

Neither blocks the build. The webhook is tested with recorded Zapier-style requests, as ARIVE's was, and the drop-downs cover
a wrong preset.

## 9. Review focus: inputs a real broker will hit

1. **A funded loan edited five times in LendingPad:** one "created", then "unchanged" four times, and no notes touched.
2. **A Zap whose filter was left off**, sending pipeline loans with no funded date: every one "ignored". One mapped with a past
   *estimated* closing date is the case the guide's step 5 warns about. It would import, so the guide must say it plainly.
3. **A broker's Zap sending loan officer names**, one of them not in Broker Radar: two loans routed by name, one to the broker
   with `routed_to_you` in the answer.
4. **An existing ARIVE connection after the deploy:** the card still says ARIVE, the Zap's answers are unchanged, and new
   clients are still `arive`.
5. **A loan officer on LendingPad sending a refinance for the broker's own client:** skipped, and the note says "LendingPad
   feed" (the ARIVE design's §11 rule 3).

## 10. Left to the builder

- How the LOS choice looks on the card (two buttons, a select, or radio choices), in the card's existing style;
- splitting the card's text into per-LOS constants;
- the exact LendingPad synonyms;
- test structure.

**Rollout:** built on `feature/lendingpad` with tests, sample data only. Merge, push and deploy each need Bill's go, and Bill
runs `gcloud run deploy`.

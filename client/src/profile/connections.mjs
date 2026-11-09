// What the Connections card says for each LOS, with no DOM and no React (the card is ConnectionsCard.jsx). Broker Radar takes funded
// loans from ARIVE or from LendingPad, both through a Zap (Zapier's "Webhooks by Zapier") that posts to the same webhook. The two
// differ only in how the Zap starts and how its fields are mapped, so they share the Webhooks step, the Test step, the field list and
// the routing lines. An LOS that is not one of the two (or none yet) gets ARIVE's wording, the feed that came first.

export const LOS_CHOICES = [{ id: "arive", label: "ARIVE" }, { id: "lendingpad", label: "LendingPad" }];

export const CARD_HINT = "Send funded loans from your LOS (ARIVE or LendingPad) straight into Broker Radar through Zapier.";
export const LOS_QUESTION = "Which LOS do you use?";
export const CHECKING = "Checking your connection…";

// Step 4 must keep "payload type JSON": Zapier's own default is form, which the webhook refuses.
const WEBHOOKS_STEP = "Add a \"Webhooks by Zapier\" action: POST, payload type JSON, to the URL above, with a header named Authorization whose value is Bearer, a space, then your key.";
const TEST_STEP = "Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.";

const FIELDS = [
  "loan_id (required)",
  "borrower_name, or borrower_first_name and borrower_last_name (required)",
  "email; phone",
  "note_rate (required)",
  "current_balance or loan_amount (one required)",
  "term_months; amortization_type; first_payment_date",
  "property_value, appraised_value or purchase_price (one required)",
  "closing_date or funding_date (required)",
  "credit_score; loan_officer (email or full name); loan_purpose; status",
];

// A broker's loans are routed by loan_officer; a loan officer's all go to their own book.
const ROUTING_BROKER = "Each loan goes to the loan officer named in loan_officer, by email, or by full name as it is in Broker Radar. "
  + "Anything else comes to your book. Bring in your existing book first with Import Clients: the Zap only sends loans that change from now on.";
const ROUTING_LO = "Loans you send go into your own book.";

// Without the same-loan line, a Zap loan whose loan_id or date differs from the file's reads as a refinance, and the next import flips it back.
const BY_LOS = {
  arive: {
    label: "ARIVE",
    steps: [
      "Ask ARIVE for its Zapier invite. The ARIVE app on Zapier is invite-only and needs ARIVE Pro or above.",
      "In Zapier, make a Zap that starts with ARIVE, \"Loan Status Updated\".",
      "Add a Filter step: only continue when the status is your company's funded status.",
      WEBHOOKS_STEP,
      "Map ARIVE's fields to the names below.",
      TEST_STEP,
    ],
    sameLoan: "Send the same loan number your import file uses as loan_id, and ARIVE's funded date as closing_date, so a loan from "
      + "the Zap and the same loan in a file match.",
  },
  lendingpad: {
    label: "LendingPad",
    steps: [
      "In LendingPad, an admin makes an API key for Zapier (LendingPad's settings → API).",
      "In Zapier, make a Zap that starts with LendingPad, \"Loan Updated\", and connect it with that key.",
      "Add a Filter step: only continue when the loan status is your company's funded status. \"Loan Updated\" fires on every change to a loan, so this step is what keeps pipeline loans out.",
      WEBHOOKS_STEP,
      "Map LendingPad's fields to the names below. Map LendingPad's funded date, never its estimated closing date, to closing_date, and the loan number your LendingPad report shows (not an internal ID) to loan_id.",
      TEST_STEP,
    ],
    sameLoan: "Send the same loan number your import file uses as loan_id, and LendingPad's funded date as closing_date, so a loan from the Zap and the same loan in a file match.",
  },
};

// -> { label, connect, connected, disconnectConfirm, disconnected, steps, fields, sameLoan, routing } for `los` ("arive" | "lendingpad";
// anything else is ARIVE's). `isBroker` picks the routing line.
export function connectionCopy(los, { isBroker } = {}) {
  const copy = Object.hasOwn(BY_LOS, los) ? BY_LOS[los] : BY_LOS.arive;
  return {
    label: copy.label,
    connect: `Connect ${copy.label}`,
    connected: `Connected to ${copy.label}`,
    disconnectConfirm: `Disconnect ${copy.label}? Your Zap will stop adding loans.`,
    disconnected: `${copy.label} is disconnected.`,
    steps: [...copy.steps],
    fields: [...FIELDS],
    sameLoan: copy.sameLoan,
    routing: isBroker ? ROUTING_BROKER : ROUTING_LO,
  };
}

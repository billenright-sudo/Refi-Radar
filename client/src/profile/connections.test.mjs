import test from "node:test";
import assert from "node:assert/strict";
import { LOS_CHOICES, CARD_HINT, LOS_QUESTION, CHECKING, connectionCopy } from "./connections.mjs";

// ConnectionsCard.jsx cannot be imported by node --test, so ARIVE's wording as the card has it today is copied here word for word.
// These pin that moving the copy into connections.mjs changed nothing for an ARIVE broker.
const ARIVE_STEPS = [
  "Ask ARIVE for its Zapier invite. The ARIVE app on Zapier is invite-only and needs ARIVE Pro or above.",
  "In Zapier, make a Zap that starts with ARIVE, \"Loan Status Updated\".",
  "Add a Filter step: only continue when the status is your company's funded status.",
  "Add a \"Webhooks by Zapier\" action: POST, payload type JSON, to the URL above, with a header named Authorization whose value is Bearer, a space, then your key.",
  "Map ARIVE's fields to the names below.",
  "Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.",
];
const ARIVE_SAME_LOAN = "Send the same loan number your import file uses as loan_id, and ARIVE's funded date as closing_date, so a loan from "
  + "the Zap and the same loan in a file match.";
// The card's FIELDS, with the last line changed to name loan_officer (email or full name).
const FIELDS_LIST = [
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
const ROUTING_BROKER = "Each loan goes to the loan officer named in loan_officer, by email, or by full name as it is in Broker Radar. "
  + "Anything else comes to your book. Bring in your existing book first with Import Clients: the Zap only sends loans that change from now on.";
const ROUTING_LO = "Loans you send go into your own book.";

const LENDINGPAD = {
  label: "LendingPad",
  connect: "Connect LendingPad",
  connected: "Connected to LendingPad",
  disconnectConfirm: "Disconnect LendingPad? Your Zap will stop adding loans.",
  disconnected: "LendingPad is disconnected.",
  steps: [
    "In LendingPad, an admin makes an API key for Zapier (LendingPad's settings → API).",
    "In Zapier, make a Zap that starts with LendingPad, \"Loan Updated\", and connect it with that key.",
    "Add a Filter step: only continue when the loan status is your company's funded status. \"Loan Updated\" fires on every change to a loan, so this step is what keeps pipeline loans out.",
    "Add a \"Webhooks by Zapier\" action: POST, payload type JSON, to the URL above, with a header named Authorization whose value is Bearer, a space, then your key.",
    "Map LendingPad's fields to the names below. Map LendingPad's funded date, never its estimated closing date, to closing_date, and the loan number your LendingPad report shows (not an internal ID) to loan_id.",
    "Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.",
  ],
  fields: FIELDS_LIST,
  sameLoan: "Send the same loan number your import file uses as loan_id, and LendingPad's funded date as closing_date, so a loan from the Zap and the same loan in a file match.",
  routing: ROUTING_BROKER,
};

test("the LOS choices, in order", () => {
  assert.deepEqual(LOS_CHOICES, [{ id: "arive", label: "ARIVE" }, { id: "lendingpad", label: "LendingPad" }]);
});

test("the card's own lines", () => {
  assert.equal(CARD_HINT, "Send funded loans from your LOS (ARIVE or LendingPad) straight into Broker Radar through Zapier.");
  assert.equal(LOS_QUESTION, "Which LOS do you use?");
  assert.equal(CHECKING, "Checking your connection…");
});

test("LendingPad's copy for a broker", () => {
  assert.deepEqual(connectionCopy("lendingpad", { isBroker: true }), LENDINGPAD);
});

test("LendingPad's step 5 warns off the estimated closing date", () => {
  assert.ok(connectionCopy("lendingpad", { isBroker: true }).steps[4].includes("never its estimated closing date"));
});

test("ARIVE's steps and sameLoan are the card's current ones, word for word", () => {
  const copy = connectionCopy("arive", { isBroker: true });
  assert.deepEqual(copy.steps, ARIVE_STEPS);
  assert.equal(copy.sameLoan, ARIVE_SAME_LOAN);
  assert.equal(copy.label, "ARIVE");
  assert.equal(copy.connect, "Connect ARIVE");
  assert.equal(copy.connected, "Connected to ARIVE");
  assert.equal(copy.disconnectConfirm, "Disconnect ARIVE? Your Zap will stop adding loans.");
  assert.equal(copy.disconnected, "ARIVE is disconnected.");
  assert.deepEqual(copy.fields, LENDINGPAD.fields);
  assert.equal(copy.routing, LENDINGPAD.routing);
});

test("a loan officer's routing line is the same for both LOSes", () => {
  for (const los of ["arive", "lendingpad"]) assert.equal(connectionCopy(los, { isBroker: false }).routing, ROUTING_LO, los);
  assert.equal(connectionCopy("arive", { isBroker: true }).routing, ROUTING_BROKER);
});

test("an unknown or missing LOS gets ARIVE's copy", () => {
  const arive = connectionCopy("arive", { isBroker: true });
  for (const los of [null, undefined, "calyx", "", "ARIVE"]) assert.deepEqual(connectionCopy(los, { isBroker: true }), arive, String(los));
  assert.deepEqual(connectionCopy("calyx", { isBroker: false }), connectionCopy("arive", { isBroker: false }));
  assert.deepEqual(connectionCopy("lendingpad"), connectionCopy("lendingpad", { isBroker: false }));
});

"use strict";
// Decides whose book an imported loan goes into. The importer is a loan officer (always their own book) or the company's broker,
// who can send each row to the loan officer it names: by email, or by full name when exactly one person in the company has it.
// A row that names nobody the broker can find stays with the broker, with a flag that says why, so a typo in a loan officer's
// name never loses a loan and never hands it to the wrong person.
//
// `named` says whether the row itself chose the owner (true) or the owner is only the importer by default (false); the import
// uses it to decide whether an existing client may be moved to this owner. Only the importer's own company is ever searched.
// Nothing here writes to the DB.

const { nameKey } = require("./normalize");

// What every routing flag starts with; the webhook strips it to tell a broker the loan came to their book.
const ROUTED_PREFIX = "routed to your book: ";

const fullNameOf = (u) => `${u.first_name} ${u.last_name}`.trim();

function resolveOwner(db, actor, loanOfficer) {
  const self = { id: actor.id, name: fullNameOf(actor) };
  // A loan officer's import is their own book, whoever the row names.
  if (actor.role === "lo") return { ...self, named: true, flag: null };

  const wanted = typeof loanOfficer === "string" ? loanOfficer.trim() : "";
  if (!wanted) return { ...self, named: false, flag: null };

  const people = db.prepare("SELECT id, first_name, last_name, email FROM users WHERE org_id = ? AND removed_at IS NULL").all(actor.org_id);
  let match = null;
  if (wanted.includes("@")) {
    const email = wanted.toLowerCase();
    match = people.find((u) => String(u.email || "").trim().toLowerCase() === email) || null;
  } else {
    // Two people with the same name name nobody in particular.
    const key = nameKey(wanted);
    const same = people.filter((u) => nameKey(fullNameOf(u)) === key);
    if (same.length === 1) match = same[0];
  }
  if (match) return { id: match.id, name: fullNameOf(match), named: true, flag: null };

  return { ...self, named: false, flag: `${ROUTED_PREFIX}no loan officer in your company matches "${wanted}"` };
}

module.exports = { resolveOwner, ROUTED_PREFIX };

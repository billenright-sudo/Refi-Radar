"use strict";
// The import whitelist: the only fields a client file or an LOS feed (ARIVE or LendingPad) may ever read, and the mapping from a file's header row
// onto them. Nothing outside FIELDS is read from a row, so an SSN, a date of birth, income, assets, an employer or an account
// number can never reach the app, whatever the file happens to contain.
//
// The mapping is a plain object { fieldId: columnIndex } with every field present and -1 for "no column". detectMapping()
// guesses it from the headers (ARIVE, LendingPad, Calyx Point and ordinary CRM exports), the broker can fix it on the page, and
// cleanMapping() makes whatever the browser sends back safe before anything is read. A column that looks protected, or has no
// header at all, is never offered, never guessed and never accepted. readFields() then lifts just the mapped cells from a row.
//
// Matching is exact, on headerKey() (lowercase letters, digits and "#" only), never "contains": "Loan Amount" is the original
// amount, so it can never be taken for the balance, and a synonym belongs to one field only.

const { headerKey, isProtectedHeader } = require("./normalize");

// The whole whitelist, in the order the mapping is read and the page lists it.
const FIELDS = Object.freeze([
  { id: "borrowerName", label: "Borrower name" },
  { id: "firstName", label: "First name" },
  { id: "lastName", label: "Last name" },
  { id: "email", label: "Email" },
  { id: "phone", label: "Phone" },
  { id: "loanNumber", label: "Loan number" },
  { id: "noteRate", label: "Note rate" },
  { id: "currentBalance", label: "Current balance" },
  { id: "loanAmount", label: "Original loan amount" },
  { id: "term", label: "Loan term" },
  { id: "amortization", label: "Amortization / product" },
  { id: "propertyValue", label: "Property value" },
  { id: "appraisedValue", label: "Appraised value" },
  { id: "purchasePrice", label: "Purchase price" },
  { id: "closingDate", label: "Closing / funding date" },
  { id: "status", label: "Loan status" },
  { id: "purpose", label: "Loan purpose" },
  { id: "firstPaymentDate", label: "First payment date" },
  { id: "creditScore", label: "Credit score" },
  { id: "loanOfficer", label: "Loan officer (email or name)" },
  { id: "notes", label: "Notes" },
].map((f) => Object.freeze(f)));

// What each field's header can be called, as headerKeys, most specific first: the first synonym that finds an unused column
// wins. The ARIVE, LendingPad and Calyx Point names are best guesses until a real export is seen; the rest are common CRM spellings.
const SYNONYMS = Object.freeze({
  borrowerName: ["borrowername", "borrowerfullname", "borrfullname", "primaryborrower", "fullname", "clientname", "customername", "contactname", "name", "borrower", "client", "customer"],
  firstName: ["borrowerfirstname", "borrfirstname", "firstname", "clientfirstname", "borrowerfname", "fname", "givenname"],
  lastName: ["borrowerlastname", "borrlastname", "lastname", "clientlastname", "borrowerlname", "lname", "surname", "familyname"],
  email: ["borroweremail", "borremail", "emailaddress", "borroweremailaddress", "primaryemail", "clientemail", "email"],
  phone: ["phone", "phonenumber", "primaryphone", "mobile", "mobilephone", "cell", "cellphone", "borrowercellphone", "borrcellphone", "borrowermobilephone", "borrowerphone", "borrphone", "borrowerhomephone", "borrhomephone", "homephone", "clientphone", "telephone"],
  loanNumber: ["loannumber", "loan#", "loanno", "loannum", "loannbr", "loanid", "loanidentifier"],
  noteRate: ["noterate", "interestrate", "currentinterestrate", "currentrate", "mortgagerate", "loanrate", "intrate", "rate"],
  currentBalance: ["currentbalance", "currentloanbalance", "currentprincipalbalance", "unpaidprincipalbalance", "upb", "remainingbalance", "outstandingbalance", "principalbalance", "loanbalance", "balance", "principal"],
  loanAmount: ["totalloanamount", "originalloanamount", "origloanamount", "originalloanamt", "loanamount", "loanamt", "originalamount", "originalbalance", "mortgageamount", "amount"],
  term: ["loanterm", "loantermmonths", "loantermyears", "mortgageterm", "termofloan", "termmonths", "termyears", "term"],
  amortization: ["amortizationtype", "amorttype", "amortization", "loanproduct", "producttype", "product", "loanprogram", "program", "mortgagetype", "loantype"],
  propertyValue: ["propertyvalue", "currentpropertyvalue", "currenthomevalue", "homevalue", "estimatedpropertyvalue", "estimatedhomevalue", "estimatedvalue", "marketvalue", "propvalue"],
  appraisedValue: ["appraisedvalue", "appraisalvalue", "appraisedamount", "appraised"],
  purchasePrice: ["purchaseprice", "salesprice", "saleprice", "purchaseamount", "contractprice", "homeprice"],
  closingDate: ["closingdate", "closedate", "closeddate", "fundeddate", "fundingdate", "funddate", "datefunded", "dateclosed", "actualclosingdate", "settlementdate", "disbursementdate"],
  status: ["loanstatus", "status", "loanstage", "currentstatus"],
  purpose: ["loanpurpose", "purposeofloan", "mortgagepurpose", "purpose"],
  firstPaymentDate: ["firstpaymentdate", "1stpaymentdate", "firstpmtdate", "1stpmtdate", "firstpaydate", "1stpaydate", "firstpaymentduedate"],
  creditScore: ["creditscore", "borrowercreditscore", "ficoscore", "borrowerfico", "fico", "qualifyingfico", "qualifyingcreditscore", "representativecreditscore"],
  loanOfficer: ["loanofficeremail", "loemail", "originatoremail", "loanofficer", "loanofficername", "loanoriginator", "originator", "loname", "lo"],
  notes: ["notes", "note", "comments", "comment"],
});
Object.values(SYNONYMS).forEach(Object.freeze);

const emptyMapping = () => Object.fromEntries(FIELDS.map((f) => [f.id, -1]));

// The headers a broker may map: not blank, not protected. This is the one place that decides, so the page's drop-downs, the
// guess and the cleaned mapping all agree.
function offeredHeaders(headers) {
  const out = [];
  if (!Array.isArray(headers)) return out;
  headers.forEach((header, index) => {
    if (headerKey(header) !== "" && !isProtectedHeader(header)) out.push({ index, header });
  });
  return out;
}

// A guess at the mapping from the header row. Fields are walked in FIELDS order, each tries its synonyms in order, and the
// first offered column with that exact key that no field has taken yet is used. Of two columns with the same header the first
// is used.
function detectMapping(headers) {
  const mapping = emptyMapping();
  const offered = offeredHeaders(headers).map(({ index, header }) => ({ index, key: headerKey(header) }));
  const taken = new Set();
  for (const { id } of FIELDS) {
    for (const synonym of SYNONYMS[id]) {
      const hit = offered.find((o) => o.key === synonym && !taken.has(o.index));
      if (!hit) continue;
      mapping[id] = hit.index;
      taken.add(hit.index);
      break;
    }
  }
  return mapping;
}

// The browser's mapping made safe: every field id present, and a value kept only when it is the integer index of an offered
// header that no earlier field (in FIELDS order) has already claimed. Unknown ids are dropped, and anything else (a string, a
// fraction, a negative, a blank or protected column, a column past the end) becomes -1.
function cleanMapping(mapping, headers) {
  const cleaned = emptyMapping();
  const given = mapping !== null && typeof mapping === "object" ? mapping : {};
  const offered = new Set(offeredHeaders(headers).map((o) => o.index));
  const taken = new Set();
  for (const { id } of FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(given, id) ? given[id] : -1;
    if (!Number.isInteger(value) || !offered.has(value) || taken.has(value)) continue;
    // "+ 0" turns a JSON "-0" into a plain 0.
    cleaned[id] = value + 0;
    taken.add(value);
  }
  return cleaned;
}

// The mapped cells of one row, as raw values: { fieldId: cell }. A field with no column, or whose column the row is too short
// to have, is left out. No other cell is touched. The mapping should come from cleanMapping(), which is what keeps a protected
// column out; the row has no headers, so this cannot check that for itself.
function readFields(row, mapping) {
  const out = {};
  if (!Array.isArray(row) || mapping === null || typeof mapping !== "object") return out;
  for (const { id } of FIELDS) {
    const index = Object.prototype.hasOwnProperty.call(mapping, id) ? mapping[id] : -1;
    if (Number.isInteger(index) && index >= 0 && index < row.length) out[id] = row[index];
  }
  return out;
}

module.exports = { FIELDS, SYNONYMS, detectMapping, offeredHeaders, cleanMapping, readFields };

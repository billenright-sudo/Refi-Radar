// The Import page's logic, with no DOM and no React (the page is ImportView.jsx). Each API wrapper takes the fetch to use, calls the
// app's own server and never throws:
//   -> { ok: true, data } | { ok: false, error }     `error` is a line to show the user as it is.
// confirmImport can also answer { ok: false, changed: true, error, review }: see below.
//
// Server contracts (server/routes/import.js, a broker only):
//   POST /api/import/preview  multipart "file"                                  -> a Review of the file with the guessed columns
//   POST /api/import/review   { fileData, mimetype, mapping, fundedStatuses }   -> a Review with the broker's picks
//   POST /api/import/confirm  { fileData, mimetype, mapping, fundedStatuses, reviewHash }
//                                                                               -> { success, results, counts }, or 409 with
//                                                                                  { success: false, error, review } when the rows
//                                                                                  now come out differently from the review
// A Review is { success, fields: [{ id, label }], headers: [{ index, header }], mapping: { [fieldId]: index | -1 },
//   statuses: null | [{ value, label, count, funded }], everyRowFunded, totalRows, results, counts, reviewHash, fileData, mimetype }.
// A result is { row, outcome: created | updated | unchanged | ambiguous | skipped, name, reason, note, flags, owner, movedFrom }, and
// counts is { created, updated, unchanged, ambiguous, skipped, moved, byOwner: [{ id, name, rows }] }.
// The file travels as base64 inside each Review, so the page sends it back with every change instead of uploading it again.

const NO_SERVER = "Couldn't reach the server. Check your connection and try again.";
const BROKER_ONLY = "Only a broker can import clients.";
const FALLBACK = "That didn't work. Try again.";
const NOT_A_SHEET = "Please upload a CSV or Excel file (.csv, .xls, .xlsx)";

// ── the API wrappers ──

// One call to the app's own API. -> { network: true } when it could not be made, else { status, ok, data } (data null when the body
// was not JSON).
async function send(fetchFn, url, init) {
  try {
    const res = await fetchFn(url, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: !!res.ok, status: res.status, data };
  } catch {
    return { network: true };
  }
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const isObject = (data) => !!data && typeof data === "object" && !Array.isArray(data);
const isResult = (data) => isObject(data) && Array.isArray(data.results) && isObject(data.counts);
const isReview = (data) => isResult(data) && Array.isArray(data.fields) && Array.isArray(data.headers) && typeof data.fileData === "string";
const messageOf = (data) => (isObject(data) && typeof data.error === "string" && data.error.trim()) || "";

// A failed call: the connection message, the broker-only message for a 403, else the server's own words (they are written for a
// person), else a plain fallback.
function answer(res, accept) {
  if (res.network) return { ok: false, error: NO_SERVER };
  if (res.ok) return accept(res.data) ? { ok: true, data: res.data } : { ok: false, error: FALLBACK };
  if (res.status === 403) return { ok: false, error: BROKER_ONLY };
  return { ok: false, error: messageOf(res.data) || FALLBACK };
}

// The file as the first Review. A file that is not a .csv, .xls or .xlsx is turned away here, before anything is sent.
export async function uploadFile(fetchFn, file) {
  if (!file) return { ok: false, error: FALLBACK };
  if (!/\.(csv|xls|xlsx)$/i.test(String(file.name || ""))) return { ok: false, error: NOT_A_SHEET };
  const form = new FormData();
  form.append("file", file);
  // No Content-Type here: the browser writes the multipart one itself, boundary and all.
  return answer(await send(fetchFn, "/api/import/preview", { method: "POST", body: form }), isReview);
}

// The same file again with the broker's picks: `mapping` is { fieldId: column index | -1 }, `fundedStatuses` the ticked status values
// (null = the server's defaults). -> a fresh Review.
export async function reviewAgain(fetchFn, review, { mapping, fundedStatuses }) {
  const body = { fileData: review.fileData, mimetype: review.mimetype, mapping, fundedStatuses };
  return answer(await send(fetchFn, "/api/import/review", json(body)), isReview);
}

// Write what the review showed. -> { ok: true, data: { success, results, counts } }. A 409 means the rows come out differently now,
// nothing was written, and the answer carries the fresh review to show instead: { ok: false, changed: true, error, review }.
export async function confirmImport(fetchFn, review) {
  const body = {
    fileData: review.fileData, mimetype: review.mimetype, mapping: review.mapping,
    fundedStatuses: fundedStatusesOf(review.statuses), reviewHash: review.reviewHash,
  };
  const res = await send(fetchFn, "/api/import/confirm", json(body));
  if (!res.network && res.status === 409 && isObject(res.data) && isReview(res.data.review)) {
    return { ok: false, changed: true, error: messageOf(res.data) || FALLBACK, review: res.data.review };
  }
  return answer(res, isResult);
}

// ── the picks ──

// The status values ticked as funded, as the server wants them; null when the file has no status column.
export function fundedStatusesOf(statuses) {
  return Array.isArray(statuses) ? statuses.filter((s) => s.funded).map((s) => s.value) : null;
}

// The picks to send after the broker sets `fieldId` to `column` (-1 = not in this file): { mapping, fundedStatuses }. A column can
// belong to one field, so taking another field's column frees that field (the latest pick wins; the server would otherwise keep
// the earlier field's and drop this one). The ticked statuses were read from the status column, so they are kept only while it is
// the same column and start again from the defaults (null) when it moves or goes.
export function withMapping(review, fieldId, column) {
  const mapping = {};
  for (const [id, index] of Object.entries(review.mapping)) mapping[id] = column >= 0 && index === column ? -1 : index;
  mapping[fieldId] = column;
  const sameStatusColumn = mapping.status >= 0 && mapping.status === review.mapping.status;
  return { mapping, fundedStatuses: sameStatusColumn ? fundedStatusesOf(review.statuses) : null };
}

// The picks to send after the broker ticks or unticks the status `value`.
export function withStatus(review, value, funded) {
  const statuses = review.statuses.map((s) => (s.value === value ? { ...s, funded } : s));
  return { mapping: { ...review.mapping }, fundedStatuses: fundedStatusesOf(statuses) };
}

// ── the words ──

// What the import will do with one row, as a line for the table.
export function outcomeText(result) {
  const { outcome, note, reason, movedFrom, owner } = result;
  switch (outcome) {
    case "created":
      return note === "second property" ? "New (second property)" : "New";
    case "updated":
      return movedFrom ? `Updated: moves from ${movedFrom}${owner && owner.name ? ` to ${owner.name}` : ""}` : "Updated";
    case "unchanged":
      return note === "older loan" ? "Older loan: unchanged" : "Unchanged";
    case "ambiguous":
      return reason ? `Ambiguous: ${reason}, skipped` : "Ambiguous: skipped";
    case "skipped":
      return reason ? `Skipped: ${reason}` : "Skipped";
    default:
      return String(outcome);
  }
}

// The book a row lands in, for beside its outcome line: "→ Lou Park" for a row that creates, updates or matches a client, "" for
// a row that goes nowhere (skipped, ambiguous) and for a move, whose outcome line already names the new book.
export function bookText(result) {
  const { outcome, owner, movedFrom } = result;
  if (!["created", "updated", "unchanged"].includes(outcome) || movedFrom) return "";
  return owner && owner.name ? `→ ${owner.name}` : "";
}

// "3 new · 1 updated · 2 unchanged · 1 skipped", with " · 1 moved" added when a client moved to another loan officer. A row that
// matched more than one client is not imported, so it counts as skipped here (R11); the server keeps "ambiguous" apart.
export function summaryText(counts) {
  const text = `${counts.created} new · ${counts.updated} updated · ${counts.unchanged} unchanged · ${counts.skipped + counts.ambiguous} skipped`;
  return counts.moved > 0 ? `${text} · ${counts.moved} moved` : text;
}

// ── paging ──

// One page of `items`: { items, page, pages }. The page is kept within 1..pages, and there is always at least one page.
export function pageOf(items, page, size = 50) {
  const all = Array.isArray(items) ? items : [];
  const pages = Math.max(1, Math.ceil(all.length / size));
  const wanted = Math.trunc(Number(page));
  const at = Number.isNaN(wanted) ? 1 : Math.min(Math.max(wanted, 1), pages);
  return { items: all.slice((at - 1) * size, at * size), page: at, pages };
}

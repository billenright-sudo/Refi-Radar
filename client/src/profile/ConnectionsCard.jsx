import { useEffect, useRef, useState } from "react";
import { loadConnection, connectLos, disconnectLos, utcTextToDate } from "./profile.mjs";
import { LOS_CHOICES, CARD_HINT, LOS_QUESTION, CHECKING, connectionCopy } from "./connections.mjs";

// The Connections card on the Profile page: a broker or loan officer connects their LOS here, ARIVE or LendingPad (picked before connecting; once
// connected the card shows the LOS the server holds, and Regenerate keeps it). The LOS sends each funded loan to Broker Radar
// through a Zap (Zapier's "Webhooks by Zapier"), signed with a key made on this card. The key is shown once, when it is made, and is
// kept only in this card's state: leaving the page, or a reload, loses it for good (the server holds only a hash). The calls are
// profile.mjs's; the server is server/routes/integrations.js.
//
// Props: ui = { C, card, mono, Icon, $c } (App's design tokens), isBroker (a broker's loans are routed by loan_officer_email, a loan
// officer's all go to their own book, so the closing line differs). Every line that differs by LOS comes from connections.mjs. The card makes its own server calls, so ProfileView renders it whether
// or not the profile has loaded.

const KEY_ONCE = "Copy your key now. It won't be shown again.";
const REGENERATE_CONFIRM = "Make a new key? The old one stops working right away, so update your Zap.";
const COPY_FAILED = "Couldn't copy. Select the text and copy it yourself.";

const WHEN = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };

// "Not used yet", or the last call's time in the viewer's own time zone (the server's text is UTC).
function usedLine(lastUsedAt) {
  if (lastUsedAt === null || lastUsedAt === undefined || lastUsedAt === "") return "Not used yet";
  const when = utcTextToDate(lastUsedAt);
  return when ? `Last used ${when.toLocaleString("en-US", WHEN)}` : `Last used ${lastUsedAt}`;
}

const button = (C, { primary = false, busy = false } = {}) => ({
  border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 14px", background: primary ? C.amber : "transparent",
  color: primary ? "#0f2040" : C.mutedHi, fontFamily: "inherit", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
  cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
});

// A value to copy (the webhook URL, the key), selectable in one click, with its Copy button.
const CopyRow = ({ label, value, testId, copied, onCopy, ui: { C, mono } }) => (
  <div style={{ marginTop: 10 }}>
    <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 4 }}>{label}</div>
    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
      <code
        data-testid={testId}
        style={{ ...mono, flex: 1, minWidth: 0, background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", color: C.text, fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere", userSelect: "all" }}
      >
        {value}
      </code>
      <button type="button" data-testid={`${testId}-copy`} aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy} style={button(C)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  </div>
);

export function ConnectionsCard({ ui, isBroker }) {
  const { C, card, mono } = ui;
  const [conn, setConn] = useState(null);     // null: checking | { error } the read failed | { connected, createdAt, lastUsedAt, webhookUrl, los }
  const [fresh, setFresh] = useState(null);   // { key } while the key just made is on screen; never kept anywhere else
  const [choice, setChoice] = useState("arive");   // the LOS picked while not connected
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);     // { text, bad? } | null
  const [copied, setCopied] = useState("");   // "url" | "key" | "" : which Copy button says "Copied" for a moment
  const timer = useRef(null);

  // Until this read answers there is no Connect button: pressing it on a connected account would replace the key.
  const check = async () => {
    setConn(null);
    const res = await loadConnection(fetch);
    setConn(res.ok ? res.data : { error: res.error });
  };
  useEffect(() => {
    check();
    return () => clearTimeout(timer.current);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const known = conn && !conn.error;
  const connected = known && conn.connected;
  const copy = connectionCopy(connected ? conn.los : choice, { isBroker });

  // Connect and Regenerate: the server makes a new key, and the old one (if any) stops working.
  const makeKey = async (los) => {
    setBusy(true); setNote(null);
    const res = await connectLos(fetch, los);
    if (res.ok) {
      setFresh({ key: res.data.key });
      setConn({ connected: true, createdAt: res.data.createdAt || null, lastUsedAt: null, webhookUrl: res.data.webhookUrl, los: res.data.los || los });
      setCopied("");
    } else {
      setNote({ bad: true, text: res.error });
    }
    setBusy(false);
  };
  const regenerate = () => { if (window.confirm(REGENERATE_CONFIRM)) makeKey(conn.los || "arive"); };

  const disconnect = async () => {
    if (!window.confirm(copy.disconnectConfirm)) return;
    setBusy(true); setNote(null);
    const res = await disconnectLos(fetch);
    if (res.ok) {
      setFresh(null);
      if (conn.los) setChoice(conn.los);
      setConn((shown) => ({ ...shown, connected: false, createdAt: null, lastUsedAt: null }));
      setNote({ text: copy.disconnected });
    } else {
      setNote({ bad: true, text: res.error });
    }
    setBusy(false);
  };

  const copyText = async (which, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(null);
      setCopied(which);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(""), 2000);
    } catch {
      setNote({ bad: true, text: COPY_FAILED });
    }
  };

  return (
    <div data-testid="connections-card" style={{ ...card, padding: "1.1rem" }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Connections</div>
      <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.45 }}>{CARD_HINT}</div>

      {conn === null && <div data-testid="connections-status" style={{ color: C.muted, fontSize: 13 }}>{CHECKING}</div>}

      {conn && conn.error && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span data-testid="connections-status" style={{ color: C.red, fontSize: 13 }}>{conn.error}</span>
          <button type="button" data-testid="connections-retry" onClick={check} style={button(C)}>Try again</button>
        </div>
      )}

      {known && (
        <div data-testid="connections-status" style={{ display: "flex", alignItems: "center", gap: 8, color: C.mutedHi, fontSize: 13, lineHeight: 1.45 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? C.green : C.muted, flex: "none" }} />
          <span>{connected ? `${copy.connected} · ${usedLine(conn.lastUsedAt)}` : "Not connected"}</span>
        </div>
      )}

      {/* The address is shown connected or not (it is no secret), so step 4 of the guide always has a URL above it. */}
      {known && conn.webhookUrl && (
        <CopyRow label="Webhook URL" value={conn.webhookUrl} testId="connections-url" copied={copied === "url"} onCopy={() => copyText("url", conn.webhookUrl)} ui={ui} />
      )}

      {known && !connected && (
        <div style={{ marginTop: 12 }}>
          <div id="connections-los-question" style={{ color: C.mutedHi, fontSize: 12.5, marginBottom: 6 }}>{LOS_QUESTION}</div>
          <div role="radiogroup" aria-labelledby="connections-los-question" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {LOS_CHOICES.map((c) => (
              <button
                key={c.id} type="button" role="radio" aria-checked={choice === c.id} data-testid={`connections-los-${c.id}`}
                onClick={() => setChoice(c.id)} style={button(C, { primary: choice === c.id })}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" data-testid="connections-connect" disabled={busy} onClick={() => makeKey(choice)} style={button(C, { primary: true, busy })}>{copy.connect}</button>
          </div>
        </div>
      )}

      {connected && (
        <>
          {fresh && (
            <>
              <CopyRow label="Key" value={fresh.key} testId="connections-key" copied={copied === "key"} onCopy={() => copyText("key", fresh.key)} ui={ui} />
              <div data-testid="connections-key-once" style={{ color: C.amber, fontSize: 12.5, fontWeight: 600, marginTop: 8 }}>{KEY_ONCE}</div>
            </>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <button type="button" data-testid="connections-regenerate" disabled={busy} onClick={regenerate} style={button(C, { busy })}>Regenerate</button>
            <button type="button" data-testid="connections-disconnect" disabled={busy} onClick={disconnect} style={button(C, { busy })}>Disconnect</button>
          </div>
        </>
      )}

      {note && <div role="status" data-testid="connections-note" style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>}

      <div data-testid="connections-guide" style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12, color: C.mutedHi, fontSize: 12.5, lineHeight: 1.55 }}>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>Set it up in Zapier</div>
        <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
          {copy.steps.map((step) => <li key={step} style={{ marginBottom: 3 }}>{step}</li>)}
        </ol>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 600, marginTop: 12 }}>Field names</div>
        <ul style={{ ...mono, margin: "6px 0 0", paddingLeft: 20, fontSize: 12 }}>
          {copy.fields.map((line) => <li key={line} style={{ marginBottom: 2, overflowWrap: "anywhere" }}>{line}</li>)}
        </ul>
        <div data-testid="connections-same-loan" style={{ marginTop: 8 }}>{copy.sameLoan}</div>
        <div data-testid="connections-routing" style={{ marginTop: 12 }}>{copy.routing}</div>
      </div>
    </div>
  );
}

export default ConnectionsCard;

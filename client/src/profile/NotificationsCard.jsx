import { useEffect, useId, useState } from "react";
import { loadAlerts, saveAlerts, enablePush, forgetDevice, sendTest, pushSupport, WHAT_YOU_GET } from "../push/push.mjs";
import {
  cardState, settingsToForm, zoneChoices, zoneLabel, channelOptions, shownChannel, savePlan, DROP_SIZES, IOS_STEP,
} from "./notifications.mjs";

// The Notifications card on the Profile page: rate-drop notifications, off until the user turns them on. All the logic is in
// notifications.mjs (what the card shows) and ../push/push.mjs (the server calls and the browser's side of phone notifications); this
// file draws it. Turning phone notifications on asks the browser for permission, and that happens only inside the Save tap.
//
// Props: ui = { C, card, mono, Icon } (App's design tokens). The card makes its own server calls, so ProfileView renders it whether or
// not the profile has loaded.

const CHECKING = "Checking your notification settings…";

const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
};

const inputStyle = (C) => ({
  width: "100%", background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px",
  color: C.text, fontFamily: "inherit", fontSize: 13, outline: "none", boxSizing: "border-box",
});
const buttonStyle = (C, { primary = false, busy = false } = {}) => ({
  border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 14px", background: primary ? C.amber : "transparent",
  color: primary ? "#0f2040" : C.mutedHi, fontFamily: "inherit", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
  cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
});

const Labeled = ({ label, C, children }) => {
  const id = useId();
  return (
    <div style={{ flex: "1 1 190px", minWidth: 0 }}>
      <label htmlFor={id} style={{ display: "block", color: C.muted, fontSize: 11.5, marginBottom: 4 }}>{label}</label>
      {children(id)}
    </div>
  );
};

export function NotificationsCard({ ui }) {
  const { C, card } = ui;
  const [alerts, setAlerts] = useState(null);   // null: checking | { error } the read failed | the GET /api/profile/alerts answer
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);       // { text, bad? } | null

  const zone = browserZone();
  const support = typeof window !== "undefined" ? pushSupport({ navigator: window.navigator, window }) : "unsupported";

  const take = (data) => {
    setAlerts(data);
    setForm({ ...settingsToForm(data.settings), timeZone: data.settings.timeZone || zone });
    setDirty(false);
  };
  const check = async () => {
    setAlerts(null);
    const res = await loadAlerts(fetch);
    if (res.ok) take(res.data); else setAlerts({ error: res.error });
  };
  useEffect(() => { check(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const known = alerts && !alerts.error;
  const state = cardState({ alerts: known ? alerts : null, support });
  const choices = state.channelChoices;
  const off = known && !alerts.available.push && !alerts.available.email;   // nothing is switched on server-side: the note only

  const change = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); setNote(null); };

  const save = async () => {
    setBusy(true); setNote(null);
    // the stored channel goes as it is unless this save changes "How" or turns pings on; only those saves may ask for permission
    const plan = savePlan({ saved: alerts.settings, form, choices, browserZone: zone });
    if (plan.askPush) {
      const asked = await enablePush({ navigator: window.navigator, Notification: window.Notification, vapidPublicKey: alerts.vapidPublicKey, fetchFn: fetch });
      if (asked.error) { setNote({ text: asked.error, bad: true }); setBusy(false); return; }
    }
    const res = await saveAlerts(fetch, plan.settings);
    if (res.ok) {
      if (plan.forgetPush) await forgetDevice({ navigator: window.navigator, fetchFn: fetch });   // pings off or email only: this browser's device goes
      take(res.data);
      setNote({ text: "Saved." });
    } else setNote({ text: res.error, bad: true });
    setBusy(false);
  };

  const test = async () => {
    setBusy(true); setNote(null);
    const res = await sendTest(fetch);
    if (!res.ok) setNote({ text: res.error, bad: true });
    else if (res.data.sent) setNote({ text: "Test sent." });
    else setNote({ text: "Nothing could be sent. Check that notifications are allowed on this device, or choose email.", bad: true });
    setBusy(false);
  };

  const options = channelOptions(choices, alerts && alerts.settings ? alerts.settings.channels : undefined);
  const locked = options.length === 0;

  return (
    <div data-testid="notifications-card" style={{ ...card, padding: "1.1rem" }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Notifications</div>
      <div style={{ color: C.muted, fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.45 }}>{WHAT_YOU_GET}</div>

      {alerts === null && <div data-testid="notifications-status" style={{ color: C.muted, fontSize: 13 }}>{CHECKING}</div>}

      {alerts && alerts.error && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span data-testid="notifications-status" style={{ color: C.red, fontSize: 13 }}>{alerts.error}</span>
          <button type="button" data-testid="notifications-retry" onClick={check} style={buttonStyle(C)}>Try again</button>
        </div>
      )}

      {known && state.showIosStep && (
        <div role="note" data-testid="notifications-ios" style={{ color: C.mutedHi, fontSize: 12.5, lineHeight: 1.45, marginBottom: 10 }}>{IOS_STEP}</div>
      )}
      {known && state.note && (
        <div role="note" data-testid="notifications-note" style={{ color: C.mutedHi, fontSize: 12.5, lineHeight: 1.45, marginBottom: 10 }}>{state.note}</div>
      )}

      {known && form && !off && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: C.text, fontSize: 13, cursor: locked ? "default" : "pointer" }}>
            <input
              type="checkbox" data-testid="notifications-enabled" checked={form.enabled} disabled={locked}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            Send me a notification when rates drop
          </label>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
            <Labeled label="Notify me when the rate falls by (points)" C={C}>
              {(id) => (
                <select id={id} data-testid="notifications-threshold" value={form.threshold} onChange={(e) => change({ threshold: Number(e.target.value) })} style={inputStyle(C)}>
                  {DROP_SIZES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              )}
            </Labeled>
            <Labeled label="How" C={C}>
              {(id) => (
                <select id={id} data-testid="notifications-channels" value={shownChannel(form.channels, choices)} disabled={locked} onChange={(e) => change({ channels: e.target.value })} style={inputStyle(C)}>
                  {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
            </Labeled>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            <Labeled label="Quiet hours start" C={C}>
              {(id) => <input id={id} type="time" data-testid="notifications-quiet-start" value={form.quietStart} onChange={(e) => change({ quietStart: e.target.value })} style={inputStyle(C)} />}
            </Labeled>
            <Labeled label="Quiet hours end" C={C}>
              {(id) => <input id={id} type="time" data-testid="notifications-quiet-end" value={form.quietEnd} onChange={(e) => change({ quietEnd: e.target.value })} style={inputStyle(C)} />}
            </Labeled>
            <Labeled label="Time zone" C={C}>
              {(id) => (
                <select id={id} data-testid="notifications-zone" value={form.timeZone || ""} onChange={(e) => change({ timeZone: e.target.value })} style={inputStyle(C)}>
                  {zoneChoices(form.timeZone, zone).map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
                </select>
              )}
            </Labeled>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, color: C.text, fontSize: 13, marginTop: 12, cursor: "pointer" }}>
            <input type="checkbox" data-testid="notifications-weekdays" checked={form.weekdaysOnly} onChange={(e) => change({ weekdaysOnly: e.target.checked })} />
            Weekdays only
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" data-testid="notifications-save" onClick={busy ? undefined : save} disabled={busy || !dirty} style={buttonStyle(C, { primary: true, busy: busy || !dirty })}>Save</button>
            {state.canTest && (
              <button type="button" data-testid="notifications-test" onClick={busy || dirty ? undefined : test} disabled={busy || dirty} style={buttonStyle(C, { busy: busy || dirty })}>Send a test</button>
            )}
            {state.canTest && dirty && <span style={{ color: C.muted, fontSize: 12 }}>Save your changes to send a test.</span>}
          </div>
        </>
      )}

      {note && <div role="status" data-testid="notifications-result" style={{ color: note.bad ? C.red : C.mutedHi, fontSize: 12.5, marginTop: 8 }}>{note.text}</div>}
    </div>
  );
}

export default NotificationsCard;

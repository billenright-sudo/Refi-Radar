// The "Send feedback" panel's checks, the same two lines the server answers with (routes/feedback.js). Pure.

export const FEEDBACK_MAX = 2000;
export const FEEDBACK_THANKS = "Thanks — the Broker Radar team will read this.";

// -> null when the message can be sent, else the line to show.
export function feedbackCanSend(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return "Please write a message.";
  if (text.length > FEEDBACK_MAX) return "Please keep it under 2,000 characters.";
  return null;
}

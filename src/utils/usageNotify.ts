// Telling you a quota moved when you are not looking at Tori.
//
// The needs-you rule, applied to a fact about a login rather than a session:
// **nothing while the window is focused.** A focused window is already showing
// the strip and, if a chat is open on that account, the banner too, so a
// notification would be a second copy of something on screen. That is a
// stronger suppression than `shouldSuppressNotification` uses for a session
// (which asks whether you are looking at *that* session), and the reason is the
// strip: there is no account whose quota a focused window is not showing.
//
// Deduped on the store's persisted fired set rather than a local one, because a
// notice repeated after every restart is the failure that set exists to prevent.
import { createEffect, createRoot, untrack } from "solid-js";
import { findAdapter } from "./agents";
import { asTabProfile, profileLabel } from "./agentHealth";
import { agentEnabled } from "./agentEnabled";
import { quotaState, windowSentence, type QuotaState } from "./chatRateLimit";
import { notifyQuota } from "./presence";
import { accountWindows, chipFor, usageNotify, usageWarnAt } from "./usageSettings";
import { accountsWithReadings, shouldAnnounce, splitAccountKey, windowsFor } from "./usageStore";

export type QuotaNotification = { title: string; body: string };

/**
 * Whether Tori has the focus, from the DOM rather than from a signal.
 *
 * `sessionActivity` keeps one for the needs-you path, and importing it from here
 * would be wrong twice: it is fed by the sidebar (so it is a *session* surface's
 * answer), and pulling that module in eagerly starts its tray and badge effects
 * wherever this one is imported. The document's own answer needs no listener and
 * cannot disagree with itself.
 */
const focusedNow = () => (typeof document === "undefined" ? false : document.hasFocus());

/**
 * The notifications this moment has earned, marking each one said.
 *
 * Not pure, and the impurity is the point: `shouldAnnounce` is the only record
 * that a window has already been announced, and it is the same record a restart
 * reads back. Marking has to happen here or a reload would repeat everything.
 *
 * **Focus is checked after the mark, not before.** A window that crossed while
 * you were looking at Tori has been delivered, by the strip; firing it later
 * when you tab away would be news about something you already saw.
 */
export function collectQuotaNotifications(
  now = Date.now(),
  focused = focusedNow(),
): QuotaNotification[] {
  const out: QuotaNotification[] = [];

  for (const key of accountsWithReadings()) {
    const { agentId, profile } = splitAccountKey(key);
    if (!agentEnabled(agentId)) continue;
    const tab = asTabProfile(profile);
    if (!usageNotify(agentId, tab)) continue;
    // A window the user took off the strip is one they said they do not want to
    // hear about; a notification would be the loudest possible version of it.
    const shown = accountWindows(agentId, tab);
    if (shown.length === 0) continue;

    const warnAt = usageWarnAt(agentId, tab);
    const who = profileLabel(agentId, tab) ?? findAdapter(agentId).label;
    for (const w of windowsFor(agentId, tab)) {
      if (!shown.includes(chipFor(w.kind))) continue;
      const state: QuotaState = quotaState(w, warnAt, now);
      if (state !== "approaching" && state !== "reached") continue;
      if (!shouldAnnounce(agentId, tab, w, state)) continue;
      if (focused) continue;
      const body = windowSentence(w, warnAt, now);
      if (body) out.push({ title: who, body });
    }
  }
  return out;
}

let watching = false;

/**
 * Send a notification whenever a window crosses, for as long as the app runs.
 *
 * Reactive on the store rather than on the event stream: the crossing that
 * matters most is a window *expiring*, which no source sends an event for, and
 * a reading landing in one chat is news for every account that shares the login.
 */
export function watchQuotaNotifications() {
  if (watching) return;
  watching = true;
  createRoot(() => {
    createEffect(() => {
      // The trigger is read here and the body is untracked, because collecting
      // *writes* the fired set it also reads: tracked, every send would schedule
      // one more pass of this effect to discover it had nothing left to say.
      accountsWithReadings();
      untrack(() => {
        for (const n of collectQuotaNotifications()) void notifyQuota(n.title, n.body);
      });
    });
  });
}

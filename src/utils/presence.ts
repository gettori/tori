// Needs-you transition tracking (Finding A/F3), the shared primitive the
// presence surfaces (OS notification, tray, dock badge - phase 3 tasks 2-4)
// all consume. LeftSidebar.tsx owns the composed per-session dot state
// (ptyActivity x session_tail_state); this module turns that level-based
// state into edge events plus a per-session "have you looked at this since
// it blocked" flag, so notification re-arm, the tray, and the badge's
// unattended count can't drift from three independent implementations.
import { createSignal } from "solid-js";
import { isPermissionGranted, requestPermission, sendNotification, onAction } from "@tauri-apps/plugin-notification";

export type LiveSessionDot = {
  sessionId: string;
  dot: string;
  sessionName: string;
  projectName: string;
  folderPath: string;
  tabId: string;
};

export type NeedsYouEvent = {
  sessionId: string;
  sessionName: string;
  projectName: string;
  folderPath: string;
  tabId: string;
};

type PresenceState = {
  attended: Record<string, boolean>;
  lastDot: Record<string, string>;
};

/// Pure: fold one tick of live sessions' dot states into the presence state.
/// Returns the sessions whose dot just crossed into "needsYou" (the rising
/// edge, not the steady state) - a session already needsYou on the previous
/// tick produces no transition, but re-arms (fires again) once its dot has
/// been something else in between (a genuine re-block, not a rerender).
export function stepPresence(
  state: PresenceState,
  live: { sessionId: string; dot: string }[],
): { state: PresenceState; transitioned: string[] } {
  const attended = { ...state.attended };
  const lastDot = { ...state.lastDot };
  const transitioned: string[] = [];
  for (const { sessionId, dot } of live) {
    if (dot === "needsYou" && lastDot[sessionId] !== "needsYou") {
      attended[sessionId] = false; // a fresh block is always unattended
      transitioned.push(sessionId);
    }
    lastDot[sessionId] = dot;
  }
  return { state: { attended, lastDot }, transitioned };
}

/// Pure: mark one session attended (a no-op if it's already attended or
/// isn't tracked yet).
export function markAttended(state: PresenceState, sessionId: string): PresenceState {
  if (state.attended[sessionId]) return state;
  return { ...state, attended: { ...state.attended, [sessionId]: true } };
}

/// Pure: tray tooltip/badge counts from one tick of live sessions. "running"
/// is any session with a visible dot (working/needsYou/solid), matching what
/// the sidebar already shows a dot for.
export function liveCounts(live: { dot: string }[]): { running: number; needsYou: number } {
  let running = 0;
  let needsYou = 0;
  for (const { dot } of live) {
    if (dot === "none") continue;
    running++;
    if (dot === "needsYou") needsYou++;
  }
  return { running, needsYou };
}

/// Pure: the dock badge count - sessions currently needsYou AND not yet
/// attended. Independent of `liveCounts.needsYou`, which counts every
/// needsYou session regardless of whether it's been looked at.
export function unattendedNeedsYouCount(
  live: { sessionId: string; dot: string }[],
  attendedMap: Record<string, boolean>,
): number {
  return live.filter((l) => l.dot === "needsYou" && !attendedMap[l.sessionId]).length;
}

/// Pure: don't toast for a session the user is already looking at at the moment
/// it blocks - they'll see it happen.
///
/// Two ways of looking at one, because the two surfaces are watched
/// differently. A PTY agent session is "being looked at" when it is the
/// selected sidebar row. A chat is not reachable that way: it mints its session
/// id before any transcript exists, so selecting its tab usually resolves only
/// as far as its branch, and keying on the selection alone would notify about a
/// prompt sitting in the pane on screen. `onScreenSessionIds` carries the chats
/// whose tab is the visible one.
///
/// An unfocused window suppresses nothing either way: that is the case the
/// notification exists for.
export function shouldSuppressNotification(
  event: { sessionId: string },
  selectedSessionId: string | undefined,
  windowFocused: boolean,
  onScreenSessionIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!windowFocused) return false;
  return selectedSessionId === event.sessionId || onScreenSessionIds.has(event.sessionId);
}

const emptyState: PresenceState = { attended: {}, lastDot: {} };

let state: PresenceState = emptyState;
const [attended, setAttended] = createSignal<Record<string, boolean>>({});
// The most recent needs-you transition, for a notification/tray consumer to
// react to; null until the first one fires. Carries full display metadata
// (sessionName/projectName) since transitions only fire on the edge, not on
// every tick, so a consumer can't cheaply re-derive it from `live` later.
const [lastTransition, setLastTransition] = createSignal<NeedsYouEvent | null>(null);

export { attended, lastTransition };

/// Called reactively (once per relevant signal change) with every currently
/// live agent session's composed dot state + display metadata.
export function notePresence(live: LiveSessionDot[]) {
  const { state: next, transitioned } = stepPresence(state, live);
  state = next;
  setAttended(next.attended);
  if (transitioned.length) {
    const last = live.find((l) => l.sessionId === transitioned[transitioned.length - 1]);
    if (last) setLastTransition(last);
  }
}

export function markSessionAttended(sessionId: string) {
  state = markAttended(state, sessionId);
  setAttended(state.attended);
}

// Requests permission once per app run; a denial just means later calls also
// skip sending (isPermissionGranted is re-checked every time, so a
// mid-session grant via System Settings takes effect without a restart).
let permissionRequested = false;

/// Fire an OS notification for a needs-you transition (the caller has
/// already applied `shouldSuppressNotification`). The session id rides in
/// `extra` so a click can be routed back to focusing that tab - see
/// `onNeedsYouNotificationClick`.
export async function notifyNeedsYou(event: NeedsYouEvent) {
  let granted = await isPermissionGranted().catch(() => false);
  if (!granted && !permissionRequested) {
    permissionRequested = true;
    granted = (await requestPermission().catch(() => "denied")) === "granted";
  }
  if (!granted) return;
  try {
    sendNotification({
      title: event.sessionName,
      body: event.projectName ? `${event.projectName} needs you` : "Needs you",
      extra: { sessionId: event.sessionId },
    });
  } catch {
    // Best-effort, matching this codebase's convention of silently swallowing
    // a failed non-critical invoke.
  }
}

let notificationClickListenerStarted = false;

/// Wires a click handler for needs-you notifications, once per app run.
/// `onAction` is the notification plugin's general interaction callback (both
/// a registered action button and a plain body click are expected to reach
/// it); this reads back the `extra.sessionId` set in `notifyNeedsYou`.
export function onNeedsYouNotificationClick(handler: (sessionId: string) => void) {
  if (notificationClickListenerStarted) return;
  notificationClickListenerStarted = true;
  void onAction((notification) => {
    const sessionId = (notification as { extra?: Record<string, unknown> }).extra?.sessionId;
    if (typeof sessionId === "string") handler(sessionId);
  });
}

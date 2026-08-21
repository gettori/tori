// Which surface a session selection opens: the chat tab, or the PTY agent tab.
//
// Chat is the default as of Phase 12, with a setting that puts the PTY agent
// tab back in front. The decision is a pure function here rather than a branch
// inside Terminal.tsx because it has three inputs that interact (the setting, a
// tab already hosting the session, and a session already running outside Sway)
// and only one of them is the setting - which is exactly the shape that hides a
// wrong answer inside a component.
import type { DefaultSurface } from "../panels/Settings/settingsStore";
import type { PersistedKind } from "./tabPersist";

/**
 * What to do with a session selection.
 *
 * - `focus`: a tab in this window already hosts it. Never open a second one -
 *   two drivers on one session id measurably corrupt its transcript.
 * - `chat`: open (or resume into) a chat tab.
 * - `agent`: open a PTY agent tab.
 */
export type SessionRoute = "focus" | "chat" | "agent";

export type RouteInputs = {
  /** The user's `chatDefaults.defaultSurface`. */
  preference: DefaultSurface;
  /** Is a tab in this window already hosting this session id? */
  hostedHere: boolean;
  /**
   * Is the session's process alive outside Sway (`session_running_elsewhere`)?
   *
   * Load-bearing: a chat tab drives the session by *resuming* it, and resuming
   * a session someone else is already running is the exact operation measured
   * to corrupt the transcript. The PTY route does not resume it - it retypes
   * into a shell, or leaves a live agent alone - so it stays safe.
   *
   * **Outside Sway, not merely alive.** A chat child outlives a webview reload
   * while its tab does not, so a bare liveness probe reports Sway's own process
   * as a stranger and sends the session to the PTY surface - where the chat
   * claim this same Sway is holding refuses it, with a message naming a tab the
   * reload destroyed.
   */
  runningElsewhere: boolean;
};

/**
 * Route a session selection to a surface.
 *
 * An externally-running session falls back to the PTY route **regardless of the
 * preference**. This is not a downgrade of the setting: chat has no safe move
 * to make there, and the pre-chat behaviour (focus the live agent, or retype
 * the resume into a shell it exited from) is both correct and what the user
 * already expects from that session.
 */
export function routeSelection({ preference, hostedHere, runningElsewhere }: RouteInputs): SessionRoute {
  if (hostedHere) return "focus";
  if (runningElsewhere) return "agent";
  return preference === "agent" ? "agent" : "chat";
}

/**
 * Which surface a **restored** tab comes back on.
 *
 * Deliberately a function of the stored kind alone: `preference` is not an
 * input and must never become one. A workspace saved with three agent tabs
 * restores as three agent tabs, on the install where chat became the default
 * as much as on any other. Converting them on the user's behalf would move a
 * live session onto a surface that drives it a different way, and a restore is
 * the worst moment to do that - it happens before the user has looked at
 * anything, to every workspace at once.
 *
 * This exists as a named function rather than as the *absence* of a call to
 * `routeSelection` so the invariant is something a test can hold, instead of
 * something a later edit can quietly undo.
 */
export function restoreRoute(storedKind: PersistedKind): SessionRoute {
  return storedKind === "chat" ? "chat" : "agent";
}

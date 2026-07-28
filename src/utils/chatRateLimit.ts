// Whether a rate limit is worth telling the user about, and what to say.
//
// Two measurements off the captures drive the whole shape of this:
//
//   1. **`rate_limit_event` fires on every turn, and its status is `allowed`.**
//      Every frame in every capture reads
//      `{"status":"allowed","resetsAt":1785179400,"rateLimitType":"five_hour"}`.
//      So "surface rate limits" cannot mean "render on the event": that would
//      pin a permanent banner to every chat announcing that nothing is wrong,
//      which is how a warning stops being read. The banner is for a status that
//      is *not* allowed, and the common case renders nothing.
//   2. **`resetsAt` is in seconds, not milliseconds.** 1785179400 is 2026-07-26;
//      read as millis it would be 1970. Both scales look equally plausible in a
//      small fixture, which is exactly the trap
//      `lesson_synthetic_test_values_hide_unit_bugs` describes, so the
//      conversion happens here, once, named, and is pinned by a test using the
//      real captured magnitude rather than a round number.
import type { ChatEvent } from "./chatTypes";

export type RateLimitState = {
  status: string;
  /** Epoch **seconds**, as the wire sends it. Converted at the one point of
   *  use below rather than at the boundary, so the field keeps the wire's
   *  units and cannot be silently reinterpreted by a second reader. */
  resetsAt: number | null;
  limitType: string | null;
};

export function rateLimitFrom(ev: Extract<ChatEvent, { type: "rateLimit" }>): RateLimitState {
  return { status: ev.status, resetsAt: ev.resetsAt, limitType: ev.limitType };
}

/** The one status observed on this transport, and the one that means "nothing
 *  to say". Anything else is surfaced, including a status we have never seen:
 *  an unrecognised limit is still a limit, and hiding it because it is not on a
 *  list is how a user finds out from a failed turn instead. */
const ALLOWED = "allowed";

export function isLimited(rl: RateLimitState | null): boolean {
  return rl !== null && rl.status !== "" && rl.status !== ALLOWED;
}

/** "five_hour" -> "5-hour". Wire values are snake_case identifiers meant for a
 *  machine; an unknown one falls through as-is rather than being dropped, since
 *  an unreadable limit type still beats a silent one. */
export function limitTypeLabel(limitType: string | null): string | null {
  if (limitType === null || limitType === "") return null;
  if (limitType === "five_hour") return "5-hour";
  if (limitType === "seven_day") return "7-day";
  return limitType;
}

/** Epoch seconds to a wall-clock time the user can act on, or null when the
 *  wire sent no reset. */
export function resetsAtMs(rl: RateLimitState): number | null {
  return rl.resetsAt === null ? null : rl.resetsAt * 1000;
}

/**
 * What the banner says, or null when there is nothing to say.
 *
 * `now` is passed in rather than read from the clock so the wording is testable
 * without freezing time, and so a reset already in the past reads as "any
 * moment now" instead of as a stale future promise.
 */
export function rateLimitMessage(rl: RateLimitState | null, now: number): string | null {
  if (!isLimited(rl) || rl === null) return null;
  const kind = limitTypeLabel(rl.limitType);
  const subject = kind ? `Your ${kind} limit` : "A usage limit";
  const at = resetsAtMs(rl);
  if (at === null) return `${subject} has been reached (${rl.status}).`;
  if (at <= now) return `${subject} has been reached (${rl.status}). It should reset any moment now.`;
  const when = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${subject} has been reached (${rl.status}). Resets at ${when}.`;
}

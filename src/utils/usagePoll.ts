// When a scheduled quota read may run, and for how long it may not.
//
// Pure decisions with their inputs explicit, the shape `forgePoll.ts` already
// has: `usageProbe.ts` is the thin half that owns the timer and the invoke.
//
// ## What the cost is here
//
// Not a budget. A read spawns `codex app-server`, waits out a handshake and two
// calls, and kills it, so the cost is a process and a second or two of somebody
// else's CPU. That makes the rules about restraint rather than exhaustion:
// nothing runs while the window is hidden (there is no strip to update), the
// background tick is slow, and every trigger shares one floor so a storm of
// focus events is still one read.
//
// The cost is the process, not the read. Claude's account-token rung is one
// request carrying a token that is already in hand, so the rules that exist to
// ration a process do not apply to it: see `spawns`.

/** The background cadence while a Codex chat is open. A five-hour window moves
 *  by a percent every few minutes, so anything faster spends a process to learn
 *  nothing. */
export const POLL_INTERVAL_MS = 5 * 60_000;

/** The shortest gap between two reads, whatever asked for them. Focus is a
 *  storm, not an event: alt-tabbing fires it repeatedly, and a pointer crossing
 *  the strip fires hover the same way. */
export const MIN_GAP_MS = 30_000;

/** The first wait after a failure, doubled per consecutive failure up to
 *  [`MAX_BACKOFF_MS`]. A missing binary or a signed-out account fails instantly
 *  and would otherwise be retried at full cadence forever. */
export const BASE_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

/** The shortest gap between two presses of a refresh control. Long enough that
 *  a press cannot repeat itself before the last answer has landed, short enough
 *  that a second press is not refused for a reason the user cannot see. */
export const MANUAL_GAP_MS = 10_000;

/** Why a read is being asked for. `manual` is the user asking: a source just
 *  switched on, or a refresh pressed. The one case where the answer has to
 *  follow the click. */
export type Trigger = "focus" | "hover" | "interval" | "manual";

/** One agent's read history, plus whatever is currently blocking it. */
export type PollClock = {
  /** Epoch ms of the last read, null when none has ever run. */
  lastPollAt: number | null;
  /** Epoch ms before which nothing may run, null when nothing blocks. */
  blockedUntil: number | null;
};

/** What the app can see about itself, which the rules need and cannot ask for. */
export type PollContext = {
  /** False while the window is hidden or minimised. */
  visible: boolean;
  /** Whether a chat on this agent is open, which is the only thing that makes
   *  the background tick worth running. */
  chatOpen: boolean;
  /** Whether this account's read spawns a process. The one that does not is a
   *  single request against a token already in memory, and holding that to a
   *  chat being open is what left the strip dimmed for want of a read nobody
   *  would have noticed. */
  spawns: boolean;
};

export function mayPoll(clock: PollClock, trigger: Trigger, now: number, ctx: PollContext): boolean {
  // First and unconditional. A hidden window has no strip to update and no
  // notification the user would see sooner for it.
  if (!ctx.visible) return false;
  // The user's own ask outranks the backoff: a failure's wait is for the timer,
  // and a press that is refused for it has nothing to show why. What a press
  // still cannot do is repeat itself faster than an answer can land, which is
  // how a refresh button hammered turned into a 429.
  if (trigger === "manual") {
    return clock.lastPollAt === null || now - clock.lastPollAt >= MANUAL_GAP_MS;
  }
  if (clock.blockedUntil !== null && now < clock.blockedUntil) return false;
  // The background tick is the only one that needs a reason to exist; focus and
  // hover are somebody looking at the strip, and it is on screen either way.
  // The reason is the process, so a read that spawns none does not need one.
  if (trigger === "interval" && ctx.spawns && !ctx.chatOpen) return false;
  if (clock.lastPollAt === null) return true;

  const since = now - clock.lastPollAt;
  return trigger === "interval" ? since >= POLL_INTERVAL_MS : since >= MIN_GAP_MS;
}

/** When the next read may run after `failures` consecutive failures. Doubling,
 *  capped, and computed rather than stored so a success only has to reset the
 *  count. */
export function backoffUntil(failures: number, now: number): number {
  if (failures <= 0) return now;
  const wait = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  return now + wait;
}

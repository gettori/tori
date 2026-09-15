// When the forge may be polled, and for how long it may not.
//
// Pure decisions with their inputs explicit, so the schedule is testable without
// a clock, a network, or a window. The store in `forgeStatus.ts` is the thin
// half that owns the timer and the invoke.
//
// ## The budget is the constraint, not the latency
//
// GitHub gives one token 5,000 points an hour, and a batched status tick over
// twenty branches costs about twenty of them. Nothing here is about being fast;
// every rule exists to stop idle polling from spending a budget the user needs
// for the things they actually clicked on. Hence a long interval, a floor that
// stops polling well before the budget is gone, and a hard stop on both of
// GitHub's rate limits rather than only the obvious one.

import type { AuthState, ForgeErrorDto, RateSnapshot, RepoAccount } from "./forgeTypes";
import { isForgeError } from "./forgeTypes";

/// The background cadence. Two minutes rather than seconds: a check run takes
/// minutes to finish, so a faster tick would spend budget to learn nothing.
export const POLL_INTERVAL_MS = 120_000;

/// The shortest gap between two ticks for one project.
///
/// Focus is a storm, not an event: alt-tabbing through windows fires it
/// repeatedly, and every fire would otherwise be a request.
export const MIN_GAP_MS = 30_000;

/// Requests left in the hour below which background polling stops.
///
/// Stopping *before* the budget is gone is the whole point. Polling to
/// exhaustion means the next thing the user clicks (open a PR, load a review) is
/// the request that gets refused, which is the one failure they will notice.
export const RATE_FLOOR = 200;

/// How long to wait out a primary limit that named no deadline.
///
/// The primary budget resets on a wall-clock hour boundary Sway does not know
/// unless the last answered call happened to carry it, so this is a re-probe
/// interval rather than a guess at the reset: four wasted requests an hour.
export const PRIMARY_BACKOFF_MS = 15 * 60_000;

/// The secondary limit is an anti-abuse throttle measured in seconds, and it
/// almost always names its own `Retry-After`. This is only the fallback.
export const SECONDARY_BACKOFF_MS = 60_000;

/// How long a project whose remote the forge cannot serve is left alone.
///
/// Not permanent: `git remote add origin` is a thing people do, and a project
/// stuck inert until restart would look broken. Ten minutes is cheap because the
/// retry costs no HTTP request at all, only a resolve that fails locally.
export const NO_REMOTE_BACKOFF_MS = 10 * 60_000;

/// Why polling is stopped, or null when it is not.
export type PauseReason = "disabled" | "signedOut" | "suspect" | "pickAccount";

/// The mirror of `AuthCore::may_call`, in the shape the UI needs: not just
/// whether polling may run, but which of the three independent noes said so, so
/// the sidebar can offer the right thing (turn it back on, sign in, sign back
/// in) instead of one useless "unavailable".
export function pauseReason(auth: AuthState, enabled: boolean): PauseReason | null {
  // The kill switch is checked first because it is the one the user chose. A
  // signed-out account with the integration off should read as off.
  if (!enabled) return "disabled";
  if (auth.kind === "signedOut") return "signedOut";
  if (auth.kind === "suspect") return "suspect";
  return null;
}

/// `pauseReason` for one checkout, through the account it resolved to. Two
/// accounts pause independently: a rejected token stops only its own repos.
export function projectPause(
  repo: RepoAccount,
  auth: (accountId: string) => AuthState,
  enabled: boolean,
): PauseReason | null {
  if (!enabled) return "disabled";
  switch (repo.kind) {
    case "account":
      return pauseReason(auth(repo.accountId), enabled);
    case "pick":
      return "pickAccount";
    case "noAccount":
      // No remote at all is not a sign-in problem. Rust answers `noRemote` and
      // the project backs off on its own.
      return repo.host === null ? null : "signedOut";
  }
}

export type Trigger = "focus" | "interval" | "manual";

/// One project's poll history, plus whatever is currently blocking the account.
export type PollClock = {
  /** Epoch ms of this project's last tick, null when it has never run. */
  lastPollAt: number | null;
  /** Epoch ms before which nothing may poll at all, null when nothing blocks. */
  blockedUntil: number | null;
};

export function mayPoll(
  clock: PollClock,
  trigger: Trigger,
  now: number,
  pause: PauseReason | null,
): boolean {
  if (pause !== null) return false;
  // A block outlasts a manual refresh on purpose: hitting refresh during a rate
  // limit is how a throttle becomes a longer throttle.
  if (clock.blockedUntil !== null && now < clock.blockedUntil) return false;
  if (trigger === "manual") return true;
  if (clock.lastPollAt === null) return true;
  return now - clock.lastPollAt >= MIN_GAP_MS;
}

/// How wide a backoff reaches.
///
/// A rate limit belongs to the token, so it stops every project on that account;
/// a remote the forge cannot serve belongs to the one repo. Blocking the account
/// for a GitLab checkout would let one unrelated project silence the rest.
export type Backoff = { scope: "account" | "project"; untilMs: number };

/// What a failed tick means for the schedule, or null when it means nothing.
///
/// A transport failure deliberately returns null: an offline laptop retrying on
/// the normal interval costs nothing (the request never leaves the machine), and
/// backing off would leave Sway quiet for minutes after the network came back.
export function backoffAfter(err: unknown, now: number): Backoff | null {
  if (!isForgeError(err)) return null;
  const dto: ForgeErrorDto = err;
  switch (dto.kind) {
    case "rateLimited": {
      // `Retry-After` first: it is an instruction, not an estimate, and it is
      // what a secondary limit sends.
      if (dto.retryAfterSecs != null) {
        return { scope: "account", untilMs: now + dto.retryAfterSecs * 1000 };
      }
      // Then the primary budget's own refill time, in **seconds**. This is the
      // number a 403 actually carries, and using it is the difference between
      // resuming on time and sitting out the fallback below for no reason.
      if (dto.resetAtSecs != null) {
        return { scope: "account", untilMs: Math.max(dto.resetAtSecs * 1000, now) };
      }
      // Neither. Which limit it was decides how long to wait, which is why the
      // kind rides on the error rather than being inferred from the sentence.
      const fallback =
        dto.rateLimitKind === "secondary" ? SECONDARY_BACKOFF_MS : PRIMARY_BACKOFF_MS;
      return { scope: "account", untilMs: now + fallback };
    }
    case "noRemote":
    case "unsupportedRemote":
      return { scope: "project", untilMs: now + NO_REMOTE_BACKOFF_MS };
    // `credentialSuspect` is absent on purpose: the pause for it comes from the
    // auth state, which every caller already checks, and duplicating it as a
    // timed block would keep polling paused for minutes after a re-sign-in.
    default:
      return null;
  }
}

/// What the budget left over from the last answered call means for the schedule.
///
/// The pre-emptive half of the same rule `backoffAfter` handles reactively:
/// backing off only once refused means the refusal always lands on somebody's
/// click.
export function budgetBackoff(rate: RateSnapshot, now: number): Backoff | null {
  if (rate.remaining === null || rate.remaining >= RATE_FLOOR) return null;
  // `resetAt` is epoch **seconds**, as the header sends it. A reset already in
  // the past means the budget is about to refill, so the block ends now rather
  // than being read as a time long gone.
  const until = rate.resetAt === null ? now + PRIMARY_BACKOFF_MS : rate.resetAt * 1000;
  return { scope: "account", untilMs: Math.max(until, now) };
}

/// The branches to ask about, in the order the tick should spend its cap on.
///
/// On-screen units first: the cap has to fall on *something*, and the only
/// defensible thing for it to fall on is what nobody is looking at. Units with
/// no branch (a `plain-dir` folder) are dropped rather than ordered, since there
/// is nothing the forge could be asked about them.
export function askOrder(units: readonly { branch: string | null; visible: boolean }[]): string[] {
  const named = units.filter((u) => u.branch !== null && u.branch !== "");
  return [
    ...named.filter((u) => u.visible).map((u) => u.branch as string),
    ...named.filter((u) => !u.visible).map((u) => u.branch as string),
  ];
}

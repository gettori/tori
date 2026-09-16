// What a quota window is worth telling the user about, and what to say.
//
// Three measurements off the captures drive the whole shape of this:
//
//   1. **`rate_limit_event` fires on every turn, and its status is usually
//      `allowed`.** So "surface rate limits" cannot mean "render on the event":
//      that would pin a permanent banner to every chat announcing that nothing
//      is wrong, which is how a warning stops being read.
//   2. **`allowed_warning` is not a limit in force.** Five captured frames read
//      `{"status":"allowed_warning","utilization":0.88,"surpassedThreshold":0.75}`.
//      The predecessor of this module treated every status that was not
//      `allowed` as a limit already hit, so those frames put up a banner saying
//      the limit "has been reached (allowed_warning)" from 75% on - wrong about
//      the state and leaking the wire's own word into the sentence.
//   3. **`resetsAt` is in seconds, not milliseconds.** 1785179400 is 2026-07-26;
//      read as millis it would be 1970. Both scales look equally plausible in a
//      small fixture, which is exactly the trap
//      `lesson_synthetic_test_values_hide_unit_bugs` describes, so the
//      conversion happens here, once, named, and is pinned by a test using the
//      real captured magnitude rather than a round number.
//
// One vocabulary, shared with Tori's own ceilings in `chatBudget.ts`: ok says
// nothing, approaching is a heads-up, reached is a limit in force. `expired`
// is the fourth answer this side needs and ceilings do not: a quota window
// resets on a clock, so a level can be known to be wrong rather than merely old.
import type { ChatEvent } from "./chatTypes";

/** The newest `rate_limit_event`, whatever it said. */
export type RateLimitState = {
  status: string;
  /** Epoch **seconds**, as the wire sends it. Converted at the one point of
   *  use below rather than at the boundary, so the field keeps the wire's
   *  units and cannot be silently reinterpreted by a second reader. */
  resetsAt: number | null;
  limitType: string | null;
  /** About `limitType` alone, which is why it is not folded into `windows`. */
  utilization: number | null;
  windows: { kind: string; utilization: number; resetsAt: number | null }[];
  /** Whether overage spending is available, **not** whether a limit is hit:
   *  every captured `allowed` frame carries `overageStatus: "rejected"`. */
  overageStatus: string | null;
};

export function rateLimitFrom(ev: Extract<ChatEvent, { type: "rateLimit" }>): RateLimitState {
  return {
    status: ev.status,
    resetsAt: ev.resetsAt,
    limitType: ev.limitType,
    utilization: ev.utilization,
    windows: ev.windows,
    overageStatus: ev.overageStatus,
  };
}

/**
 * One window's level as some source reported it.
 *
 * Source-neutral on purpose: a Claude passive frame, a Codex `app-server` read
 * and an account-token read all land here, and the state machine below must not
 * be able to tell them apart. `status` is the harness's own word (null for a
 * source that has none) and `reachedType` is a source's own "you have hit this"
 * flag, which outranks the level.
 */
export type QuotaReading = {
  /** The source's own window name (`five_hour`, `seven_day`), never an enum. */
  kind: string;
  /** 0 to 1, or null when the source named the window without a level. */
  utilization: number | null;
  /** Epoch **seconds**. */
  resetsAt: number | null;
  status: string | null;
  /** Codex's `rateLimitReachedType`: which limit was hit, or null for none. */
  reachedType: string | null;
};

export type QuotaState = "ok" | "approaching" | "reached" | "expired";

/** The one status that means "nothing to say", and the two that mean something
 *  specific. Anything else is a status no capture has shown; see `quotaState`
 *  for why an unknown one is surfaced rather than dropped. */
const ALLOWED = "allowed";
const WARNING = "allowed_warning";
const REJECTED = "rejected";

/**
 * Which of the four things this reading is.
 *
 * The precedence is the whole design:
 *
 * - **Expiry first.** A level from a window that has since reset is not a level,
 *   it is a memory. Checked after `reached`, a 100% five-hour window would keep
 *   a blocking banner up for the hours after the reset that cleared it.
 * - **`reached` outranks the level.** A `rejected` status, or a source's own hit
 *   flag, is the source saying it refused work; 100% is only Tori's arithmetic
 *   agreeing. Either wins over the threshold below.
 * - **The threshold applies only under that.** `warnAt` outside (0, 1) disables
 *   `approaching` and nothing else, mirroring `chatBudget.approaching`: 100% is
 *   the "off" stop on the shared control, and off must never silence a limit
 *   that is already in force.
 */
export function quotaState(r: QuotaReading, warnAt: number, now: number): QuotaState {
  const at = resetsAtMs(r.resetsAt);
  if (at !== null && at <= now) return "expired";

  if (r.status === REJECTED || r.reachedType) return "reached";
  if (r.utilization !== null && r.utilization >= 1) return "reached";

  if (typeof warnAt !== "number" || warnAt <= 0 || warnAt >= 1) return "ok";

  if (r.utilization !== null && r.utilization >= warnAt) return "approaching";
  if (r.status === WARNING) return "approaching";
  // A status no capture has shown is still surfaced: a limit nobody has a name
  // for is still a limit, and hiding it because it is not on a list is how a
  // user finds out from a failed turn instead. Approaching rather than reached,
  // because an unrecognised word is not evidence that anything stopped.
  if (r.status !== null && r.status !== "" && r.status !== ALLOWED) return "approaching";
  return "ok";
}

/**
 * The three bands a level is painted in, on every surface that draws one.
 *
 * Fixed rather than read off the account's Warn at, which governs when Tori
 * *says* something (the chat's banner, the notification). Colour is a scale the
 * eye reads without a legend: green is fine and paints only the bar, orange is
 * worth knowing and paints the figure too, red is nearly out. A user who moved
 * their warn point to 90% still wants a bar at 85% to look like one.
 */
export type QuotaBand = "none" | "clear" | "warm" | "hot";
export const WARM_AT = 0.6;
export const HOT_AT = 0.8;

export function quotaBand(r: QuotaReading, state: QuotaState): QuotaBand {
  // A window that has since reset has no level to paint, and a source saying
  // it refused work is red whatever number it sent with that.
  if (state === "expired") return "none";
  if (state === "reached") return "hot";
  if (r.utilization === null) return "none";
  if (r.utilization >= HOT_AT) return "hot";
  return r.utilization >= WARM_AT ? "warm" : "clear";
}

/** The separator the card's window names are drawn with, written as its code
 *  point so the file itself stays ASCII. */
const DOT = " \u00b7 ";

/**
 * One vocabulary for the windows, in the three lengths the surfaces need.
 *
 * `label` is the name a card has room for, `short` is what the titlebar has room
 * for (one or two characters, since the strip is scanned rather than read), and
 * `inline` is the form a sentence can carry: no card name survives being dropped
 * into "your ... limit", and the chat's notice is the one place these names have
 * to be read rather than scanned.
 */
const NAMES: Record<string, { label: string; short: string; inline: string }> = {
  five_hour: { label: `Session${DOT}5h rolling`, short: "5H", inline: "rolling 5-hour" },
  seven_day: { label: `Week${DOT}all models`, short: "W", inline: "weekly all-model" },
  extra_usage: { label: "Extra usage", short: "Extra", inline: "extra usage" },
};

/**
 * The model families a weekly window can be scoped to, weakest first (the order
 * a catalogue is ranked in when no read has named one yet).
 *
 * The one list here, and it exists because the endpoint spells its non-model
 * weeks exactly like its model ones. A capture of a Max account carries
 * `seven_day_oauth_apps`, `seven_day_cowork` and `seven_day_omelette` beside
 * `seven_day_opus` and `seven_day_sonnet`, so "starts with `seven_day_`" reads
 * `seven_day_overage_included` as a model called "Overage included". A family
 * word in the suffix is what tells the two apart; a model whose family is not
 * yet listed degrades to the qualifier below, which is the harmless direction.
 */
export const MODEL_FAMILIES = ["haiku", "sonnet", "opus", "fable"];

/** The words after `seven_day_`, spaced, or null when there are none. */
function weekSuffix(limitType: string): string | null {
  if (!limitType.startsWith("seven_day_")) return null;
  const words = limitType.slice("seven_day_".length).replace(/_/g, " ").trim();
  return words === "" ? null : words;
}

const titled = (words: string) => `${words[0].toUpperCase()}${words.slice(1)}`;

/** The model a weekly window is scoped to, titled, or null for a window that is
 *  not one. Titled rather than looked up: the endpoint names the window after
 *  the model's own display name, so the family word confirms it is a model and
 *  the suffix supplies what it is called. */
export function scopedModel(limitType: string): string | null {
  const words = weekSuffix(limitType);
  if (words === null) return null;
  return words.split(" ").some((w) => MODEL_FAMILIES.includes(w)) ? titled(words) : null;
}

/** What else a weekly window is scoped to, in the endpoint's own words, or null
 *  for one scoped to a model or to nothing. Kept lower case and read as a
 *  qualifier ("Week - overage included"), never as a name, since the thing on
 *  the other end of it is not something anyone can chat with. */
export function weekQualifier(limitType: string): string | null {
  return scopedModel(limitType) === null ? weekSuffix(limitType) : null;
}

/** A model-scoped weekly window's full name, for a caller naming one before any
 *  read has confirmed which model it is scoped to. */
export function modelWeekLabel(model: string | null): string {
  return `Week${DOT}${model === null ? "one model" : `${model} only`}`;
}

/** A weekly window scoped to something other than a model, named before any read
 *  has said what. */
export const OTHER_WEEK_LABEL = `Week${DOT}other scope`;

/** The same window on the strip, where a model gets one letter: the bar beside
 *  it is what carries the meaning, and the row has three of these to fit. */
export function modelWeekShort(model: string): string {
  return model.slice(0, 1).toUpperCase();
}

/** "five_hour" -> "Session / 5h rolling". Wire values are snake_case identifiers
 *  meant for a machine; an unknown one falls through as-is rather than being
 *  dropped, since an unreadable window name still beats a silent one. */
export function limitTypeLabel(limitType: string | null): string | null {
  if (limitType === null || limitType === "") return null;
  const known = NAMES[limitType];
  if (known) return known.label;
  const model = scopedModel(limitType);
  if (model) return modelWeekLabel(model);
  const qualifier = weekQualifier(limitType);
  return qualifier ? `Week${DOT}${qualifier}` : limitType;
}

/** The same window, in the width the titlebar has: "5H", "W", "F". A window
 *  scoped to something that is not a model still gets its letter: the strip has
 *  room for one either way, and the bar beside it is what carries the meaning. */
export function limitTypeShort(limitType: string): string {
  const known = NAMES[limitType]?.short;
  if (known) return known;
  const model = scopedModel(limitType);
  if (model) return modelWeekShort(model);
  const qualifier = weekQualifier(limitType);
  return qualifier ? qualifier[0].toUpperCase() : limitType;
}

/** The same window on a settings chip: "5H", "Week", "Fable". A word rather
 *  than the strip's letter, because a chip is the control that decides what the
 *  strip shows and has to be readable before the reader has learned the
 *  letters. */
export function limitTypeChip(limitType: string): string {
  if (limitType === "seven_day") return "Week";
  const qualifier = weekQualifier(limitType);
  return scopedModel(limitType) ?? (qualifier ? titled(qualifier) : limitTypeShort(limitType));
}

/** The same window as a sentence carries it, lower case and singular. */
export function limitTypeInline(limitType: string): string {
  const known = NAMES[limitType]?.inline;
  if (known) return known;
  const model = scopedModel(limitType);
  if (model) return `weekly ${model}`;
  const qualifier = weekQualifier(limitType);
  return qualifier ? `weekly ${qualifier}` : limitType;
}

/** Epoch seconds to a wall-clock time the user can act on, or null when the
 *  source sent no reset. */
export function resetsAtMs(resetsAt: number | null): number | null {
  return resetsAt === null ? null : resetsAt * 1000;
}

/** A weekly window resets days out, so a bare clock time would read as today.
 *  The weekday is added only when it is not. */
function whenLabel(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/**
 * What one window says, or null when it has nothing to say.
 *
 * `now` is passed in rather than read from the clock so the wording is testable
 * without freezing time. The harness's own status word never reaches the
 * sentence: `allowed_warning` is a wire token, and a user told their limit "has
 * been reached (allowed_warning)" has been told two wrong things at once.
 */
export function windowSentence(r: QuotaReading, warnAt: number, now: number): string | null {
  const state = quotaState(r, warnAt, now);
  if (state === "ok") return null;

  const kind = r.kind ? limitTypeInline(r.kind) : null;
  const subject = kind ? `your ${kind} limit` : "a usage limit";
  const Subject = subject[0].toUpperCase() + subject.slice(1);

  // No percentage: the level belongs to a window that has since reset, so
  // reporting it would describe a quota that no longer exists.
  if (state === "expired") return `${Subject} has reset.`;

  const at = resetsAtMs(r.resetsAt);
  const resets = at === null ? "" : ` Resets ${whenLabel(at, now)}.`;
  if (state === "reached") return `${Subject} has been reached.${resets}`;

  const pct = r.utilization === null ? null : Math.round(r.utilization * 100);
  return pct === null
    ? `${Subject} is close.${resets}`
    : `You have used ${pct}% of ${subject}.${resets}`;
}

/**
 * How long each window kind runs, in seconds.
 *
 * Needed because no source sends the window's *start*: it sends a level and a
 * reset, and the elapsed fraction is the missing half of any rate. The two
 * durations are in the names, which is the only reason this is derivable at
 * all; a kind not on this list gets no projection rather than a guessed one.
 */
const WINDOW_SECONDS: Record<string, number> = {
  five_hour: 5 * 60 * 60,
  seven_day: 7 * 24 * 60 * 60,
};

/**
 * When this window runs out at the rate it has been used so far, or null.
 *
 * **Null is the common answer and the useful one.** A pace line is worth
 * showing only when the straight-line projection lands *before* the reset,
 * because that is the case where carrying on as you are runs you out. Any
 * projection past the reset says you are fine, which the bar already says.
 *
 * Null too for: a window whose duration is not known, a level of zero or none
 * (no rate to project), a window already reached or expired (the projection is
 * about a future that has happened), and a `now` before the window began.
 */
export function paceOutAt(r: QuotaReading, now: number): number | null {
  const seconds = WINDOW_SECONDS[r.kind];
  const at = resetsAtMs(r.resetsAt);
  if (seconds === undefined || at === null || at <= now) return null;
  if (r.utilization === null || r.utilization <= 0 || r.utilization >= 1) return null;

  const started = at - seconds * 1000;
  const elapsed = now - started;
  if (elapsed <= 0) return null;

  // Straight-line: `utilization` of the window took `elapsed`, so the whole of
  // it takes `elapsed / utilization`.
  const out = started + elapsed / r.utilization;
  return out < at ? out : null;
}

/**
 * The windows one `rate_limit_event` reported.
 *
 * A frame carrying `unifiedWindows` names every window it knows; one without it
 * names exactly one, through `rateLimitType`, and its `utilization` is about
 * that one alone. Folding the second shape into the first would report a level
 * for a window the frame never mentioned.
 */
export function readingsOf(rl: RateLimitState | null): QuotaReading[] {
  if (rl === null) return [];
  if (rl.windows.length) {
    return rl.windows.map((w) => ({
      kind: w.kind,
      utilization: w.utilization,
      resetsAt: w.resetsAt,
      // The frame's status is about `limitType`, so it is carried only onto the
      // window it is about. A `rejected` on the five-hour window must not mark
      // the weekly one as reached.
      status: w.kind === rl.limitType ? rl.status : null,
      reachedType: null,
    }));
  }
  if (rl.limitType === null) return [];
  return [
    {
      kind: rl.limitType,
      utilization: rl.utilization,
      resetsAt: rl.resetsAt,
      status: rl.status,
      reachedType: null,
    },
  ];
}

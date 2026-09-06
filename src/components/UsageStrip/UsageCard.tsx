import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Clock, RefreshCw } from "lucide-solid";
import AgentGlyph from "../Icon/AgentGlyph";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import Popover from "../Popover/Popover";
import { findAdapter } from "../../utils/agents";
import { agentHealthFor, asProfileId, asTabProfile, namedProfiles, profileLabel } from "../../utils/agentHealth";
import {
  limitTypeInline,
  limitTypeLabel,
  paceOutAt,
  quotaBand,
  quotaState,
  resetsAtMs,
  windowSentence,
} from "../../utils/chatRateLimit";
import { catalogFor } from "../../utils/modelCatalog";
import { usageWarnAt } from "../../utils/usageSettings";
import { canPollUsage, pollUsage, usageIdentity, usageReading, usageReason } from "../../utils/usageProbe";
import { temporalOf, windowsFor, type WindowReading } from "../../utils/usageStore";
import styles from "./UsageCard.module.css";

// What the strip is short for.
//
// **Opens on hover, stays on click.** A card under the pointer is there to be
// read, and the click is the decision to keep it while the pointer goes
// elsewhere. Nothing on it writes a setting: the quota controls live on the
// account's settings card, so nothing here can be changed by accident on the
// way to somewhere else.
//
// **One card, every account.** The strip is one row per login and this is the
// same shape opened up: the account row switches which of them the windows below
// belong to, so comparing two logins is a click rather than a second hover.
//
// Reuses `Popover` rather than adding a HoverCard door to the primitives. The
// hover timing belongs to the strip (it is the thing the pointer is on and off);
// what a popover owns is dismissal, focus and portalling, which is the same here
// as it is for the history dropdown.

/** The separator this card's lines are drawn with, written as its code point so
 *  the file itself stays ASCII. */
const DOT = " \u00b7 ";

/** A plan as a reader would write it. The wire sends enum tokens (`plus`,
 *  `self_serve_business_prolite`), and an unknown one is reshaped rather than
 *  dropped: a plan Sway has not heard of is still this account's plan. */
function planLabel(planType: string | null): string | null {
  if (!planType || planType === "unknown") return null;
  const words = planType.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

const clockAt = (at: number): string =>
  new Date(at)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(" ", "");

/**
 * When this window empties, in the shape the distance calls for.
 *
 * Inside a day the countdown is the answer ("4h 34m") and the clock time is the
 * detail beside it; a weekly window resets days out, where a bare time would
 * read as today, so the weekday is what carries it.
 */
function whenLine(at: number | null, now: number): string | null {
  if (at === null) return null;
  const left = at - now;
  if (left <= 0) return "resetting";
  if (left < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(left / (60 * 60 * 1000));
    const mins = Math.floor((left % (60 * 60 * 1000)) / 60_000);
    return `${hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}${DOT}${clockAt(at)}`;
  }
  return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${clockAt(at)}`;
}

/** How long ago the newest reading landed. The card's one word about freshness,
 *  in place of a source and a timestamp per row: what a reader is checking is
 *  whether the numbers are current, not which rung fetched them. */
function agoLine(sampledAt: number | null, now: number): string | null {
  if (sampledAt === null) return null;
  const secs = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/** How long the card is, per row, from a source's own reading. */
function windowLine(w: WindowReading, warnAt: number, now: number) {
  const state = quotaState(w, warnAt, now);
  const pct = w.utilization === null ? null : w.utilization * 100;
  return {
    kind: w.kind,
    name: limitTypeLabel(w.kind) ?? w.kind,
    state,
    band: quotaBand(w, state),
    temporal: temporalOf(w, now),
    fill: pct === null ? 0 : Math.min(100, pct),
    // No percentage past the reset: the level belongs to a window that has
    // since emptied, and printing it beside the word "reset" is the one
    // contradiction this card must not put on screen.
    level: state === "expired" || pct === null ? null : `${pct.toFixed(1)}%`,
    when: state === "expired" ? "reset" : whenLine(resetsAtMs(w.resetsAt), now),
  };
}

/**
 * Every window Sway has a reading for, whatever the chips say.
 *
 * The chips decide what the titlebar carries, and only that. This card is the
 * place you come to for the whole picture, so a window switched off the strip is
 * still here: hiding a bar is not the same as not wanting to know. What the card
 * cannot show is a window nothing has read, and for the model week that is what
 * an unlit chip means, since lighting it is what authorises the read.
 */
function readWindows(agentId: string, profile: string | null): WindowReading[] {
  return windowsFor(agentId, profile);
}

/**
 * The card's one sentence about where this is heading.
 *
 * Two clauses, and both earn their place. The first is about the account on
 * screen: a limit in force, or a straight-line projection that runs out before
 * the reset, or the fact that neither is true. The second names the *other*
 * login only when it is the one in trouble, which is the case a strip glance
 * misses: you read the row you are signed into and the row beside it is the one
 * about to stop working.
 */
function paceSentence(
  agentId: string,
  profile: string,
  now: number,
): string | null {
  const tab = asTabProfile(profile);
  const warnAt = usageWarnAt(agentId, tab);
  const mine = readWindows(agentId, tab);
  if (mine.length === 0) return null;

  const state = (w: WindowReading) => quotaState(w, warnAt, now);
  const hit = mine.find((w) => state(w) === "reached");
  const soon = mine
    .map((w) => ({ w, out: paceOutAt(w, now) }))
    .filter((p): p is { w: WindowReading; out: number } => p.out !== null)
    .sort((a, b) => a.out - b.out)[0];
  const near = mine.find((w) => state(w) === "approaching");

  const first = hit
    ? windowSentence(hit, warnAt, now)
    : soon
      ? `At this pace your ${limitTypeInline(soon.w.kind)} limit runs out around ${clockAt(soon.out)}.`
      : near
        ? windowSentence(near, warnAt, now)
        : "Comfortable all week at this pace.";

  const second = otherAccountClause(agentId, profile, now);
  return [first, second].filter(Boolean).join(" ");
}

/** The other login worth naming, or nothing. Nothing is the common answer: a
 *  second account nobody is near the limit of is not news. */
function otherAccountClause(agentId: string, profile: string, now: number): string | null {
  let worst: { label: string; pct: number; kind: string; at: number | null } | null = null;
  for (const p of namedProfiles(agentId)) {
    if (p.id === profile) continue;
    const tab = asTabProfile(p.id);
    const warnAt = usageWarnAt(agentId, tab);
    for (const w of readWindows(agentId, tab)) {
      const state = quotaState(w, warnAt, now);
      if (state !== "approaching" && state !== "reached") continue;
      const pct = (w.utilization ?? 0) * 100;
      if (worst && worst.pct >= pct) continue;
      worst = { label: p.label, pct, kind: w.kind, at: resetsAtMs(w.resetsAt) };
    }
  }
  if (worst === null) return null;
  const resets =
    worst.at === null
      ? ""
      : `, resets ${new Date(worst.at).toLocaleDateString([], { weekday: "long" })} ${clockAt(worst.at)}`;
  return `${worst.label} is the one to watch, ${worst.pct.toFixed(1)}% used on its ${limitTypeInline(worst.kind)} limit${resets}.`;
}

export default function UsageCard(props: {
  agentId: string;
  /** The backend's spelling, so `"default"` rather than null. */
  profile: string;
  anchorEl: HTMLElement;
  /** Pinned by a click: leaving no longer closes it. */
  pinned: boolean;
  now: number;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  /** The account the tabs are pointing at, which starts as the row the strip
   *  was hovered on and follows it when the pointer moves to another row. */
  const [picked, setPicked] = createSignal<string | null>(null);
  createEffect(on(() => props.profile, () => setPicked(null), { defer: true }));
  const shown = () => picked() ?? props.profile;

  const tab = () => asTabProfile(shown());
  const adapter = () => findAdapter(props.agentId);
  const label = () => profileLabel(props.agentId, tab()) ?? adapter().label;
  const accounts = () => namedProfiles(props.agentId);

  /**
   * The email, from whichever of the three things knows it.
   *
   * `namedProfiles` is empty on a one-account install by design ("Default" is a
   * word for the only thing there is), and that install is the common case, so
   * the sweep's top-level answer is the same probe asked for the default
   * account. Codex answers neither, and reaches the card through its usage
   * probe instead.
   */
  const account = () => {
    const named = accounts().find((p) => p.id === shown())?.account;
    if (named) return named;
    if (shown() !== asProfileId(null)) return null;
    // Third place, and for Codex the only one: its `login status` answers in an
    // exit code and names nobody, so the email exists solely on the same
    // exchange the windows came from.
    return agentHealthFor(props.agentId)?.account ?? identity()?.email ?? null;
  };

  const identity = () => usageIdentity(props.agentId, tab());
  const credits = () => {
    const c = identity()?.credits;
    if (!c) return null;
    if (c.unlimited) return "unlimited credits";
    // A balance nobody has is not news, and every account without credits
    // reports the same "0". Only a balance there is something to spend.
    return c.hasCredits && c.balance ? `${c.balance} credits` : null;
  };

  /** Plan, models, credits: what this account *is*, as against what it has left. */
  const plan = () => {
    const models = catalogFor(props.agentId, tab())?.catalogue?.models?.length ?? 0;
    return [planLabel(identity()?.planType ?? null), models > 0 ? `${models} models` : null, credits()]
      .filter(Boolean)
      .join(DOT);
  };

  const warnAt = () => usageWarnAt(props.agentId, tab());
  const lines = () => readWindows(props.agentId, tab()).map((w) => windowLine(w, warnAt(), props.now));

  // The stamp has its own second hand. `props.now` is the strip's minute tick,
  // which is right for a reset and wrong here: a stamp that says "59s ago" and
  // holds it for a minute looks like a refresh that did nothing.
  const [second, setSecond] = createSignal(Date.now());
  onMount(() => {
    const tick = setInterval(() => setSecond(Date.now()), 1000);
    onCleanup(() => clearInterval(tick));
  });
  const ago = () => {
    const read = readWindows(props.agentId, tab()).map((w) => w.sampledAt);
    return agoLine(read.length > 0 ? Math.max(...read) : null, second());
  };

  return (
    <Popover
      anchorEl={props.anchorEl}
      onClose={props.onClose}
      placement="bottom-end"
      class={styles.card}
      aria-label={`${label()} usage detail`}
    >
      <div onMouseEnter={() => props.onPointerEnter?.()} onMouseLeave={() => props.onPointerLeave?.()}>
        <header class={styles.head}>
          <AgentGlyph id={props.agentId} label={adapter().label} size={24} />
          <span class={styles.who}>{adapter().label}</span>
          <span class={styles.ago}>
            <Show when={ago()}>{(when) => when()}</Show>
            {/* Only where there is a read to run. A sessions-only account gets
                its numbers from chat turns and has nothing to ask; a button
                there would spawn nothing and say it had. `manual` skips the
                rate floor, since a press is not a storm of focus events. */}
            <Show when={canPollUsage(props.agentId, tab())}>
              <IconButton
                size="sm"
                icon={<Icon icon={RefreshCw} />}
                tooltip="Read again"
                onClick={() => pollUsage(props.agentId, "manual", tab())}
                disabled={usageReading(props.agentId, tab())}
              />
            </Show>
          </span>
        </header>

        <div class={styles.accounts}>
          {/* Two logins or more are tabs; one is not a choice, so its email is
              what identifies what you are looking at instead. */}
          <Show
            when={accounts().length > 1}
            fallback={<Show when={account()}>{(email) => <span class={styles.email}>{email()}</span>}</Show>}
          >
            <For each={accounts()}>
              {(p) => (
                <button
                  type="button"
                  class={styles.tab}
                  classList={{ [styles.tabOn]: p.id === shown() }}
                  aria-pressed={p.id === shown()}
                  onClick={() => setPicked(p.id)}
                >
                  {p.label}
                </button>
              )}
            </For>
          </Show>
          <span class={styles.rule} aria-hidden="true" />
          <Show when={plan()}>{(p) => <span class={styles.plan}>{p()}</span>}</Show>
        </div>

        <ul class={styles.windows}>
          <For each={lines()}>
            {(line) => (
              <li
                class={styles.window}
                data-kind={line.kind}
                data-state={line.state}
                data-band={line.band}
                data-temporal={line.temporal}
              >
                <span class={styles.kind}>{line.name}</span>
                <span class={styles.level}>{line.level ?? "-"}</span>
                <span class={styles.when}>{line.when}</span>
                <span class={styles.track} aria-hidden="true">
                  <Show when={line.level !== null}>
                    <span class={styles.fill} style={{ width: `${line.fill}%` }} />
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>

        {/* A tab can be an account nothing has read yet, which is not a blank
            card. */}
        <Show when={lines().length === 0}>
          <p class={styles.empty}>Nothing read for this account yet.</p>
        </Show>

        <Show when={paceSentence(props.agentId, shown(), props.now)}>
          {(sentence) => (
            <p class={styles.pace}>
              <Icon icon={Clock} />
              <span>{sentence()}</span>
            </p>
          )}
        </Show>

        {/* Beside the windows, never instead of them. A rung that cannot answer
            says why while the readings a cheaper rung filled stay on screen. */}
        <Show when={usageReason(props.agentId, tab())}>
          {(why) => <p class={styles.trouble}>{why()}</p>}
        </Show>

        {/* No footer. The notify switch lived here and moved to the account's
            settings card with the rest of the quota controls, and no breakdown
            link ever will: a 7-day view was built and taken out again, since
            the snapshot ring is Sway's record of what *Sway* read, and a stretch
            with Sway shut has no samples in it while the level went on moving.
            What answers the question is above: the level now, and when it
            resets. */}
      </div>
    </Popover>
  );
}

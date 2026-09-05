import { Index, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import AgentGlyph from "../Icon/AgentGlyph";
import UsageCard from "./UsageCard";
import { findAdapter } from "../../utils/agents";
import { asProfileId, asTabProfile, profileLabel } from "../../utils/agentHealth";
import { agentEnabled } from "../../utils/agentEnabled";
import { limitTypeLabel, quotaState, type QuotaState } from "../../utils/chatRateLimit";
import { settings } from "../../panels/Settings/settingsStore";
import { accountOnStrip, usageDetail, usageSource } from "../../utils/usageSettings";
import {
  accountsWithReadings,
  splitAccountKey,
  temporalOf,
  windowsFor,
  type Temporal,
  type WindowReading,
} from "../../utils/usageStore";
import styles from "./UsageStrip.module.css";

// What every account's quota is at, in the titlebar, without opening anything.
//
// One cluster per account rather than per chat, because that is what a quota
// window is: three chats on one login share one five-hour window, and a strip
// that counted chats would show the same number three times and still not
// answer "how much is left".
//
// **Three states, not two.** A reading past its reset is not an old number, it
// is a wrong one, so it renders as the word "reset" with no percentage rather
// than dimmed the way a merely-old reading is. Drawing 98% on a quota that has
// since emptied is the failure this distinction exists to prevent.
//
// Colour comes from the attention and danger roles, never the blocking tier.
// The tier means "this stopped the turn" and `scripts/check-tokens.mjs` check 10
// holds it to exactly two wearers for that reason; a bar in the chrome saying
// an account is out of quota is the same claim the chat's reached banner makes,
// and wears the same role it does.

/** How much of an account's quota the strip draws, per the Detail setting. */
type Detail = "compact" | "standard" | "full";

/**
 * The window kinds every source is normalized to.
 *
 * Anything else is a scoped window (Claude's per-model weekly one), which only
 * `full` draws: it is a second number about the same seven days, and on
 * `standard` it reads as a duplicate of the row above it.
 */
const GENERIC_KINDS = ["five_hour", "seven_day"];

/**
 * Below this the strip drops to one glyph and one bar per account.
 *
 * Measured against the **topbar**, not against the strip itself: the strip's own
 * width is its content's, so collapsing would shrink it below the threshold and
 * it could never tell that space had come back.
 */
const COLLAPSE_BELOW_PX = 900;

export function shouldCollapse(topbarWidth: number): boolean {
  return topbarWidth > 0 && topbarWidth < COLLAPSE_BELOW_PX;
}

/** The window with the least headroom: what a one-bar row has to show, since
 *  the reason to glance at the strip is the limit you are nearest to. */
export function tightestWindow(windows: WindowReading[], now = Date.now()): WindowReading | null {
  const rank: Record<QuotaState, number> = { reached: 3, approaching: 2, ok: 1, expired: 0 };
  const warnAt = settings.budgets?.warnAtFraction ?? 1;
  let best: WindowReading | null = null;
  let bestScore = -1;
  for (const w of windows) {
    const score = rank[quotaState(w, warnAt, now)] * 2 + (w.utilization ?? 0);
    if (score > bestScore) {
      best = w;
      bestScore = score;
    }
  }
  return best;
}

function windowsAtDetail(windows: WindowReading[], detail: Detail, now: number): WindowReading[] {
  if (detail === "compact") {
    const one = tightestWindow(windows, now);
    return one ? [one] : [];
  }
  if (detail === "full") return windows;
  return windows.filter((w) => GENERIC_KINDS.includes(w.kind));
}

/** One account with something to say, in the order the strip draws them. */
type Cluster = {
  agentId: string;
  /** The backend's spelling, so `"default"` rather than null. */
  profile: string;
  isDefault: boolean;
  label: string;
  windows: WindowReading[];
};

function clusters(collapsed: boolean, now: number): Cluster[] {
  const out: Cluster[] = [];
  for (const key of accountsWithReadings()) {
    const { agentId, profile } = splitAccountKey(key);
    if (!agentEnabled(agentId)) continue;
    if (usageSource(agentId) === "off") continue;
    const tab = asTabProfile(profile);
    if (!accountOnStrip(agentId, tab)) continue;

    const isDefault = profile === asProfileId(null);
    const adapter = findAdapter(agentId);
    // A named account is the label a reader needs (two Claude logins are two
    // rows), and the agent's own name is what identifies the default one.
    const label = (isDefault ? adapter.label : profileLabel(agentId, tab)) ?? adapter.label;
    const all = windowsFor(agentId, tab);
    // Collapsed and non-default rows are one bar each. That is the setting the
    // user chose only for the default row; the rest are compact by construction,
    // because the strip's stable anchor is the account you are signed into.
    const detail: Detail = collapsed || !isDefault ? "compact" : usageDetail(agentId);
    out.push({ agentId, profile, isDefault, label, windows: windowsAtDetail(all, detail, now) });
  }
  // Default accounts first, then by agent, so a bar does not move when a second
  // login starts reporting.
  return out.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.agentId.localeCompare(b.agentId) ||
      a.profile.localeCompare(b.profile),
  );
}

/** One window in words: the level, its age when that is worth saying, and where
 *  the number came from. */
export function windowSummary(w: WindowReading, temporal: Temporal, now: number): string {
  const kind = limitTypeLabel(w.kind) ?? w.kind;
  if (temporal === "expired") return `${kind}: reset`;
  const pct = w.utilization === null ? "level unknown" : `${Math.round(w.utilization * 100)}% used`;
  const age = Math.round((now - w.sampledAt) / 60_000);
  const when = temporal === "stale" ? `, last read ${age} min ago` : "";
  return `${kind}: ${pct}${when} (${w.source})`;
}

/**
 * The cluster's accessible name, carrying every window it draws.
 *
 * Not a native `title` on each bar, which is where this started. A `title` is
 * mouse-only hover text, and these bars sit **inside** the cluster's button, so
 * a keyboard user would reach the control and be told nothing about what is on
 * it. The native-tooltip guard (`src/test/interactiveTitle.test.ts`) exists for
 * exactly that shape, and counts the attribute in prose too. The pointer gets
 * the same content, and more of it, from the card this button opens.
 */
function clusterLabel(row: Cluster, now: number): string {
  const windows = row.windows.map((w) => windowSummary(w, temporalOf(w, now), now));
  return [`${row.label} usage`, ...windows].join(", ");
}

function UsageBar(props: { reading: WindowReading; now: number }) {
  const warnAt = () => settings.budgets?.warnAtFraction ?? 1;
  const state = () => quotaState(props.reading, warnAt(), props.now);
  const temporal = () => temporalOf(props.reading, props.now);
  const pct = () =>
    props.reading.utilization === null ? null : Math.round(props.reading.utilization * 100);

  return (
    <span
      class={[
        styles.bar,
        state() === "approaching" ? styles.approaching : "",
        state() === "reached" ? styles.reached : "",
        temporal() === "stale" ? styles.stale : "",
        temporal() === "expired" ? styles.expired : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-kind={props.reading.kind}
      data-state={state()}
      data-temporal={temporal()}
    >
      <span class={styles.kind}>{limitTypeLabel(props.reading.kind) ?? props.reading.kind}</span>
      <Show
        when={temporal() !== "expired"}
        // The level belongs to a window that has since reset, so a percentage
        // here would describe a quota that no longer exists.
        fallback={<span class={styles.figure}>reset</span>}
      >
        <span class={styles.track} aria-hidden="true">
          <Show when={pct() !== null}>
            <span class={styles.fill} style={{ width: `${Math.min(100, pct()!)}%` }} />
          </Show>
        </span>
        <span class={styles.figure}>{pct() === null ? "?" : `${pct()}%`}</span>
      </Show>
    </span>
  );
}

/**
 * How long the pointer rests before the card opens, and how long it may be off
 * both surfaces before it closes.
 *
 * The grace exists because the gap between the strip and the card is real: the
 * popover is portalled and gutter-offset, so a pointer travelling from one to
 * the other is briefly over neither, and a card that closed on `mouseleave`
 * could never be reached.
 */
const HOVER_OPEN_MS = 350;
const HOVER_GRACE_MS = 250;

/** Which account's card is open, and whether a click has pinned it. */
type Opened = { agentId: string; profile: string; anchor: HTMLElement; pinned: boolean };

/**
 * The topbar's quota strip.
 *
 * Renders nothing at all until some account has a reading, which is the honest
 * empty state: an agent Sway has never seen a quota frame from has no quota of
 * zero, it has no quota Sway knows about.
 */
export default function UsageStrip() {
  let el: HTMLDivElement | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const [opened, setOpened] = createSignal<Opened | null>(null);

  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimers = () => {
    if (openTimer !== null) clearTimeout(openTimer);
    if (closeTimer !== null) clearTimeout(closeTimer);
    openTimer = closeTimer = null;
  };
  onCleanup(clearTimers);

  /** The pointer is on the strip or on the card, so nothing is closing. */
  const stay = () => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
  };

  /** The pointer has left one of the two. A pinned card ignores this entirely:
   *  a click is a decision to keep it, and walking away is not undoing it. */
  const leave = () => {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
    if (opened()?.pinned) return;
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => setOpened(null), HOVER_GRACE_MS);
  };

  const hover = (row: Cluster, anchor: HTMLElement) => {
    stay();
    // Already pinned on this account: hovering it again changes nothing, and
    // re-opening would drop the pin.
    if (opened()?.pinned && opened()?.anchor === anchor) return;
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = setTimeout(
      () => setOpened({ agentId: row.agentId, profile: row.profile, anchor, pinned: false }),
      HOVER_OPEN_MS,
    );
  };

  const pin = (row: Cluster, anchor: HTMLElement) => {
    clearTimers();
    setOpened({ agentId: row.agentId, profile: row.profile, anchor, pinned: true });
  };

  // The one transition nothing sends an event for: a window resets on a clock,
  // so without this the strip would keep drawing a level that expired an hour
  // ago. Same 60s tick the chat's banner runs on, and the same reason.
  const [clock, setClock] = createSignal(Date.now());

  onMount(() => {
    const tick = setInterval(() => setClock(Date.now()), 60_000);
    onCleanup(() => clearInterval(tick));

    const topbar = el?.parentElement;
    if (!topbar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setCollapsed(shouldCollapse(entry.contentRect.width)));
    ro.observe(topbar);
    onCleanup(() => ro.disconnect());
  });

  // On the clock as well as on the readings: which window a compact row is
  // nearest to changes when one of them resets, and nothing sends an event for
  // that.
  const rows = createMemo(() => clusters(collapsed(), clock()));

  return (
    <Show when={rows().length > 0}>
      <div class={styles.strip} ref={el} aria-label="Agent usage">
        {/* `Index`, not `For`, and this is load bearing. `clusters()` builds
            fresh objects on every run and `For` is keyed by reference (gotcha
            #64), so a reading landing on any turn boundary would replace every
            button on the strip - including the one a pinned card is anchored
            to, leaving the popover hanging off a removed node. Position is the
            stable key here: rows come and go with accounts, not with readings. */}
        <Index each={rows()}>
          {(row) => (
            <button
              type="button"
              class={[styles.cluster, collapsed() ? styles.tight : ""].filter(Boolean).join(" ")}
              data-agent={row().agentId}
              data-profile={row().profile}
              aria-label={clusterLabel(row(), clock())}
              onMouseEnter={(e) => hover(row(), e.currentTarget)}
              onMouseLeave={leave}
              onClick={(e) => pin(row(), e.currentTarget)}
            >
              <Show when={collapsed() || row().isDefault}>
                <AgentGlyph id={row().agentId} label={row().label} size={14} />
              </Show>
              <Show when={!collapsed()}>
                <span class={styles.name}>{row().label}</span>
              </Show>
              <Index each={row().windows}>{(w) => <UsageBar reading={w()} now={clock()} />}</Index>
            </button>
          )}
        </Index>
      </div>
      <Show when={opened()}>
        {(open) => (
          <UsageCard
            agentId={open().agentId}
            profile={open().profile}
            anchorEl={open().anchor}
            pinned={open().pinned}
            now={clock()}
            onClose={() => {
              clearTimers();
              setOpened(null);
            }}
            onPointerEnter={stay}
            onPointerLeave={leave}
          />
        )}
      </Show>
    </Show>
  );
}

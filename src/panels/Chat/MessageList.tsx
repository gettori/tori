import {
  For,
  Match,
  Show,
  Switch,
  children,
  createEffect,
  createMemo,
  createSignal,
  flush,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import { byKey } from "../../lib/byKey";
import type { JSX } from "@solidjs/web";
import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  EyeOff,
  FoldVertical,
  Info,
  KeyRound,
  TriangleAlert,
  Volume2,
  Webhook,
} from "../../components/Icon/icons";
import {
  hasEarlier,
  turnBlindEdits,
  turnSecretRows,
  turnSecrets,
  windowed,
  queuedText,
  WINDOW_STEP,
  type ChatItem,
  type QuestionItem,
  type SecretRow,
  type TextItem,
  type ToolItem,
  type TurnCheck,
} from "./chatStore";
import { VERDICT_LABEL, verdictDetail } from "../../utils/verification";
import type { PermissionMode, QuestionAnswer, SecretHit } from "../../utils/chatTypes";
import { commandAround, secretLabel } from "../../utils/secretReads";
import { mentionPath } from "../../utils/pathScope";
import Popover from "../../components/Popover/Popover";
import { openWorkspacePath, workspacePath } from "./openPath";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import { speakableBlocks } from "./speakable";
import WorktreeCard, { isWorktreeCard } from "./WorktreeCard";
import ToolCallCard, { type HunkRef } from "./ToolCallCard";
import QuestionCard from "./QuestionCard";
import ToriNoteRow from "./ToriNote";
import PromptFrom from "./PromptFrom";
import { peerPrompt } from "./relatedSessions";
import { findSession } from "../../utils/sessionStore";
import { toriNote } from "../../utils/toriNote";
import type { Answer } from "./PermissionPrompt";
import styles from "./Chat.module.css";
import type { Timestamps } from "../Settings/settingsStore";
import Tooltip from "../../components/Tooltip/Tooltip";
import Markdown from "./Markdown";
import SentPrompt from "./SentPrompt";
import {
  foldEdits,
  groupRuns,
  runLabel,
  thoughtLabel,
  type RunCache,
  type TranscriptRow,
  type WorkRun,
} from "./toolRenderers";
import patterns from "../../styles/patterns.module.css";
import { enterOnce } from "../../utils/enterOnce";

const VERDICT_ICON = { verified: CircleCheck, failed: CircleX, unverified: CircleDashed } as const;

const NONE: ReadonlySet<TranscriptRow> = new Set();
const RISE_AT_MOST = 3;

function appended(was: readonly TranscriptRow[], now: readonly TranscriptRow[]): ReadonlySet<TranscriptRow> {
  const at = was.length ? now.lastIndexOf(was[was.length - 1]) : -1;
  const added = now.length - 1 - at;
  if (at < 0 || at >= was.length || added < 1 || added > RISE_AT_MOST) return NONE;
  // A sliding window drops rows off the top, so `was` can lead with extra ones.
  const dropped = was.length - 1 - at;
  for (let i = 0; i < at; i++) if (now[i] !== was[dropped + i]) return NONE;
  return new Set(now.slice(at + 1));
}

// Every element the row drew: a row is sibling nodes (its turn anchor, then the
// card), and a wrapper would break the list's gap and the anchor's margin.
function rise(view: JSX.Element): JSX.Element {
  const nodes = children(() => view);
  for (const node of untrack(() => nodes.toArray()))
    if (node instanceof HTMLElement) enterOnce(node, patterns.enterRise);
  return <>{nodes()}</>;
}

function ThinkingBlock(props: { text: string; live: boolean; thoughtMs: number }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class={styles.thinking}>
      <button type="button" class={styles.thinkingToggle} onClick={() => setOpen(!open())}>
        {/* Every row that is not the reply now says what it is with a glyph, so
            the kind is read before the words are. `aria-hidden` on all of them:
            the label beside each one already says it, and a second announcement
            is noise on the one output that cannot be skimmed. */}
        <Icon icon={Brain} size={14} aria-hidden="true" />
        <span class={{ [styles.thinkingLive]: props.live }}>
          {open() ? "Hide thinking" : props.live ? "Thinking" : thoughtLabel(props.thoughtMs)}
        </span>
      </button>
      <Show when={open()}>
        <div class={styles.thinkingBody}>{props.text}</div>
      </Show>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "Just now", "Today at 2:32 PM", "Yesterday at 12:12 AM", "10th Jan 2026, 12:12 AM". */
export function stampLabel(at: number, now = Date.now()): string {
  if (now - at < 60_000) return "Just now";
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}

// One clock for every stamp on screen, running only while one is mounted, so
// "Just now" turns into "Today at ..." without each row keeping a timer.
const [clock, setClock] = createSignal(Date.now());
let clockUsers = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
function useClock(): () => number {
  if (clockUsers++ === 0) {
    // A write from a component body is refused on 2.0, so the fresh reading lands a microtask on.
    queueMicrotask(() => setClock(Date.now()));
    clockTimer = setInterval(() => setClock(Date.now()), 30_000);
  }
  onCleanup(() => {
    if (--clockUsers === 0) clearInterval(clockTimer);
  });
  return clock;
}

function Stamp(props: { at: number }) {
  const now = useClock();
  const date = () => new Date(props.at);
  return (
    <Tooltip as="span" class={styles.stamp} label={date().toLocaleString()}>
      <time datetime={date().toISOString()}>{stampLabel(props.at, now())}</time>
    </Tooltip>
  );
}

function ReplyText(props: {
  id: string;
  text: string;
  cwd: string;
  onRead?: (body: HTMLElement, itemId: string) => void;
  readingBlock?: (itemId: string) => number | undefined;
  action?: JSX.Element;
  at?: number;
}) {
  let body!: HTMLDivElement;
  const [renders, setRenders] = createSignal(0);
  createEffect(
    () => {
      renders();
      return props.readingBlock?.(props.id);
    },
    (block) => {
      if (block === undefined) return;
      const el = speakableBlocks(body)[block]?.el;
      el?.classList.add(styles.readingBlock);
      return () => el?.classList.remove(styles.readingBlock);
    },
  );
  return (
    <div class={styles.replyText}>
      <Show when={props.onRead}>
        {(onRead) => (
          <IconButton
            size="xs"
            icon={<Icon icon={Volume2} />}
            class={styles.replyRead}
            tooltip="Read aloud"
            onClick={() => onRead()(body, props.id)}
          />
        )}
      </Show>
      <div ref={body} class={styles.assistant} data-reply={props.id}>
        <Markdown text={props.text} cwd={props.cwd} onRendered={() => setRenders((n) => n + 1)} />
      </div>
      {props.action}
      <Show when={props.at}>{(at) => <Stamp at={at()} />}</Show>
    </div>
  );
}

/**
 * One hook frame.
 *
 * Deliberately a single dense line: a hook is context for the tool call next to
 * it, not an event competing with the conversation for attention. The failure
 * case is the exception - a non-zero exit or a blocking outcome is the one time
 * a hook is the most important thing on screen, so it gets the error styling and
 * its stderr.
 */
function HookRow(props: { item: Extract<ChatItem, { kind: "hook" }> }) {
  const failed = () => props.item.exitCode !== null && props.item.exitCode !== 0;
  // A finished frame that reported neither an outcome nor an exit code still
  // has to say something: "()" reads as a rendering bug rather than as a hook
  // that simply told us nothing.
  const detail = () => {
    if (props.item.phase === "started") return "running";
    const parts = [props.item.outcome, props.item.exitCode === null ? null : `exit ${props.item.exitCode}`].filter(
      Boolean,
    );
    return parts.length ? parts.join(", ") : "finished";
  };
  return (
    <div class={[styles.notice, { [styles.noticeError]: failed() }]}>
      <span class={styles.noticeLine}>
        {/* The glyph says "a hook ran" whether or not it failed; the colour and
            the stderr below say how it went. Swapping it for a warning sign on
            failure would cost the one thing it is there to carry. */}
        <Icon icon={Webhook} size={14} class={styles.noticeIcon} aria-hidden="true" />
        <span>
          {props.item.toriOwned ? "Tori's before-state hook" : props.item.name} ({detail()})
        </span>
      </span>
      <Show when={failed() && props.item.stderr}>{(err) => <div>{err()}</div>}</Show>
    </div>
  );
}

/**
 * A notice for something that has not finished yet, which so far means one
 * thing: a compaction.
 *
 * It exists because the wire goes completely silent for the duration - measured
 * at 33 seconds on the captured run, with the start and the boundary the only
 * two frames - and a transcript that shows nothing for half a minute is
 * indistinguishable from a session that has hung. There is no progress to
 * report (nobody publishes one), so what it counts is the only honest thing it
 * can: how long this has been going on.
 */
function PendingNotice(props: { text: string; since: number }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = window.setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => window.clearInterval(timer));
  const seconds = () => Math.max(0, Math.floor((now() - props.since) / 1000));
  const clock = () => (seconds() >= 60 ? `${Math.floor(seconds() / 60)}m ${seconds() % 60}s` : `${seconds()}s`);
  return (
    <span class={styles.noticeLine}>
      <Icon icon={FoldVertical} size={14} class={`${styles.noticeIcon} ${styles.noticePending}`} aria-hidden="true" />
      <span>{props.text}</span>
      <span class={styles.noticeClock}>{clock()}</span>
    </span>
  );
}

const sessionName = (id: string) => {
  const meta = findSession(id)?.session;
  return meta?.name || meta?.title || "another session";
};

/**
 * The transcript.
 *
 * Windowed, not virtualized: a chat is read from the bottom, and rendering the
 * last N items with an explicit "load earlier" keeps the measurement machinery
 * a virtual list needs out of the streaming path entirely. A 2000-turn session
 * paints N items whatever its length.
 *
 * Sticky-to-bottom follows new output only while the user is already at the
 * bottom. Scrolling up detaches, and nothing yanks the view back until they
 * scroll down again, which is what makes reading an earlier turn mid-stream
 * possible.
 */
export default function MessageList(props: {
  items: readonly ChatItem[];
  streaming: boolean;
  sessionId: string;
  cwd: string;
  /** False while the chat sits behind another tab, where pinning the tail would
   *  force a layout of the whole window for a list nobody can see. */
  active?: boolean;
  /** The session's skills, coloured where a prompt names one. */
  skills?: readonly string[];
  /** The scrolling root, for a caller that needs to know whether a selection
   *  sits inside this transcript. */
  ref?: (el: HTMLDivElement) => void;
  /** Display label for the model that ran a turn, or null when the turn never
   *  named one (replayed history). The header renders the agent name alone
   *  then, rather than blaming an old turn on the current model. */
  modelLabelFor: (turnId: string) => string | null;
  /** Answer a permission prompt. Absent where nothing can be sent, which
   *  renders every prompt read only, the same as `onAnswerQuestion`. */
  onAnswer?: (card: ToolItem, answer: Answer) => void;
  onSetMode: (mode: PermissionMode) => void;
  /** Start the agent's own login for this chat's account. Absent where the
   *  chat has no account to sign in to, which leaves the notice as text. */
  onSignIn?: () => void;
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
  /** Send the answers to a question. Absent where nothing can be sent, which
   *  renders every question read only rather than offering a Submit that would
   *  go nowhere. */
  onAnswerQuestion?: (item: QuestionItem, answers: QuestionAnswer[]) => void;
  /** The turn to open at, so returning from another view lands where the reader
   *  left rather than at the bottom. Null means the usual pin-to-bottom. */
  anchorTurnId?: string | null;
  /** Reports the turn the reader was on as this list goes away. */
  onAnchor?: (turnId: string | null) => void;
  /** The checkpoint a turn can be rewound to, or null when there is none.
   *  Only turns this tab actually ran have one: a replayed turn predates the
   *  snapshot, so offering to rewind to it would promise a tree state that was
   *  never recorded. */
  rewindTsFor?: (turnId: string) => number | null;
  onRewind?: (promptTs: number) => void;
  /** Drawn beside each reply, for a view that puts a face on the agent. */
  replyMark?: () => JSX.Element;
  /** Read a reply aloud, given the element its text renders into. Absent where
   *  there is no speech, which leaves replies without the button. */
  onRead?: (body: HTMLElement, itemId: string) => void;
  reading?: { itemId: string; block: number } | null;
  replyAction?: (item: TextItem) => JSX.Element | undefined;
  /** Whether the agent opened this turn for itself, which a background
   *  subagent's finishing makes it do. Such a turn answers no prompt, so it
   *  must not claim the one above it. */
  agentTurn?: (turnId: string) => boolean;
  /** The lane an `Agent` call opened, or null for an ordinary call. A finished
   *  card is the way into that lane from where the launch happened. */
  laneOpenedBy?: (toolUseId: string) => string | null;
  /** The lane a row belongs to while it is showing outside that lane, which is
   *  what a blocked row does. */
  blockedIn?: (item: ChatItem) => string | null;
  onOpenLane?: (agentId: string) => void;
  onOpenWorktree?: (folder: string, session: string | null) => void;
  onOpenSession?: (id: string) => void;
  /** The prompt this chat was spawned with and the chat that wrote it. */
  firstPrompt?: { sender: string; text: string } | null;
  /** Fetch the page before the first item, for a caller that holds only the
   *  latest pages. Asked for once every held item is already shown. */
  onFetchEarlier?: () => void;
  /** Draw each run of thinking, calls, hooks and answered questions as a one
   *  line card, so the transcript reads as prompts and replies. */
  collapseWork?: boolean;
  /** Off hides the secret marks a session's calls already carry. */
  showSecrets?: boolean;
  /** Off hides the blind edit marks a session's calls already carry. */
  showBlindEdits?: boolean;
  /** `turnId` -> what that turn ran to check the code it changed. */
  verifications?: Record<string, TurnCheck>;
  /** Off hides the verification marks a session's turns already carry. */
  showVerification?: boolean;
  /** Which rows show their time. Absent shows none. */
  timestamps?: Timestamps;
}) {
  const [limit, setLimit] = createSignal(WINDOW_STEP);
  // Read once, deliberately: whether this list opens pinned to the bottom is an
  // initial condition, not something that should flip mid-life. Returning to a
  // remembered turn starts unpinned so the pin effect does not yank the reader
  // to the tail before the anchor is restored.
  const [stuck, setStuck] = createSignal(untrack(() => !props.anchorTurnId));
  let scroller: HTMLDivElement | undefined;

  const shown = createMemo(() => windowed(props.items, limit()));
  const readingBlocks = byKey(() => {
    const now = props.reading;
    return new Map(now ? [[now.itemId, now.block]] : []);
  });
  const readingBlock = (itemId: string) => readingBlocks[itemId];
  const stampsPrompts = () => props.timestamps === "prompts" || props.timestamps === "both";
  const stampsReplies = () => props.timestamps === "replies" || props.timestamps === "both";
  // One time per reply, on its last block: a turn's text is split by every
  // tool call in it, and a time under each piece would repeat itself.
  const replyEnds = createMemo(() => {
    const last = new Map<string, string>();
    if (!stampsReplies()) return new Set<string>();
    for (const it of shown()) if (it.kind === "text" && it.agentId === null) last.set(it.turnId, it.id);
    return new Set(last.values());
  });
  const replyAt = (it: TextItem) => (replyEnds().has(it.id) ? it.at : undefined);
  // Rows added above push everything down, so the reader is held where they
  // were measured from the bottom. Only while the old first row is still shown:
  // a first row that changed some other way (a lane switch) is not rows above.
  let keep: { first: string | undefined; fromBottom: number } | null = null;
  createEffect(
    () => shown()[0]?.id,
    (first) => {
      if (!keep || !scroller || first === keep.first) return;
      const was = keep.first;
      if (untrack(() => shown().some((it) => it.id === was)))
        scroller.scrollTop = scroller.scrollHeight - keep.fromBottom;
      keep = null;
    },
    { defer: true },
  );

  // Earlier rows load as the reader nears the top, a screen ahead of them. An
  // observer rather than a scroll handler, which would read layout on every
  // scroll event; it also never fires for a chat behind another tab.
  const [loading, setLoading] = createSignal(false);
  // Not until the reader has scrolled up: a short chat shows its top row on
  // open, and paging its history in unasked would be a fetch nobody wanted.
  let armed = false;
  let earlierRow: HTMLElement | undefined;
  let watcher: IntersectionObserver | undefined;
  const canLoadEarlier = () => hasEarlier(props.items, limit()) || !!props.onFetchEarlier;

  // A page that never arrives must not leave the row stuck saying so.
  const LOADING_GIVE_UP_MS = 5000;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(giveUp));

  function loadEarlier() {
    if (loading() || !canLoadEarlier()) return;
    if (scroller) keep = { first: shown()[0]?.id, fromBottom: scroller.scrollHeight - scroller.scrollTop };
    setLoading(true);
    clearTimeout(giveUp);
    giveUp = setTimeout(() => setLoading(false), LOADING_GIVE_UP_MS);
    if (!hasEarlier(props.items, limit())) props.onFetchEarlier?.();
    setLimit(limit() + WINDOW_STEP);
  }

  // A fresh observation reports where the row is now. Asked after each page
  // lands, so a page too short to push the row out of reach fetches the next,
  // and once the reader arms, for a row that was already in reach before.
  function lookAgain() {
    if (!watcher || !earlierRow) return;
    watcher.unobserve(earlierRow);
    watcher.observe(earlierRow);
  }

  onSettled(() => {
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    watcher = new IntersectionObserver(
      (entries) => {
        if (armed && entries.some((e) => e.isIntersecting)) loadEarlier();
      },
      { root: scroller, rootMargin: "100% 0px 0px 0px" },
    );
    if (earlierRow) watcher.observe(earlierRow);
    return () => watcher?.disconnect();
  });

  createEffect(
    () => shown()[0]?.id,
    () => {
      if (!untrack(loading)) return;
      clearTimeout(giveUp);
      setLoading(false);
      lookAgain();
    },
    { defer: true },
  );

  function EarlierRow(rowProps: { children: JSX.Element }) {
    let el: HTMLDivElement | undefined;
    onCleanup(() => {
      if (!el) return;
      watcher?.unobserve(el);
      if (earlierRow === el) earlierRow = undefined;
    });
    return (
      <div
        class={styles.loadEarlier}
        ref={(node) => {
          el = node;
          earlierRow = node;
          watcher?.observe(node);
        }}
      >
        {rowProps.children}
      </div>
    );
  }

  // Our own pins fire scroll events too. One that lands after a tall row
  // arrived but before its pin ran is not the reader leaving the bottom, and
  // judging it as one would drop every pin after it.
  let pinnedTop = -1;
  function onListScroll() {
    if (stuck() && scroller?.scrollTop === pinnedTop) return;
    const atEnd = atBottom();
    setStuck(atEnd);
    if (!armed && !atEnd) {
      armed = true;
      lookAgain();
    }
  }
  // Three cards saying `Edit MessageList.tsx` in a row are three copies of one
  // answer. Folded at render time rather than in the store, because what folded
  // is still its own call: its own approval, its own revert, its own id.
  const folded = createMemo(() => foldEdits(shown()));
  // The first prompt matching the one this chat was spawned with: by text, so
  // it is found wherever it sits in the loaded pages, and only once.
  const spawnedWith = createMemo(() => {
    const text = props.firstPrompt?.text.trim();
    if (!text) return null;
    return props.items.find((i) => i.kind === "user" && queuedText(i).trim() === text)?.id ?? null;
  });

  const runCache: RunCache = new Map();
  // Null while the setting is off: grouping reads every call's state, and a
  // transcript nobody collapsed should not re-run it each time a call settles.
  const grouped = createMemo(() => (props.collapseWork ? groupRuns(shown(), runCache) : null));
  const rows = () => grouped()?.rows ?? shown();
  const arrivals = createMemo<{ rows: readonly TranscriptRow[]; fresh: ReadonlySet<TranscriptRow> }>(
    (was = { rows: [], fresh: NONE }) => {
      const now = rows();
      return { rows: now, fresh: appended(was.rows, now) };
    },
  );

  const turnIdOf = (it: ChatItem) =>
    it.kind === "text" || it.kind === "thinking" || it.kind === "tool" || it.kind === "question" ? it.turnId : null;

  // The item ids that open their turn. There is no visible byline any more - a
  // reply is obviously the reply, and repeating "Claude" above every tool call
  // was the loudest thing on screen - but a turn still needs one row carrying
  // its id, because that is what scroll anchoring and the model line hang off.
  const turnOpeners = createMemo(() => {
    const openers = new Map<string, string>();
    const seen = new Set<string>();
    for (const it of shown()) {
      const turnId = turnIdOf(it);
      if (!turnId || seen.has(turnId)) continue;
      seen.add(turnId);
      openers.set(it.id, turnId);
    }
    return openers;
  });
  const openerOf = byKey(turnOpeners);

  // The prompt that started each turn, so "rewind to here" can sit on the
  // message the reader would point at when they say "here" rather than in a
  // byline. A steer lands inside a turn already running, so it starts none.
  const promptTurns = createMemo(() => {
    const map = new Map<string, string>();
    let pending: string | null = null;
    for (const it of shown()) {
      if (it.kind === "user") {
        if (!it.steer) pending = it.id;
        continue;
      }
      const turnId = turnIdOf(it);
      if (!turnId) continue;
      // A turn the agent opened for itself starts no prompt. Letting it claim
      // the pending one would point "rewind to here" at a checkpoint taken
      // *after* the turn the reader meant, so the undo would miss its edits.
      if (props.agentTurn?.(turnId)) continue;
      if (pending) map.set(pending, turnId);
      pending = null;
    }
    return map;
  });
  const promptTurnOf = byKey(promptTurns);

  // Which turns announce their model: only the ones that changed it. Naming the
  // model on every turn is the same repetition the byline was, and the fact
  // worth seeing is the switch, not the steady state.
  const modelLines = createMemo(() => {
    const lines = new Map<string, string>();
    let last: string | null = null;
    for (const [itemId, turnId] of turnOpeners()) {
      const label = props.modelLabelFor(turnId);
      if (!label) continue;
      if (label !== last) lines.set(itemId, label);
      last = label;
    }
    return lines;
  });
  const modelLineOf = byKey(modelLines);

  // The rows the turn marks are folded from: the window, plus the rest of the
  // turn it opens in. A mark hangs on a turn's head, and only a shown turn has
  // one, so the transcript above the window has nothing to say. A window that
  // opens mid-turn still needs that turn's earlier cards, because they are what
  // its head is there to tell about.
  const marked = createMemo(() => {
    const rows = shown();
    const items = props.items;
    const start = items.length - rows.length;
    let from = start;
    const turn = rows.length ? turnIdOf(rows[0]) : null;
    while (turn && from > 0 && turnIdOf(items[from - 1]) === turn) from--;
    return from === start ? rows : items.slice(from);
  });

  // Said at the head of the turn, not only on the card that made the read: a
  // card can sit folded inside a run of calls nobody opens.
  const secrets = createMemo(() => (props.showSecrets === false ? new Map() : turnSecrets(marked())));
  const secretOf = byKey(secrets);
  const secretRows = createMemo(() => (props.showSecrets === false ? new Map() : turnSecretRows(marked())));

  // The call "Show call" asked for. Its card opens, and so does a shut run
  // holding it, since a card inside one is not drawn.
  const [revealed, setRevealed] = createSignal<string | null>(null);
  function showCall(toolUseId: string) {
    setRevealed(null);
    // Writes coalesce: without this, asking for the same call twice shows no change to the effects.
    flush();
    setRevealed(toolUseId);
    requestAnimationFrame(() =>
      scroller
        ?.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }

  const SecretMark = (p: { hit: SecretHit; rows: SecretRow[] }) => {
    const [open, setOpen] = createSignal(false);
    let anchor: HTMLButtonElement | undefined;
    return (
      <>
        <button
          type="button"
          ref={anchor}
          class={styles.turnSecret}
          aria-expanded={open() ? "true" : "false"}
          aria-haspopup="dialog"
          onClick={() => setOpen(!open())}
        >
          <Icon icon={KeyRound} size={12} />
          {secretLabel(p.hit)}
        </button>
        <Show when={open()}>
          <Popover
            anchorEl={anchor}
            placement="bottom-start"
            onClose={() => setOpen(false)}
            class={styles.secretPopover}
            aria-label="Secret files"
          >
            <For each={p.rows}>
              {(row) => (
                <div class={styles.secretRow}>
                  <Show
                    when={workspacePath(row.path, props.cwd)}
                    fallback={<span class={styles.secretPath}>{row.path}</span>}
                  >
                    {(path) => (
                      <button
                        type="button"
                        class={styles.secretPath}
                        onClick={() => openWorkspacePath(path(), props.cwd)}
                      >
                        {mentionPath(path(), props.cwd)}
                      </button>
                    )}
                  </Show>
                  <Show
                    when={row.strength === "named" && row.command}
                    fallback={<span class={styles.secretReason}>{`Read with ${row.tool}`}</span>}
                  >
                    {(command) => <code class={styles.secretReason}>{commandAround(command(), row.path)}</code>}
                  </Show>
                  <button
                    type="button"
                    class={styles.secretShow}
                    onClick={() => {
                      setOpen(false);
                      showCall(row.toolUseId);
                    }}
                  >
                    Show call
                  </button>
                </div>
              )}
            </For>
          </Popover>
        </Show>
      </>
    );
  };
  const blindEdits = createMemo(() => (props.showBlindEdits === false ? new Map() : turnBlindEdits(marked())));
  const blindEditOf = byKey(blindEdits);

  // Zero height: it exists to carry the turn id, not to take up room. The
  // negative bottom margin cancels the flex gap it would otherwise open.
  const TurnAnchor = (p: { itemId: string; off?: boolean }) => (
    <Show when={!p.off && openerOf[p.itemId]}>
      {(id) => (
        <>
          <div class={styles.turnAnchor} data-turn-id={id()} />
          <Show when={modelLineOf[p.itemId]}>{(label) => <div class={styles.turnModel}>{label()}</div>}</Show>
          <Show when={secretOf[id()]}>{(hit) => <SecretMark hit={hit()} rows={secretRows().get(id()) ?? []} />}</Show>
          <Show when={blindEditOf[id()]}>
            {(paths) => (
              <Tooltip<HTMLSpanElement> as="span" tabindex={0} class={styles.turnBlindEdit} label={paths().join("\n")}>
                <Icon icon={EyeOff} size={12} />
                Edited without reading
              </Tooltip>
            )}
          </Show>
          <Show when={props.showVerification !== false && props.verifications?.[id()]}>
            {(v) => (
              <Tooltip<HTMLSpanElement>
                as="span"
                tabindex={0}
                class={styles.turnVerification}
                data-verdict={v().verdict}
                label={verdictDetail(v().verdict, v().checks, v().settledLater)}
              >
                <Icon icon={VERDICT_ICON[v().verdict]} size={12} />
                {VERDICT_LABEL[v().verdict]}
              </Tooltip>
            )}
          </Show>
        </>
      )}
    </Show>
  );

  // The checkpoint behind a prompt is the tree as it stood *before* the turn it
  // started, which is exactly what "go back to here" has to mean for the undo
  // to include that turn's edits.
  const rewindTsForPrompt = (userItemId: string) => {
    const turnId = promptTurnOf[userItemId];
    return turnId ? (props.rewindTsFor?.(turnId) ?? null) : null;
  };

  // Within a few pixels of the bottom counts as being at the bottom: sub-pixel
  // layout and a mid-stream reflow would otherwise detach the view on their own.
  const atBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;

  // The length of the streaming bubble's text, so the pin effect has something
  // that changes while deltas land: a delta mutates the last item in place
  // without changing how many items there are.
  const tailLength = () => {
    const last = props.items[props.items.length - 1];
    return last && (last.kind === "text" || last.kind === "thinking") ? last.text.length : 0;
  };

  // Live means deltas can still land here: the item is the tail of a streaming
  // turn. A thinking block a tool call has moved past is done, mid-turn or not.
  const tailId = () => props.items[props.items.length - 1]?.id;

  // The turn the reader is looking at: the last header at or above the top of
  // the viewport, else the first one below it. Turn headers are the anchor
  // because a turn is the unit the reader is actually placed in; a pixel offset
  // would not survive the list re-windowing.
  function visibleTurn(): string | null {
    if (!scroller) return null;
    const headers = [...scroller.querySelectorAll<HTMLElement>("[data-turn-id]")];
    if (!headers.length) return null;
    const top = scroller.getBoundingClientRect().top;
    let current = headers[0];
    for (const h of headers) {
      if (h.getBoundingClientRect().top > top + 1) break;
      current = h;
    }
    return current.dataset.turnId ?? null;
  }

  /** Put `turnId`'s row at the top of the viewport. */
  function scrollToTurn(turnId: string) {
    // The row renders from the update that asked for it, so it is found after.
    queueMicrotask(() => {
      const target = scroller?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
      if (!target || !scroller) return;
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      setStuck(atBottom());
    });
  }

  const mountAnchor = untrack(() => props.anchorTurnId);
  onSettled(() => {
    if (mountAnchor) scrollToTurn(mountAnchor);
  });

  // An anchor that arrives later is somebody pointing at a turn - the blame
  // widget's "open the turn that wrote this line" - rather than a view being
  // restored, and the list is already mounted when it lands.
  createEffect(
    () => props.anchorTurnId,
    (anchor) => {
      if (anchor) scrollToTurn(anchor);
    },
    { defer: true },
  );

  onCleanup(() => props.onAnchor?.(visibleTurn()));

  /** Put the tail back on screen in the next frame, before it lays out: once
   *  however many rows landed, and never as a layout of its own. Asked again
   *  there, since a reader can scroll up inside the frame it waited for. */
  let pinFrame = 0;
  const pin = () => {
    if (pinFrame) return;
    pinFrame = requestAnimationFrame(() => {
      pinFrame = 0;
      if (!stuck() || !scroller) return;
      scroller.scrollTo({ top: scroller.scrollHeight });
      pinnedTop = scroller.scrollTop;
    });
  };
  onCleanup(() => cancelAnimationFrame(pinFrame));

  // Re-pin after the DOM has the new content, and only while pinned.
  createEffect(
    () => [shown().length, shown()[shown().length - 1]?.id, tailLength(), untrack(() => props.active)] as const,
    ([, , , active]) => {
      if (!untrack(stuck) || !scroller || active === false) return;
      pin();
    },
  );
  createEffect(
    () => props.active,
    (active) => {
      if (active !== false && stuck()) pin();
    },
    { defer: true },
  );

  // Your own message is the exception to "scrolling up detaches": Enter is the
  // one moment the reader has asked for the tail, and a prompt sent into a
  // transcript scrolled up lands under the composer entire.
  createEffect(
    () => {
      const last = shown()[shown().length - 1];
      return last?.kind === "user" ? last.id : null;
    },
    (id) => {
      if (!id) return;
      // Re-pinned, not merely scrolled: the composer changes height again
      // after a send (chips clear, a lane strip opens), and only the observer
      // below follows that, and only while pinned.
      setStuck(true);
      pin();
    },
    // Not on mount: a restored transcript can end on a prompt, and opening it
    // is not sending one.
    { defer: true },
  );

  // An image has no height until it loads, so a prompt carrying one is pinned
  // against a bubble still about to grow by up to 180px. `load` does not bubble
  // but does run the capture phase, so one listener covers every image.
  onSettled(() => {
    if (!scroller) return;
    const onLoad = () => {
      if (stuck()) pin();
    };
    scroller.addEventListener("load", onLoad, true);
    return () => scroller?.removeEventListener("load", onLoad, true);
  });

  // And re-pin when the *viewport* shrinks, which is the other way the bottom
  // of the conversation leaves the screen and the one nothing was watching.
  //
  // The composer under this list grows as you type - a second line, an
  // attachment chip, the queue strip - and every pixel it takes comes off the
  // list. Scroll position is measured from the top, so a shorter viewport
  // leaves the last rows below the fold: the reply you were reading slides
  // under the input box, and a tall row (a question card) can disappear behind
  // it whole. Nothing about the *content* changed, so the effect above never
  // ran.
  //
  // Every row is watched as well, for the growth the effect above has no key
  // for: a question card or permission prompt filled into an item already
  // shown, a finished reply's code blocks highlighting after its last delta.
  onSettled(() => {
    if (!scroller || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    // Only while pinned: a reader who has scrolled up is holding a position on
    // purpose, and a resize is not a reason to take it away from them.
    const ro = new ResizeObserver(() => {
      if (!stuck() || !scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
      pinnedTop = scroller.scrollTop;
    });
    ro.observe(scroller);
    for (const row of scroller.children) ro.observe(row);
    const rows = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n instanceof Element && ro.observe(n));
        r.removedNodes.forEach((n) => n instanceof Element && ro.unobserve(n));
      }
    });
    rows.observe(scroller, { childList: true });
    return () => {
      rows.disconnect();
      ro.disconnect();
    };
  });

  const Row = (p: { item: ChatItem; unanchored?: boolean }) => (
    <Switch>
      {/* The one side of the conversation that gets a bubble, held to the
          right: with no bylines left, the shape and the side are what say
          who is speaking, and prompts are the landmarks a reader scrolls
          back to. A steer is the same person, so it keeps the bubble; it
          is inset and labelled because it landed *inside* the turn above
          it, and reading it as an ordinary prompt would suggest the reply
          below answers only that. It opens no turn group: `turnOpeners`
          counts assistant-side rows only. */}
      <Match when={p.item.kind === "user" && !peerPrompt(p.item.blocks) && toriNote(p.item.blocks)}>
        {(note) => <ToriNoteRow note={note()} />}
      </Match>
      <Match when={p.item.kind === "user" && p.item}>
        {(it) => {
          const peer = createMemo(
            () =>
              peerPrompt(it().blocks) ??
              (it().id === spawnedWith() && props.firstPrompt
                ? { from: props.firstPrompt.sender, blocks: it().blocks }
                : null),
          );
          return (
            <div class={[styles.userRow, { [styles.steerRow]: it().steer }]}>
              <div class={styles.userBubble}>
                <Show when={peer()}>
                  {(peer) => (
                    <PromptFrom
                      name={sessionName(peer().from)}
                      onOpen={props.onOpenSession ? () => props.onOpenSession?.(peer().from) : undefined}
                    />
                  )}
                </Show>
                <Show when={rewindTsForPrompt(it().id)}>
                  {(ts) => (
                    <Tooltip
                      as="button"
                      type="button"
                      class={styles.userRewind}
                      label="Put the files back to how they were before this prompt, and carry the conversation into a new chat"
                      onClick={() => props.onRewind?.(ts())}
                    >
                      Rewind to here
                    </Tooltip>
                  )}
                </Show>
                <Show when={it().steer}>
                  <span class={styles.steerLabel}>Steer</span>
                </Show>
                <SentPrompt blocks={peer()?.blocks ?? it().blocks} cwd={props.cwd} skills={props.skills ?? []} />
              </div>
              <Show when={stampsPrompts() && it().at}>{(at) => <Stamp at={at()} />}</Show>
            </div>
          );
        }}
      </Match>
      <Match when={p.item.kind === "text" && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <Show
              when={props.replyMark}
              fallback={
                <ReplyText
                  id={it().id}
                  text={it().text}
                  cwd={props.cwd}
                  onRead={props.onRead}
                  readingBlock={readingBlock}
                  action={props.replyAction?.(it())}
                  at={replyAt(it())}
                />
              }
            >
              {(mark) => (
                <div class={styles.markedReply}>
                  {mark()()}
                  <ReplyText
                    id={it().id}
                    text={it().text}
                    cwd={props.cwd}
                    onRead={props.onRead}
                    readingBlock={readingBlock}
                    action={props.replyAction?.(it())}
                    at={replyAt(it())}
                  />
                </div>
              )}
            </Show>
          </>
        )}
      </Match>
      <Match when={p.item.kind === "command" && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <div class={styles.command}>
              {/* Only when a record named it. Live nothing does, and the
                  prompt that ran the command is the row directly above,
                  so a header there would just say it twice. */}
              <Show when={it().command}>{(name) => <div class={styles.commandName}>{name()}</div>}</Show>
              <div class={styles.commandBody}>
                <Markdown text={it().output} cwd={props.cwd} breaks />
              </div>
            </div>
          </>
        )}
      </Match>
      <Match when={p.item.kind === "thinking" && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <ThinkingBlock
              text={it().text}
              live={props.streaming && tailId() === it().id}
              thoughtMs={it().endedAt - it().startedAt}
            />
          </>
        )}
      </Match>
      <Match when={p.item.kind === "notice" && p.item}>
        {(it) => (
          <div
            class={[
              styles.notice,
              {
                [styles.noticeError]: it().level === "error",
                [styles.noticeAttention]: it().level === "attention",
              },
            ]}
          >
            <Show
              when={it().pendingSince}
              fallback={
                <span class={styles.noticeLine}>
                  <Icon
                    icon={it().level === "info" ? Info : TriangleAlert}
                    size={14}
                    class={styles.noticeIcon}
                    aria-hidden="true"
                  />
                  <span>{it().text}</span>
                </span>
              }
            >
              {(since) => <PendingNotice text={it().text} since={since()} />}
            </Show>
            <Show when={it().signIn && props.onSignIn}>
              {(signIn) => (
                <div class={styles.noticeAction}>
                  <Button size="sm" onClick={() => signIn()()}>
                    Sign in again
                  </Button>
                </div>
              )}
            </Show>
            {/* Closed by default: the line is the news, the details are
                what you go looking for afterwards. A plain `<details>`
                because it needs no state of its own - one open summary
                does not concern the rest of the transcript. */}
            <Show when={it().details}>
              {(d) => (
                <details class={styles.noticeDetails}>
                  <summary>Summary</summary>
                  <div class={styles.noticeDetailsBody}>{d()}</div>
                </details>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={p.item.kind === "hook" && p.item}>{(it) => <HookRow item={it()} />}</Match>
      <Match when={p.item.kind === "question" && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <QuestionCard
              item={it()}
              onAnswer={props.onAnswerQuestion ? (answers) => props.onAnswerQuestion?.(it(), answers) : undefined}
              inLane={props.blockedIn?.(it()) ?? null}
              onOpenLane={props.onOpenLane}
            />
          </>
        )}
      </Match>
      <Match when={p.item.kind === "tool" && !folded().hidden.has(p.item.id) && isWorktreeCard(p.item) && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <WorktreeCard card={it()} cwd={props.cwd} onOpenWorktree={props.onOpenWorktree} />
          </>
        )}
      </Match>
      <Match when={p.item.kind === "tool" && !folded().hidden.has(p.item.id) && p.item}>
        {(it) => (
          <>
            <TurnAnchor itemId={it().id} off={p.unanchored} />
            <ToolCallCard
              card={it()}
              showSecret={props.showSecrets !== false}
              showBlindEdit={props.showBlindEdits !== false}
              revealed={revealed() === it().toolUseId}
              also={folded().followers.get(it().id) ?? []}
              sessionId={props.sessionId}
              cwd={props.cwd}
              onAnswer={props.onAnswer}
              onSetMode={props.onSetMode}
              onRevertHunk={props.onRevertHunk}
              lane={props.laneOpenedBy?.(it().toolUseId) ?? null}
              inLane={props.blockedIn?.(it()) ?? null}
              onOpenLane={props.onOpenLane}
            />
          </>
        )}
      </Match>
    </Switch>
  );

  const WorkCard = (p: { run: WorkRun }) => {
    const [open, setOpen] = createSignal(false);
    const held = () => grouped()?.members.get(p.run) ?? [];
    createEffect(
      () => {
        const id = revealed();
        return !!id && held().some((m) => m.kind === "tool" && m.toolUseId === id);
      },
      (hit) => {
        if (hit) setOpen(true);
      },
    );
    const label = createMemo(() => runLabel(held(), props.streaming && held()[held().length - 1]?.id === tailId()));
    return (
      <>
        {/* A turn that opens inside the card still needs its anchor on screen
            while the card is shut, so the card carries it and the rows do not. */}
        <For each={held()}>{(m) => <TurnAnchor itemId={m.id} />}</For>
        <div class={styles.work}>
          <button
            type="button"
            class={styles.workToggle}
            aria-expanded={open() ? "true" : "false"}
            onClick={() => setOpen(!open())}
          >
            <Icon
              icon={ChevronRight}
              size={14}
              class={[styles.workChevron, { [styles.toolCaretOpen]: open() }]}
              aria-hidden="true"
            />
            <span class={styles.workText}>
              <span class={[styles.workLabel, { [styles.thinkingLive]: label().live }]}>{label().text}</span>
              <Show when={label().failed}>
                <span class={styles.workFailed}>{`, ${label().failed} failed`}</span>
              </Show>
            </span>
          </button>
          <Show when={open()}>
            <div class={styles.workBody}>
              <For each={held()}>{(m) => <Row item={m} unanchored />}</For>
            </div>
          </Show>
        </div>
      </>
    );
  };

  return (
    <div
      class={styles.list}
      ref={(el) => {
        scroller = el;
        props.ref?.(el);
      }}
      onScroll={onListScroll}
    >
      <Show when={canLoadEarlier()}>
        {/* Kept as a button: it is how a keyboard or a screen reader reaches
            earlier rows, and how a page that failed to arrive is asked again. */}
        <EarlierRow>
          <Button size="sm" onClick={loadEarlier}>
            {loading() ? "Loading earlier…" : "Load earlier"}
          </Button>
        </EarlierRow>
      </Show>
      <For each={rows()}>
        {(row) => {
          const view = untrack(() => (row.kind === "run" ? <WorkCard run={row} /> : <Row item={row} />));
          return untrack(() => arrivals().fresh.has(row)) ? rise(view) : view;
        }}
      </For>
      <Show when={props.streaming}>
        <span class={styles.cursor} aria-hidden="true" />
      </Show>
    </div>
  );
}

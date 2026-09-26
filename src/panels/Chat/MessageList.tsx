import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Brain, FoldVertical, Info, TriangleAlert, Webhook } from "lucide-solid";
import { convertFileSrc } from "@tauri-apps/api/core";
import { hasEarlier, windowed, WINDOW_STEP, type ChatItem, type QuestionItem, type ToolItem } from "./chatStore";
import { attachmentKind } from "../../utils/chatCompose";
import type { ContentBlock, PermissionMode, QuestionAnswer } from "../../utils/chatTypes";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import ToolCallCard, { type HunkRef } from "./ToolCallCard";
import QuestionCard from "./QuestionCard";
import ToriNoteRow from "./ToriNote";
import { toriNote } from "../../utils/toriNote";
import type { Answer } from "./PermissionPrompt";
import styles from "./Chat.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";
import Markdown from "./Markdown";
import { foldEdits } from "./toolRenderers";

/** Every token that could name an attachment, for splitting a prompt into the
 *  parts that name one and the parts that are prose. */
// Case-insensitive: a turn sent before the capitalisation still says
// `[Image 1]`, and it named a real attachment when it was sent.
const TOKEN_SPLIT = /(\[(?:image|pdf|file) \d+\])/gi;

function blockText(blocks: readonly ContentBlock[]): string {
  const typed = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  return blocks
    .flatMap((b) => {
      if (b.type === "text") return [b.text];
      if (b.type !== "fileRef") return [];
      if (!b.label) return [`@${b.path}`];
      // A labelled attachment is drawn where the sentence names it. One the
      // sentence never named still has to appear, or attaching a file and
      // pressing Enter would leave a turn with no sign of what it carried.
      return typed.includes(b.label) ? [] : [b.label];
    })
    .join("\n");
}

/** The paths this turn attached, by the token naming each. */
function promptRefs(blocks: readonly ContentBlock[]): Map<string, string> {
  const by = new Map<string, string>();
  for (const b of blocks) if (b.type === "fileRef" && b.label) by.set(b.label, b.path);
  return by;
}

/**
 * The prompt, with every token naming one of this turn's own attachments drawn
 * as a chip.
 *
 * Only its own: a user who typed `[Image 9]` at an agent that never got one
 * meant those characters, and dressing them up as an attachment would claim
 * the turn carried something it did not.
 */
function PromptText(props: { blocks: readonly ContentBlock[] }) {
  const refs = createMemo(() => promptRefs(props.blocks));
  const parts = createMemo(() => blockText(props.blocks).split(TOKEN_SPLIT).filter((p) => p !== ""));
  return (
    <Index each={parts()}>
      {(part) => (
        <Show when={refs().get(part())} fallback={part()}>
          {(path) => (
            <span class={styles.promptChip} title={path()}>
              {part()}
            </span>
          )}
        </Show>
      )}
    </Index>
  );
}

/** `src` is null for an image a replay knows was sent but has no bytes for. */
type PromptImage = { label: string | null; nth: number; src: string | null };

function promptImages(blocks: readonly ContentBlock[]): PromptImage[] {
  const found: PromptImage[] = [];
  for (const b of blocks) {
    const nth = found.length + 1;
    if (b.type === "image") found.push({ label: null, nth, src: `data:${b.mediaType};base64,${b.data}` });
    else if (b.type === "imageRef") found.push({ label: null, nth, src: null });
    // An attached image is a path now, so the picture comes off disk. The same
    // file the composer drew, drawn again from the same place.
    else if (b.type === "fileRef" && b.label && attachmentKind(b.path) === "image") {
      found.push({ label: b.label, nth, src: convertFileSrc(b.path) });
    }
  }
  return found;
}

/** Above the text, which is the order they were sent in and the order the
 *  composer drew them in, so a chip does not move when it becomes a turn. A
 *  live turn still holds its bytes; a replayed one is numbered instead. */
function PromptImages(props: { blocks: readonly ContentBlock[] }) {
  const images = createMemo(() => promptImages(props.blocks));
  return (
    <Show when={images().length}>
      <div class={styles.promptImages}>
        <For each={images()}>
          {(img) => (
            <Show when={img.src} fallback={<span class={styles.promptImageGone}>[Image #{img.nth}]</span>}>
              {(src) => (
                <img class={styles.promptImage} src={src()} alt={`attached image ${img.label ?? img.nth}`} />
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The settled label: measured seconds when the span is real, plain past tense
 *  when it is not (a replay folds in one tick and measures nothing). */
function thoughtLabel(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 1) return "Thought";
  if (secs < 60) return `Thought for ${secs}s`;
  return `Thought for ${Math.floor(secs / 60)}m ${secs % 60}s`;
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
        <span classList={{ [styles.thinkingLive]: props.live }}>
          {open() ? "Hide thinking" : props.live ? "Thinking" : thoughtLabel(props.thoughtMs)}
        </span>
      </button>
      <Show when={open()}>
        <div class={styles.thinkingBody}>{props.text}</div>
      </Show>
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
    <div class={`${styles.notice} ${failed() ? styles.noticeError : ""}`}>
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
  /** Fetch the page before the first item, for a caller that holds only the
   *  latest pages. Asked for once every held item is already shown. */
  onFetchEarlier?: () => void;
}) {
  const [limit, setLimit] = createSignal(WINDOW_STEP);
  // Read once, deliberately: whether this list opens pinned to the bottom is an
  // initial condition, not something that should flip mid-life. Returning to a
  // remembered turn starts unpinned so the pin effect does not yank the reader
  // to the tail before the anchor is restored.
  const [stuck, setStuck] = createSignal(!props.anchorTurnId);
  let scroller: HTMLDivElement | undefined;

  const shown = createMemo(() => windowed(props.items, limit()));
  // Three cards saying `Edit MessageList.tsx` in a row are three copies of one
  // answer. Folded at render time rather than in the store, because what folded
  // is still its own call: its own approval, its own revert, its own id.
  const folded = createMemo(() => foldEdits(shown()));

  const turnIdOf = (it: ChatItem) =>
    it.kind === "text" || it.kind === "thinking" || it.kind === "tool" || it.kind === "question"
      ? it.turnId
      : null;

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

  // Zero height: it exists to carry the turn id, not to take up room. The
  // negative bottom margin cancels the flex gap it would otherwise open.
  const TurnAnchor = (p: { itemId: string }) => (
    <Show when={turnOpeners().get(p.itemId)}>
      {(id) => (
        <>
          <div class={styles.turnAnchor} data-turn-id={id()} />
          <Show when={modelLines().get(p.itemId)}>{(label) => <div class={styles.turnModel}>{label()}</div>}</Show>
        </>
      )}
    </Show>
  );

  // The checkpoint behind a prompt is the tree as it stood *before* the turn it
  // started, which is exactly what "go back to here" has to mean for the undo
  // to include that turn's edits.
  const rewindTsForPrompt = (userItemId: string) => {
    const turnId = promptTurns().get(userItemId);
    return turnId ? props.rewindTsFor?.(turnId) ?? null : null;
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

  /** Put `turnId`'s row at the top of the viewport. After the next paint, so the
   *  rows it is measured against exist. */
  function scrollToTurn(turnId: string) {
    queueMicrotask(() => {
      const target = scroller?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
      if (!target || !scroller) return;
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      setStuck(atBottom());
    });
  }

  onMount(() => {
    // Captured now, not read again inside the microtask: props are reactive
    // getters, and the anchor this mount is restoring is the one it opened
    // with.
    const anchor = props.anchorTurnId;
    if (anchor) scrollToTurn(anchor);
  });

  // An anchor that arrives later is somebody pointing at a turn - the blame
  // widget's "open the turn that wrote this line" - rather than a view being
  // restored, and the list is already mounted when it lands.
  createEffect(
    on(
      () => props.anchorTurnId,
      (anchor) => {
        if (anchor) scrollToTurn(anchor);
      },
      { defer: true },
    ),
  );

  onCleanup(() => props.onAnchor?.(visibleTurn()));

  /** Put the tail back on screen, after the DOM has the row Solid just wrote. */
  const pin = () => queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));

  // Re-pin after the DOM has the new content, and only while pinned.
  createEffect(
    on(
      () => [shown().length, shown()[shown().length - 1]?.id, tailLength()] as const,
      () => {
        if (!stuck() || !scroller) return;
        pin();
      },
    ),
  );

  // Your own message is the exception to "scrolling up detaches": Enter is the
  // one moment the reader has asked for the tail, and a prompt sent into a
  // transcript scrolled up lands under the composer entire.
  createEffect(
    on(
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
    ),
  );

  // An image has no height until it loads, so a prompt carrying one is pinned
  // against a bubble still about to grow by up to 180px. `load` does not bubble
  // but does run the capture phase, so one listener covers every image.
  onMount(() => {
    if (!scroller) return;
    const onLoad = () => {
      if (stuck()) pin();
    };
    scroller.addEventListener("load", onLoad, true);
    onCleanup(() => scroller?.removeEventListener("load", onLoad, true));
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
  onMount(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let height = scroller.clientHeight;
    const ro = new ResizeObserver(() => {
      const next = scroller?.clientHeight ?? 0;
      if (next === height) return;
      height = next;
      // Only while pinned: a reader who has scrolled up is holding a position
      // on purpose, and a resize is not a reason to take it away from them.
      if (stuck() && scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class={styles.list}
      ref={(el) => {
        scroller = el;
        props.ref?.(el);
      }}
      onScroll={() => setStuck(atBottom())}
    >
      <Show when={hasEarlier(props.items, limit()) || props.onFetchEarlier}>
        <div class={styles.loadEarlier}>
          <Button
            size="sm"
            onClick={() => {
              if (!hasEarlier(props.items, limit())) props.onFetchEarlier?.();
              setLimit(limit() + WINDOW_STEP);
            }}
          >
            Load earlier
          </Button>
        </div>
      </Show>
      <For each={shown()}>
        {(item) => (
          <Switch>
            {/* The one side of the conversation that gets a bubble, held to the
                right: with no bylines left, the shape and the side are what say
                who is speaking, and prompts are the landmarks a reader scrolls
                back to. A steer is the same person, so it keeps the bubble; it
                is inset and labelled because it landed *inside* the turn above
                it, and reading it as an ordinary prompt would suggest the reply
                below answers only that. It opens no turn group: `turnOpeners`
                counts assistant-side rows only. */}
            <Match when={item.kind === "user" && toriNote(item.blocks)}>
              {(note) => <ToriNoteRow note={note()} />}
            </Match>
            <Match when={item.kind === "user" && item}>
              {(it) => (
                <div class={styles.userRow} classList={{ [styles.steerRow]: it().steer }}>
                  <div class={styles.userBubble}>
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
                    <PromptImages blocks={it().blocks} />
                    <Show when={it().steer}>
                      <span class={styles.steerLabel}>Steer</span>
                    </Show>
                    <PromptText blocks={it().blocks} />
                  </div>
                </div>
              )}
            </Match>
            <Match when={item.kind === "text" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <Show
                    when={props.replyMark}
                    fallback={
                      <div class={styles.assistant}>
                        <Markdown text={it().text} cwd={props.cwd} />
                      </div>
                    }
                  >
                    {(mark) => (
                      <div class={styles.markedReply}>
                        {mark()()}
                        <div class={styles.assistant}>
                          <Markdown text={it().text} cwd={props.cwd} />
                        </div>
                      </div>
                    )}
                  </Show>
                </>
              )}
            </Match>
            <Match when={item.kind === "command" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <div class={styles.command}>
                    {/* Only when a record named it. Live nothing does, and the
                        prompt that ran the command is the row directly above,
                        so a header there would just say it twice. */}
                    <Show when={it().command}>
                      {(name) => <div class={styles.commandName}>{name()}</div>}
                    </Show>
                    <div class={styles.commandBody}>
                      <Markdown text={it().output} cwd={props.cwd} breaks />
                    </div>
                  </div>
                </>
              )}
            </Match>
            <Match when={item.kind === "thinking" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <ThinkingBlock
                    text={it().text}
                    live={props.streaming && tailId() === it().id}
                    thoughtMs={it().endedAt - it().startedAt}
                  />
                </>
              )}
            </Match>
            <Match when={item.kind === "notice" && item}>
              {(it) => (
                <div
                  class={`${styles.notice} ${it().level === "error" ? styles.noticeError : ""} ${
                    it().level === "attention" ? styles.noticeAttention : ""
                  }`}
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
            <Match when={item.kind === "hook" && item}>{(it) => <HookRow item={it()} />}</Match>
            <Match when={item.kind === "question" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <QuestionCard
                    item={it()}
                    onAnswer={
                      props.onAnswerQuestion ? (answers) => props.onAnswerQuestion?.(it(), answers) : undefined
                    }
                    inLane={props.blockedIn?.(it()) ?? null}
                    onOpenLane={props.onOpenLane}
                  />
                </>
              )}
            </Match>
            <Match when={item.kind === "tool" && !folded().hidden.has(item.id) && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <ToolCallCard
                    card={it()}
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
        )}
      </For>
      <Show when={props.streaming}>
        <span class={styles.cursor} aria-hidden="true" />
      </Show>
    </div>
  );
}

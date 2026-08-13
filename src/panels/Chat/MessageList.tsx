import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { marked } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { hasEarlier, windowed, WINDOW_STEP, type ChatItem, type ToolItem } from "./chatStore";
import type { ContentBlock, PermissionMode } from "../../utils/chatTypes";
import Button from "../../components/Button/Button";
import ToolCallCard, { type HunkRef } from "./ToolCallCard";
import type { Answer } from "./PermissionPrompt";
import styles from "./Chat.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

// Assistant text is model output, so it is untrusted as far as script execution
// goes and the webview it lands in can call backend commands. Same treatment as
// a local markdown file: render locally with `marked`, then strip
// script-execution vectors before it goes anywhere near innerHTML.
function renderMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text) as string);
}

function blockText(blocks: readonly ContentBlock[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : b.type === "fileRef" ? `@${b.path}` : "[image]")).join("\n");
}

function ThinkingBlock(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class={styles.thinking}>
      <button type="button" class={styles.thinkingToggle} onClick={() => setOpen(!open())}>
        {open() ? "Hide thinking" : "Thinking"}
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
      <span>
        {props.item.swayOwned ? "Sway approval hook" : props.item.name} ({detail()})
      </span>
      <Show when={failed() && props.item.stderr}>{(err) => <div>{err()}</div>}</Show>
    </div>
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
  /** Display label for the model that ran a turn, or null when the turn never
   *  named one (replayed history). The header renders the agent name alone
   *  then, rather than blaming an old turn on the current model. */
  modelLabelFor: (turnId: string) => string | null;
  onAnswer: (card: ToolItem, answer: Answer) => void;
  onSetMode: (mode: PermissionMode) => void;
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
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
}) {
  const [limit, setLimit] = createSignal(WINDOW_STEP);
  // Read once, deliberately: whether this list opens pinned to the bottom is an
  // initial condition, not something that should flip mid-life. Returning to a
  // remembered turn starts unpinned so the pin effect does not yank the reader
  // to the tail before the anchor is restored.
  const [stuck, setStuck] = createSignal(!props.anchorTurnId);
  let scroller: HTMLDivElement | undefined;

  const shown = createMemo(() => windowed(props.items, limit()));

  const turnIdOf = (it: ChatItem) =>
    it.kind === "text" || it.kind === "thinking" || it.kind === "tool" ? it.turnId : null;

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

  // Re-pin after the DOM has the new content, and only while pinned.
  createEffect(
    on(
      () => [shown().length, shown()[shown().length - 1]?.id, tailLength()] as const,
      () => {
        if (!stuck() || !scroller) return;
        queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
      },
    ),
  );

  return (
    <div class={styles.list} ref={scroller} onScroll={() => setStuck(atBottom())}>
      <Show when={hasEarlier(props.items, limit())}>
        <div class={styles.loadEarlier}>
          <Button size="sm" onClick={() => setLimit(limit() + WINDOW_STEP)}>
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
                    <Show when={it().steer}>
                      <span class={styles.steerLabel}>Steer</span>
                    </Show>
                    {blockText(it().blocks)}
                  </div>
                </div>
              )}
            </Match>
            <Match when={item.kind === "text" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <div class={styles.assistant} innerHTML={renderMarkdown(it().text)} />
                </>
              )}
            </Match>
            <Match when={item.kind === "thinking" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <ThinkingBlock text={it().text} />
                </>
              )}
            </Match>
            <Match when={item.kind === "notice" && item}>
              {(it) => (
                <div class={`${styles.notice} ${it().level === "error" ? styles.noticeError : ""}`}>
                  {it().text}
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
            <Match when={item.kind === "tool" && item}>
              {(it) => (
                <>
                  <TurnAnchor itemId={it().id} />
                  <ToolCallCard
                    card={it()}
                    sessionId={props.sessionId}
                    cwd={props.cwd}
                    onAnswer={props.onAnswer}
                    onSetMode={props.onSetMode}
                    onRevertHunk={props.onRevertHunk}
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

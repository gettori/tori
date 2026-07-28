import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { User } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { marked } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { hasEarlier, windowed, WINDOW_STEP, type ChatItem, type ToolItem } from "./chatStore";
import type { ContentBlock } from "../../utils/chatTypes";
import Button from "../../components/Button/Button";
import ToolCallCard, { type HunkRef } from "./ToolCallCard";
import type { Answer } from "./PermissionPrompt";
import styles from "./Chat.module.css";

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
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
}) {
  const [limit, setLimit] = createSignal(WINDOW_STEP);
  const [stuck, setStuck] = createSignal(true);
  let scroller: HTMLDivElement | undefined;

  const shown = createMemo(() => windowed(props.items, limit()));

  // The item ids that open their turn: the first assistant-side row of each
  // turn carries the "who answered" header, the way one reply gets one byline
  // rather than every bubble repeating it.
  const turnOpeners = createMemo(() => {
    const openers = new Map<string, string>();
    const seen = new Set<string>();
    for (const it of shown()) {
      const turnId =
        it.kind === "text" || it.kind === "thinking" ? it.turnId : it.kind === "tool" ? it.turnId : null;
      if (!turnId || seen.has(turnId)) continue;
      seen.add(turnId);
      openers.set(it.id, turnId);
    }
    return openers;
  });

  const TurnHeader = (p: { itemId: string }) => {
    const turnId = () => turnOpeners().get(p.itemId);
    return (
      <Show when={turnId()}>
        {(id) => (
          <div class={styles.turnHeader}>
            <span class={styles.turnDot} aria-hidden="true" />
            <span class={styles.turnAgent}>Claude</span>
            <Show when={props.modelLabelFor(id())}>
              {(label) => <span class={styles.turnModel}>{label()}</span>}
            </Show>
          </div>
        )}
      </Show>
    );
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
            <Match when={item.kind === "user" && item}>
              {(it) => (
                <div class={styles.userRow}>
                  <span class={styles.userAvatar} aria-hidden="true">
                    <Icon icon={User} size={13} />
                  </span>
                  <div class={styles.userText}>{blockText(it().blocks)}</div>
                </div>
              )}
            </Match>
            <Match when={item.kind === "text" && item}>
              {(it) => (
                <>
                  <TurnHeader itemId={it().id} />
                  <div class={styles.assistant} innerHTML={renderMarkdown(it().text)} />
                </>
              )}
            </Match>
            <Match when={item.kind === "thinking" && item}>
              {(it) => (
                <>
                  <TurnHeader itemId={it().id} />
                  <ThinkingBlock text={it().text} />
                </>
              )}
            </Match>
            <Match when={item.kind === "notice" && item}>
              {(it) => (
                <div class={`${styles.notice} ${it().level === "error" ? styles.noticeError : ""}`}>{it().text}</div>
              )}
            </Match>
            <Match when={item.kind === "hook" && item}>{(it) => <HookRow item={it()} />}</Match>
            <Match when={item.kind === "tool" && item}>
              {(it) => (
                <>
                  <TurnHeader itemId={it().id} />
                  <ToolCallCard
                    card={it()}
                    sessionId={props.sessionId}
                    cwd={props.cwd}
                    onAnswer={props.onAnswer}
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

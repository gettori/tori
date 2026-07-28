import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
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
  onAnswer: (card: ToolItem, answer: Answer) => void;
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
}) {
  const [limit, setLimit] = createSignal(WINDOW_STEP);
  const [stuck, setStuck] = createSignal(true);
  let scroller: HTMLDivElement | undefined;

  const shown = createMemo(() => windowed(props.items, limit()));

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
              {(it) => <div class={`${styles.bubble} ${styles.user}`}>{blockText(it().blocks)}</div>}
            </Match>
            <Match when={item.kind === "text" && item}>
              {(it) => <div class={`${styles.bubble} ${styles.assistant}`} innerHTML={renderMarkdown(it().text)} />}
            </Match>
            <Match when={item.kind === "thinking" && item}>{(it) => <ThinkingBlock text={it().text} />}</Match>
            <Match when={item.kind === "notice" && item}>
              {(it) => (
                <div class={`${styles.notice} ${it().level === "error" ? styles.noticeError : ""}`}>{it().text}</div>
              )}
            </Match>
            <Match when={item.kind === "tool" && item}>
              {(it) => (
                <ToolCallCard
                  card={it()}
                  sessionId={props.sessionId}
                  cwd={props.cwd}
                  onAnswer={props.onAnswer}
                  onRevertHunk={props.onRevertHunk}
                />
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

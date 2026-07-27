import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { marked } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { hasEarlier, windowed, WINDOW_STEP, type ChatItem, type ToolItem } from "./chatStore";
import type { ContentBlock } from "../../utils/chatTypes";
import Button from "../../components/Button/Button";
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

/** One-line summary of what a tool call is doing, from the argument that
 *  actually distinguishes it. The rich card, its diff and its editor coupling
 *  are a later phase; this is enough to read the transcript. */
function toolSummary(card: ToolItem): string {
  if (!card.input || typeof card.input !== "object") return "";
  const rec = card.input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

const TOOL_STATE_LABEL: Record<ToolItem["state"], string> = {
  awaitingApproval: "Waiting for approval",
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
};

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
export default function MessageList(props: { items: readonly ChatItem[]; streaming: boolean }) {
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
                <div class={`${styles.tool} ${it().state === "awaitingApproval" ? styles.toolBlocked : ""}`}>
                  <span class={styles.toolName}>{it().name ?? "tool"}</span>
                  <span class={styles.toolArg}>{toolSummary(it())}</span>
                  <span class={styles.toolState}>{TOOL_STATE_LABEL[it().state]}</span>
                </div>
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

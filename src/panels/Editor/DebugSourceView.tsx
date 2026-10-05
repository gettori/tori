import { For, Show, createMemo, createEffect } from "solid-js";

import { currentFrame, currentSourceTab, debugSourceText } from "../../utils/debugStack";
import styles from "./DebugSourceView.module.css";

/**
 * A frame's code when there is no file to open.
 *
 * Stepping into a bundled dependency lands in code that exists only inside the
 * runtime: DAP hands it back by `sourceReference` with a `source` request, and
 * there is no path any editor could read. So it opens as a synthetic tab
 * ([[concept_synthetic_editor_tabs]]) rather than as a buffer.
 *
 * Read-only by construction rather than by a flag: there is nothing to save it
 * to. That is also why this is not a CodeEditor buffer, which would bring an
 * undo history, a dirty flag, a language server and a save path to a document
 * that can have none of them. Plain rows with line numbers, which is what makes
 * a stack frame readable.
 */
export default function DebugSourceView(props: { id: string; name: string }) {
  const lines = createMemo(() => (debugSourceText(props.id) ?? "").split("\n"));
  // Only when this tab is the frame's own. Stepping through a bundle opens
  // several of these, and "the current frame has no file" is true in all of
  // them at once; the id is what tells them apart.
  const here = createMemo(() => {
    if (currentSourceTab() !== props.id) return null;
    return currentFrame()?.frame.line ?? null;
  });

  let host: HTMLDivElement | undefined;
  createEffect(() => {
    const line = here();
    if (!line || !host) return;
    // Centred rather than merely revealed: a frame at the top edge of the view
    // shows none of the code that called it, which is most of why anyone opens
    // a frame at all.
    host.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  });

  return (
    <div class={styles.sourceView}>
      <div class={styles.head}>
        <span class={styles.name}>{props.name}</span>
        <span class={styles.note}>from the debugger, read-only</span>
      </div>
      <Show
        when={debugSourceText(props.id) !== null}
        fallback={
          <div class={styles.empty}>
            The debugger did not return this source. The run that fetched it may have ended.
          </div>
        }
      >
        <div class={styles.code} ref={host}>
          <For each={lines()}>
            {(text, i) => (
              <div class={styles.row} classList={{ [styles.current]: here() === i() + 1 }} data-line={i() + 1}>
                <span class={styles.gutter}>{i() + 1}</span>
                <span class={styles.text}>{text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

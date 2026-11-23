import { Show, createDeferred, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import styles from "./LspLogView.module.css";

/**
 * What a language server wrote to stderr, as the backend kept it.
 *
 * Not a CodeEditor buffer, for the reason `DebugSourceView` is not one: there is
 * no file to save it to, so it has no dirty flag, no undo and no server.
 */
export default function LspLogView(props: { root: string; serverId: string }) {
  const log = createDeferred<string | undefined>(
    () => {
      const handle = { serverId: props.serverId, root: props.root };
      return invoke<string>("lsp_log", { handle }).catch(() => "");
    },
    { loadingValue: undefined },
  );

  // Opened at the end: the lines that explain a crash are the last ones written.
  let pre: HTMLPreElement | undefined;
  createEffect(
    () => log(),
    (text) => {
      if (text && pre) pre.scrollTop = pre.scrollHeight;
    },
  );

  return (
    <div class={styles.logView}>
      <div class={styles.head}>
        <span class={styles.name}>{props.serverId}</span>
        <span class={styles.note}>{props.root}, stderr, read-only</span>
      </div>
      <Show when={log()} fallback={<div class={styles.empty}>This server has written nothing to stderr.</div>}>
        {(text) => (
          <pre ref={pre} class={styles.log}>
            {text()}
          </pre>
        )}
      </Show>
    </div>
  );
}

import { Errored, Match, Switch, createDeferred, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import Button from "../../components/Button/Button";
import styles from "./LspLogView.module.css";

/**
 * What a language server wrote to stderr, as the backend kept it.
 *
 * Not a CodeEditor buffer, for the reason `DebugSourceView` is not one: there is
 * no file to save it to, so it has no dirty flag, no undo and no server.
 */
export default function LspLogView(props: { root: string; serverId: string }) {
  const log = createDeferred<string | undefined>(
    () => invoke<string>("lsp_log", { handle: { serverId: props.serverId, root: props.root } }),
    { loadingValue: undefined },
  );

  return (
    <div class={styles.logView}>
      <div class={styles.head}>
        <span class={styles.name}>{props.serverId}</span>
        <span class={styles.note}>{props.root}, stderr, read-only</span>
      </div>
      <Errored
        fallback={(err, reset) => (
          <div class={styles.empty}>
            The log could not be read: {String(err())}{" "}
            <Button size="xs" variant="ghost" onClick={() => reset()}>
              Try again
            </Button>
          </div>
        )}
      >
        <Switch fallback={<div class={styles.empty}>This server has written nothing to stderr.</div>}>
          <Match when={log() === undefined}>
            <div class={styles.empty}>Reading the log...</div>
          </Match>
          <Match when={log()}>{(text) => <LogText text={text()} />}</Match>
        </Switch>
      </Errored>
    </div>
  );
}

function LogText(props: { text: string }) {
  // Opened at the end: the lines that explain a crash are the last ones written.
  let pre: HTMLPreElement | undefined;
  createEffect(
    () => props.text,
    () => {
      if (pre) pre.scrollTop = pre.scrollHeight;
    },
  );
  return (
    <pre ref={pre} class={styles.log}>
      {props.text}
    </pre>
  );
}

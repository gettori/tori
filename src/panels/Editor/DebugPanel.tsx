import { For, Show } from "solid-js";

import {
  consoleLines,
  debugTree,
  type DebugNode,
  type OutputCategory,
  type SessionState,
} from "../../utils/debugStore";
import styles from "./DebugPanel.module.css";

const STATE_LABEL: Record<SessionState, string> = {
  idle: "Starting",
  running: "Running",
  stopped: "Paused",
  terminated: "Finished",
};

const CATEGORY_LABEL: Record<OutputCategory, string> = {
  stdout: "stdout",
  stderr: "stderr",
  console: "console",
  important: "important",
};

/**
 * The debug pane: what is being run, and what it has said.
 *
 * The session list is a tree because a debug run is: even the smallest target
 * is a root plus a child, and a test runner is three or four levels deep. It is
 * flattened into one indented column rather than nested boxes, for the reason
 * the outline is: a deep tree then scrolls as one list and no row can be
 * indented off the right edge of a narrow pane.
 *
 * The console interleaves every session's output in arrival order, tagged with
 * the session that produced it. Splitting it per session would be tidier and
 * would lose the one thing the interleaving shows, which is what happened
 * before what.
 */
export default function DebugPanel() {
  return (
    <div class={styles.debugPanel}>
      <Show
        when={debugTree().length > 0}
        fallback={
          <div class={styles.empty}>
            Nothing is being debugged. Start a run to see its sessions and output here.
          </div>
        }
      >
        <div class={styles.sessions}>
          <SessionRows nodes={debugTree()} depth={0} />
        </div>
      </Show>

      {/* Hidden entirely when there is neither a run nor a transcript: the
          empty state above already says why the pane is empty, and stacking
          "No output yet" under it says the same thing twice. */}
      <Show when={debugTree().length > 0 || consoleLines().length > 0}>
        <div class={styles.console}>
          <Show
            when={consoleLines().length > 0}
            fallback={<div class={styles.empty}>No output yet.</div>}
          >
            <For each={consoleLines()}>
              {(line) => (
                <div class={`${styles.line} ${styles[line.category]}`}>
                  <span class={styles.origin} title={`${line.sessionName} · ${CATEGORY_LABEL[line.category]}`}>
                    {line.sessionName}
                  </span>
                  <span class={styles.text}>{line.text}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// Deep enough for a package script that spawns a runner that spawns a worker;
// past that the indent eats the name, which is the thing the row is for.
const MAX_INDENT_DEPTH = 6;

function SessionRows(props: { nodes: DebugNode[]; depth: number }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <>
          <div
            class={styles.session}
            style={{
              "padding-left": `calc(${Math.min(props.depth, MAX_INDENT_DEPTH)} * 12px * var(--ui-scale) + 8px * var(--ui-scale))`,
            }}
          >
            <span class={styles.name}>{node.name}</span>
            <span class={`${styles.state} ${styles[node.state]}`}>{STATE_LABEL[node.state]}</span>
          </div>
          <SessionRows nodes={node.children} depth={props.depth + 1} />
        </>
      )}
    </For>
  );
}

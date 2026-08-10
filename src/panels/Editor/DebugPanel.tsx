import { For, Show } from "solid-js";
import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-solid";

import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import {
  consoleLines,
  debugTree,
  type DebugNode,
  type OutputCategory,
  type SessionState,
} from "../../utils/debugStore";
import {
  continueDebug,
  debugPaused,
  debugStops,
  pauseDebug,
  selectFrame,
  selectedFrame,
  stepIn,
  stepOut,
  stepOver,
  type StackFrame,
} from "../../utils/debugStack";
import { emit, DEBUG_RESTART, DEBUG_STOP } from "../../utils/events";
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
      <Show when={debugTree().length > 0}>
        <Controls />
      </Show>
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

      {/* Only while something is paused. A stack is what a stopped program has;
          an empty "Call stack" heading over a running one would be a section
          that is permanently empty in the state people spend most time in. */}
      <Show when={debugStops().length > 0}>
        <div class={styles.stack}>
          <For each={debugStops()}>
            {(stop) => (
              <>
                {/* Named even when there is only one, because there usually is
                    not: a test run pauses in a worker, and "which of the 214"
                    is the first thing to know about a frame. */}
                <div class={styles.stackHead}>
                  {stop.name} · paused on {stop.reason}
                </div>
                <Show
                  when={stop.frames.length > 0}
                  fallback={<div class={styles.empty}>No frames for this pause.</div>}
                >
                  <For each={stop.frames}>
                    {(frame) => <FrameRow session={stop.id} frame={frame} />}
                  </For>
                </Show>
              </>
            )}
          </For>
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

/**
 * The six controls, gated on whether the program is paused.
 *
 * Stepping a running program is not a thing DAP can do, so those four are
 * disabled rather than hidden: a toolbar whose buttons come and go is one nobody
 * can build muscle memory for, and a disabled button with a reason on it says
 * why. Continue and pause are the two halves of one state, so exactly one of
 * them is ever available.
 */
function Controls() {
  const paused = () => debugPaused();
  return (
    <div class={styles.controls} role="toolbar" aria-label="Debug controls">
      <Show
        when={paused()}
        fallback={
          <IconButton
            size="xs"
            icon={<Icon icon={Pause} />}
            title="Pause"
            onClick={() => pauseDebug()}
          />
        }
      >
        <IconButton
          size="xs"
          icon={<Icon icon={Play} />}
          title="Continue"
          onClick={() => continueDebug()}
        />
      </Show>
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowRightToLine} />}
        title="Step over"
        disabled={!paused()}
        onClick={() => stepOver()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowDownToLine} />}
        title="Step into"
        disabled={!paused()}
        onClick={() => stepIn()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowUpFromLine} />}
        title="Step out"
        disabled={!paused()}
        onClick={() => stepOut()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={RotateCcw} />}
        title="Restart"
        onClick={() => emit(DEBUG_RESTART)}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={Square} />}
        title="Stop"
        onClick={() => emit(DEBUG_STOP)}
      />
    </div>
  );
}

/** One frame. The whole row is the target, because the thing being clicked is
 *  "go where this is" rather than any one word in it. */
function FrameRow(props: { session: string; frame: StackFrame }) {
  const isSelected = () =>
    selectedFrame()?.session === props.session && selectedFrame()?.frameId === props.frame.id;
  return (
    <button
      type="button"
      class={styles.frame}
      classList={{ [styles.selected]: isSelected() }}
      aria-current={isSelected() ? "true" : undefined}
      onClick={() => selectFrame(props.session, props.frame.id)}
      title={props.frame.path ?? props.frame.sourceName}
    >
      <span class={styles.frameName}>{props.frame.name}</span>
      <span class={styles.frameWhere}>
        {props.frame.sourceName}:{props.frame.line}
      </span>
    </button>
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

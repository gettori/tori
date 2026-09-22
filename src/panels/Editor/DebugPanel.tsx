import { For, Index, Show, createMemo, createSignal } from "solid-js";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpFromLine,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-solid";

import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import { askAgentAboutFrame } from "../../utils/debugAsk";
import { sendTargetFor } from "../../utils/sendTarget";
import {
  consoleLines,
  debugBuild,
  debugTree,
  type DebugNode,
  type OutputCategory,
  type SessionState,
} from "../../utils/debugStore";
import { evaluateRepl, replHistory } from "../../utils/debugRepl";
import {
  addWatchExpression,
  moveWatchExpression,
  removeWatchExpression,
  watchRows,
  watchesLive,
  type WatchRow,
} from "../../utils/debugWatch";
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
import {
  canSetVariable,
  debugScopes,
  isVariableExpanded,
  isVariablesBusy,
  loadMoreVariables,
  setVariableValue,
  toggleVariables,
  variableMore,
  variableRows,
  VARIABLE_PAGE,
  type VarRow,
} from "../../utils/debugVariables";
import { emit, emitWith, DEBUG_RESTART, DEBUG_STOP, TOAST, type ToastEvent } from "../../utils/events";
import type { Selection } from "../LeftSidebar/LeftSidebar";
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
  repl: "console entry",
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
export default function DebugPanel(props: { root: string | null; selected: Selection | null }) {
  return (
    <div class={styles.debugPanel}>
      <Show when={debugTree().length > 0}>
        <Controls />
      </Show>
      <Show when={debugBuild()}>
        {(build) => (
          <div class={styles.building} role="status">
            <span>{build().label}</span>
            <Button size="sm" onClick={() => build().cancel()}>
              Cancel
            </Button>
          </div>
        )}
      </Show>
      <Show
        when={debugTree().length > 0}
        fallback={
          <Show when={!debugBuild()}>
            <div class={styles.empty}>
              Nothing is being debugged. Start a run to see its sessions and output here.
            </div>
          </Show>
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
                    {(frame) => (
                      <FrameRow session={stop.id} frame={frame} selected={props.selected} />
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      {/* Under the stack, because a scope belongs to the frame above it: the
          reading order is which session, where it is, and only then what is in
          scope there. */}
      <Show when={debugScopes().length > 0}>
        <div class={styles.variables}>
          {/* The second entry point for the same question. It sits over the
              scopes rather than on one of them because what it sends is the
              frame: the stack, and whatever of these has been opened. */}
          <div class={styles.varHead}>
            <span>Variables</span>
            <AskButton selected={props.selected} />
          </div>
          <For each={debugScopes()}>
            {(scope) => (
              <>
                <button
                  type="button"
                  class={`${styles.varRow} ${styles.scopeRow}`}
                  aria-expanded={isVariableExpanded(scope.key)}
                  onClick={() =>
                    toggleVariables(scope.key, scope.variablesReference, scope.indexedVariables)
                  }
                >
                  <Twisty open={isVariableExpanded(scope.key)} />
                  <span class={styles.scopeName}>{scope.name}</span>
                  {/* The adapter's own warning, passed on rather than acted on:
                      Global is expensive everywhere, and hiding it would hide
                      the scope people open when nothing else explains the bug. */}
                  <Show when={scope.expensive}>
                    <span class={styles.varNote}>slow</span>
                  </Show>
                </button>
                <Show when={isVariableExpanded(scope.key)}>
                  <VarRows parent={scope.key} depth={1} />
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      {/* Always available, unlike everything above it: the point of a watch is
          that you write it once and it answers on every run afterwards, so the
          list has to be editable before there is anything to answer it. */}
      <Show when={props.root}>
        <Watches root={props.root!} />
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
        <Repl />
      </Show>
    </div>
  );
}

/**
 * The watch list.
 *
 * Rows keep their place while they are being answered, so a step reads as
 * values changing rather than as a list rebuilding itself. An expression that
 * stops resolving shows the adapter's message in place of its value and keeps
 * its row: a watch that vanishes when it errors is one nobody can fix, because
 * there is nothing left to click.
 */
function Watches(props: { root: string }) {
  const [draft, setDraft] = createSignal("");
  const rows = createMemo(() => watchRows(props.root));

  function add() {
    const text = draft().trim();
    if (!text) return;
    addWatchExpression(props.root, text);
    setDraft("");
  }

  return (
    <div class={styles.watches}>
      <div class={styles.watchHead}>Watch</div>
      <form
        class={styles.watchAdd}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          class={styles.watchInput}
          aria-label="Watch expression"
          placeholder="Expression to watch"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <IconButton size="xs" icon={<Icon icon={Plus} />} tooltip="Add watch" type="submit" />
      </form>
      <Show
        when={rows().length > 0}
        fallback={<div class={styles.varNote}>Nothing is being watched.</div>}
      >
        {/* `Index` rather than `For`: the rows are rebuilt on every answer, so
            keying by identity would re-create all of them N times per stop and
            take the focus out of anything being clicked. Keyed by position,
            only the fields that changed are written. */}
        <Index each={rows()}>
          {(row, i) => (
            <WatchRowView root={props.root} row={row()} index={i} last={rows().length - 1} />
          )}
        </Index>
      </Show>
    </div>
  );
}

function WatchRowView(props: { root: string; row: WatchRow; index: number; last: number }) {
  return (
    <div class={styles.varRow} style={{ "padding-left": "calc(8px * var(--ui-scale))" }}>
      <span class={styles.varName}>{props.row.expression}</span>
      <Show
        when={props.row.error}
        fallback={
          <span class={styles.varValue}>
            {props.row.pending
              ? "reading…"
              : (props.row.value ?? (watchesLive() ? "" : "not running"))}
          </span>
        }
      >
        <span class={styles.watchError}>{props.row.error}</span>
      </Show>
      {/* Buttons rather than dragging: the list is short, the order rarely
          changes, and a keyboard can reach these. */}
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowUp} />}
        tooltip={`Move ${props.row.expression} up`}
        disabled={props.index === 0}
        onClick={() => moveWatchExpression(props.root, props.index, props.index - 1)}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowDown} />}
        tooltip={`Move ${props.row.expression} down`}
        disabled={props.index === props.last}
        onClick={() => moveWatchExpression(props.root, props.index, props.index + 1)}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={X} />}
        tooltip={`Remove ${props.row.expression}`}
        onClick={() => removeWatchExpression(props.root, props.index)}
      />
    </div>
  );
}

/**
 * The console's input.
 *
 * Cleared on submit rather than on the answer, because the answer arrives on a
 * line of its own and the entry is already echoed above it: leaving the text in
 * place would make a slow adapter look like a submission that did not take.
 */
function Repl() {
  const [entry, setEntry] = createSignal("");
  // How far back through the history the arrows have walked. `null` is the
  // line being typed, which is what walking forward past the end returns to.
  const [back, setBack] = createSignal<number | null>(null);

  function walk(by: number) {
    const past = replHistory();
    if (!past.length) return;
    const at = back() ?? past.length;
    const next = Math.min(past.length, Math.max(0, at + by));
    setBack(next === past.length ? null : next);
    setEntry(next === past.length ? "" : past[next]);
  }

  return (
    <form
      class={styles.replBar}
      onSubmit={(e) => {
        e.preventDefault();
        const text = entry();
        setEntry("");
        setBack(null);
        void evaluateRepl(text);
      }}
    >
      <span class={styles.replPrompt} aria-hidden="true">
        &gt;
      </span>
      <input
        class={styles.replInput}
        aria-label="Evaluate in the debug console"
        placeholder="Evaluate an expression"
        value={entry()}
        onInput={(e) => {
          setEntry(e.currentTarget.value);
          setBack(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          // The caret would otherwise jump to one end of the field, which is
          // the browser's answer to a key this field has its own answer to.
          e.preventDefault();
          walk(e.key === "ArrowUp" ? -1 : 1);
        }}
      />
    </form>
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
            tooltip="Pause"
            onClick={() => pauseDebug()}
          />
        }
      >
        <IconButton
          size="xs"
          icon={<Icon icon={Play} />}
          tooltip="Continue"
          onClick={() => continueDebug()}
        />
      </Show>
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowRightToLine} />}
        tooltip="Step over"
        disabled={!paused()}
        onClick={() => stepOver()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowDownToLine} />}
        tooltip="Step into"
        disabled={!paused()}
        onClick={() => stepIn()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={ArrowUpFromLine} />}
        tooltip="Step out"
        disabled={!paused()}
        onClick={() => stepOut()}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={RotateCcw} />}
        tooltip="Restart"
        onClick={() => emit(DEBUG_RESTART)}
      />
      <IconButton
        size="xs"
        icon={<Icon icon={Square} />}
        tooltip="Stop"
        onClick={() => emit(DEBUG_STOP)}
      />
    </div>
  );
}

/** One frame. The whole row is the target, because the thing being clicked is
 *  "go where this is" rather than any one word in it. The ask button is a
 *  sibling rather than a child: a button inside a button is not a thing, and
 *  only the selected row carries one, because that is the frame the message
 *  would describe. */
function FrameRow(props: { session: string; frame: StackFrame; selected: Selection | null }) {
  const isCurrent = () =>
    selectedFrame()?.session === props.session && selectedFrame()?.frameId === props.frame.id;
  return (
    <div class={styles.frameRow} classList={{ [styles.selected]: isCurrent() }}>
      {/* No `aria-label`: the two spans below are the frame's name and where it
          is, which is what the row should be called. A label here would replace
          both with the bare path. */}
      <Tooltip
        as="button"
        type="button"
        class={styles.frame}
        aria-current={isCurrent() ? "true" : undefined}
        onClick={() => selectFrame(props.session, props.frame.id)}
        label={props.frame.path ?? props.frame.sourceName}
      >
        <span class={styles.frameName}>{props.frame.name}</span>
        <span class={styles.frameWhere}>
          {props.frame.sourceName}:{props.frame.line}
        </span>
      </Tooltip>
      <Show when={isCurrent()}>
        <AskButton selected={props.selected} />
      </Show>
    </div>
  );
}

/**
 * "Ask the agent", the one control both entry points render.
 *
 * One component rather than two call sites, so the stack pane and the variables
 * tree cannot drift into asking two different questions. What it sends is
 * composed in `debugAsk.ts` from the selected frame, so both buttons produce
 * the same text by construction rather than by agreement.
 *
 * The same capability gate the Problems and TODO panels use: safe-send needs a
 * resumable session to land the text in, and a button that fails when clicked is
 * worse than one that says why first.
 */
function AskButton(props: { selected: Selection | null }) {
  // Asked once per selection rather than once per read: the tooltip and the
  // click both want the same answer, and it is the same answer.
  const gate = createMemo(() => sendTargetFor(props.selected));
  const refusal = () => {
    const answer = gate();
    return "reason" in answer ? answer.reason : null;
  };

  async function ask() {
    const answer = gate();
    if ("reason" in answer) {
      emitWith<ToastEvent>(TOAST, { message: answer.reason, kind: "error" });
      return;
    }
    await askAgentAboutFrame(answer.target);
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      class={styles.ask}
      tooltip={refusal() ?? "Ask the agent about this frame"}
      onClick={() => void ask()}
    >
      Ask
    </Button>
  );
}

/** The open/closed marker. A glyph rather than an icon, so it sits on the text
 *  baseline of a monospace row and lines up down the column. */
function Twisty(props: { open: boolean }) {
  return (
    <span class={styles.twisty} aria-hidden="true">
      {props.open ? "▾" : "▸"}
    </span>
  );
}

// An object graph nests further than a session tree does, so this is its own
// number rather than the session tree's: past it the indent eats the name,
// which is the thing the row is for.
const MAX_VAR_DEPTH = 10;

const varIndent = (depth: number) =>
  `calc(${Math.min(depth, MAX_VAR_DEPTH)} * 12px * var(--ui-scale) + 8px * var(--ui-scale))`;

/** One container's children, plus what is still missing from them. */
function VarRows(props: { parent: string; depth: number }) {
  const indent = () => varIndent(props.depth);
  return (
    <>
      <For each={variableRows(props.parent)}>
        {(row) => <VariableRow row={row} depth={props.depth} />}
      </For>
      {/* A container mid-fetch reads as slow rather than as empty, which are
          the same thing to anyone looking at a scope that has not answered. */}
      <Show when={isVariablesBusy(props.parent)}>
        <div class={styles.varNote} style={{ "padding-left": indent() }}>
          Reading…
        </div>
      </Show>
      {/* Paging is visible on purpose: a truncated list that says nothing is
          indistinguishable from a short one. */}
      <Show when={variableMore(props.parent) > 0}>
        <button
          type="button"
          class={styles.varMore}
          style={{ "padding-left": indent() }}
          onClick={() => void loadMoreVariables(props.parent)}
        >
          Show {Math.min(VARIABLE_PAGE, variableMore(props.parent))} more of{" "}
          {variableMore(props.parent)}
        </button>
      </Show>
    </>
  );
}

/**
 * One variable, and its children when it has any.
 *
 * The value doubles as the edit control, so a settable variable is one click
 * from being set and an unsettable one is plain text. That is also the whole of
 * the capability gate: adapters that do not serve `setVariable` render no
 * control at all rather than one that fails when used.
 */
function VariableRow(props: { row: VarRow; depth: number }) {
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const key = () => props.row.key;
  const indent = () => varIndent(props.depth);

  async function commit(value: string) {
    setEditing(false);
    if (value === props.row.value) return;
    const failure = await setVariableValue(props.row, value);
    setError(failure);
  }

  return (
    <>
      <div class={styles.varRow} style={{ "padding-left": indent() }}>
        <Show
          when={props.row.variablesReference > 0}
          fallback={<span class={styles.twisty} aria-hidden="true" />}
        >
          <button
            type="button"
            class={styles.varToggle}
            aria-expanded={isVariableExpanded(key())}
            aria-label={`Expand ${props.row.name}`}
            onClick={() =>
              toggleVariables(key(), props.row.variablesReference, props.row.indexedVariables)
            }
          >
            <Twisty open={isVariableExpanded(key())} />
          </button>
        </Show>
        <span class={styles.varName}>{props.row.name}</span>
        <Show when={props.row.type}>
          <span class={styles.varType}>{props.row.type}</span>
        </Show>
        <Show
          when={editing()}
          fallback={
            <Show
              when={canSetVariable()}
              fallback={<span class={styles.varValue}>{props.row.value}</span>}
            >
              {/* `aria-label` here, unlike the frame row: the visible text is
                  the variable's *value*, so the name a screen reader would
                  otherwise read out is "42". The action is what to call it. */}
              <Tooltip
                as="button"
                type="button"
                class={`${styles.varValue} ${styles.varEditable}`}
                aria-label={`Set ${props.row.name}`}
                label={`Set ${props.row.name}`}
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
              >
                {props.row.value}
              </Tooltip>
            </Show>
          }
        >
          <input
            class={styles.varInput}
            aria-label={`Value of ${props.row.name}`}
            value={props.row.value}
            autofocus
            onBlur={(e) => void commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit(e.currentTarget.value);
              // Escape leaves the old value alone, which is the only way out of
              // a half-typed expression that does not write it.
              if (e.key === "Escape") setEditing(false);
            }}
          />
        </Show>
      </div>
      <Show when={error()}>
        <div class={styles.varError} style={{ "padding-left": indent() }}>
          {error()}
        </div>
      </Show>
      <Show when={isVariableExpanded(key())}>
        <VarRows parent={key()} depth={props.depth + 1} />
      </Show>
    </>
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

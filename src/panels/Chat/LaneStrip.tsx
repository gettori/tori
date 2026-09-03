import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { Lane } from "./chatStore";
import styles from "./Chat.module.css";

/** The row above the composer: `main`, then one lane per subagent still
 *  running. It switches what you read, never what you type: Sway has no channel
 *  to a subagent, so rebinding the composer would promise one. */
export default function LaneStrip(props: {
  lanes: readonly Lane[];
  /** The lane being read, or null for the main agent. */
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  /** Whether this chat is the one on screen. The `Opt+N` binding is only armed
   *  for it, or every open chat would answer the same keystroke. */
  active: boolean;
}) {
  // Ticks only while something is running, so an idle chat costs nothing. The
  // figure is what this panel has watched, the same basis the status strip's
  // elapsed clock uses.
  const [now, setNow] = createSignal(Date.now());

  createEffect(
    on(
      () => props.lanes.some((l) => l.status === null),
      (running) => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        onCleanup(() => clearInterval(timer));
      },
    ),
  );

  createEffect(() => {
    if (!props.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      // On `e.code`, never `e.key`: macOS rewrites the key while Option is
      // held, so a key-based match would silently never fire.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (!digit) return;
      const at = Number(digit[1]) - 1;
      if (at > props.lanes.length) return;
      e.preventDefault();
      props.onSelect(at === 0 ? null : props.lanes[at - 1]!.agentId);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // A component rather than a factory returning JSX: a lane is mutated in place
  // by the store, so a chip built from plain strings would show the figure and
  // the dot it was first handed and never move again.
  const Chip = (p: { lane: Lane | null; at: number }) => {
    const id = () => p.lane?.agentId ?? null;
    return (
      <button
        type="button"
        class={styles.lane}
        classList={{ [styles.laneOn]: props.selected === id() }}
        aria-pressed={props.selected === id()}
        onClick={() => props.onSelect(id())}
      >
        <span class={`${styles.laneDot} ${p.lane ? laneTone(p.lane) : styles.laneIdle}`} aria-hidden="true" />
        <span class={styles.laneLabel}>{p.lane ? laneLabel(p.lane) : "main"}</span>
        <Show when={p.lane && laneFigure(p.lane, now())}>
          {(figure) => <span class={styles.laneFigure}>{figure()}</span>}
        </Show>
        <span class={styles.laneKey} aria-hidden="true">
          {`⌥${p.at + 1}`}
        </span>
      </button>
    );
  };

  return (
    <Show when={props.lanes.length > 0}>
      <div class={styles.lanes} role="group" aria-label="Subagent lanes">
        <Chip lane={null} at={0} />
        <For each={props.lanes}>{(lane, at) => <Chip lane={lane} at={at() + 1} />}</For>
      </div>
    </Show>
  );
}

/** What it was asked to do, which is the only description a reader can act on.
 *  Its type is the fallback, and the raw id the last resort: an unnamed lane is
 *  still one the reader has to be able to reach. */
export function laneLabel(lane: Lane): string {
  return lane.description || lane.agentType || lane.agentId.slice(0, 8);
}

/** Elapsed while it runs, its token total once it has one. One figure, because
 *  two numbers side by side on a chip this small invite being read as one. */
function laneFigure(lane: Lane, now: number): string | null {
  if (lane.status === null) {
    const seconds = Math.max(0, Math.round((now - lane.startedAt) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
  }
  const tokens = lane.usage?.totalTokens;
  if (tokens === undefined) return null;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Three states, not the agent's whole vocabulary. Folding `cancelled` into
 *  `completed` would hide the one outcome worth noticing, so everything that is
 *  not `completed` reads as trouble. */
function laneTone(lane: Lane): string {
  if (lane.status === null) return styles.laneBusy;
  return lane.status === "completed" ? styles.laneIdle : styles.laneBad;
}

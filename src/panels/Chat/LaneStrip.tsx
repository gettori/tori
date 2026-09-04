import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { Lane } from "./chatStore";
import agentStyles from "../../components/Icon/agentMarks.module.css";
import styles from "./Chat.module.css";

/** The row above the composer: `main`, then one lane per subagent still
 *  running. It switches what you read, never what you type: Sway has no channel
 *  to a subagent, so rebinding the composer would promise one. */
export default function LaneStrip(props: {
  lanes: readonly Lane[];
  /** The lane being read, or null for the main agent. */
  selected: string | null;
  /** The lanes with a row waiting on the user. Those rows also render in main,
   *  so this marks where answering one would take you. */
  blocked: ReadonlySet<string>;
  onSelect: (agentId: string | null) => void;
  /** Whether the main agent is mid-turn. Its own chip has no `Lane` behind it,
   *  so its state is the only one the strip has to be told. */
  busy: boolean;
  /** Which provider mark this chat wears, for the tint the main chip takes
   *  while it works. Null for a session whose provider Sway cannot name, which
   *  keeps the neutral accent rather than borrowing a logo's colour. */
  mark: string | null;
  /** Whether this chat is the one on screen. The `Opt+N` binding is only armed
   *  for it, or every open chat would answer the same keystroke. */
  active: boolean;
}) {
  // Ticks only while something is running, so an idle chat costs nothing. The
  // figure is what this panel has watched, the same basis the status strip's
  // elapsed clock uses.
  const [now, setNow] = createSignal(Date.now());

  const mainTone = () => (props.busy ? agentStyles.tint : styles.laneIdle);

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
    const blocked = () => p.lane !== null && props.blocked.has(p.lane.agentId);
    return (
      <button
        type="button"
        class={styles.lane}
        classList={{ [styles.laneOn]: props.selected === id() }}
        aria-pressed={props.selected === id()}
        onClick={() => props.onSelect(id())}
      >
        {/* The main agent's dot is the one that is not a status tone: it wears
            the working agent's own hue, the way its tab already does, because
            "main" is an identity and the four tones are outcomes. */}
        <span
          class={`${styles.laneDot} ${p.lane ? laneTone(p.lane, blocked()) : mainTone()}`}
          data-mark={p.lane === null && props.busy ? (props.mark ?? undefined) : undefined}
          aria-hidden="true"
        />
        <span class={styles.laneLabel}>{p.lane ? laneLabel(p.lane) : "main"}</span>
        <Show when={p.lane && laneFigure(p.lane, now(), blocked())}>
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

/** Elapsed while it runs, its token total once it succeeded, and otherwise the
 *  agent's own word for how it ended. One figure, because two numbers side by
 *  side on a chip this small invite being read as one.
 *
 *  Every state but "running" says itself in words, so nothing the reader has to
 *  act on is carried by a 6px dot's colour alone. */
function laneFigure(lane: Lane, now: number, blocked: boolean): string | null {
  if (blocked) return "waiting";
  if (lane.status === null) {
    const seconds = Math.max(0, Math.round((now - lane.startedAt) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
  }
  if (lane.status !== "completed") return lane.status;
  const tokens = lane.usage?.totalTokens;
  if (tokens === undefined) return null;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** What a backgrounded `Agent` call records on disk: it returned before the
 *  work did, so the transcript says the lane started and never that it ended. */
const LAUNCHED = "async_launched";

/** Four states, not the agent's whole vocabulary, and the same four the status
 *  strip above the transcript already uses.
 *
 *  Everything that is not `completed` reads as trouble, except the one status
 *  measured to be neither: `async_launched` is what a reopened session finds on
 *  a backgrounded call whose ending was never written, so it is an outcome
 *  nobody recorded rather than a bad one. */
function laneTone(lane: Lane, blocked: boolean): string {
  if (blocked) return styles.laneBlocked;
  if (lane.status === null) return styles.laneBusy;
  if (lane.status === "completed" || lane.status === LAUNCHED) return styles.laneIdle;
  return styles.laneBad;
}

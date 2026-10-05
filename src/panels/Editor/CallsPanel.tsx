import { createSignal, For, Show } from "solid-js";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { callKey, callRootsFor, fetchCallLevel, type CallDirection, type CallItem } from "../../utils/callHierarchy";
import SymbolIcon from "../../components/SymbolIcon/SymbolIcon";
import styles from "./CallsPanel.module.css";

/** Deep enough to follow a chain worth following; past this the indent eats the
 *  name, which is the thing the panel is for. */
const MAX_INDENT_DEPTH = 8;

/** One rendered position in the tree.
 *
 *  `id` is the whole ancestor chain, not the symbol: one function can appear at
 *  several places in a call tree, and each of those is separately expandable.
 *  Keying expansion on the symbol alone would open every copy at once. */
type Row = {
  item: CallItem;
  depth: number;
  id: string;
  /** True when this symbol already appears above it in this branch. */
  cycle: boolean;
};

/**
 * The calls into or out of the symbol under the caret.
 *
 * Expanded a level at a time, because the protocol has no "give me the tree"
 * request: every level is another round trip, and a server that resolves on
 * demand will spend real time on a level nobody asked to see.
 */
export default function CallsPanel(props: { path: string | null }) {
  const [direction, setDirection] = createSignal<CallDirection>("incoming");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set<string>());
  const [children, setChildren] = createSignal<Record<string, CallItem[]>>({});
  const [loading, setLoading] = createSignal<Set<string>>(new Set<string>());

  const roots = () => callRootsFor(props.path);

  /** Switching direction re-roots the same symbol at a different question, so
   *  every expansion below it is about the other tree and cannot be reused. */
  function choose(next: CallDirection) {
    if (next === direction()) return;
    setDirection(next);
    setExpanded(new Set<string>());
    setChildren({});
  }

  async function toggle(row: Row) {
    if (row.cycle) return;
    // Already fetching this row's level. Without this a second click while the
    // first is in flight issues a second identical request: the `…` says a
    // fetch is running but nothing was reading it.
    if (loading().has(row.id)) return;
    const open = expanded();
    if (open.has(row.id)) {
      const next = new Set(open);
      next.delete(row.id);
      setExpanded(next);
      return;
    }
    if (!(row.id in children())) {
      setLoading((prev) => new Set(prev).add(row.id));
      const level = await fetchCallLevel(row.item, direction());
      setChildren((prev) => ({ ...prev, [row.id]: level }));
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
    setExpanded((prev) => new Set(prev).add(row.id));
  }

  function reveal(item: CallItem) {
    // The name, not the body: landing on a function's opening brace is
    // technically the symbol and practically the wrong line to be looking at.
    emitWith(OPEN_IN_EDITOR, { path: item.path, line: item.selectLine, col: item.selectColumn });
  }

  /** The tree flattened to a list, so a deep chain scrolls as one column.
   *
   *  The cycle guard lives here rather than at fetch time on purpose: a
   *  mutually recursive pair is a real edge and worth drawing once. What must
   *  not happen is expanding *through* it forever, so the repeat is rendered
   *  and marked, and simply has no disclosure control. */
  function rows(): Row[] {
    const out: Row[] = [];
    const walk = (items: CallItem[], depth: number, prefix: string, seen: string[]) => {
      for (const item of items) {
        const key = callKey(item);
        const id = `${prefix}>${key}`;
        const cycle = seen.includes(key);
        out.push({ item, depth, id, cycle });
        if (!cycle && expanded().has(id)) {
          walk(children()[id] ?? [], depth + 1, id, [...seen, key]);
        }
      }
    };
    walk(roots(), 0, "", []);
    return out;
  }

  return (
    <div class={styles.callsPanel}>
      <div class={styles.toolbar}>
        <button
          type="button"
          class={`${styles.toggle} ${direction() === "incoming" ? styles.toggleOn : ""}`}
          onClick={() => choose("incoming")}
        >
          Incoming
        </button>
        <button
          type="button"
          class={`${styles.toggle} ${direction() === "outgoing" ? styles.toggleOn : ""}`}
          onClick={() => choose("outgoing")}
        >
          Outgoing
        </button>
      </div>
      <div class={styles.rows}>
        <Show
          when={roots().length}
          fallback={
            // The tab is visible, so the server *does* do call hierarchy; it
            // just found nothing callable where the caret is. Saying which of
            // those two it is, is the whole reason the tab is not hidden here.
            <div class={styles.empty}>Put the caret on a function to see its calls.</div>
          }
        >
          <For each={rows()}>
            {(row) => (
              <div
                class={styles.row}
                style={{
                  "padding-left": `calc(${Math.min(row.depth, MAX_INDENT_DEPTH)} * 12px * var(--ui-scale) + 4px * var(--ui-scale))`,
                }}
                onClick={() => reveal(row.item)}
                title={row.item.detail ? `${row.item.name} ${row.item.detail}` : row.item.name}
              >
                <button
                  type="button"
                  class={styles.twisty}
                  aria-label={expanded().has(row.id) ? "Collapse" : "Expand"}
                  onClick={(e) => {
                    // The row itself navigates; the twisty must not, or opening
                    // a level would also jump away from the tree being opened.
                    e.stopPropagation();
                    void toggle(row);
                  }}
                >
                  {row.cycle ? "" : loading().has(row.id) ? "…" : expanded().has(row.id) ? "▾" : "▸"}
                </button>
                <SymbolIcon kind={row.item.kind} class={styles.kind} />
                <span class={styles.name}>{row.item.name}</span>
                <Show when={row.cycle}>
                  <span class={styles.cycle}>cycle</span>
                </Show>
                <span class={styles.where}>
                  {row.item.path.split("/").pop()}:{row.item.selectLine}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

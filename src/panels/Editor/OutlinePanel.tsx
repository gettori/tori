import { For, Show } from "solid-js";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { symbolsFor, type SymbolNode } from "../../utils/symbols";
import SymbolIcon from "../../components/SymbolIcon/SymbolIcon";
import styles from "./OutlinePanel.module.css";

// Deep enough for a nested class in a namespace in a module; past that the
// indent eats the name, which is the thing the panel is for.
const MAX_INDENT_DEPTH = 6;

/** The active file's symbols, as the server sees them.
 *
 *  Reads the shared store rather than requesting: the editor is the only thing
 *  holding a live client, so it publishes and every symbol surface reads. That
 *  is also what lets this panel, the palette's `@` mode and (later) breadcrumbs
 *  share one answer instead of asking three times for the same file.
 *
 *  Rows are flattened into one list with an indent rather than nested `<div>`s,
 *  so a deep tree scrolls as one column and no row can be indented off the
 *  right edge of a narrow pane. */
export default function OutlinePanel(props: { path: string | null }) {
  const nodes = () => symbolsFor(props.path);

  function reveal(node: SymbolNode) {
    // The name, not the body: landing on a class's opening brace is technically
    // the symbol and practically the wrong line to be looking at.
    emitWith(OPEN_IN_EDITOR, { path: node.path, line: node.selectLine, col: node.selectColumn });
  }

  return (
    <div class={styles.outlinePanel}>
      <Show
        when={nodes().length}
        fallback={<div class={styles.empty}>No symbols in this file.</div>}
      >
        <Rows nodes={nodes()} depth={0} onReveal={reveal} />
      </Show>
    </div>
  );
}

function Rows(props: { nodes: SymbolNode[]; depth: number; onReveal: (n: SymbolNode) => void }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <>
          <div
            class={styles.row}
            style={{
              "padding-left": `calc(${Math.min(props.depth, MAX_INDENT_DEPTH)} * 12px * var(--ui-scale) + 8px * var(--ui-scale))`,
            }}
            onClick={() => props.onReveal(node)}
            title={node.detail ? `${node.name} ${node.detail}` : node.name}
          >
            <SymbolIcon kind={node.kind} class={styles.kind} />
            <span class={styles.name}>{node.name}</span>
            <Show when={node.detail}>
              <span class={styles.detail}>{node.detail}</span>
            </Show>
          </div>
          <Rows nodes={node.children} depth={props.depth + 1} onReveal={props.onReveal} />
        </>
      )}
    </For>
  );
}

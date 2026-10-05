// The pane tree, drawn (plan phase 8). One recursive component over the layout
// model: a split lays its visible children out along its direction with a
// Resizer between each pair, a leaf is a PaneView. The shell hands it the
// per-pane roles; nothing about terminals or files is decided here.
//
// The editor chrome is not in here (phase 12). It is workspace chrome, like the
// sidebar: it sits beside the whole tree, so splitting a pane or moving the
// last file tab out of one never carries the file tree along with it.
//
// Sizing repeats what the two-pane shell did before it: the first visible child
// of a split is the filler (it absorbs the slack and any rounding), every other
// child gets an explicit px size derived from its stored share of the measured
// box. That is why a seeded two-pane layout renders the DOM it always did.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import Resizer from "../components/Resizer/Resizer";
import PaneView from "../tabs/PaneView";
import { leaves, type PaneNode, type PaneSplit } from "./paneLayout";
import type { UnifiedTabKind } from "../tabs/unifiedTabs";

/** Smallest a pane may be dragged to, in design px at `--ui-scale` 1. */
export const PANE_MIN = 180;
/** One Resizer's thickness (Resizer.module.css .resizer). */
const GUTTER = 8;

export type PaneRoles = {
  /** What an empty pane's trailing cluster belongs to. */
  pinKindOf: (paneId: string) => UnifiedTabKind;
  /** The pane's shell class: "terminal", "editor" or "split". */
  roleOf: (paneId: string) => string;
  /** The workspace whose tabs these panes hold. */
  ws: string;
  /** Design px -> on-screen px, at the current UI scale. */
  px: (base: number) => number;
  onResize: (paneId: string, percent: number) => void;
  onCommit: () => void;
};

const hiddenNode = (n: PaneNode): boolean => (n.type === "pane" ? n.hidden : leaves(n).every((l) => l.hidden));

const asSplit = (n: PaneNode) => (n.type === "split" ? n : null);

export default function PaneTree(props: { node: PaneNode; roles: PaneRoles }): JSX.Element {
  return (
    <Show when={asSplit(props.node)} fallback={<Leaf node={props.node} roles={props.roles} filler />}>
      {(split) => <Split node={split()} roles={props.roles} filler />}
    </Show>
  );
}

function Split(props: { node: PaneSplit; roles: PaneRoles; filler: boolean }) {
  let el: HTMLDivElement | undefined;
  const [box, setBox] = createSignal(0);
  const row = () => props.node.dir === "row";
  const dim = () => (row() ? "width" : "height");
  onMount(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox(row() ? entry.contentRect.width : entry.contentRect.height));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const visible = () => props.node.children.filter((c) => !hiddenNode(c));
  const floor = () => props.roles.px(PANE_MIN);
  // What the sized children share, once the gutters between them are gone.
  const avail = () => Math.max(0, box() - props.roles.px(GUTTER) * Math.max(0, visible().length - 1));
  // Room a single child may take: everything but its siblings' floors.
  const ceiling = () => Math.max(floor(), avail() - floor() * Math.max(0, visible().length - 1));
  // Sizes are read as a share of the visible children, but the model stores a
  // share of all of them, so a drag in a split with a hidden sibling has to be
  // scaled back into the model's frame before it is written.
  const visibleShare = () => visible().reduce((s, c) => s + Math.max(0, c.size), 0);
  const toModelPercent = (v: number) => (avail() > 0 ? (v / avail()) * (visibleShare() || 100) : 50);
  // The same clamp-at-render the two-pane shell used: the stored share is what
  // the user chose, so a narrower window squeezes a pane and widening it restores
  // the choice.
  const sizeOf = (n: PaneNode) => {
    if (avail() <= 0) return 0;
    const vis = visible();
    const sum = vis.reduce((s, c) => s + Math.max(0, c.size), 0);
    const share = sum > 0 ? Math.max(0, n.size) / sum : 1 / Math.max(1, vis.length);
    return Math.min(Math.max(share * avail(), floor()), ceiling());
  };

  // Every child stays mounted, hidden ones included: a hidden pane keeps its
  // PTYs and buffers alive behind display:none, which is the whole reason the
  // model carries `hidden` instead of dropping the leaf.
  const filler = (c: PaneNode) => visible()[0]?.id === c.id;
  const leading = (c: PaneNode) => !hiddenNode(c) && !filler(c);

  return (
    <div class="pane-split" classList={{ row: row(), column: !row(), filler: props.filler }} ref={el}>
      <For each={props.node.children}>
        {(child) => (
          <>
            <Show when={leading(child)}>
              <Resizer
                axis={row() ? "x" : "y"}
                side="after"
                variant="hairline"
                value={sizeOf(child)}
                min={floor()}
                max={ceiling()}
                onInput={(v) => props.roles.onResize(child.id, toModelPercent(v))}
                onCommit={props.roles.onCommit}
              />
            </Show>
            <Show
              when={asSplit(child)}
              fallback={
                <Leaf
                  node={child}
                  roles={props.roles}
                  filler={filler(child)}
                  style={filler(child) ? undefined : { [dim()]: `${sizeOf(child)}px` }}
                />
              }
            >
              {(s) => (
                <div
                  class="pane-slot"
                  classList={{
                    filler: filler(s()),
                    sized: !filler(s()),
                    hidden: hiddenNode(s()),
                  }}
                  style={filler(s()) ? undefined : { [dim()]: `${sizeOf(s())}px` }}
                >
                  <Split node={s()} roles={props.roles} filler />
                </div>
              )}
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

function Leaf(props: { node: PaneNode; roles: PaneRoles; filler: boolean; style?: Record<string, string> }) {
  const pin = () => props.roles.pinKindOf(props.node.id);
  return (
    <div
      class="pane"
      classList={{
        [props.roles.roleOf(props.node.id)]: true,
        filler: props.filler,
        sized: !props.filler,
        hidden: hiddenNode(props.node),
      }}
      data-pane-id={props.node.id}
      style={props.style}
    >
      <PaneView paneId={props.node.id} ws={props.roles.ws} pinKind={pin()} />
    </div>
  );
}

// The conflict tab's editors held at one height per region, so a single scroll
// position is the same place in every one of them.
import { BlockType, Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";

class AlignSpacer extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  eq(other: AlignSpacer): boolean {
    return other.height === this.height;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-align-spacer";
    el.style.height = `${this.height}px`;
    return el;
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.style.height = `${this.height}px`;
    return true;
  }

  get estimatedHeight(): number {
    return this.height;
  }
}

const setSpacers = StateEffect.define<DecorationSet>();

const spacerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(spacers, tr) {
    for (const e of tr.effects) if (e.is(setSpacers)) return e.value;
    return spacers.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// A region starts above its own rows but ends at the text of the line after
// it, so a side with no lines still counts the row it shows.
export type Anchor = { pos: number; at: "top" | "text" | "bottom" };

export function posAnchor(doc: Text, pos: number, at: "top" | "text"): Anchor {
  const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
  // A last line with no newline has no line start after it, only its bottom.
  return pos <= line.from ? { pos: line.from, at } : { pos: line.to, at: "bottom" };
}

export function lineAnchor(doc: Text, line: number, at: "top" | "text"): Anchor {
  return line > doc.lines ? posAnchor(doc, doc.length, at) : { pos: doc.line(Math.max(line, 1)).from, at };
}

function spacerHeights(natural: number[][]): number[][] {
  const added = natural.map(() => 0);
  const out = natural.map(() => [] as number[]);
  const count = Math.min(...natural.map((group) => group.length));
  for (let i = 0; i < count; i++) {
    const at = natural.map((group, g) => group[i] + added[g]);
    const target = Math.max(...at);
    at.forEach((y, g) => {
      out[g].push(target - y);
      added[g] += target - y;
    });
  }
  return out;
}

export type AlignMember = { view: EditorView; anchors: Anchor[] };

// Where each anchor would sit without this module's spacers, which is what
// the next set is computed from.
function naturalTops({ view, anchors }: AlignMember): number[] {
  const spacers: { pos: number; height: number }[] = [];
  view.state.field(spacerField, false)?.between(0, view.state.doc.length, (from, _to, deco) => {
    spacers.push({ pos: from, height: (deco.spec.widget as AlignSpacer).height });
  });
  let i = 0;
  let above = 0;
  return anchors.map(({ pos, at }) => {
    while (i < spacers.length && (spacers[i].pos < pos || (at !== "top" && spacers[i].pos === pos))) {
      above += spacers[i++].height;
    }
    const block = view.lineBlockAt(pos);
    const text = Array.isArray(block.type) ? block.type.find((b) => b.type === BlockType.Text) : block;
    return (at === "bottom" ? block.bottom : at === "text" ? (text ?? block).top : block.top) - above;
  });
}

function sameSpacers(a: DecorationSet, b: DecorationSet): boolean {
  if (a.size !== b.size) return false;
  for (const ia = a.iter(), ib = b.iter(); ia.value && ib.value; ia.next(), ib.next()) {
    const [wa, wb] = [ia.value.spec, ib.value.spec];
    if (ia.from !== ib.from || wa.side !== wb.side || Math.abs(wa.widget.height - wb.widget.height) > 1) return false;
  }
  return true;
}

// Groups are lined up against each other, and every member of a group gets the
// same spacers. The two side panes are one group because MergeView aligns them
// itself: a spacer on one of them alone is a difference it would measure and undo.
export function paneAligner(groups: () => AlignMember[][]): {
  extension: Extension;
  schedule(): void;
  destroy(): void;
} {
  let frame = 0;

  const run = () => {
    frame = 0;
    const live = groups().filter((members) => members.length);
    if (live.length < 2) return;
    const natural = live.map((members) => {
      const tops = members.map(naturalTops);
      return tops[0].map((_, i) => Math.max(...tops.map((t) => t[i])));
    });
    const heights = spacerHeights(natural);
    live.forEach((members, g) => {
      for (const { view, anchors } of members) {
        const ranges = anchors.flatMap((anchor, i) =>
          heights[g][i] > 0.5
            ? [
                // The rows at a region's start (side actions, the Result slot)
                // are side -1: a start spacer goes above them, an end spacer
                // below, so a row stays with its own region.
                Decoration.widget({
                  widget: new AlignSpacer(heights[g][i]),
                  block: true,
                  side: anchor.at === "bottom" ? 1 : anchor.at === "text" ? 0 : -2,
                }).range(anchor.pos),
              ]
            : [],
        );
        const next = Decoration.set(ranges, true);
        if (!sameSpacers(next, view.state.field(spacerField))) view.dispatch({ effects: setSpacers.of(next) });
      }
    });
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run);
  };

  return {
    extension: [
      spacerField,
      EditorView.updateListener.of((u) => {
        if (!(u.heightChanged || u.geometryChanged || u.docChanged)) return;
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setSpacers)))) return;
        schedule();
      }),
    ],
    schedule,
    destroy: () => cancelAnimationFrame(frame),
  };
}

export function scrollTogether(els: HTMLElement[]): () => void {
  // An element this module just moved, whose own scroll event must not move
  // the rest back: a shorter pane clamps, and following the clamp would pin
  // the one the reader is scrolling.
  const quiet = new Set<HTMLElement>();
  const offs = els.map((el) => {
    const onScroll = () => {
      if (quiet.delete(el)) return;
      for (const other of els) {
        if (other === el || Math.abs(other.scrollTop - el.scrollTop) < 1) continue;
        const before = other.scrollTop;
        quiet.add(other);
        other.scrollTop = el.scrollTop;
        if (other.scrollTop === before) quiet.delete(other);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  });
  return () => offs.forEach((off) => off());
}

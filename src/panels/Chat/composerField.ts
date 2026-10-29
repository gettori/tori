// The composer's input: a CodeMirror view in place of the textarea it was.
//
// Only `@codemirror/view` and `@codemirror/state` are imported here, because the
// composer is on the eager path and those two are all the lazy-editor boundary
// lets it hold (src/test/lazyEditorBoundary.test.ts). Undo, the keymaps and the
// markdown and code highlighting are in `composerFieldRich.ts`, which loads
// behind a dynamic import and is slotted in when it arrives. Until then the
// field is a plain editable box, which is all a first keystroke needs.
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, dropCursor, placeholder, type DecorationSet } from "@codemirror/view";

/** How a chip draws itself. `key` is what tells two chips for one label apart
 *  (a chip removed and another attached under the same name), so a widget is
 *  reused only while its key holds. */
export type ChipSpec = { key: string; mount: (dom: HTMLElement) => () => void };

export type ComposerFieldOptions = {
  parent: HTMLElement;
  doc: string;
  placeholder: string;
  readOnly: boolean;
  disabled: boolean;
  skills: readonly string[];
  /** The chip for a bracketed token, or null when nothing held answers to it. */
  chipFor: (label: string) => ChipSpec | null;
  /** The text changed by the user, never by `set`. */
  onInput: (value: string) => void;
  /** The caret or the selection moved, by any means. */
  onSelect: () => void;
  /** Return true once the key is handled, so CodeMirror leaves it alone. */
  onKeyDown: (e: KeyboardEvent) => boolean;
  onPaste: (e: ClipboardEvent) => boolean;
  /** A drop on the text. Return true once the composer has taken it (files,
   *  paths, chips); false leaves it to CodeMirror, which moves text dragged
   *  inside the field itself. */
  onDrop: (e: DragEvent) => boolean;
  onFocus: () => void;
  onBlur: () => void;
};

export type ComposerField = {
  view: EditorView;
  value: () => string;
  caret: () => number;
  selection: () => { from: number; to: number };
  /** Replace the text and put the caret at `caret`, without an `onInput`. */
  set: (text: string, caret: number) => void;
  select: (caret: number) => void;
  focus: () => void;
  /** The text offset under a point, or undefined outside the text. */
  posAt: (x: number, y: number) => number | undefined;
  setPlaceholder: (text: string) => void;
  setReadOnly: (readOnly: boolean, disabled: boolean) => void;
  setSkills: (names: readonly string[]) => void;
  /** Recompute which tokens are chips, after the held attachments changed. */
  refreshChips: () => void;
  destroy: () => void;
};

/** The session's skills by name, for the rich layer to colour a `/skill` named
 *  mid-sentence the way it colours a command at the start. */
export const skillNames = Facet.define<readonly string[], readonly string[]>({
  combine: (values) => values.flat(),
});

/** Marks a transaction as the composer's own, so it is not reported back as
 *  typing. */
const external = Annotation.define<boolean>();
const refresh = StateEffect.define<null>();

// A label is one line in brackets: `[Image 1]`, `[PR 412]`, `[Session: Fix it]`.
const TOKEN = /\[[^[\]\n]{1,200}\]/g;

// Per drawn copy, not per widget: CodeMirror may draw one widget more than once
// and names the copy it is retiring, so a single slot would let retiring an old
// copy empty the one on screen.
const disposers = new WeakMap<HTMLElement, () => void>();

class ChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly spec: ChipSpec,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.label === this.label && other.spec.key === this.spec.key;
  }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-chip";
    disposers.set(dom, this.spec.mount(dom));
    return dom;
  }
  destroy(dom: HTMLElement) {
    disposers.get(dom)?.();
    disposers.delete(dom);
  }
}

// The shapes an attachment's label takes. A token in one of them with nothing
// held behind it names an attachment the message will not carry.
const LABEL = /^\[(?:(?:Image|PDF|File|PR) \d+|(?:Session|Project|Space): .+)\]$/i;

const ghost = Decoration.mark({ class: "cm-ghostToken" });

type Tokens = { chips: DecorationSet; ghosts: DecorationSet };

function chipField(chipFor: (label: string) => ChipSpec | null) {
  const build = (state: EditorState): Tokens => {
    const chips = new RangeSetBuilder<Decoration>();
    const ghosts = new RangeSetBuilder<Decoration>();
    for (const m of state.doc.toString().matchAll(TOKEN)) {
      const from = m.index;
      const to = from + m[0].length;
      const spec = chipFor(m[0]);
      if (spec) chips.add(from, to, Decoration.replace({ widget: new ChipWidget(m[0], spec) }));
      else if (LABEL.test(m[0])) ghosts.add(from, to, ghost);
    }
    return { chips: chips.finish(), ghosts: ghosts.finish() };
  };
  return StateField.define<Tokens>({
    create: build,
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(refresh))) return build(tr.state);
      return value;
    },
    // A chip is atomic as well as drawn: the caret steps over it and Backspace
    // takes the whole token, rather than leaving `[Image ` behind as text. A
    // ghost stays text, since it is text that has to be fixed.
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.chips),
      EditorView.decorations.from(f, (v) => v.ghosts),
      EditorView.atomicRanges.of((view) => view.state.field(f).chips),
    ],
  });
}

export function createComposerField(opts: ComposerFieldOptions): ComposerField {
  const placeholderSlot = new Compartment();
  const editableSlot = new Compartment();
  const richSlot = new Compartment();
  const skillsSlot = new Compartment();
  // A drag that started inside the field is a move of its own text.
  let draggingOwn = false;

  const editable = (readOnly: boolean, disabled: boolean): Extension => [
    EditorState.readOnly.of(readOnly || disabled),
    EditorView.editable.of(!disabled),
  ];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      selection: EditorSelection.cursor(opts.doc.length),
      extensions: [
        EditorView.lineWrapping,
        // Where a dragged token will land, shown while it is over the text, so
        // dropping one inside a word is not guesswork.
        dropCursor(),
        placeholderSlot.of(placeholder(opts.placeholder)),
        editableSlot.of(editable(opts.readOnly, opts.disabled)),
        skillsSlot.of(skillNames.of(opts.skills)),
        EditorView.contentAttributes.of({
          "aria-label": "Message",
          "aria-multiline": "true",
          // Spelling is marked, never rewritten: autocorrect would "fix" the
          // identifiers and paths a prompt is full of.
          spellcheck: "true",
          autocorrect: "off",
          autocapitalize: "off",
        }),
        chipField(opts.chipFor),
        // Highest, so the composer's keys (send, menus, recall) are answered
        // before any keymap the rich layer brings.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (e) => opts.onKeyDown(e),
            paste: (e) => opts.onPaste(e),
            dragstart: () => {
              draggingOwn = true;
              return false;
            },
            dragend: () => {
              draggingOwn = false;
              return false;
            },
            // Handled here rather than left to bubble: a handler that returns
            // true has its event's default prevented by CodeMirror, which is
            // the very mark the composer reads as "already dealt with".
            drop: (e) => {
              const own = draggingOwn;
              draggingOwn = false;
              return !own && opts.onDrop(e);
            },
            focus: () => {
              opts.onFocus();
              return false;
            },
            blur: () => {
              opts.onBlur();
              return false;
            },
          }),
        ),
        EditorView.updateListener.of((u) => {
          const ours = u.transactions.some((tr) => tr.annotation(external));
          if (u.docChanged && !ours) opts.onInput(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) opts.onSelect();
        }),
        richSlot.of([]),
      ],
    }),
  });

  let destroyed = false;
  void import("./composerFieldRich").then(
    (m) => {
      if (!destroyed) view.dispatch({ effects: richSlot.reconfigure(m.richExtensions()) });
    },
    () => {},
  );

  return {
    view,
    value: () => view.state.doc.toString(),
    caret: () => view.state.selection.main.head,
    selection: () => ({ from: view.state.selection.main.from, to: view.state.selection.main.to }),
    set(text, caret) {
      const at = Math.max(0, Math.min(caret, text.length));
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(at),
        annotations: external.of(true),
        scrollIntoView: true,
      });
    },
    select(caret) {
      const at = Math.max(0, Math.min(caret, view.state.doc.length));
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
    },
    focus: () => view.focus(),
    posAt(x, y) {
      // Over the text or not at all: a drop on the tiles above the field is not
      // a drop at the nearest character, it is a drop at the caret.
      const box = view.contentDOM.getBoundingClientRect();
      if (!box.width || x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined;
      return view.posAtCoords({ x, y }) ?? undefined;
    },
    setPlaceholder(text) {
      view.dispatch({ effects: placeholderSlot.reconfigure(placeholder(text)) });
    },
    setReadOnly(readOnly, disabled) {
      view.dispatch({ effects: editableSlot.reconfigure(editable(readOnly, disabled)) });
    },
    setSkills(names) {
      view.dispatch({ effects: skillsSlot.reconfigure(skillNames.of(names)) });
    },
    refreshChips() {
      view.dispatch({ effects: refresh.of(null) });
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}

// The composer field's lazy half (see composerField.ts): undo, the editing
// keymaps, and markdown with every fenced block highlighted in its own
// language, painted with the editor's own syntax colours.
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, keymap, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { toriHighlight } from "../Editor/syntaxStyle";

// Prose stays prose: the marks that make it markdown recede, and what they mark
// reads the way it will once the message is a bubble.
const prose = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // The address, not the bracketed text: `[Image 1]` parses as a link, and
  // painting it as one would dress an attachment's name as something it is not.
  { tag: t.url, color: "var(--accent-fg)" },
  { tag: t.monospace, fontFamily: "var(--tori-font-mono)", color: "var(--syntax-string)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--fg-subtle)" },
]);

const fenceLine = Decoration.line({ class: "cm-fence" });
const fenceTop = Decoration.line({ class: "cm-fence cm-fenceEdge cm-fenceTop" });
const fenceBottom = Decoration.line({ class: "cm-fence cm-fenceEdge cm-fenceBottom" });

/** A fenced block's lines get the code block's ground, so a block in the draft
 *  looks like the block it becomes in the transcript. */
const fences = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== "FencedCode") return;
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) {
              const line = doc.line(n);
              builder.add(line.from, line.from, n === first ? fenceTop : n === last ? fenceBottom : fenceLine);
            }
            return false;
          },
        });
      }
      return builder.finish();
    }
  },
  { decorations: (p) => p.decorations },
);

const commandMark = Decoration.mark({ class: "cm-command" });
const COMMAND = /^\/[a-z][\w:-]*(?=\s|$)/;

/** A slash command at the very start reads as the command it is. */
const command = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const m = COMMAND.exec(view.state.doc.sliceString(0, 64));
      return m ? Decoration.set([commandMark.range(0, m[0].length)]) : Decoration.none;
    }
  },
  { decorations: (p) => p.decorations },
);

export function richExtensions(): Extension {
  return [
    history(),
    keymap.of([...historyKeymap, ...standardKeymap]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(toriHighlight),
    syntaxHighlighting(prose),
    fences,
    command,
  ];
}

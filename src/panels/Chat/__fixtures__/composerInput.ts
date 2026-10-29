import { EditorView } from "@codemirror/view";

/**
 * The composer's input for a test: the editor's content element, answering to
 * the slice of the textarea API the composer tests drive it by.
 *
 * Every write goes through the real EditorView, so a test still exercises the
 * field the user types into. `fireEvent.input(el, { target: { value } })` sets
 * `value` here, which is the user's edit; `fireEvent.keyDown(el, ...)` reaches
 * the field's own key handling, since the content element is where CodeMirror
 * listens.
 */
export function composerInput(root: ParentNode = document): HTMLTextAreaElement {
  // By its label: a sent prompt in the transcript is drawn by an editor too.
  const editor = root
    .querySelector<HTMLElement>('.cm-content[aria-label="Message"]')
    ?.closest<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("no composer field in this tree");
  const view = EditorView.findFromDOM(editor)!;
  const el = view.contentDOM;
  if (!(el as { __composer?: true }).__composer) {
    Object.defineProperties(el, {
      __composer: { value: true },
      value: {
        get: () => view.state.doc.toString(),
        set: (text: string) =>
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: text.length },
            userEvent: "input.type",
          }),
        configurable: true,
      },
      selectionStart: { get: () => view.state.selection.main.from, configurable: true },
      selectionEnd: { get: () => view.state.selection.main.to, configurable: true },
      setSelectionRange: {
        value: (from: number, to: number) => view.dispatch({ selection: { anchor: from, head: to } }),
        configurable: true,
      },
      placeholder: {
        get: () => editor.querySelector(".cm-placeholder")?.textContent ?? "",
        configurable: true,
      },
      readOnly: { get: () => view.state.readOnly, configurable: true },
      disabled: { get: () => !view.state.facet(EditorView.editable), configurable: true },
    });
  }
  // Typed as the textarea it stands in for, which is the whole of its purpose:
  // the tests were written against one and read the same against this.
  return el as unknown as HTMLTextAreaElement;
}

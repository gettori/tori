// The Changes tab's editor layout: the file itself in a read-only buffer, with
// git's hunks drawn over it. Behind the fence; DiffView loads it lazily.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { defaultKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { DiffHunk } from "../../utils/diffHunks";
import { vimModeOn } from "../Settings/settingsStore";
import { diffBufferExtension, setDiffHunks } from "./diffBuffer";
import { swayTheme } from "./editorTheme";
import { languageForPath } from "./languages";
import { syntaxFor } from "./syntaxStyle";
import { vimExtension } from "./vimMode";
import styles from "./DiffBufferView.module.css";

export default function DiffBufferView(props: { text: string; hunks: DiffHunk[]; path: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let language: Language | null = null;
  const vimConf = new Compartment();
  const syntaxConf = new Compartment();

  function load() {
    if (!view) return;
    const doc = view.state.doc.toString();
    view.dispatch({
      changes: doc === props.text ? undefined : { from: 0, to: doc.length, insert: props.text },
      effects: setDiffHunks.of({ hunks: props.hunks, language }),
    });
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          // First, for CodeEditor's reason: vim claims a key before any keymap sees it.
          vimConf.of(vimExtension(vimModeOn())),
          diffBufferExtension(),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.readOnly.of(true),
          highlightSelectionMatches(),
          syntaxConf.of([]),
          swayTheme,
          keymap.of([...searchKeymap, ...defaultKeymap]),
        ],
      }),
    });
    load();
  });

  createEffect(
    on(
      () => props.path,
      async (path) => {
        const [ext, lang] = await Promise.all([syntaxFor(path), languageForPath(path)]);
        if (path !== props.path || !view) return;
        language = lang;
        view.dispatch({ effects: syntaxConf.reconfigure(ext) });
        load();
      },
    ),
  );
  createEffect(on([() => props.text, () => props.hunks], load, { defer: true }));
  createEffect(
    on(vimModeOn, (vimOn) => view?.dispatch({ effects: vimConf.reconfigure(vimExtension(vimOn)) }), { defer: true }),
  );
  onCleanup(() => view?.destroy());

  return <div class={styles.buffer} ref={host} />;
}

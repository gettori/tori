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
import { Compartment, EditorState, type StateCommand } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { defaultKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { Blame } from "../../utils/blame";
import type { DiffHunk } from "../../utils/diffHunks";
import { vimModeOn } from "../Settings/settingsStore";
import { blameExtension, setBlameMarkers } from "./blameGutter";
import { caretListener } from "./cursorJump";
import {
  diffBufferExtension,
  diffBufferField,
  diffOverviewRuler,
  hunkActionGutter,
  nextChange,
  previousChange,
  selectedRows,
  setDiffHunks,
  setHunksBusy,
  type HunkAction,
} from "./diffBuffer";
import { toriTheme } from "./editorTheme";
import { findWidget } from "./FindWidget";
import { languageForPath } from "./languages";
import { syntaxFor } from "./syntaxStyle";
import { vimExtension } from "./vimMode";
import styles from "./DiffBufferView.module.css";

export default function DiffBufferView(props: {
  text: string;
  hunks: DiffHunk[];
  path: string;
  staged: boolean;
  busy: boolean;
  canStage: boolean;
  blame: Blame | null;
  onHunk: (hunk: number, action: HunkAction) => void;
  onSelect: (picked: { hunk: number; lines: number[] }[]) => void;
  controls?: (nav: { next: () => void; previous: () => void }) => void;
  onCaret?: (line: number, column: number) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let language: Language | null = null;
  const vimConf = new Compartment();
  const syntaxConf = new Compartment();
  const stageConf = new Compartment();
  const blameConf = new Compartment();
  let blameShown = false;
  const stageGutter = hunkActionGutter({
    staged: () => props.staged,
    run: (hunk, action) => props.onHunk(hunk, action),
  });

  function load() {
    if (!view) return;
    const doc = view.state.sliceDoc();
    view.dispatch({
      changes: doc === props.text ? undefined : { from: 0, to: view.state.doc.length, insert: props.text },
      effects: setDiffHunks.of({ hunks: props.hunks, language }),
    });
    placeBlame();
  }

  // After the text: a whole-document replace drops the markers it maps through.
  function placeBlame() {
    if (!view) return;
    const blame = props.blame;
    if (!!blame !== blameShown) {
      blameShown = !!blame;
      view.dispatch({ effects: blameConf.reconfigure(blame ? blameExtension() : []) });
    }
    if (blame) setBlameMarkers(view, blame);
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
          blameConf.of([]),
          stageConf.of(props.canStage ? stageGutter : []),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.readOnly.of(true),
          highlightSelectionMatches(),
          findWidget(),
          syntaxConf.of([]),
          toriTheme,
          diffOverviewRuler(),
          keymap.of([
            { key: "Alt-F5", run: nextChange },
            { key: "Shift-Alt-F5", run: previousChange },
            ...searchKeymap,
            ...defaultKeymap,
          ]),
          caretListener((line, column) => props.onCaret?.(line, column)),
          EditorView.updateListener.of((update) => {
            if (
              update.selectionSet ||
              update.startState.field(diffBufferField) !== update.state.field(diffBufferField)
            ) {
              props.onSelect(selectedRows(update.state));
            }
          }),
        ],
      }),
    });
    const go = (command: StateCommand) => () => {
      if (!view) return;
      command(view);
      view.focus();
    };
    props.controls?.({ next: go(nextChange), previous: go(previousChange) });
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
  createEffect(on(() => props.blame, placeBlame, { defer: true }));
  createEffect(
    on(vimModeOn, (vimOn) => view?.dispatch({ effects: vimConf.reconfigure(vimExtension(vimOn)) }), { defer: true }),
  );
  createEffect(
    on(
      () => props.busy,
      (busy) => view?.dispatch({ effects: setHunksBusy.of(busy) }),
    ),
  );
  createEffect(
    on(
      () => props.canStage,
      (can) => view?.dispatch({ effects: stageConf.reconfigure(can ? stageGutter : []) }),
      { defer: true },
    ),
  );
  onCleanup(() => {
    view?.destroy();
    view = undefined;
  });

  return <div class={styles.buffer} ref={host} />;
}

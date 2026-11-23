// The Changes tab's editor layout: the file itself in a read-only buffer, with
// git's hunks drawn over it. Behind the fence; DiffView loads it lazily.
import { createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
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

  // The defaults read props, so an effect passes what it read in its compute:
  // an apply cannot read a prop the parent hands over as a computed expression.
  function load(text = props.text, hunks = props.hunks, blame = props.blame) {
    if (!view) return;
    const doc = view.state.sliceDoc();
    view.dispatch({
      changes: doc === text ? undefined : { from: 0, to: view.state.doc.length, insert: text },
      effects: setDiffHunks.of({ hunks, language }),
    });
    placeBlame(blame);
  }

  // After the text: a whole-document replace drops the markers it maps through.
  function placeBlame(blame = props.blame) {
    if (!view) return;
    if (!!blame !== blameShown) {
      blameShown = !!blame;
      view.dispatch({ effects: blameConf.reconfigure(blame ? blameExtension() : []) });
    }
    if (blame) setBlameMarkers(view, blame);
  }

  const [mounted, setMounted] = createSignal(false);
  const first = untrack(() => ({
    text: props.text,
    hunks: props.hunks,
    blame: props.blame,
    canStage: props.canStage,
    controls: props.controls,
  }));
  onSettled(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: first.text,
        extensions: [
          // First, for CodeEditor's reason: vim claims a key before any keymap sees it.
          vimConf.of(vimExtension(vimModeOn())),
          diffBufferExtension(),
          lineNumbers(),
          blameConf.of([]),
          stageConf.of(first.canStage ? stageGutter : []),
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
    first.controls?.({ next: go(nextChange), previous: go(previousChange) });
    load(first.text, first.hunks, first.blame);
    setMounted(true);
  });

  // The two that ran at mount read `mounted` too: the view is made in
  // onSettled, after the first run of an effect.
  createEffect(
    () => [props.path, mounted()] as const,
    ([path, ready]) => {
      if (!ready) return;
      void (async () => {
        const [ext, lang] = await Promise.all([syntaxFor(path), languageForPath(path)]);
        if (path !== props.path || !view) return;
        language = lang;
        view.dispatch({ effects: syntaxConf.reconfigure(ext) });
        load();
      })();
    },
  );
  createEffect(
    () => [props.text, props.hunks, untrack(() => props.blame)] as const,
    ([text, hunks, blame]) => load(text, hunks, blame),
    { defer: true },
  );
  createEffect(
    () => props.blame,
    (blame) => placeBlame(blame),
    { defer: true },
  );
  createEffect(vimModeOn, (vimOn) => view?.dispatch({ effects: vimConf.reconfigure(vimExtension(vimOn)) }), {
    defer: true,
  });
  createEffect(
    () => [props.busy, mounted()] as const,
    ([busy]) => view?.dispatch({ effects: setHunksBusy.of(busy) }),
  );
  createEffect(
    () => props.canStage,
    (can) => view?.dispatch({ effects: stageConf.reconfigure(can ? stageGutter : []) }),
    { defer: true },
  );
  onCleanup(() => {
    view?.destroy();
    view = undefined;
  });

  return <div class={styles.buffer} ref={host} />;
}

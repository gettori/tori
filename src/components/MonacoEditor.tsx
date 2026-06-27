import { onMount, onCleanup, createEffect, on, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import monaco, { languageForPath } from "../monaco";

type LineMark = { line: number; kind: string };

export default function MonacoEditor(props: { path: string | null }) {
  let host!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let decorations: monaco.editor.IEditorDecorationsCollection | undefined;
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal("");

  function basename(p: string) {
    return p.slice(p.lastIndexOf("/") + 1);
  }

  async function refreshGitMarks() {
    if (!editor || !props.path) return;
    try {
      const marks = await invoke<LineMark[]>("git_diff_lines", { path: props.path });
      const decos = marks.map((m) => ({
        range: new monaco.Range(m.line, 1, m.line, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: `git-${m.kind}`,
        },
      }));
      decorations?.set(decos);
    } catch {
      decorations?.clear();
    }
  }

  async function save() {
    if (!editor || !props.path || !dirty()) return;
    try {
      await invoke("write_file", { path: props.path, content: editor.getValue() });
      setDirty(false);
      await refreshGitMarks();
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadFile(path: string) {
    if (!editor) return;
    setError("");
    try {
      const content = await invoke<string>("read_file", { path });
      editor.setValue(content);
      monaco.editor.setModelLanguage(editor.getModel()!, languageForPath(path));
      editor.updateOptions({ readOnly: false });
      setDirty(false);
      editor.revealLine(1);
      await refreshGitMarks();
    } catch (e) {
      editor.setValue("");
      editor.updateOptions({ readOnly: true });
      setError(String(e));
      decorations?.clear();
    }
  }

  onMount(() => {
    editor = monaco.editor.create(host, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
    });
    decorations = editor.createDecorationsCollection();

    editor.onDidChangeModelContent(() => {
      if (!dirty()) setDirty(true);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());

    if (props.path) loadFile(props.path);
  });

  createEffect(on(() => props.path, (path) => {
    if (path && editor) loadFile(path);
  }, { defer: true }));

  // External edits / git changes: only the gutter refreshes (don't clobber edits).
  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("files://changed", () => void refreshGitMarks());
  });
  onCleanup(() => {
    unlisten?.();
    editor?.dispose();
  });

  return (
    <div class="editor-main">
      <div class="editor-head">
        <Show when={props.path} fallback={<span class="eh-empty">No file open</span>}>
          <span class="eh-name">{basename(props.path!)}</span>
          <Show when={dirty()}>
            <span class="eh-dirty" title="unsaved changes">●</span>
          </Show>
          <button class="eh-save" disabled={!dirty()} onClick={() => void save()}>
            Save
          </button>
        </Show>
        <Show when={error()}>
          <span class="eh-error">{error()}</span>
        </Show>
      </div>
      <div class="editor-host" ref={host} />
    </div>
  );
}

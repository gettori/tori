import { createSignal, createEffect, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import FileTree from "./FileTree";
import MonacoEditor from "./MonacoEditor";
import type { Selection } from "./Sidebar";

export default function EditorPane(props: { selected: Selection | null }) {
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const root = () => props.selected?.projectPath ?? null;

  // When the active project changes, point the file watcher at the new root.
  createEffect(
    on(root, (r) => {
      setOpenPath(null);
      if (r) invoke("files_watch_start", { root: r }).catch(() => {});
    }),
  );

  return (
    <div class="editor-pane">
      <FileTree root={root()} activePath={openPath()} onOpen={setOpenPath} />
      <MonacoEditor path={openPath()} />
    </div>
  );
}

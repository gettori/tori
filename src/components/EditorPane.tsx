import { createSignal, onCleanup, onMount, Show } from "solid-js";
import CodeEditor from "./CodeEditor";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../events";
import type { Selection } from "./Sidebar";

// Same-origin CM6 editor. Opens whatever file the rest of the app requests via
// the OPEN_IN_EDITOR event (terminal path clicks, and the file tree in Phase 3).
export default function EditorPane(_props: { selected: Selection | null }) {
  const [path, setPath] = createSignal<string | null>(null);
  let off: (() => void) | undefined;

  onMount(() => {
    off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => {
      if (d?.path) setPath(d.path);
    });
  });
  onCleanup(() => off?.());

  return (
    <div class="editor-pane">
      <Show
        when={path()}
        fallback={<div class="editor-empty">Open a file to start editing.</div>}
      >
        <CodeEditor path={path()} />
      </Show>
    </div>
  );
}

import { createSignal, createEffect, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Selection } from "./Sidebar";

// Real VS Code via code-server, embedded in an iframe. A single code-server
// instance is started on demand by the Rust side; we switch projects by
// pointing the iframe at ?folder=<path>.
export default function EditorPane(props: { selected: Selection | null }) {
  const [baseUrl, setBaseUrl] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal("");

  async function ensureServer() {
    if (baseUrl()) return baseUrl();
    setStarting(true);
    try {
      const url = await invoke<string>("code_server_url");
      setBaseUrl(url);
      return url;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setStarting(false);
    }
  }

  const src = () => {
    const url = baseUrl();
    const p = props.selected?.projectPath;
    if (!url || !p) return "";
    return `${url}/?folder=${encodeURIComponent(p)}`;
  };

  // Start the server the first time a project is selected.
  createEffect(
    on(
      () => props.selected?.projectPath,
      (p) => {
        if (p) ensureServer();
      },
    ),
  );

  return (
    <div class="editor-pane">
      <Show
        when={props.selected?.projectPath}
        fallback={<div class="editor-empty">Select a branch to open its project in VS Code.</div>}
      >
        <Show when={error()}>
          <div class="editor-err">{error()}</div>
        </Show>
        <Show when={starting() && !baseUrl()}>
          <div class="editor-empty">Starting VS Code…</div>
        </Show>
        <Show when={src()}>
          <iframe class="cs-frame" src={src()} title="VS Code" />
        </Show>
      </Show>
    </div>
  );
}

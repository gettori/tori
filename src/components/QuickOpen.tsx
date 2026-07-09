import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR } from "../events";
import FileIcon from "../seti/FileIcon";
import { fuzzyScore } from "../fuzzy";

const MAX_RESULTS = 200;

/** ⌘P fuzzy file finder overlay. Loads the project file list once on open;
 *  typing filters, ↑/↓ navigate, Enter opens, Esc closes. */
export default function QuickOpen(props: { root: string | null; onClose: () => void }) {
  const [files, setFiles] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let input!: HTMLInputElement;

  const results = createMemo(() => {
    const q = query().trim();
    const all = files();
    if (!q) return all.slice(0, MAX_RESULTS);
    const scored: { path: string; score: number }[] = [];
    for (const path of all) {
      const s = fuzzyScore(q, path);
      if (s !== null) scored.push({ path, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.path);
  });

  // Keep the selection in range as results change.
  createEffect(() => {
    const n = results().length;
    if (index() >= n) setIndex(0);
  });

  onMount(async () => {
    input.focus();
    const root = props.root;
    if (!root) return;
    try {
      setFiles(await invoke<string[]>("list_project_files", { projectPath: root }));
    } catch {
      setFiles([]);
    }
  });

  function open(rel: string) {
    const root = props.root;
    if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${rel}` });
    props.onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = results().length;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results()[index()];
      if (hit) open(hit);
    }
  }

  return (
    <div class="qo-backdrop" onClick={props.onClose}>
      <div class="qo-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          class="qo-input"
          placeholder="Go to file…"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div class="qo-list">
          <Show when={results().length} fallback={<div class="qo-empty">No matching files</div>}>
            <For each={results()}>
              {(rel, i) => (
                <div
                  class="qo-item"
                  classList={{ active: i() === index() }}
                  onClick={() => open(rel)}
                  onMouseEnter={() => setIndex(i())}
                >
                  <FileIcon name={rel.split("/").pop()!} />
                  <span class="qo-name">{rel}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

import { createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR } from "../events";

const MAX_RESULTS = 200;

// Subsequence fuzzy score: null if `query` isn't a subsequence of `target`,
// otherwise higher is better (contiguous runs and basename matches score more).
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const baseStart = t.lastIndexOf("/") + 1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === last + 1 ? 3 : 1; // contiguity bonus
      if (ti >= baseStart) score += 1; // basename bonus
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

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
                  {rel}
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

import { createSignal, createEffect, on, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import TerminalView from "./TerminalView";
import type { Selection } from "./Sidebar";
import { on as onEvent, CLOSE_TAB } from "../events";

type OpenTerm = {
  id: string;
  title: string;
  cwd: string;
  program: string;
  args: string[];
};

export default function TerminalArea(props: {
  selected: Selection | null;
  onOpenChange?: (ids: Set<string>) => void;
}) {
  const [open, setOpen] = createSignal<OpenTerm[]>([]);
  const [active, setActive] = createSignal<string | null>(null);

  // Report the set of live session ids so the sidebar can show running dots.
  createEffect(() => props.onOpenChange?.(new Set(open().map((o) => o.id))));

  const offClose = onEvent(CLOSE_TAB, () => {
    const id = active();
    if (id) closeId(id);
  });
  onCleanup(offClose);

  function openOrActivate(t: OpenTerm) {
    if (!open().some((o) => o.id === t.id)) {
      setOpen([...open(), t]);
    }
    setActive(t.id);
  }

  // Selecting a session opens (or re-focuses) its resumed terminal.
  createEffect(
    on(
      () => props.selected,
      (sel) => {
        if (sel?.sessionId) {
          openOrActivate({
            id: sel.sessionId,
            title: sel.sessionTitle?.slice(0, 28) || sel.sessionId.slice(0, 8),
            cwd: sel.projectPath,
            program: "claude",
            args: ["--resume", sel.sessionId],
          });
        }
      },
    ),
  );

  function newSession() {
    const sel = props.selected;
    if (!sel) return;
    const id = `new:${sel.projectPath}:${Date.now()}`;
    openOrActivate({
      id,
      title: `${sel.projectName} new`,
      cwd: sel.projectPath,
      program: "claude",
      args: [],
    });
  }

  function closeId(id: string) {
    invoke("pty_kill", { id }).catch(() => {});
    const remaining = open().filter((o) => o.id !== id);
    setOpen(remaining);
    if (active() === id) {
      setActive(remaining.length ? remaining[remaining.length - 1].id : null);
    }
  }

  function close(id: string, e: MouseEvent) {
    e.stopPropagation();
    closeId(id);
  }

  return (
    <div class="term-area">
      <div class="term-tabs">
        <For each={open()}>
          {(t) => (
            <div
              class={`term-tab ${active() === t.id ? "active" : ""}`}
              onClick={() => setActive(t.id)}
              title={t.cwd}
            >
              <span class="tab-label">{t.title}</span>
              <span class="tab-close" onClick={(e) => close(t.id, e)}>
                ×
              </span>
            </div>
          )}
        </For>
        <button
          class="term-new"
          disabled={!props.selected}
          title={
            props.selected
              ? `New Claude session in ${props.selected.projectName}`
              : "Select a branch first"
          }
          onClick={newSession}
        >
          + New
        </button>
      </div>

      <div class="term-stage">
        <Show
          when={open().length}
          fallback={
            <div class="term-empty">
              Select a session to resume it, or pick a branch and click + New.
            </div>
          }
        >
          <For each={open()}>
            {(t) => (
              <TerminalView
                id={t.id}
                cwd={t.cwd}
                program={t.program}
                args={t.args}
                active={active() === t.id}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

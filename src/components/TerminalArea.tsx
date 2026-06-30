import { createSignal, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView from "./TerminalView";
import OverflowTabBar from "./OverflowTabBar";
import type { Selection } from "./Sidebar";
import { on as onEvent, onWith, CLOSE_TAB, OPEN_TERMINAL, type OpenTerminal } from "../events";

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

  // Tabs (clone / bootstrap) that should re-discover projects when they exit.
  const rediscoverOnExit = new Set<string>();
  let offOpenTerminal: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;
  onMount(async () => {
    offOpenTerminal = onWith<OpenTerminal>(OPEN_TERMINAL, (t) => {
      if (t.rediscoverOnExit) rediscoverOnExit.add(t.id);
      openOrActivate({ id: t.id, title: t.title, cwd: t.cwd, program: t.program, args: t.args });
    });
    unlistenExit = await listen<string>("pty://exit", (e) => {
      const id = e.payload;
      if (rediscoverOnExit.delete(id)) invoke("rediscover").catch(() => {});
    });
  });
  onCleanup(() => {
    offOpenTerminal?.();
    unlistenExit?.();
  });

  function openOrActivate(t: OpenTerm) {
    if (!open().some((o) => o.id === t.id)) {
      setOpen([...open(), t]);
    }
    setActive(t.id);
  }

  // Selecting a session opens (or re-focuses) its resumed terminal. Resume spawns
  // per agent at the session's OWN recorded cwd (sessionCwd), so a nested session
  // resumes where it ran, not at the branch-unit root. The checkout guard already
  // ran at selection time, so the tree is on the right branch before we spawn.
  createEffect(
    on(
      () => props.selected,
      (sel) => {
        if (sel?.sessionId) {
          const isPi = sel.agent === "pi";
          openOrActivate({
            id: sel.sessionId,
            title: sel.sessionTitle?.slice(0, 28) || sel.sessionId.slice(0, 8),
            cwd: sel.sessionCwd || sel.folderPath,
            program: isPi ? "pi" : "claude",
            args: isPi && sel.sessionFile ? ["--session", sel.sessionFile] : ["--resume", sel.sessionId],
          });
        }
      },
    ),
  );

  // A new session starts in the branch-unit folder (already the right checkout).
  function newSession(agent: "claude" | "pi") {
    const sel = props.selected;
    if (!sel) return;
    const id = `new:${agent}:${sel.folderPath}:${Date.now()}`;
    openOrActivate({
      id,
      title: `${sel.projectName} ${agent}`,
      cwd: sel.folderPath,
      program: agent,
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
      <OverflowTabBar
        class="term-tabs"
        items={open()}
        activeId={active()}
        idOf={(t) => t.id}
        onActivate={setActive}
        onReorder={setOpen}
        renderTab={(t) => (
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
        renderMenuItem={(t) => (
          <>
            <span class="tab-label">{t.title}</span>
            <span class="tab-close" onClick={(e) => close(t.id, e)}>
              ×
            </span>
          </>
        )}
        trailing={
          <>
            <button
              class="term-new"
              disabled={!props.selected}
              title={
                props.selected
                  ? `New Claude session in ${props.selected.projectName}`
                  : "Select a branch first"
              }
              onClick={() => newSession("claude")}
            >
              + Claude
            </button>
            <button
              class="term-new"
              disabled={!props.selected}
              title={
                props.selected
                  ? `New pi session in ${props.selected.projectName}`
                  : "Select a branch first"
              }
              onClick={() => newSession("pi")}
            >
              + pi
            </button>
          </>
        }
      />

      <div class="term-stage">
        <Show
          when={open().length}
          fallback={
            <div class="term-empty">
              Select a session to resume it, or pick a branch and start a new Claude or pi session.
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

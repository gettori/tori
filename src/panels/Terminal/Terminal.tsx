import { createSignal, createEffect, on, onCleanup, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView from "./TerminalView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Icon from "../../components/Icon/Icon";
import { X, ChevronDown } from "lucide-solid";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import {
  on as onEvent,
  onWith,
  CLOSE_TAB,
  OPEN_TERMINAL,
  NEW_SESSION,
  PURGE_UNDER_PATH,
  type OpenTerminal,
  type NewSession,
  type PurgeUnderPath,
} from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import styles from "./Terminal.module.css";

type OpenTerm = {
  id: string;
  title: string;
  cwd: string;
  program: string;
  args: string[];
};

export default function Terminal(props: {
  selected: Selection | null;
  onOpenChange?: (ids: Set<string>) => void;
}) {
  const [open, setOpen] = createSignal<OpenTerm[]>([]);
  const [active, setActive] = createSignal<string | null>(null);
  // The "+ Claude ›" split button's dropdown of yolo-mode launchers. The menu is
  // portalled to <body> and anchored to the caret because the tab bar clips
  // overflow, which would otherwise hide a menu rendered inside it.
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 });
  let splitEl: HTMLDivElement | undefined;
  let caretEl: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  // The agent of the focused tab drives the split button: the main action mirrors
  // the session you're in, defaulting to claude when nothing is open.
  const activeAgent = (): "claude" | "pi" => {
    const t = open().find((o) => o.id === active());
    return t?.program === "pi" ? "pi" : "claude";
  };

  function toggleMenu() {
    if (menuOpen()) {
      setMenuOpen(false);
      return;
    }
    if (caretEl) {
      const r = caretEl.getBoundingClientRect();
      setMenuPos({ left: r.right, top: r.bottom + 4 });
    }
    setMenuOpen(true);
  }

  // Report the set of live session ids so the sidebar can show running dots.
  createEffect(() => props.onOpenChange?.(new Set(open().map((o) => o.id))));

  const offClose = onEvent(CLOSE_TAB, () => {
    const id = active();
    if (id) closeId(id);
  });
  onCleanup(offClose);

  // A space is being deleted: kill + close every terminal tab whose cwd is rooted
  // under it, so no agent keeps running in a folder that is about to vanish.
  const offPurge = onWith<PurgeUnderPath>(PURGE_UNDER_PATH, ({ path }) => {
    for (const t of open()) {
      if (isUnderPath(t.cwd, path)) closeId(t.id);
    }
  });
  onCleanup(offPurge);

  // Tabs (clone / bootstrap) that should re-discover projects when they exit.
  const rediscoverOnExit = new Set<string>();
  let offOpenTerminal: (() => void) | undefined;
  let offNewSession: (() => void) | undefined;
  let unlistenExit: UnlistenFn | undefined;
  onMount(async () => {
    offOpenTerminal = onWith<OpenTerminal>(OPEN_TERMINAL, (t) => {
      if (t.rediscoverOnExit) rediscoverOnExit.add(t.id);
      openOrActivate({ id: t.id, title: t.title, cwd: t.cwd, program: t.program, args: t.args });
    });
    // Sidebar "New session": matches the "+ Claude" main button (claude, non-yolo).
    // Spawns at the named folder, with no props.selected timing dependency.
    offNewSession = onWith<NewSession>(NEW_SESSION, (s) => {
      spawnSession(s.agent ?? "claude", s.folderPath, s.projectName, false);
    });
    unlistenExit = await listen<string>("pty://exit", (e) => {
      const id = e.payload;
      if (rediscoverOnExit.delete(id)) invoke("rediscover").catch(() => {});
    });
  });

  // Close the launch dropdown on any click outside the split button or its
  // portalled menu.
  const onDocPointerDown = (e: PointerEvent) => {
    if (!menuOpen()) return;
    const t = e.target as Node;
    if (splitEl?.contains(t) || menuEl?.contains(t)) return;
    setMenuOpen(false);
  };
  document.addEventListener("pointerdown", onDocPointerDown);
  onCleanup(() => document.removeEventListener("pointerdown", onDocPointerDown));

  onCleanup(() => {
    offOpenTerminal?.();
    offNewSession?.();
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
  // claude in yolo mode skips permission prompts; pi is always yolo so it just
  // launches normally.
  function spawnSession(agent: "claude" | "pi", folderPath: string, projectName: string, yolo = false) {
    const id = `new:${agent}:${folderPath}:${Date.now()}`;
    openOrActivate({
      id,
      title: `${projectName} ${agent}`,
      cwd: folderPath,
      program: agent,
      args: agent === "claude" && yolo ? ["--dangerously-skip-permissions"] : [],
    });
  }

  function newSession(agent: "claude" | "pi", yolo = false) {
    const sel = props.selected;
    if (!sel) return;
    spawnSession(agent, sel.folderPath, sel.projectName, yolo);
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
    <div class={styles.termArea}>
      <OverflowTabBar
        class={styles.termTabs}
        items={open()}
        activeId={active()}
        idOf={(t) => t.id}
        onActivate={setActive}
        onReorder={setOpen}
        renderTab={(t) => (
          <div
            class={`${styles.termTab} ${active() === t.id ? styles.active : ""}`}
            onClick={() => setActive(t.id)}
            title={t.cwd}
          >
            <span class="tab-label">{t.title}</span>
            <span class="tab-close" aria-label="Close" onClick={(e) => close(t.id, e)}>
              <Icon icon={X} size={14} />
            </span>
          </div>
        )}
        renderMenuItem={(t) => (
          <>
            <span class="tab-label">{t.title}</span>
            <span class="tab-close" aria-label="Close" onClick={(e) => close(t.id, e)}>
              <Icon icon={X} size={14} />
            </span>
          </>
        )}
        trailing={
          <div class={styles.termNewSplit} ref={splitEl}>
            <button
              class={`${styles.termNew} ${styles.termNewMain}`}
              disabled={!props.selected}
              title={
                props.selected
                  ? `New ${activeAgent() === "pi" ? "Pi" : "Claude"} session in ${props.selected.projectName}`
                  : "Select a branch first"
              }
              onClick={() => newSession(activeAgent(), activeAgent() === "pi")}
            >
              {activeAgent() === "pi" ? "+ Pi" : "+ Claude"}
            </button>
            <button
              ref={caretEl}
              class={`${styles.termNew} ${styles.termNewCaret}`}
              disabled={!props.selected}
              title="More launch options"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={toggleMenu}
            >
              <Icon icon={ChevronDown} size={14} class={styles.termNewChevron} />
            </button>
            <Show when={menuOpen()}>
              <Portal>
                <div
                  ref={menuEl}
                  class={styles.termNewMenu}
                  role="menu"
                  style={{ left: `${menuPos().left}px`, top: `${menuPos().top}px` }}
                >
                  <Show
                    when={activeAgent() === "pi"}
                    fallback={
                      <>
                        <button
                          class={styles.termNewMenuItem}
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            newSession("claude", true);
                          }}
                        >
                          Claude (yolo)
                        </button>
                        <button
                          class={styles.termNewMenuItem}
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            newSession("pi", true);
                          }}
                        >
                          Pi (yolo)
                        </button>
                      </>
                    }
                  >
                    <button
                      class={styles.termNewMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        newSession("claude");
                      }}
                    >
                      Claude
                    </button>
                    <button
                      class={styles.termNewMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        newSession("claude", true);
                      }}
                    >
                      Claude (yolo)
                    </button>
                  </Show>
                </div>
              </Portal>
            </Show>
          </div>
        }
      />

      <div class={styles.termStage}>
        <Show
          when={open().length}
          fallback={
            <div class={styles.termEmpty}>
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

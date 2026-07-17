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
  type LiveTab,
} from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import styles from "./Terminal.module.css";

type TabKind = "shell" | "agent" | "command";

type OpenTerm = {
  id: string;
  title: string;
  cwd: string;
  // The branch-unit anchor this tab is grouped under (the selected folderPath at
  // spawn), NOT the tab cwd: a nested session still groups with its branch unit.
  // Command tabs (clone/bootstrap) group under their own cwd.
  workspace: string;
  // Every shell/agent tab hosts a login shell; an agent tab is that shell seeded
  // with `init`. Command tabs (clone/bootstrap) spawn the program directly.
  kind: TabKind;
  program: string;
  args: string[];
  // Agent tabs: the command line typed into the shell once it's ready. Exiting
  // the agent drops back to the live shell rather than closing the tab.
  init?: string;
  // Agent tabs: the soft session id (the resumed uuid), distinct from the stable
  // shell tab id. Used to focus/resume in place (Phase 2), not for spawning.
  sessionId?: string;
};

// A stable, unique id for a shell-hosted tab. Deliberately not the session uuid:
// one shell can host successive agents, and the uuid is a soft attribute.
function shellId(): string {
  return `sh:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

// The command an agent tab types into its shell once (e.g. "claude --resume x\n").
// Args are single-quoted: they're re-parsed by the shell (unlike a direct spawn),
// so a session-file path containing spaces would otherwise word-split and fail.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function agentInit(program: string, args: string[]): string {
  return `${[program, ...args.map(shQuote)].join(" ")}\n`;
}

export default function Terminal(props: {
  selected: Selection | null;
  onOpenChange?: (tabs: LiveTab[]) => void;
}) {
  const [open, setOpen] = createSignal<OpenTerm[]>([]);
  // Tabs are grouped by workspace (branch-unit folder). Only the active
  // workspace's tabs show in the bar/stage; every other group stays mounted and
  // CSS-hidden so its PTYs keep running (gotcha #64). `activeWorkspace` is the
  // group on screen; `activeByWorkspace` remembers the focused tab per group.
  const [activeWorkspace, setActiveWorkspace] = createSignal<string | null>(null);
  const [activeByWorkspace, setActiveByWorkspace] = createSignal<Record<string, string>>({});

  const tabsIn = (ws: string) => open().filter((t) => t.workspace === ws);
  const workspaceTabs = (): OpenTerm[] => {
    const ws = activeWorkspace();
    return ws ? tabsIn(ws) : [];
  };
  // The single visible tab: the active workspace's remembered tab, falling back
  // to its first tab when that record is unset or points at a closed tab.
  const visibleId = (): string | null => {
    const ws = activeWorkspace();
    if (!ws) return null;
    const tabs = tabsIn(ws);
    const recorded = activeByWorkspace()[ws];
    if (recorded && tabs.some((t) => t.id === recorded)) return recorded;
    return tabs.length ? tabs[0].id : null;
  };
  function focusTab(ws: string, id: string) {
    setActiveWorkspace(ws);
    setActiveByWorkspace({ ...activeByWorkspace(), [ws]: id });
  }

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
    const t = open().find((o) => o.id === visibleId());
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

  // Surface the live tabs (id + workspace + kind + soft sessionId) so the sidebar
  // can count what's actually running in a folder for its confirms.
  createEffect(() =>
    props.onOpenChange?.(
      open().map((o) => ({ id: o.id, workspace: o.workspace, kind: o.kind, sessionId: o.sessionId })),
    ),
  );

  const offClose = onEvent(CLOSE_TAB, () => {
    const id = visibleId();
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
      openOrActivate({
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        // Clone/bootstrap have no branch-unit yet, so they group under their own
        // cwd; opening one reveals that group so its progress is visible.
        workspace: t.cwd,
        kind: "command",
        program: t.program,
        args: t.args,
      });
    });
    // Sidebar "New session": matches the "+ Claude" main button (claude, non-yolo).
    // Spawns at the named folder, with no props.selected timing dependency.
    offNewSession = onWith<NewSession>(NEW_SESSION, (s) => {
      spawnSession(s.agent ?? "claude", s.folderPath, s.projectName, false);
    });
    // A shell/agent tab that exits (the user typed `exit`) is closed; a command
    // tab (clone/bootstrap) stays visible so its failure is inspectable, and
    // re-discovers projects. Agent-exit within a live shell fires no event.
    unlistenExit = await listen<string>("pty://exit", (e) => {
      const id = e.payload;
      const t = open().find((o) => o.id === id);
      if (t && t.kind !== "command") {
        closeId(id);
        return;
      }
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
    focusTab(t.workspace, t.id);
  }

  // Selecting anything reveals its workspace group. A session selection then does
  // focus-or-resume (Option A): if a tab already hosts that session, focus it (and
  // re-issue the resume in place if the agent has since exited to its shell);
  // otherwise spawn a fresh resume tab. A branch-only selection just reveals the
  // group and spawns nothing. Resume runs at the session's OWN recorded cwd, but
  // the tab groups under the branch-unit folder, not that nested cwd.
  createEffect(
    on(
      () => props.selected,
      (sel) => {
        if (!sel?.folderPath) return;
        setActiveWorkspace(sel.folderPath);
        if (sel.sessionId) void focusOrResume(sel);
      },
    ),
  );

  async function focusOrResume(sel: Selection) {
    const sessionId = sel.sessionId!;
    const existing = open().find((t) => t.sessionId === sessionId);
    if (existing) {
      focusTab(existing.workspace, existing.id);
      // Agent still carrying its id in argv → visible/live, leave it. If it has
      // exited (dropped to the shell), retype the resume so the session comes
      // back in place. Best-effort: without shell integration we can't tell an
      // idle prompt from a foreground program, so treat "agent gone" as idle.
      const running = await invoke<boolean>("session_running", { id: sessionId }).catch(() => true);
      if (!running) {
        invoke("pty_write", { id: existing.id, data: agentInit(existing.program, existing.args) }).catch(
          () => {},
        );
      }
      return;
    }
    const isPi = sel.agent === "pi";
    const program = isPi ? "pi" : "claude";
    const args =
      isPi && sel.sessionFile ? ["--session", sel.sessionFile] : ["--resume", sessionId];
    openOrActivate({
      id: shellId(),
      title: sel.sessionTitle?.slice(0, 28) || sessionId.slice(0, 8),
      cwd: sel.sessionCwd || sel.folderPath,
      workspace: sel.folderPath,
      kind: "agent",
      program,
      args,
      init: agentInit(program, args),
      sessionId,
    });
  }

  // A new session starts in the branch-unit folder (already the right checkout).
  // claude in yolo mode skips permission prompts; pi is always yolo so it just
  // launches normally.
  function spawnSession(agent: "claude" | "pi", folderPath: string, projectName: string, yolo = false) {
    const args = agent === "claude" && yolo ? ["--dangerously-skip-permissions"] : [];
    openOrActivate({
      id: shellId(),
      title: `${projectName} ${agent}`,
      cwd: folderPath,
      workspace: folderPath,
      kind: "agent",
      program: agent,
      args,
      init: agentInit(agent, args),
    });
  }

  function newSession(agent: "claude" | "pi", yolo = false) {
    const sel = props.selected;
    if (!sel) return;
    spawnSession(agent, sel.folderPath, sel.projectName, yolo);
  }

  // A plain shell tab: the same login shell as an agent tab, just unseeded (no
  // init), opened in the selected branch-unit folder.
  function newShell() {
    const sel = props.selected;
    if (!sel) return;
    openOrActivate({
      id: shellId(),
      title: `${sel.projectName} shell`,
      cwd: sel.folderPath,
      workspace: sel.folderPath,
      kind: "shell",
      program: "",
      args: [],
    });
  }

  function closeId(id: string) {
    invoke("pty_kill", { id }).catch(() => {});
    setOpen(open().filter((o) => o.id !== id));
    // No active-tab bookkeeping needed: visibleId() falls back to the workspace's
    // first tab when its remembered id is now gone.
  }

  function close(id: string, e: MouseEvent) {
    e.stopPropagation();
    closeId(id);
  }

  // The bar reorders only the active workspace's tabs (the subset it was given).
  // Splice that new order back over the same slots in the full `open[]`, keeping
  // every object ref and other groups' positions intact (gotcha #64).
  function mergeReorder(next: OpenTerm[]) {
    const ws = activeWorkspace();
    if (!ws) return;
    let i = 0;
    setOpen(open().map((t) => (t.workspace === ws ? next[i++] : t)));
  }

  return (
    <div class={styles.termArea}>
      <OverflowTabBar
        class={styles.termTabs}
        items={workspaceTabs()}
        activeId={visibleId()}
        idOf={(t) => t.id}
        onActivate={(id) => {
          const ws = activeWorkspace();
          if (ws) focusTab(ws, id);
        }}
        onReorder={mergeReorder}
        renderTab={(t) => (
          <div
            class={`${styles.termTab} ${visibleId() === t.id ? styles.active : ""}`}
            onClick={() => focusTab(t.workspace, t.id)}
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
          <>
          <button
            class={`${styles.termNew} ${styles.termNewSolo}`}
            disabled={!props.selected}
            title={props.selected ? `New shell in ${props.selected.projectName}` : "Select a branch first"}
            onClick={newShell}
          >
            + Terminal
          </button>
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
          </>
        }
      />

      <div class={styles.termStage}>
        {/* Every tab is always mounted (CSS-hidden unless it is the visible one),
            so switching workspaces never unmounts a group's PTYs (gotcha #64).
            The empty message is an overlay, not a fallback that would replace
            (and thus unmount) the tabs. */}
        <For each={open()}>
          {(t) => (
            <TerminalView
              id={t.id}
              cwd={t.cwd}
              kind={t.kind}
              program={t.program}
              args={t.args}
              init={t.init}
              active={visibleId() === t.id}
            />
          )}
        </For>
        <Show when={!visibleId()}>
          <div class={styles.termEmpty}>
            Select a session to resume it, or pick a branch and start a new Claude or pi session.
          </div>
        </Show>
      </div>
    </div>
  );
}

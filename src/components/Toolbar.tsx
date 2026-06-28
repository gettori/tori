import { createSignal, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emit, SESSIONS_REFRESH } from "../events";
import type { Selection } from "./Sidebar";

type SessionDetail = {
  message_count: number;
  output_tokens: number;
  context_tokens: number;
  model: string | null;
};
type Worktree = { path: string; branch: string; is_main: boolean };

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// Session/branch actions, folded into a compact bar above the work panes.
export default function Toolbar(props: { selected: Selection | null }) {
  const [detail, setDetail] = createSignal<SessionDetail | null>(null);
  const [running, setRunning] = createSignal(false);
  const [displayName, setDisplayName] = createSignal("");
  const [renaming, setRenaming] = createSignal(false);
  const [nameDraft, setNameDraft] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [showWt, setShowWt] = createSignal(false);
  const [worktrees, setWorktrees] = createSignal<Worktree[]>([]);
  const [wtPath, setWtPath] = createSignal("");
  const [err, setErr] = createSignal("");

  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;

  createEffect(
    on(
      () => sel()?.sessionId,
      (id) => {
        setDetail(null);
        setRunning(false);
        setRenaming(false);
        setConfirmDelete(false);
        setErr("");
        const s = sel();
        setDisplayName(s?.sessionName || s?.sessionTitle || "");
        if (id && s?.sessionPath) {
          invoke<SessionDetail>("session_detail", { path: s.sessionPath }).then(setDetail).catch(() => {});
          invoke<boolean>("session_running", { id }).then(setRunning).catch(() => {});
        }
      },
    ),
  );

  createEffect(
    on(
      () => sel()?.projectPath,
      (p) => {
        setWorktrees([]);
        setShowWt(false);
        if (p) setWtPath(`${p}-${sel()?.branch ?? "branch"}`.replace(/[^\w/.-]/g, "-"));
      },
    ),
  );

  function loadWorktrees() {
    const p = sel()?.projectPath;
    if (p) invoke<Worktree[]>("list_worktrees", { repoPath: p }).then(setWorktrees).catch(() => {});
  }

  function toggleWt() {
    const next = !showWt();
    setShowWt(next);
    if (next) loadWorktrees();
  }

  async function openGhostty(resume: boolean) {
    const s = sel();
    if (!s) return;
    const args = resume && s.sessionId ? ["--resume", s.sessionId] : [];
    await invoke("open_in_ghostty", { cwd: s.projectPath, program: "claude", args }).catch((e) => setErr(String(e)));
  }
  async function openVSCode() {
    const s = sel();
    if (s) await invoke("open_in_vscode", { path: s.projectPath }).catch((e) => setErr(String(e)));
  }
  async function saveName() {
    const s = sel();
    if (!s?.sessionId) return;
    await invoke("set_session_name", { id: s.sessionId, name: nameDraft() }).catch((e) => setErr(String(e)));
    setDisplayName(nameDraft() || s.sessionTitle || "");
    setRenaming(false);
    emit(SESSIONS_REFRESH);
  }
  async function toggleArchive() {
    const s = sel();
    if (!s?.sessionId) return;
    await invoke("set_session_archived", { id: s.sessionId, archived: !s.sessionArchived }).catch((e) => setErr(String(e)));
    emit(SESSIONS_REFRESH);
  }
  async function doDelete() {
    const s = sel();
    if (!s?.sessionPath) return;
    if (!confirmDelete()) {
      setConfirmDelete(true);
      return;
    }
    await invoke("delete_session", { path: s.sessionPath }).catch((e) => setErr(String(e)));
    setConfirmDelete(false);
    emit(SESSIONS_REFRESH);
  }
  async function addWorktree() {
    const s = sel();
    if (!s || !wtPath().trim()) return;
    try {
      await invoke("add_worktree", { repoPath: s.projectPath, branch: s.branch, worktreePath: wtPath().trim() });
      loadWorktrees();
    } catch (e) {
      setErr(String(e));
    }
  }
  async function removeWorktree(path: string) {
    const s = sel();
    if (!s) return;
    try {
      await invoke("remove_worktree", { repoPath: s.projectPath, worktreePath: path });
      loadWorktrees();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div class="toolbar">
      <Show when={sel()} fallback={<div class="tb-empty">Select a branch or session</div>}>
        <div class="tb-row">
          <div class="tb-info">
            <Show
              when={!renaming()}
              fallback={
                <div class="rename-row">
                  <input
                    class="rename-input"
                    value={nameDraft()}
                    placeholder="session name"
                    onInput={(e) => setNameDraft(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveName()}
                  />
                  <button class="btn sm" onClick={saveName}>Save</button>
                  <button class="btn sm ghost" onClick={() => setRenaming(false)}>Cancel</button>
                </div>
              }
            >
              <span class="tb-name">{isSession() ? displayName() : sel()!.projectName}</span>
              <span class="tb-sub dim">{sel()!.projectName} @ {sel()!.branch}</span>
              <Show when={running()}><span class="run-pill">● running</span></Show>
              <Show when={isSession() && detail()}>
                <span class="tb-stats dim">{detail()!.message_count} msgs · {fmt(detail()!.context_tokens)} ctx</span>
              </Show>
            </Show>
          </div>

          <div class="tb-actions">
            <Show
              when={isSession()}
              fallback={<button class="btn primary" onClick={() => openGhostty(false)}>+ New in Ghostty</button>}
            >
              <button class="btn primary" onClick={() => openGhostty(true)}>Resume in Ghostty</button>
              <button class="btn" onClick={() => { setNameDraft(displayName()); setRenaming(true); }}>Rename</button>
              <button class="btn" onClick={toggleArchive}>{sel()!.sessionArchived ? "Unarchive" : "Archive"}</button>
              <button class={`btn ${confirmDelete() ? "danger" : ""}`} onClick={doDelete}>
                {confirmDelete() ? "Really?" : "Delete"}
              </button>
            </Show>
            <button class="btn" onClick={openVSCode} title="Open in the real VS Code app">VSCode ↗</button>
            <button class="btn" onClick={toggleWt}>Worktrees</button>
          </div>
        </div>

        <Show when={showWt()}>
          <div class="tb-worktrees">
            <For each={worktrees()} fallback={<span class="dim sm">no worktrees</span>}>
              {(w) => (
                <div class="wt-row">
                  <span class="wt-branch">{w.branch || "(detached)"}</span>
                  <span class="wt-path dim">{w.path}</span>
                  <Show when={w.is_main}><span class="wt-main">main</span></Show>
                  <Show when={!w.is_main}>
                    <button class="btn xs ghost" onClick={() => removeWorktree(w.path)}>remove</button>
                  </Show>
                </div>
              )}
            </For>
            <div class="wt-add">
              <input class="wt-input" value={wtPath()} placeholder="worktree path" onInput={(e) => setWtPath(e.currentTarget.value)} />
              <button class="btn sm" onClick={addWorktree}>+ Add for {sel()!.branch}</button>
            </div>
          </div>
        </Show>

        <Show when={err()}><div class="tb-err">{err()}</div></Show>
      </Show>
    </div>
  );
}

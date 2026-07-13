import { createSignal, createEffect, on, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emit, SESSIONS_REFRESH } from "../../events";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import ClaudeIcon from "../../seti/ClaudeIcon";
import PiIcon from "../../seti/PiIcon";
import styles from "./Toolbar.module.css";

type SessionDetail = {
  prompt_count: number;
  turn_count: number;
  tool_count: number;
  output_tokens: number;
  context_tokens: number;
  model: string | null;
};
type Worktree = { path: string; branch: string; is_main: boolean };

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// Drop provider/variant/date noise so a model id reads at a glance: e.g.
// "anthropic/claude-sonnet-4.6" -> "sonnet-4.6", "qwen/qwen3.6-plus:free" ->
// "qwen3.6-plus", "claude-opus-4.6" -> "opus-4.6".
function modelLabel(model: string | null): string {
  if (!model) return "";
  return model
    .replace(/^[^/]+\//, "") // provider/ prefix
    .replace(/:.*$/, "") // :free and other variant suffixes
    .replace(/^claude-/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

// Accurate context windows fetched from OpenRouter (cached in the backend), keyed
// by OpenRouter model id. Loaded once; until it arrives, lookups miss and the
// static fallback applies. Reading the signal inside the render keeps the toolbar
// reactive, so the percentage corrects itself the moment the caps land.
const [modelCaps, setModelCaps] = createSignal<Record<string, number>>({});
let capsRequested = false;
function ensureModelCaps() {
  if (capsRequested) return;
  capsRequested = true;
  invoke<Record<string, number>>("model_context_caps").then(setModelCaps).catch(() => {});
}

// Offline/unmatched fallback, by model family. Values mirror OpenRouter so a
// network miss stays close to the truth; the first matching key wins.
const STATIC_CAPS: [string, number][] = [
  ["gemini", 1_000_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["qwen", 1_000_000],
  ["kimi", 262_144],
  ["moonshot", 262_144],
  ["deepseek", 131_072],
  ["minimax", 204_800],
];
function staticCap(id: string): number {
  const m = id.toLowerCase();
  // Sonnet/Opus are 1M today; haiku and other Claudes stay at 200k.
  if (m.includes("sonnet") || m.includes("opus")) return 1_000_000;
  if (m.includes("claude")) return 200_000;
  for (const [key, cap] of STATIC_CAPS) if (m.includes(key)) return cap;
  return 200_000;
}

function contextWindow(model: string | null): number {
  const id = model || "";
  const caps = modelCaps();
  // pi stores bare anthropic ids (claude-sonnet-4.6); OpenRouter keys them
  // anthropic/...; the API style uses dashes (claude-sonnet-4-6) vs dots.
  const dotted = id.replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2");
  for (const cand of [id, `anthropic/${id}`, `anthropic/${dotted}`, dotted]) {
    if (caps[cand]) return caps[cand];
  }
  return staticCap(id);
}

// Stats-row glyphs as stroked SVGs (24-unit viewBox, currentColor) so they read
// crisp and uniform next to the context gauge, independent of the UI font.
function ModelIcon() {
  return (
    <svg class={styles.statIco} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </svg>
  );
}
function PromptIcon() {
  return (
    <svg class={styles.statIco} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function TurnIcon() {
  return (
    <svg class={styles.statIco} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function ToolIcon() {
  return (
    <svg class={styles.statIco} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}
// Context as a pie gauge that fills with actual usage (top, clockwise).
function CtxGauge(props: { pct: number }) {
  const p = () => Math.max(0, Math.min(1, props.pct / 100));
  const wedge = () => {
    const f = p();
    if (f <= 0) return "";
    const a = -Math.PI / 2 + 2 * Math.PI * f;
    const x = (8 + 7 * Math.cos(a)).toFixed(2);
    const y = (8 + 7 * Math.sin(a)).toFixed(2);
    const large = f > 0.5 ? 1 : 0;
    return `M8 8 L8 1 A7 7 0 ${large} 1 ${x} ${y} Z`;
  };
  return (
    <svg class={styles.statIco} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4" />
      <Show when={wedge()}>{(d) => <path d={d()} fill="currentColor" />}</Show>
    </svg>
  );
}

// Session/branch actions, folded into a compact bar above the work panes.
export default function Toolbar(props: { selected: Selection | null }) {
  const [detail, setDetail] = createSignal<SessionDetail | null>(null);
  const [displayName, setDisplayName] = createSignal("");
  const [renaming, setRenaming] = createSignal(false);
  const [nameDraft, setNameDraft] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [showWt, setShowWt] = createSignal(false);
  const [worktrees, setWorktrees] = createSignal<Worktree[]>([]);
  const [wtPath, setWtPath] = createSignal("");
  const [err, setErr] = createSignal("");

  ensureModelCaps();

  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;

  createEffect(
    on(
      () => sel()?.sessionId,
      (id) => {
        setDetail(null);
        setRenaming(false);
        setConfirmDelete(false);
        setErr("");
        const s = sel();
        setDisplayName(s?.sessionName || s?.sessionTitle || "");
        if (id && s?.sessionPath) {
          const path = s.sessionPath;
          const loadDetail = () => invoke<SessionDetail>("session_detail", { path }).then(setDetail).catch(() => {});
          loadDetail();
          // While the agent is live it keeps appending to the transcript, so
          // poll: re-check running each tick and re-read the file only while it
          // is. Idle sessions cost one running-check and nothing more.
          const timer = setInterval(() => {
            invoke<boolean>("session_running", { id })
              .then((r) => {
                if (r) loadDetail();
              })
              .catch(() => {});
          }, 4000);
          onCleanup(() => clearInterval(timer));
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
    // Anchor on the working folder (the worktree/session dir), not the container.
    await invoke("open_in_ghostty", { cwd: s.folderPath, program: "claude", args }).catch((e) => setErr(String(e)));
  }
  async function openVSCode() {
    const s = sel();
    if (s) await invoke("open_in_vscode", { path: s.folderPath }).catch((e) => setErr(String(e)));
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
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
            <Show
              when={!renaming()}
              fallback={
                <div class={styles.renameRow}>
                  <input
                    class={styles.renameInput}
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
              <nav class={styles.tbCrumb} aria-label="location">
                <span class={`${styles.crumb} dim`}>{sel()!.groupName}</span>
                <span class={`${styles.crumbSep} dim`}>›</span>
                <span class={`${styles.crumb} dim`}>{sel()!.projectName}</span>
                <span class={`${styles.crumbSep} dim`}>›</span>
                <Show
                  when={isSession()}
                  fallback={<span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.branch}</span>}
                >
                  <span class={`${styles.crumb} dim`}>{sel()!.branch}</span>
                  <span class={`${styles.crumbSep} dim`}>›</span>
                  <span class={`${styles.crumb} ${styles.leaf}`}>
                    <Show when={sel()!.agent === "pi"} fallback={<ClaudeIcon />}><PiIcon /></Show>
                    {displayName()}
                  </span>
                </Show>
              </nav>
              <Show when={isSession() && detail()}>
                <span class={styles.tbDivider} />
                <span class={styles.tbStats}>
                  <Show when={detail()!.model}>
                    <span class={`${styles.stat} ${styles.statModel}`} title="Model">
                      <ModelIcon />{modelLabel(detail()!.model)}
                    </span>
                    <span class={styles.statSep}>·</span>
                  </Show>
                  <span class={styles.stat} title="Prompts you sent">
                    <PromptIcon />{detail()!.prompt_count}
                  </span>
                  <span class={styles.statSep}>·</span>
                  <span class={styles.stat} title="Agent turns">
                    <TurnIcon />{detail()!.turn_count}
                  </span>
                  <span class={styles.statSep}>·</span>
                  <span class={styles.stat} title="Tool calls">
                    <ToolIcon />{detail()!.tool_count}
                  </span>
                  <span class={styles.statSep}>·</span>
                  <span
                    class={styles.stat}
                    title={`Context: ${Math.round((detail()!.context_tokens / contextWindow(detail()!.model)) * 100)}% of ${fmt(contextWindow(detail()!.model))}`}
                  >
                    <CtxGauge pct={(detail()!.context_tokens / contextWindow(detail()!.model)) * 100} />
                    {fmt(detail()!.context_tokens)}/{fmt(contextWindow(detail()!.model))}
                  </span>
                </span>
              </Show>
            </Show>
          </div>

          <div class={styles.tbActions}>
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
          <div class={styles.tbWorktrees}>
            <For each={worktrees()} fallback={<span class="dim sm">no worktrees</span>}>
              {(w) => (
                <div class={styles.wtRow}>
                  <span class={styles.wtBranch}>{w.branch || "(detached)"}</span>
                  <span class={`${styles.wtPath} dim`}>{w.path}</span>
                  <Show when={w.is_main}><span class={styles.wtMain}>main</span></Show>
                  <Show when={!w.is_main}>
                    <button class="btn xs ghost" onClick={() => removeWorktree(w.path)}>remove</button>
                  </Show>
                </div>
              )}
            </For>
            <div class={styles.wtAdd}>
              <input class={styles.wtInput} value={wtPath()} placeholder="worktree path" onInput={(e) => setWtPath(e.currentTarget.value)} />
              <button class="btn sm" onClick={addWorktree}>+ Add for {sel()!.branch}</button>
            </div>
          </div>
        </Show>

        <Show when={err()}><div class={styles.tbErr}>{err()}</div></Show>
      </Show>
    </div>
  );
}

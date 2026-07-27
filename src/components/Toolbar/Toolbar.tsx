import { createSignal, createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import ClaudeIcon from "../../seti/ClaudeIcon";
import PiIcon from "../../seti/PiIcon";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { Brain, Pencil, RefreshCw, Wrench, ChevronRight, SquareTerminal, Code2, ArrowUpRight, FoldVertical, ArrowDown } from "lucide-solid";
import styles from "./Toolbar.module.css";

type SessionDetail = {
  prompt_count: number;
  turn_count: number;
  tool_count: number;
  output_tokens: number;
  context_tokens: number;
  model: string | null;
  compaction_count: number;
  compaction_reclaimed: number;
  touched_count: number;
};
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

// Stats-row glyphs as Lucide icons (currentColor, uniformly boxed by .statIco)
// so they read crisp next to the context gauge and match the app icon system.
function ModelIcon() {
  return <Icon icon={Brain} class={styles.statIco} />;
}
function PromptIcon() {
  return <Icon icon={Pencil} class={styles.statIco} />;
}
function TurnIcon() {
  return <Icon icon={RefreshCw} class={styles.statIco} />;
}
function ToolIcon() {
  return <Icon icon={Wrench} class={styles.statIco} />;
}
function CompactIcon() {
  return <Icon icon={FoldVertical} class={styles.statIco} />;
}
function ReclaimedIcon() {
  return <Icon icon={ArrowDown} class={styles.statIco} />;
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
  const [err, setErr] = createSignal("");

  ensureModelCaps();

  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;

  // Load the currently-selected session's detail, guarding against a stale
  // selection: `session_detail` is a full-file read, so a slow load for a
  // just-deselected session must not overwrite the current one's stats. We
  // capture the selection at call time and drop the result if it changed.
  function loadDetail() {
    const s = sel();
    if (!s?.sessionId || !s.sessionPath) return;
    const forId = s.sessionId;
    const agent = s.agent === "pi" ? "pi" : "claude";
    invoke<SessionDetail>("session_detail", { path: s.sessionPath, agent })
      .then((d) => {
        if (sel()?.sessionId === forId) setDetail(d);
      })
      .catch(() => {});
  }

  createEffect(
    on(
      () => sel()?.sessionId,
      (id) => {
        setDetail(null);
        setErr("");
        const s = sel();
        setDisplayName(s?.sessionName || s?.sessionTitle || "");
        if (id && s?.sessionPath) loadDetail();
      },
    ),
  );

  // Refresh on transcript changes instead of a fixed poll: the backend already
  // emits `sessions://changed` (debounced on transcript growth). One subscription
  // for the component's life; the handler reloads the current selection and
  // no-ops when nothing is selected. loadDetail's guard drops stale results.
  onMount(() => {
    const un = listen("sessions://changed", () => loadDetail());
    onCleanup(() => {
      un.then((f) => f()).catch(() => {});
    });
  });

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

  return (
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
            <nav class={styles.tbCrumb} aria-label="location">
              <span class={`${styles.crumb} dim`}>{sel()!.spaceName}</span>
              <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
              <span class={`${styles.crumb} dim`}>{sel()!.projectName}</span>
              <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
              <Show
                when={isSession()}
                fallback={<span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.branch}</span>}
              >
                <span class={`${styles.crumb} dim`}>{sel()!.branch}</span>
                <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
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
                <Show when={detail()!.compaction_count > 0}>
                  <span
                    class={styles.stat}
                    title={
                      detail()!.compaction_reclaimed > 0
                        ? `${detail()!.compaction_count} compactions, ~${fmt(detail()!.compaction_reclaimed)} tokens reclaimed`
                        : `${detail()!.compaction_count} compactions`
                    }
                  >
                    <CompactIcon />{detail()!.compaction_count}
                    <Show when={detail()!.compaction_reclaimed > 0}>
                      <ReclaimedIcon />{fmt(detail()!.compaction_reclaimed)}
                    </Show>
                  </span>
                  <span class={styles.statSep}>·</span>
                </Show>
                <span
                  class={styles.stat}
                  title={`Context: ${Math.round((detail()!.context_tokens / contextWindow(detail()!.model)) * 100)}% of ${fmt(contextWindow(detail()!.model))}`}
                >
                  <CtxGauge pct={(detail()!.context_tokens / contextWindow(detail()!.model)) * 100} />
                  {fmt(detail()!.context_tokens)}/{fmt(contextWindow(detail()!.model))}
                </span>
              </span>
            </Show>
          </div>

          <div class={styles.tbActions}>
            <Button
              size="sm"
              onClick={() => openGhostty(isSession())}
              title={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
              aria-label={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
              icon={<Icon icon={SquareTerminal} class={styles.tbAppIco} />}
              iconRight={<Icon icon={ArrowUpRight} class={styles.tbArrow} />}
            />
            <Button
              size="sm"
              onClick={openVSCode}
              title="Open in VSCode"
              aria-label="Open in VSCode"
              icon={<Icon icon={Code2} class={styles.tbAppIco} />}
              iconRight={<Icon icon={ArrowUpRight} class={styles.tbArrow} />}
            />
          </div>
        </div>

        <Show when={err()}><div class={styles.tbErr}>{err()}</div></Show>
      </Show>
    </div>
  );
}

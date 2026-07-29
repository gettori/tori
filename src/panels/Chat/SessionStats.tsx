import { Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, Brain, FoldVertical, Pencil, RefreshCw, Wrench } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import styles from "./Chat.module.css";

/**
 * One session's figures, as a row: model, prompts, turns, tool calls, and how
 * much of the context window is spoken for.
 *
 * Read from the transcript on disk (`chat_session_detail`) rather than counted
 * off the live store, so a resumed session's earlier turns are included and the
 * figures mean the same thing on turn one as on turn fifty.
 */
export type SessionDetail = {
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
// static fallback applies. Reading the signal inside the render keeps the strip
// reactive, so the percentage corrects itself the moment the caps land.
const [modelCaps, setModelCaps] = createSignal<Record<string, number>>({});
let capsRequested = false;
export function ensureModelCaps() {
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

export default function SessionStats(props: { detail: SessionDetail }) {
  const window = () => contextWindow(props.detail.model);
  const pct = () => (props.detail.context_tokens / window()) * 100;
  return (
    <span class={styles.stats}>
      <Show when={props.detail.model}>
        <span class={`${styles.stat} ${styles.statModel}`} title="Model">
          <Icon icon={Brain} class={styles.statIco} />
          {modelLabel(props.detail.model)}
        </span>
        <span class={styles.statSep}>·</span>
      </Show>
      <span class={styles.stat} title="Prompts you sent">
        <Icon icon={Pencil} class={styles.statIco} />
        {props.detail.prompt_count}
      </span>
      <span class={styles.statSep}>·</span>
      <span class={styles.stat} title="Agent turns">
        <Icon icon={RefreshCw} class={styles.statIco} />
        {props.detail.turn_count}
      </span>
      <span class={styles.statSep}>·</span>
      <span class={styles.stat} title="Tool calls">
        <Icon icon={Wrench} class={styles.statIco} />
        {props.detail.tool_count}
      </span>
      <span class={styles.statSep}>·</span>
      <Show when={props.detail.compaction_count > 0}>
        <span
          class={styles.stat}
          title={
            props.detail.compaction_reclaimed > 0
              ? `${props.detail.compaction_count} compactions, ~${fmt(props.detail.compaction_reclaimed)} tokens reclaimed`
              : `${props.detail.compaction_count} compactions`
          }
        >
          <Icon icon={FoldVertical} class={styles.statIco} />
          {props.detail.compaction_count}
          <Show when={props.detail.compaction_reclaimed > 0}>
            <Icon icon={ArrowDown} class={styles.statIco} />
            {fmt(props.detail.compaction_reclaimed)}
          </Show>
        </span>
        <span class={styles.statSep}>·</span>
      </Show>
      <span class={styles.stat} title={`Context: ${Math.round(pct())}% of ${fmt(window())}`}>
        <CtxGauge pct={pct()} />
        {fmt(props.detail.context_tokens)}/{fmt(window())}
      </span>
    </span>
  );
}

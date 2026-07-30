import { Show } from "solid-js";
import { ArrowDown, FoldVertical, Pencil, RefreshCw, Wrench } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { providerIcon } from "../../components/Icon/ProviderIcon";
import { contextPercent } from "../../utils/chatModels";
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

export default function SessionStats(props: {
  detail: SessionDetail;
  /** The window the one resolver produced for this session's model, or null
   *  when no source knew one. Passed in rather than resolved here so the strip
   *  and the composer meter cannot show two denominators for one model. */
  contextWindow: number | null;
  /** The adapter behind the session, used only when the transcript's model id
   *  does not name a vendor on its own. Optional for the same reason as in the
   *  composer's picker: no adapter named, no vendor claimed. */
  agentId?: string;
}) {
  // Resolved upstream and passed in, never worked out here: one resolver owns
  // every step, including the non-Claude catalogue lookup, so this row and the
  // composer meter cannot reach different answers for one model.
  const window = () => props.contextWindow;
  const pct = () => contextPercent(props.detail.context_tokens, window());
  return (
    <span class={styles.stats}>
      <Show when={props.detail.model}>
        <span class={`${styles.stat} ${styles.statModel}`} title="Model">
          <Icon icon={providerIcon(props.detail.model, props.agentId)} class={styles.statIco} />
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
      {/* Nothing at all when no source knows the window, and nothing when the
          usage contradicts it: a percentage is a claim, and neither case
          supports one. */}
      <Show when={window()}>
        {(w) => (
          <span
            class={styles.stat}
            title={
              pct() === null
                ? `Context: ${fmt(props.detail.context_tokens)} used, window unknown`
                : `Context: ${Math.round(pct()!)}% of ${fmt(w())}`
            }
          >
            {/* Withheld with the percentage: an empty gauge beside numbers
                that visibly exceed the window would be a second wrong claim,
                reading as "nothing used". */}
            <Show when={pct() !== null}>{(_) => <CtxGauge pct={pct()!} />}</Show>
            {fmt(props.detail.context_tokens)}/{fmt(w())}
            {/* Shown beside the raw figures rather than instead of them: the
                percentage is the one people read at a glance, the tokens are
                what they check it against. Absent with the gauge when the two
                numbers contradict each other, for the same reason. */}
            <Show when={pct() !== null}>{(_) => <> ({Math.round(pct()!)}%)</>}</Show>
          </span>
        )}
      </Show>
    </span>
  );
}

import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { Footprints } from "lucide-solid";
import { emitWith, REVEAL_TURN, type RevealTurn } from "../../utils/events";
import type { DiffHunk } from "../../utils/diffHunks";
import { liveChats } from "../../utils/chatSessions";
import { checkpointClock } from "../../utils/syntheticTabs";
import {
  CALLS_SHOWN,
  callSummary,
  claimHeadline,
  orderedCalls,
  rangeLabel,
  turnLabel,
  type CallRef,
  type ClaimReader,
  type ClaimRange,
  type TurnRef,
} from "../../utils/provenance";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import styles from "./HunkProvenance.module.css";

/** One hunk's provenance, read when the panel opens: who wrote each run of its
 *  lines, in what turn, by which call, and what the agent said before it. */
export default function HunkProvenance(props: { hunk: DiffHunk; read: ClaimReader }) {
  const [ranges] = createResource(
    () => ({ hunk: props.hunk, read: props.read }),
    (k) => k.read(k.hunk),
  );

  return (
    <div class={styles.panel}>
      <Switch>
        <Match when={ranges.loading}>
          <div class={styles.quiet}>Reading the sessions that ran here...</div>
        </Match>
        <Match when={ranges() === null}>
          <div class={styles.quiet}>Tori could not work out who wrote this hunk.</div>
        </Match>
        <Match when={ranges()?.length === 0}>
          <div class={styles.quiet}>Tori cannot follow this file line by line.</div>
        </Match>
        <Match when={ranges()}>
          {(all) => <For each={all()}>{(range) => <RangeClaim range={range} labelled={all().length > 1} />}</For>}
        </Match>
      </Switch>
    </div>
  );
}

function RangeClaim(props: { range: ClaimRange; labelled: boolean }) {
  const claim = () => props.range.claim;
  const turn = (): TurnRef | null => {
    const c = claim();
    return c.tier === "none" ? null : c.turn;
  };
  const calls = (): CallRef[] => {
    const c = claim();
    if (c.tier === "call") return [c.call];
    if (c.tier === "none") return [];
    return orderedCalls(c.calls);
  };
  return (
    <div class={styles.range}>
      <Show when={props.labelled}>
        <div class={styles.rangeLabel}>{rangeLabel(props.range)}</div>
      </Show>
      <div class={styles.headline}>{claimHeadline(claim())}</div>
      <Show when={turn()}>{(t) => <TurnLine turn={t()} />}</Show>
      <For each={calls().slice(0, CALLS_SHOWN)}>{(call) => <CallBlock call={call} />}</For>
      <Show when={calls().length > CALLS_SHOWN}>
        <div class={styles.quiet}>and {calls().length - CALLS_SHOWN} more</div>
      </Show>
    </div>
  );
}

function TurnLine(props: { turn: TurnRef }) {
  const isChatTabOpen = () => liveChats().some((c) => c.sessionId === props.turn.session.id);
  return (
    <div class={styles.turn}>
      <span>
        {turnLabel(props.turn)}, {checkpointClock(props.turn.promptTs)}
      </span>
      <Show when={isChatTabOpen()}>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            emitWith<RevealTurn>(REVEAL_TURN, { sessionId: props.turn.session.id, promptTs: props.turn.promptTs })
          }
        >
          Show in chat
        </Button>
      </Show>
      <Show when={props.turn.prompt}>{(prompt) => <div class={styles.prompt}>{prompt()}</div>}</Show>
    </div>
  );
}

function CallBlock(props: { call: CallRef }) {
  return (
    <div class={styles.call}>
      <Show when={props.call.reply}>{(reply) => <div class={styles.reply}>{reply()}</div>}</Show>
      <code class={styles.command}>{callSummary(props.call)}</code>
    </div>
  );
}

/** Which hunks of one diff have their provenance open, by index into it. */
export function createOpenHunks() {
  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  return {
    has: (hunk: number) => open().has(hunk),
    toggle: (hunk: number) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(hunk)) next.add(hunk);
        return next;
      }),
    clear: () => setOpen(new Set<number>()),
  };
}

/** The hunk header's control for the panel. */
export function WhyToggle(props: { open: boolean; onClick: () => void }) {
  return (
    <IconButton
      size="sm"
      icon={<Icon icon={Footprints} />}
      active={props.open}
      tooltip={props.open ? "Hide who wrote this hunk" : "Who wrote this hunk"}
      onClick={props.onClick}
    />
  );
}

import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Footprints } from "lucide-solid";
import {
  ASK_WHY,
  emitWith,
  FOCUS_SESSION_TAB,
  REVEAL_TURN,
  type AskWhy as AskWhyEvent,
  type FocusSessionTab,
  type RevealTurn,
} from "../../utils/events";
import type { DiffHunk } from "../../utils/diffHunks";
import { liveChats } from "../../utils/chatSessions";
import { checkpointClock } from "../../utils/syntheticTabs";
import { chatTier } from "../../utils/chatCapabilities";
import { findAdapter } from "../../utils/agents";
import { catalogFor, ensureModelCatalogsLoaded } from "../../utils/modelCatalog";
import {
  askRefusal,
  CALLS_SHOWN,
  callSummary,
  claimHeadline,
  orderedCalls,
  questionLine,
  rangeLabel,
  turnLabel,
  whySeed,
  type CallRef,
  type ClaimReader,
  type ClaimRange,
  type SessionLabel,
  type TurnRef,
} from "../../utils/provenance";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import styles from "./HunkProvenance.module.css";
import hunkStyles from "./HunkCommentInput.module.css";

/** One hunk's provenance, read when the panel opens: who wrote each run of its
 *  lines, in what turn, by which call, and what the agent said before it. */
export default function HunkProvenance(props: { file: string; hunk: DiffHunk; read: ClaimReader }) {
  const [ranges] = createResource(
    () => ({ hunk: props.hunk, read: props.read }),
    (k) => k.read(k.hunk),
  );
  const failure = () => {
    const r = ranges();
    return r && !Array.isArray(r) ? r.error : null;
  };
  const claims = () => {
    const r = ranges();
    return Array.isArray(r) ? r : null;
  };

  return (
    <div class={styles.panel}>
      <Switch>
        <Match when={ranges.loading}>
          <div class={styles.quiet}>Reading the sessions that ran here...</div>
        </Match>
        <Match when={failure()}>
          {(why) => <div class={styles.quiet}>Tori could not work out who wrote this hunk: {why()}</div>}
        </Match>
        <Match when={claims()?.length === 0}>
          <div class={styles.quiet}>Tori cannot follow this file line by line.</div>
        </Match>
        <Match when={claims()}>
          {(all) => (
            <For each={all()}>
              {(range) => <RangeClaim file={props.file} hunk={props.hunk} range={range} labelled={all().length > 1} />}
            </For>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function RangeClaim(props: { file: string; hunk: DiffHunk; range: ClaimRange; labelled: boolean }) {
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
      <AskWhy file={props.file} hunk={props.hunk} range={props.range} calls={calls()} />
    </div>
  );
}

// Claude forks by its transport, which Tori measured. An ACP agent forks only
// if it said so on a handshake Tori has cached, since the verb is unstable in
// the protocol and agents differ.
function canFork(session: SessionLabel): boolean {
  const transport = findAdapter(session.agent).chat?.transport;
  if (chatTier(transport).rewind === "fork") return true;
  return transport === "acp" && !!catalogFor(session.agent, session.profile)?.catalogue?.capabilities?.fork;
}

const POLL_MS = 1500;
const GIVE_UP_MS = 10 * 60 * 1000;
const NOT_STARTED_MS = 30 * 1000;

function AskWhy(props: { file: string; hunk: DiffHunk; range: ClaimRange; calls: CallRef[] }) {
  const [text, setText] = createSignal("");
  const [asked, setAsked] = createSignal<{ forkId: string; agentId: string; line: string } | null>(null);
  const [reply, setReply] = createSignal<string | null>(null);
  const [gaveUp, setGaveUp] = createSignal(false);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);
  const [notStarted, setNotStarted] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(timer));
  void ensureModelCatalogsLoaded();

  const refusal = () => askRefusal(props.range.claim, canFork);
  const fork = () => {
    const a = asked();
    return a ? liveChats().find((c) => c.sessionId === a.forkId) : undefined;
  };
  const done = () => !!reply() && !!fork()?.doneAt;
  const waiting = () => {
    const status = fork()?.status;
    return status === "waitingForApproval" || status === "waitingForAnswer";
  };

  function ask() {
    const claim = props.range.claim;
    const question = text().trim();
    if (claim.tier === "none" || !question || asked()) return;
    const session = claim.turn.session;
    const forkId = crypto.randomUUID();
    const line = questionLine(question);
    emitWith<AskWhyEvent>(ASK_WHY, {
      forkId,
      from: session.id,
      agentId: session.agent,
      cwd: session.cwd,
      profile: session.profile,
      title: `why: ${props.file.split("/").pop() ?? props.file}`,
      text: whySeed({
        file: props.file,
        range: props.range,
        turn: claim.turn,
        calls: props.calls,
        hunk: props.hunk,
        question,
      }),
    });
    setAsked({ forkId, agentId: session.agent, line });
    const started = Date.now();
    timer = setInterval(async () => {
      const a = asked();
      if (!a) return;
      let said: { reply: string | null; failed: string | null; started: boolean } | null = null;
      try {
        said = await invoke("ask_why_reply", { sessionId: a.forkId, agentId: a.agentId, question: a.line });
        setReadError(null);
      } catch (e) {
        setReadError(String(e));
      }
      if (said?.reply) setReply(said.reply);
      if (said?.failed) {
        setFailed(said.failed);
        clearInterval(timer);
        return;
      }
      setNotStarted(!!said && !said.started && Date.now() - started > NOT_STARTED_MS);
      if (done()) clearInterval(timer);
      else if (Date.now() - started > GIVE_UP_MS) {
        clearInterval(timer);
        setGaveUp(true);
      }
    }, POLL_MS);
  }

  const openChat = () => {
    const tabId = fork()?.tabId;
    if (tabId) emitWith<FocusSessionTab>(FOCUS_SESSION_TAB, { tabId });
  };

  return (
    <Show when={!refusal()} fallback={<div class={styles.quiet}>{refusal()}</div>}>
      <Show
        when={asked()}
        fallback={
          <div class={hunkStyles.commentBox}>
            <input
              class={hunkStyles.commentInput}
              type="text"
              placeholder="Ask why, in a side conversation with this session"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            <Button size="xs" disabled={!text().trim()} onClick={ask}>
              Ask
            </Button>
          </div>
        }
      >
        <div class={styles.answer}>
          <Show when={reply()} fallback={<div class={styles.quiet}>Asking a fork of this session...</div>}>
            {(said) => <div class={styles.reply}>{said()}</div>}
          </Show>
          <Show when={waiting()}>
            <div class={styles.quiet}>The fork is waiting for you in its chat.</div>
          </Show>
          <Show when={failed()}>{(why) => <div class={styles.quiet}>The fork could not open: {why()}</div>}</Show>
          <Show when={notStarted() && !failed()}>
            <div class={styles.quiet}>The fork has not started yet. Its chat says why.</div>
          </Show>
          <Show when={!reply() && readError()}>
            {(why) => <div class={styles.quiet}>Could not read the fork's answer yet: {why()}</div>}
          </Show>
          <Show when={gaveUp() && !done()}>
            <div class={styles.quiet}>No finished answer yet. The rest is in its chat.</div>
          </Show>
          <Show when={fork()}>
            <Button size="xs" variant="ghost" onClick={openChat}>
              Continue in chat
            </Button>
          </Show>
        </div>
      </Show>
    </Show>
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

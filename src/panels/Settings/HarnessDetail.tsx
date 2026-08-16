import { For, Show, Switch, Match, onMount } from "solid-js";
import { ChevronLeft } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import { findAgent } from "../../utils/agents";
import {
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  unavailableCapabilities,
  type PublishedCapability,
} from "../../utils/chatCapabilities";
import type { AgentHealth, BinaryStatus } from "../../utils/agentHealth";
import AgentAccounts from "./AgentAccounts";
import styles from "./Settings.module.css";

// What each published key means, since the value alone is deliberately terse.
// Keyed on the capability's own `key`, so a value changing (a better rewind, a
// re-measured steer) does not orphan its explanation.
const CAPABILITY_NOTES: Record<PublishedCapability["key"], string> = {
  rewind:
    "Puts the files back to a chosen turn and carries the conversation into a fork. The forked agent still remembers the turns you undid.",
  steer: "A message typed during a turn goes into that turn rather than waiting for the next one.",
  approvals:
    "Where a tool call's permission question comes from. In-protocol means the agent asks and Sway shows it, so the agent's own permission modes are the ones in force.",
  // Two sources now, which is why the note names both rather than the one Sway
  // happens to use for Claude: `before-state` is Sway reading the file ahead of
  // the write, `agent-supplied` is the agent sending it, and a reader on an ACP
  // harness needs to know theirs depends on which agent they picked.
  diffs: "A tool card can show what a write changed, either because Sway recorded the file just before it was written or because the agent sent its prior contents. An agent that sends neither gets a card with no diff.",
  budgets: "A spend limit stops the chat at a turn boundary: the running turn finishes, the next one does not start.",
  history:
    "This agent can reopen a conversation it still holds, so a chat closed and reopened replays its earlier turns.",
  sessions: "This agent can list its own sessions, including ones started outside Sway.",
};

/**
 * One harness, in full: everything the card had to drop to stay scannable.
 *
 * Escape is answered here and its propagation stopped, so the panel's own
 * handler never sees it: inside this page Escape means "back to the list", and
 * letting it bubble would close the whole settings panel instead.
 */
export default function HarnessDetail(props: {
  agent: AgentHealth;
  tone: Record<BinaryStatus, string>;
  stateLabel: Record<BinaryStatus, string>;
  statePill: Record<BinaryStatus, string>;
  onBack: () => void;
  onRecheck: () => Promise<unknown>;
  rechecking: boolean;
}) {
  let backEl: HTMLButtonElement | undefined;
  const a = () => props.agent;
  // From the resolved adapter rather than from `agent_health`, which answers
  // about the binary on disk and knows nothing about the chat transport.
  const tier = () => chatTier(findAgent(a().id).chat?.transport);
  const capabilities = () => publishedCapabilities(tier());
  const missing = () => (capabilities().length ? unavailableCapabilities(tier()) : []);

  onMount(() => backEl?.focus());

  return (
    <div
      class={styles.detail}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onBack();
      }}
    >
      <button ref={backEl} type="button" class={styles.detailBack} onClick={() => props.onBack()}>
        <Icon icon={ChevronLeft} size={14} />
        Harnesses
      </button>

      <div class={styles.detailHead}>
        <span class={`${styles.dot} ${props.tone[a().status]}`} />
        <span class={styles.detailTitle}>{a().label}</span>
        <Show when={a().version}>{(v) => <span class={styles.detailVersion}>{v()}</span>}</Show>
        <span class={`${styles.statePill} ${props.statePill[a().status]}`}>
          {props.stateLabel[a().status]}
        </span>
      </div>
      <div class={styles.detailProgram}>
        <code>{a().path ?? a().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code>, then check again.
          </Match>
          <Match when={a().status === "versionMatch"}>Installed, version {a().version}.</Match>
          {/* Installed, but **this adapter** was never measured against it: the
              adapter declares no `verified_against` at all. */}
          <Match when={a().status === "versionUnknown" && a().version && !a().verifiedAgainst}>
            Installed, version {a().version}. Untested: nobody has measured Sway against this
            agent, so treat it as a starting point rather than a supported harness.
          </Match>
          <Match when={a().status === "versionUnknown" && a().version}>
            Installed, version {a().version}.
          </Match>
          <Match when={a().status === "versionUnknown"}>
            Installed. It does not report a version, so Sway cannot check it.
          </Match>
          <Match when={a().status === "versionDrift"}>
            Installed, version {a().version}. Sway's adapter was built against{" "}
            {a().verifiedAgainst}, so some behaviour may differ.
          </Match>
        </Switch>
        {/* Installed and signed-out are two independent facts, and this one is
            the harness's own answer rather than Sway's inference. */}
        <Show when={a().status !== "notFound" && a().signIn === "signedOut"}>
          {" "}
          Nobody is signed in, so it is not offered for a new session.
        </Show>
        <Show when={a().signIn === "signedIn" && a().account}>
          {(account) => <> Signed in as {account()}.</>}
        </Show>
      </div>

      {/* The harness's own statement about which credential it will bill
          against, not Sway reading its environment and guessing. */}
      <Show when={a().apiKeySource}>
        {(source) => (
          <div class={styles.hint}>
            <code>{source()}</code> is set in this environment, so {a().label} bills against that
            API key rather than the subscription it is signed in with.
          </div>
        )}
      </Show>

      <div class={styles.cardActions}>
        <Button size="sm" onClick={() => void props.onRecheck()} disabled={props.rechecking}>
          {props.rechecking ? "Checking…" : "Check again"}
        </Button>
      </div>

      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Sessions</span>
        <span class={styles.sectionRule} />
      </div>
      <div class={styles.cardMeta}>
        <Switch>
          {/* No directory at all, because this agent keeps its sessions
              somewhere only its protocol reaches. */}
          <Match when={!a().sessionsDir}>Sessions come over the agent's own protocol.</Match>
          <Match when={a().sessionsDirExists}>
            Sessions read from <code>{a().sessionsDir}</code>
          </Match>
          <Match when={true}>
            No sessions yet at <code>{a().sessionsDir}</code>
          </Match>
        </Switch>
      </div>
      <div class={styles.chips}>
        <Show when={a().hooks}>
          <span class={styles.chip} title="Status comes from the agent's own hooks">
            live status
          </span>
        </Show>
        <Show when={a().needsYou}>
          <span class={styles.chip} title="Sway can detect when this agent is waiting on you">
            needs-you
          </span>
        </Show>
      </div>
      <Show when={a().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>

      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Models</span>
        <span class={styles.sectionRule} />
      </div>
      {/* No list and no count. This used to render the adapter's
          `[[chat.models]]`, a hand-maintained table shown as what the harness
          could run; it said 200k for two models the harness reports 1M for.
          Every harness now reads the same way until the probe cache is wired in:
          the models are the harness's to name. */}
      <div class={styles.cardMeta}>
        {a().label} names its own models when a session starts, so there is no list to show here.
      </div>

      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Chat capabilities</span>
        <span class={styles.sectionRule} />
      </div>
      {/* Each entry publishes the *qualified* value, never the bare feature
          name. A chip reading "rewind" would promise the unqualified capability
          when what shipped is a fork the agent still remembers. */}
      <div class={styles.chips}>
        <For each={capabilities()}>
          {(cap) => (
            <span class={styles.chip} title={CAPABILITY_NOTES[cap.key]}>
              {cap.label}
            </span>
          )}
        </For>
        {/* A gap carries no qualified label, because there is no measured value
            to qualify: the bare key, struck through, denies the capability
            rather than promising it. */}
        <For each={missing()}>
          {(gap) => (
            <span class={`${styles.chip} ${styles.chipGone}`} title={gap.why}>
              {gap.key}
            </span>
          )}
        </For>
      </div>
      <Show when={!capabilities().length}>
        <div class={styles.cardMeta}>Terminal only. Sway has no chat transport for this agent.</div>
      </Show>
      {/* The reasons in full rather than behind hover text: they answer "why is
          this control missing", and a tooltip would make finding that the
          user's problem. */}
      <Show when={missing().length}>
        <ul class={styles.gaps}>
          <For each={missing()}>{(gap) => <li>{gap.why}</li>}</For>
        </ul>
      </Show>
      <Show when={steerCostDetail(tier())}>
        {(detail) => <div class={styles.hint}>{detail()}</div>}
      </Show>

      {/* Only for an installed harness: an account list for a binary that is
          not there would be a set of controls with nothing behind them. It
          renders itself away for an adapter that declares no `[accounts]`. */}
      <Show when={a().status !== "notFound"}>
        <AgentAccounts agentId={a().id} agentLabel={a().label} />
      </Show>
    </div>
  );
}

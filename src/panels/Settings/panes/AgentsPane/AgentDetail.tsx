import { For, Show, Switch, Match, onMount } from "solid-js";
import { ChevronLeft } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import { findAdapter } from "../../../../utils/agents";
import {
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  unavailableCapabilities,
  type PublishedCapability,
} from "../../../../utils/chatCapabilities";
import {
  catalogFor,
  isProbing,
  isStale,
  refreshCatalog,
  type ProbeFailureReason,
} from "../../../../utils/modelCatalog";
import type { AgentHealth, BinaryStatus } from "../../../../utils/agentHealth";
import { mirroredOptions } from "../../../../utils/chatTypes";
import AgentAccounts from "./AgentAccounts";
import styles from "../../Settings.module.css";

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
  // agent needs to know theirs depends on which agent they picked.
  diffs: "A tool card can show what a write changed, either because Sway recorded the file just before it was written or because the agent sent its prior contents. An agent that sends neither gets a card with no diff.",
  budgets: "A spend limit stops the chat at a turn boundary: the running turn finishes, the next one does not start.",
  history:
    "This agent can reopen a conversation it still holds, so a chat closed and reopened replays its earlier turns.",
  sessions: "This agent can list its own sessions, including ones started outside Sway.",
};

/**
 * Why a probe produced no catalogue, as a sentence with a next step.
 *
 * `unsupported` is deliberately not phrased as the agent failing: it is a fact
 * about this build of Sway, and blaming the binary would send the user to
 * reinstall something that is working.
 */
const FAILURE_NOTE: Record<ProbeFailureReason, string> = {
  spawnFailed: "Sway could not start it, so there was nothing to ask.",
  timedOut: "It did not answer in time.",
  signedOut: "Nobody is signed in, so it would not answer.",
  noAnswer: "It started and said nothing.",
  unsupported: "Sway cannot ask this agent yet. Its models arrive when a session starts.",
};

/** The probe's date, in the reader's own locale. The time is dropped: what
 *  matters is how old the answer is, and a catalogue does not move by the hour. */
function probedOn(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/**
 * One agent, in full: everything the card had to drop to stay scannable.
 *
 * Escape is answered here and its propagation stopped, so the panel's own
 * handler never sees it: inside this page Escape means "back to the list", and
 * letting it bubble would close the whole settings panel instead.
 */
export default function AgentDetail(props: {
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
  const tier = () => chatTier(findAdapter(a().id).chat?.transport);
  const capabilities = () => publishedCapabilities(tier());
  const missing = () => (capabilities().length ? unavailableCapabilities(tier()) : []);

  const catalog = () => catalogFor(a().id);
  const catalogue = () => catalog()?.catalogue ?? null;
  const probingThis = () => isProbing(a().id);
  const stale = () => isStale(catalog(), a().version);
  /** The agent's own words when it gave any, after Sway's sentence naming the
   *  kind of failure. Quoted rather than paraphrased, and omitted when empty. */
  const failureNote = () => {
    const failure = catalog()?.lastFailure;
    if (!failure) return "";
    const detail = failure.detail.trim();
    return detail ? `${FAILURE_NOTE[failure.reason]} It said: ${detail}` : FAILURE_NOTE[failure.reason];
  };

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
        Agents
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
            agent, so treat it as a starting point rather than a supported agent.
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
            the agent's own answer rather than Sway's inference. */}
        <Show when={a().status !== "notFound" && a().signIn === "signedOut"}>
          {" "}
          Nobody is signed in, so it is not offered for a new session.
        </Show>
        <Show when={a().signIn === "signedIn" && a().account}>
          {(account) => <> Signed in as {account()}.</>}
        </Show>
      </div>

      {/* The agent's own statement about which credential it will bill
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

      {/* Only for a agent Sway can actually ask. A terminal-only adapter
          declares no `[chat]` table, so the probe has nothing to drive and the
          backend never returns a row for it: the section would be a heading, a
          "nobody has asked" line and a button whose only possible outcome is
          a failure saying Sway cannot ask. The capabilities section below says
          "Terminal only" for the same agent, which is the honest answer. */}
      <Show when={findAdapter(a().id).chat}>
        <div class={styles.groupHead}>
          <span class={styles.groupTitle}>Models</span>
          <span class={styles.sectionRule} />
          {/* "Ask again", not "Check again": the button above re-probes the
              binary, this one re-asks the agent what it can run, and two
              controls with one label would be two different actions under one
              name. */}
          <Button size="sm" onClick={() => void refreshCatalog(a().id)} disabled={probingThis()}>
            {probingThis() ? "Asking…" : "Ask again"}
          </Button>
        </div>
        {/* Every row here is something the agent itself named, on the probe
            this page reports below. Nothing is declared: the adapter used to carry
            a `[[chat.models]]` table shown as what the agent could run, and it
            said 200k for two models the agent reports 1M for. */}
        <Switch>
          <Match when={probingThis() && !catalogue()}>
            <div class={styles.cardMeta}>Asking {a().label} what it can run…</div>
          </Match>
          <Match when={catalogue()}>
            {(cat) => (
              <>
                <ul class={styles.modelList}>
                  <For each={cat().models}>
                    {(m) => (
                      <li class={styles.modelRow}>
                        <span class={styles.modelName}>{m.displayName || m.value}</span>
                        <code class={styles.modelId}>{m.value}</code>
                        {/* Said out loud, because its provenance differs: the
                            user wrote this id in the agent's own settings and
                            Sway passes it through unresolved. */}
                        <Show when={m.userConfigured}>
                          <span class={styles.chip}>yours</span>
                        </Show>
                        <Show when={m.supportsEffort && m.supportedEffortLevels.length}>
                          <span class={styles.modelEffort}>
                            {m.supportedEffortLevels.join(" · ")}
                          </span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={!cat().models.length}>
                  <div class={styles.cardMeta}>
                    {a().label} answered, and named no models it can run.
                  </div>
                </Show>
                {/* Provenance in full: who was asked, which build, and when. A
                    list with no date is a list that can rot without saying so. */}
                <div class={styles.hint}>
                  Asked {a().label}
                  <Show when={cat().version}>{(v) => <> {v()}</>}</Show>, {probedOn(cat().probedAtMs)}.
                  {/* A catalogue can differ per account: OpenCode's depends on
                      which providers are authenticated. So a page showing one has
                      to say whose answer it is, and the probe runs as the default
                      profile rather than as whichever account you were reading. */}
                  <Show when={cat().account}>
                    {(acct) => (
                      <>
                        {" "}
                        Answered for {acct().subscriptionType || "the signed-in account"}, which is the
                        default profile: another account can be offered different models.
                      </>
                    )}
                  </Show>
                </div>
                <Show when={stale()}>
                  <div class={styles.hint}>
                    This was asked of {catalogue()?.version}, and {a().version} is installed now, so
                    the list may have moved. Check again to re-ask.
                  </div>
                </Show>
                {/* The rest of what the agent published: the levers with no
                    control of Sway's own, previewed from the same probe rather
                    than only appearing once a chat is open. Read-only here, on
                    purpose - they are session state, and there is no session on
                    this page to set them on. */}
                <Show when={mirroredOptions(cat().options ?? []).length}>
                  <div class={styles.groupHead}>
                    <span class={styles.groupTitle}>Its own options</span>
                    <span class={styles.sectionRule} />
                  </div>
                  <ul class={styles.modelList}>
                    <For each={mirroredOptions(cat().options ?? [])}>
                      {(o) => (
                        <li class={styles.modelRow}>
                          <span class={styles.modelName}>{o.name}</span>
                          <code class={styles.modelId}>
                            {o.kind === "select" ? o.current : o.value ? "on" : "off"}
                          </code>
                          <Show when={o.description}>
                            <span class={styles.modelEffort}>{o.description}</span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div class={styles.hint}>
                    Set these in a chat with {a().label}, where they mirror the agent's own
                    controls.
                  </div>
                </Show>
              </>
            )}
          </Match>
          <Match when={catalog()?.state === "failed"}>
            <div class={styles.cardMeta}>{failureNote()}</div>
          </Match>
          <Match when={true}>
            <div class={styles.cardMeta}>
              Nobody has asked {a().label} what it can run. Check again to ask.
            </div>
          </Match>
        </Switch>
        {/* Kept below the list rather than instead of it, because a failure never
            clears an older answer: stale-but-real beats fresh-but-empty. */}
        <Show when={catalogue() && catalog()?.state === "failed"}>
          <div class={styles.hint}>The last attempt failed. {failureNote()}</div>
        </Show>
      </Show>

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

      {/* Only for an installed agent: an account list for a binary that is
          not there would be a set of controls with nothing behind them. It
          renders itself away for an adapter that declares no `[accounts]`. */}
      <Show when={a().status !== "notFound"}>
        <AgentAccounts agentId={a().id} agentLabel={a().label} />
      </Show>
    </div>
  );
}

import { For, Show, Switch, Match, createResource, createSignal, onMount } from "solid-js";
import { Check, ChevronLeft, RefreshCw } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import AgentGlyph from "../../../../components/Icon/AgentGlyph";
// Aliased: this module already imports Solid's control-flow `Switch`.
import Toggle from "../../../../components/Switch/Switch";
import { findAdapter } from "../../../../utils/agents";
import { agentChosen, enableBlockedReason, setAgentEnabled } from "../../../../utils/agentEnabled";
import { copyText } from "../../../../utils/clipboard";
import {
  chatTier,
  publishedCapabilities,
  unavailableCapabilities,
  type PublishedCapability,
} from "../../../../utils/chatCapabilities";
import {
  catalogFor,
  isProbing,
  refreshCatalog,
  type CatalogModel,
  type ProbeFailureReason,
} from "../../../../utils/modelCatalog";
import { fuzzyMatch, type Range } from "../../../../utils/fuzzy";
import { Mark } from "../../components/paneKit";
import { asTabProfile, type AgentHealth } from "../../../../utils/agentHealth";
import { setupJob, installNote, type InstallRoute, type SetupVerb } from "../../../../utils/install";
import { loginJob, loginNote, type LoginRoute } from "../../../../utils/signIn";
import { OPEN_JOB, emitWith, type OpenJob } from "../../../../utils/events";
import { mirroredOptions } from "../../../../utils/chatTypes";
import { settings, saveSettings } from "../../settingsStore";
import { behindVerified, verifiedVersion } from "../../../../utils/versions";
import OverlayScroll from "../../../../components/Scrollbar/OverlayScroll";
import AgentAccounts from "./AgentAccounts";
import AgentFiles from "./AgentFiles";
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
  attachmentMentions:
    "What the agent can open when handed a path it already has: a file dragged from the tree or mentioned with @. Each becomes a labelled path like [Image 1] the message can name.",
  attachmentUploads:
    "What the agent can open when handed a pasted or dropped file. Sway writes it under its own folder and passes the path, so the agent reads it rather than receiving the bytes.",
  history:
    "This agent can reopen a conversation it still holds, so a chat closed and reopened replays its earlier turns.",
  sessions: "This agent can list its own sessions, including ones started outside Sway.",
  // "Read" and not "talk to": the lane switches what you are reading and never
  // where the composer sends, since only the main agent can reach a helper.
  subagents:
    "When this agent splits work across helpers, each one gets a lane above the composer you can switch into and read, both while it runs and after the session is reopened.",
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

/** A command the user could run themselves, with the one control that keeps
 *  the promise honest: copy, exactly as shown. */
function CmdLine(props: { program: string; args: string[] }) {
  const [copied, setCopied] = createSignal(false);
  const text = () => [props.program, ...props.args].join(" ");
  const copy = async () => {
    if (!(await copyText(text()))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class={styles.cmd}>
      <span class={styles.cmdPrompt}>$</span>
      <code class={styles.cmdText}>{text()}</code>
      <button type="button" class={styles.cmdCopy} onClick={() => void copy()}>
        {copied() ? "copied" : "copy"}
      </button>
    </div>
  );
}

/**
 * One account's answer: what this agent said it can run, signed in as this
 * profile.
 *
 * A component per account rather than a list inside one, because everything
 * here is that account's: the count, the filter, the failure sentence, and Ask
 * again, which probes one account and not the agent.
 */
function ModelsPane(props: {
  agentId: string;
  agentLabel: string;
  /** `null` is the default account, the tab model's spelling. */
  profile: string | null;
  /** This account's own label, or null on an install with only one account,
   *  where naming it would be a word for the only thing there is. Also what
   *  decides whether the plan is worth printing: it tells two lists apart, and
   *  over a single list it is the footnote this page dropped on purpose. */
  account: string | null;
  /** The accounts to switch between, when there is more than one. They stand
   *  where the section title does: one list at a time, named by which tab is
   *  lit, rather than a block per account down the page. */
  tabs?: readonly { id: string; label: string }[];
  onSelect?: (id: string) => void;
}) {
  const catalog = () => catalogFor(props.agentId, props.profile);
  const catalogue = () => catalog()?.catalogue ?? null;
  const probingThis = () => isProbing(props.agentId, props.profile);
  /** The agent's own words when it gave any, after Sway's sentence naming the
   *  kind of failure. Quoted rather than paraphrased, and omitted when empty. */
  const failureNote = () => {
    const failure = catalog()?.lastFailure;
    if (!failure) return "";
    const detail = failure.detail.trim();
    return detail ? `${FAILURE_NOTE[failure.reason]} It said: ${detail}` : FAILURE_NOTE[failure.reason];
  };

  // The model list with its own little filter, because one agent answers with
  // fifteen rows. The counter reads "visible of total" so a running filter is
  // visibly a filter and not a shorter answer.
  const models = () => catalogue()?.models ?? [];
  const [modelQuery, setModelQuery] = createSignal("");
  /* Eight rows is also the card's height cap, so the box appears exactly when
     there is something off screen to find. */
  const searchable = () => models().length > 8;
  /** What one row shows, exactly as it shows it. The filter matches these and
   *  nothing invisible (`resolvedModel` is deliberately out), so a kept row
   *  can always mark why it was kept. */
  const rowText = (m: CatalogModel) => ({
    name: m.displayName || m.value,
    id: m.value,
    effort:
      m.supportsEffort && m.supportedEffortLevels.length
        ? m.supportedEffortLevels.join(" · ")
        : "",
  });
  /** Fuzzy, per field, marks included: `fuzzyMatch` is the same subsequence
   *  walk the palette and the settings search run, and returning the ranges
   *  with the verdict is what pins the marks to the match. Null filters the
   *  row out; an empty query keeps every row with nothing marked. */
  const rowHit = (m: CatalogModel): { name: Range[]; id: Range[]; effort: Range[] } | null => {
    // A list of eight or fewer gets no search box, so a query left over from a
    // longer answer (a re-probe can shrink the list under the threshold, taking
    // the box and the way to clear it) must not keep filtering invisibly.
    const q = searchable() ? modelQuery().trim() : "";
    if (!q) return { name: [], id: [], effort: [] };
    const t = rowText(m);
    const name = fuzzyMatch(q, t.name);
    const id = fuzzyMatch(q, t.id);
    const effort = t.effort ? fuzzyMatch(q, t.effort) : null;
    if (!name && !id && !effort) return null;
    return { name: name?.ranges ?? [], id: id?.ranges ?? [], effort: effort?.ranges ?? [] };
  };
  const visibleModels = () => models().filter((m) => rowHit(m) !== null);
  const modelCount = () => (catalogue() ? `${visibleModels().length} of ${models().length}` : "unknown");

  /** The plan the agent named for this account, as it worded it. Empty for a
   *  catalogue that never carried one, which renders as nothing rather than as
   *  a tier Sway guessed. */
  const plan = () => catalogue()?.account?.subscriptionType.trim() ?? "";
  const fact = () =>
    props.account ? [plan(), modelCount()].filter(Boolean).join(", ") : modelCount();

  return (
    <>
      <div class={styles.groupHead}>
        {/* The section keeps its own name, and the accounts sit past the rule
            with the facts they qualify. The tabs used to *be* the title, which
            read as the Models section disappearing the moment a second account
            existed. */}
        <span class={styles.groupTitle}>Models</span>
        <span class={styles.sectionRule} />
        <Show when={props.tabs}>
          {(tabs) => (
            <div class={styles.groupTabs}>
              <For each={tabs()}>
                {(tab) => (
                  <button
                    type="button"
                    class={styles.groupTab}
                    aria-pressed={tab.label === props.account}
                    onClick={() => props.onSelect?.(tab.id)}
                  >
                    {tab.label}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <span class={styles.groupFact}>{fact()}</span>
        {/* The same chrome recipe as the Agents list title: count, filter,
            re-ask, all on the heading so the card below is nothing but
            rows. The filter only exists where the card scrolls: a list that
            fits whole has nothing off screen to find. */}
        <Show when={searchable()}>
          <input
            type="text"
            class={styles.tableFilter}
            placeholder="Search"
            aria-label="Filter models"
            value={modelQuery()}
            onInput={(e) => setModelQuery(e.currentTarget.value)}
          />
        </Show>
        {/* "Ask again", not "Check again": the setup head's button re-probes
            the binary, this one re-asks the agent what it can run, and two
            controls with one label would be two different actions under one
            name. */}
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Ask again"
          onClick={() => void refreshCatalog(props.agentId, props.profile)}
          disabled={probingThis()}
        />
      </div>
      {/* Every row here is something the agent itself named, on the probe
          this page reports below. Nothing is declared: the adapter used to carry
          a `[[chat.models]]` table shown as what the agent could run, and it
          said 200k for two models the agent reports 1M for. */}
      <Switch>
        <Match when={probingThis() && !catalogue()}>
          <div class={styles.cardMeta}>Asking {props.agentLabel} what it can run…</div>
        </Match>
        <Match when={catalogue()}>
          {(cat) => (
            <>
              <div class={styles.modelsCard}>
                {/* The scrollbar is drawn over the rows rather than beside
                    them, so the effort ladders keep the full width. */}
                <OverlayScroll class={styles.modelScroll}>
                  <ul class={styles.modelList}>
                  <For each={visibleModels()}>
                    {(m) => {
                      // The same call that kept the row on screen, so what is
                      // marked is the actual reason it is here.
                      const hit = () => rowHit(m) ?? { name: [], id: [], effort: [] };
                      return (
                        <li class={styles.modelRow}>
                          <span class={styles.modelName}>
                            <Mark text={rowText(m).name} ranges={hit().name} />
                          </span>
                          <code class={styles.modelId}>
                            <Mark text={m.value} ranges={hit().id} />
                          </code>
                          {/* Said out loud, because its provenance differs: the
                              user wrote this id in the agent's own settings and
                              Sway passes it through unresolved. */}
                          <Show when={m.userConfigured}>
                            <span class={styles.chip}>yours</span>
                          </Show>
                          <Show when={m.supportsEffort && m.supportedEffortLevels.length}>
                            <span class={styles.modelEffort}>
                              <Mark text={rowText(m).effort} ranges={hit().effort} />
                            </span>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
                  <Show when={models().length && !visibleModels().length}>
                    <div class={styles.modelsNone}>No model matches "{modelQuery().trim()}".</div>
                  </Show>
                </OverlayScroll>
              </div>
              <Show when={!cat().models.length}>
                <div class={styles.cardMeta}>
                  {props.agentLabel} answered, and named no models it can run.
                </div>
              </Show>
              {/* No footnotes under the list - not the probe date, not the
                  account it answered for, not the staleness flag. All were
                  dropped by request: the rows are the answer, and Ask again
                  is always one press away. */}
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
                        {/* A lever the agent has and will not take reads the
                            same here as in a chat: shown, with its reason. */}
                        <Show when={o.disabled && o.note}>
                          {(note) => <span class={styles.modelNote}>{note()}</span>}
                        </Show>
                        <Show when={o.description}>
                          <span class={styles.modelEffort}>{o.description}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <div class={styles.hint}>
                  Set these in a chat with {props.agentLabel}, where they mirror the agent's own
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
            Nobody has asked {props.agentLabel} what it can run. Ask again and Sway will.
          </div>
        </Match>
      </Switch>
    </>
  );
}

/**
 * One agent, in full: everything the table row had to drop to stay scannable.
 *
 * Escape is answered here and its propagation stopped, so the panel's own
 * handler never sees it: inside this page Escape means "back to the list", and
 * letting it bubble would close the whole settings panel instead.
 */
export default function AgentDetail(props: {
  agent: AgentHealth;
  /** The folder an opened file lands in, or `null` when the workspace has no
   *  folder (Shells, a Feature with no present member). Every action here that
   *  opens the editor is disabled without one and says why. */
  projectRoot: string | null;
  onBack: () => void;
  onRecheck: () => Promise<unknown>;
  rechecking: boolean;
}) {
  let backEl: HTMLButtonElement | undefined;
  const a = () => props.agent;
  const installed = () => a().status !== "notFound";
  // The one drift direction worth surfacing: strictly older than the version
  // the adapter was measured against. Ahead of it is the steady state.
  const behind = () =>
    a().status === "versionDrift" && behindVerified(a().version, a().verifiedAgainst);
  // The page has two shapes. An agent that is not usable yet gets the setup
  // steps; one that is gets its accounts. Never both: the setup page's sign-in
  // step signs in the default profile, which is the account that decides
  // whether the agent is offered at all.
  const setupMode = () => !installed() || a().signIn === "signedOut";

  // From the resolved adapter rather than from `agent_health`, which answers
  // about the binary on disk and knows nothing about the chat transport.
  const tier = () => chatTier(findAdapter(a().id).chat?.transport);
  const capabilities = () => publishedCapabilities(tier());
  const missing = () => (capabilities().length ? unavailableCapabilities(tier()) : []);

  // Straight from the sweep, which already enumerates every account of every
  // adapter. One row means nothing to tell apart, so the models pane keeps its
  // plain heading.
  const accounts = () => a().profiles ?? [];
  // Bumped when the accounts list gains or loses one, so the Files group below
  // re-resolves against the new set of homes. A counter rather than the list
  // itself: what the Files group needs is "ask again", not "which one".
  const [accountsChanged, setAccountsChanged] = createSignal(0);
  const [modelsAccount, setModelsAccount] = createSignal<string | null>(null);
  // The picked one while it is still there, the first otherwise, which is also
  // what a switch to another agent lands on.
  const shownAccount = () =>
    accounts().find((p) => p.id === modelsAccount()) ?? accounts()[0];


  // All of these are reads of the adapter file, no probe behind any, which is
  // what allows fetching them on every page open. Errors collapse to null: a
  // route Sway cannot resolve renders as "nothing declared" rather than a
  // broken step.
  const [installRoute] = createResource(
    () => a().id,
    (id) => invoke<InstallRoute>("agent_install_route", { adapterId: id }).catch(() => null),
  );
  const [updateRoute] = createResource(
    () => a().id,
    (id) => invoke<InstallRoute>("agent_update_route", { adapterId: id }).catch(() => null),
  );
  const [uninstallRoute] = createResource(
    () => a().id,
    (id) => invoke<InstallRoute>("agent_uninstall_route", { adapterId: id }).catch(() => null),
  );
  const [loginRoute] = createResource(
    () => a().id,
    (id) => invoke<LoginRoute>("agent_login_route", { adapterId: id }).catch(() => null),
  );
  const terminal = (r: InstallRoute | null | undefined) =>
    r && r.type === "terminal" ? r : null;
  const installCmd = () => terminal(installRoute());
  const updateCmd = () => terminal(updateRoute());
  const uninstallCmd = () => terminal(uninstallRoute());
  const loginCmd = () => {
    const r = loginRoute();
    return r && r.type === "terminal" ? r : null;
  };

  onMount(() => backEl?.focus());

  // Sway never installs, updates, or removes anything itself: each button
  // starts a job running the vendor's own documented command (from the
  // adapter's [install] table) and gets out of the way, the same posture as
  // signing in. When the process exits the job re-probes health, so a finished
  // run flips this very page forward without a restart.
  const runVerb = async (verb: SetupVerb, route: InstallRoute | null) => {
    if (!route) return;
    const cwd = await homeDir().catch(() => "/");
    const job = setupJob(verb, a().id, a().label, route, cwd);
    if (job) emitWith<OpenJob>(OPEN_JOB, job);
  };

  // The default profile, by name: this step exists to make the agent usable at
  // all, and the default account is the one that decides that. Other accounts
  // are signed in from the accounts list, which owns their home variables.
  const signIn = async () => {
    const route = loginCmd();
    if (!route) return;
    const cwd = await homeDir().catch(() => "/");
    const job = loginJob(a().id, a().label, "default", "Default", route, cwd);
    if (job) emitWith<OpenJob>(OPEN_JOB, job);
  };

  /** The verdict pill, same ladder as the table's state column except drift,
   *  which gets a banner with room to name both versions instead of a pill. */
  const verdict = () => {
    if (!installed()) return { label: "Not installed", cls: "" };
    if (a().signIn === "signedOut") return { label: "Sign in", cls: styles.statePillWarn };
    return { label: "Ready", cls: styles.statePillOk };
  };

  const savePath = (raw: string) => {
    const paths = { ...(settings.agent.paths ?? {}) };
    const trimmed = raw.trim();
    if (trimmed) paths[a().id] = trimmed;
    else delete paths[a().id];
    void saveSettings({ ...settings, agent: { ...settings.agent, paths } }).catch(() => {});
  };

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
        {/* On a plate of its own, unlike the table rows: the page is this
            agent's, so the mark is an identity rather than a bullet. No status
            dot either - the verdict pill on this same line already answers. */}
        <span class={styles.detailGlyph}>
          <AgentGlyph id={a().id} label={a().label} size={28} />
        </span>
        {/* Two lines beside the mark, like a letterhead: who this is, then
            where it was found. The path is part of the identity - it says
            *which* claude - so it sits here rather than floating below. */}
        <div class={styles.detailIdentity}>
          <div class={styles.detailTitleRow}>
            <span class={styles.detailTitle}>{a().label}</span>
            <Show when={a().version}>{(v) => <span class={styles.detailVersion}>{v()}</span>}</Show>
          </div>
          <div class={styles.detailProgram}>
            <code>
              {installed() ? (a().path ?? a().program) : "not found on your login shell"}
            </code>
          </div>
        </div>
        <span class={`${styles.statePill} ${verdict().cls}`}>{verdict().label}</span>
        {/* Here as well as in the table, because this is the page a reader
            lands on to install or sign in, and turning the agent on is the
            next thing they want. No words beside it: the switch is the last
            thing on a line that already names the agent and prints its verdict,
            and a caption there would be a third label for one row. */}
        <span class={styles.detailToggle}>
          <Toggle
            checked={agentChosen(a().id)}
            disabled={enableBlockedReason(a().id) !== null && !agentChosen(a().id)}
            aria-label={`Offer ${a().label} in Sway`}
            tooltip={
              enableBlockedReason(a().id) ??
              (agentChosen(a().id) ? "Disable in Sway" : "Enable in Sway")
            }
            onChange={(next) => setAgentEnabled(a().id, next)}
          />
        </span>
      </div>

      {/* Drift is only worth a banner in one direction. A binary *newer* than
          the adapter's measurement is the steady state of every fast-shipping
          vendor and stays quiet - that bookkeeping lives in ADAPTERS.md. A
          binary *older* than it is different in kind: the measured version
          exists, so a newer release provably does, and the banner can offer
          it with the vendor's own update where one is declared. */}
      <Show when={behind()}>
        <div class={styles.detailBanner}>
          <span class={styles.bannerMark}>!</span>
          <div class={styles.bannerBody}>
            <div class={styles.bannerTitle}>Update available</div>
            <div class={styles.bannerText}>
              You are running {a().label} {a().version} and {verifiedVersion(a().verifiedAgainst)}{" "}
              is available.
            </div>
            <Show when={updateCmd()}>
              {(cmd) => (
                <>
                  <CmdLine program={cmd().program} args={cmd().args} />
                  <div class={styles.stepActions}>
                    <Button size="sm" onClick={() => void runVerb("update", cmd())}>
                      Update
                    </Button>
                    <span class={styles.stepActionNote}>Opens a terminal</span>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
      <Show when={installed() && a().status === "versionUnknown" && !a().version}>
        <div class={styles.hint}>It does not report a version, so Sway cannot check it.</div>
      </Show>

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

      <Show when={setupMode()}>
        <div class={styles.groupHead}>
          <span class={styles.groupTitle}>Setup</span>
          <span class={styles.sectionRule} />
          <span class={styles.groupFact}>{installed() ? "1" : "0"} of 3</span>
          {/* For an install or login finished outside Sway: the tabs re-probe
              on exit, but a user's own terminal cannot. */}
          <IconButton
            size="sm"
            icon={<Icon icon={RefreshCw} />}
            tooltip="Check again"
            onClick={() => void props.onRecheck()}
            disabled={props.rechecking}
          />
        </div>
        <div class={styles.setupSteps}>
          {/* Step 1: the binary. */}
          <div class={styles.setupStep} classList={{ [styles.stepDone]: installed() }}>
            <span class={styles.stepBadge}>
              {installed() ? <Icon icon={Check} size={12} /> : "1"}
            </span>
            <div class={styles.stepBody}>
              <div class={styles.stepHead}>
                <span class={styles.stepTitle}>
                  {installed() ? "Installed" : `Install the ${a().program} binary`}
                </span>
                <Show when={installed()}>
                  <span class={styles.stepState}>done</span>
                </Show>
              </div>
              <Switch>
                <Match when={installed()}>
                  <div class={styles.stepMeta}>
                    {a().version ? `${a().program} ${a().version} · ` : ""}
                    {a().path ?? a().program}
                  </div>
                </Match>
                <Match when={installCmd()}>
                  <div class={styles.stepDesc}>
                    Sway opens a terminal and runs the install for you. Come back here when it
                    finishes.
                  </div>
                </Match>
                {/* No [install] table means instructions, never a guessed
                    package manager. */}
                <Match when={installRoute()}>
                  {(route) => (
                    <div class={styles.stepDesc}>{installNote(a().label, a().program, route())}</div>
                  )}
                </Match>
              </Switch>
              <Show when={installCmd()}>
                {(cmd) => <CmdLine program={cmd().program} args={cmd().args} />}
              </Show>
              <Show when={!installed() && installCmd()}>
                <div class={styles.stepActions}>
                  <Button size="sm" onClick={() => void runVerb("install", installCmd())}>
                    Install
                  </Button>
                  <span class={styles.stepActionNote}>Opens a terminal</span>
                </div>
              </Show>
            </div>
          </div>

          {/* Step 2: the login. Inert until there is a binary to run it. */}
          <div class={styles.setupStep} classList={{ [styles.stepInert]: !installed() }}>
            <span class={styles.stepBadge}>2</span>
            <div class={styles.stepBody}>
              <div class={styles.stepHead}>
                <span class={styles.stepTitle}>Sign in</span>
              </div>
              <Switch>
                <Match when={!installed()}>
                  <div class={styles.stepDesc}>Available once the binary is installed.</div>
                </Match>
                <Match when={loginCmd()}>
                  <div class={styles.stepDesc}>
                    A terminal runs the agent's own login. Sway checks again when it closes.
                  </div>
                </Match>
                {/* No login command declared. The ladder's other rungs are
                    sentences, so the step says the sentence. */}
                <Match when={loginRoute()}>
                  {(route) => <div class={styles.stepDesc}>{loginNote(a().label, route())}</div>}
                </Match>
              </Switch>
              <Show when={installed() && loginCmd()}>
                {(cmd) => (
                  <>
                    <CmdLine program={cmd().program} args={cmd().args} />
                    <div class={styles.stepActions}>
                      <Button size="sm" onClick={() => void signIn()}>
                        Sign in
                      </Button>
                      <span class={styles.stepActionNote}>Opens a terminal</span>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>

          {/* Step 3 never renders as done: the page swaps to the accounts view
              the moment the agent is usable, so this is always the horizon. */}
          <div class={`${styles.setupStep} ${styles.stepInert}`}>
            <span class={styles.stepBadge}>3</span>
            <div class={styles.stepBody}>
              <div class={styles.stepHead}>
                <span class={styles.stepTitle}>Ready for chat</span>
              </div>
              <div class={styles.stepDesc}>Sway asks the agent what models it can run.</div>
            </div>
          </div>
        </div>
      </Show>

      {/* Only for an agent that is set up: an account list for a binary that
          is missing or signed out would repeat what the steps above say. It
          renders itself away for an adapter that declares no `[accounts]`. */}
      <Show when={!setupMode()}>
        <AgentAccounts
          agentId={a().id}
          agentLabel={a().label}
          onRecheck={props.onRecheck}
          onAccountsChanged={() => setAccountsChanged((n) => n + 1)}
        />
      </Show>

      {/* Only for an agent Sway can actually ask, and only once it is set up.
          A terminal-only adapter declares no `[chat]` table, so the probe has
          nothing to drive and the backend never returns a row for it. During
          setup the section is dropped whole rather than shown saying
          "unknown": the steps already name asking for models as what happens
          when setup finishes, and a section whose every state is a shrug is
          not information. */}
      <Show when={!setupMode() && findAdapter(a().id).chat}>
        {/* One pane per account once there are two of them. A catalogue is an
            account's answer and not an agent's: two logins of one binary can
            sit on different plans and offer different models, and a single
            list would be whichever of them probed last. */}
        <Show
          when={accounts().length > 1}
          fallback={
            <ModelsPane agentId={a().id} agentLabel={a().label} profile={null} account={null} />
          }
        >
          {/* Keyed, so switching accounts builds a fresh pane: the filter box
              holds a query about the list that was on screen. */}
          <Show when={shownAccount()} keyed>
            {(account) => (
              <ModelsPane
                agentId={a().id}
                agentLabel={a().label}
                profile={asTabProfile(account.id)}
                account={account.label}
                tabs={accounts()}
                onSelect={setModelsAccount}
              />
            )}
          </Show>
        </Show>
      </Show>

      {/* Last of the three account-scoped groups. Everything above it is what
          the agent can *do* for an account; this is what is on disk for one,
          which is the least urgent of the three and the longest. Still below
          the accounts, because every row is resolved against one of them and
          the sub-headings mean nothing until they are on screen. */}
      <Show when={!setupMode()}>
        <AgentFiles
          agentId={a().id}
          agentLabel={a().label}
          projectRoot={props.projectRoot}
          accountsNonce={accountsChanged()}
        />
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

      {/* Its own section rather than a label-and-control row: a path is the
          widest string on the page, and a 196px control column truncated it to
          uselessness. The field gets the full measure, the explanation sits
          under what it explains. */}
      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Binary path</span>
        <span class={styles.sectionRule} />
      </div>
      <input
        type="text"
        class={`${styles.input} ${styles.text} ${styles.pathInput}`}
        aria-label="Binary path"
        value={settings.agent.paths?.[a().id] ?? ""}
        placeholder={installed() ? "found on your login shell" : "nothing found yet"}
        onChange={(e) => savePath(e.currentTarget.value)}
      />
      <div class={styles.hint}>
        Overrides the discovered binary for new chat sessions. Leave empty to use the one found
        above.
      </div>
      <Show when={a().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>
      {/* Only when there is a binary to remove and a declared command to do it
          with: an uninstall section for an agent that is not installed, or with
          no verified command, would be a button that can only guess. Danger
          styling because the tab it opens really removes the binary. */}
      {/* The vendor's update, offered whenever it is declared and there is a
          binary to move - a tool, not an alarm. When the update-available
          banner is up it already carries this command and button, so the
          section yields to it rather than repeating the control. */}
      <Show when={installed() && !behind() && updateCmd()}>
        {(cmd) => (
          <>
            <div class={styles.groupHead}>
              <span class={styles.groupTitle}>Update</span>
              <span class={styles.sectionRule} />
            </div>
            <div class={styles.cardMeta}>
              Opens a terminal running <code>{[cmd().program, ...cmd().args].join(" ")}</code>, the
              vendor's own update.
            </div>
            <div class={styles.cardActions}>
              <Button size="sm" onClick={() => void runVerb("update", cmd())}>
                Update
              </Button>
            </div>
          </>
        )}
      </Show>
      <Show when={installed() && uninstallCmd()}>
        {(cmd) => (
          <>
            <div class={styles.groupHead}>
              <span class={styles.groupTitle}>Uninstall</span>
              <span class={styles.sectionRule} />
            </div>
            <div class={styles.cardMeta}>
              Opens a terminal running <code>{[cmd().program, ...cmd().args].join(" ")}</code>, the
              vendor's own removal. Your sign-in and settings stay wherever the agent keeps them.
            </div>
            <div class={styles.cardActions}>
              <Button size="sm" variant="danger" onClick={() => void runVerb("uninstall", cmd())}>
                Uninstall
              </Button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

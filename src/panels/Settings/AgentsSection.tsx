import { For, Show, Switch, Match, createResource, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ensureAgentsLoaded, findAgent } from "../../utils/agents";
import {
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  unavailableCapabilities,
  type PublishedCapability,
} from "../../utils/chatCapabilities";
import styles from "./Settings.module.css";

// One card per registered adapter, answering the question a new user actually
// has: "which of my agent CLIs does this thing work with?" The backend
// (`agent_health`) resolves each launch binary against the login-shell PATH,
// so an agent installed via nvm/asdf shows as found rather than missing.
//
// Tone matters here: a missing agent is not an error. Nobody has all three
// installed, so an uninstalled one gets an install hint, and an unparseable
// version gets neutral text - never red, never a warning icon.

type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

export type AgentHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  path: string | null;
  version: string | null;
  verifiedAgainst: string | null;
  // Null for an agent whose sessions only its protocol reaches, which is not a
  // broken install: there is no directory to name.
  sessionsDir: string | null;
  sessionsDirExists: boolean;
  hooks: boolean;
  needsYou: boolean;
  overridePath: string | null;
};

// The dot answers one question - is this agent installed and usable? - and
// nothing else. `versionUnknown` is therefore green, not gray: an adapter
// carrying no `verified_against` says nothing about the
// user's install, and dimming two of three healthy agents over Sway's own
// missing bookkeeping reads as "these are worse off" when they are fine.
// Version detail belongs in the status text below, where it can be explained.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  versionDrift: styles.dotWarn,
  notFound: styles.dotOff,
};

// What each published key means, since the value alone is deliberately terse.
// Keyed on the capability's own `key`, so a value changing (a better rewind, a
// re-measured steer) does not orphan its explanation.
const CAPABILITY_NOTES: Record<PublishedCapability["key"], string> = {
  rewind:
    "Puts the files back to a chosen turn and carries the conversation into a fork. The forked agent still remembers the turns you undid.",
  steer: "A message typed during a turn goes into that turn rather than waiting for the next one.",
  approvals:
    "Where a tool call's permission question comes from. In-protocol means the agent asks and Sway shows it, so the agent's own permission modes are the ones in force.",
  diffs: "A tool card can show what a write changed, because Sway records the file just before it is written.",
  budgets: "A spend limit stops the chat at a turn boundary: the running turn finishes, the next one does not start.",
  history:
    "This agent can reopen a conversation it still holds, so a chat closed and reopened replays its earlier turns.",
  sessions: "This agent can list its own sessions, including ones started outside Sway.",
};

function AgentCard(props: { agent: AgentHealth }) {
  const a = () => props.agent;
  // From the resolved adapter rather than from `agent_health`, which answers
  // about the binary on disk and knows nothing about the chat transport. An
  // agent still resolving reports the PTY-only tier, which is the honest
  // answer to "what can it do" before the adapter has been read.
  const tier = () => chatTier(findAgent(a().id).chat?.transport);
  const capabilities = () => publishedCapabilities(tier());
  // Only for an agent that has a chat surface at all. A PTY-only adapter's
  // absences are one fact, which the fallback line below states once.
  const missing = () => (capabilities().length ? unavailableCapabilities(tier()) : []);
  return (
    <div class={styles.card}>
      <div class={styles.cardHead}>
        <span class={`${styles.dot} ${TONE[a().status]}`} />
        <span class={styles.cardTitle}>{a().label}</span>
        <code class={styles.cardProgram}>{a().program}</code>
      </div>

      <div class={styles.cardStatus}>
        <Switch>
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code> and reopen Sway to pick it up.
          </Match>
          <Match when={a().status === "versionMatch"}>Installed, version {a().version}.</Match>
          {/* Installed, but **this adapter** was never measured against it: the
              adapter declares no `verified_against` at all. Said plainly rather
              than folded into "version not reported", which is about the CLI
              being quiet and would read as supported. An ACP adapter is mostly
              launch instructions, which is what makes shipping one unmeasured
              reasonable - but not what makes it tested. */}
          <Match when={a().status === "versionUnknown" && a().version && !a().verifiedAgainst}>
            Installed, version {a().version}. Untested: nobody has measured Sway against this
            agent, so treat it as a starting point rather than a supported harness.
          </Match>
          {/* Unknown covers two different situations, and saying "version not
              reported" for an agent that plainly reported one reads as a bug.
              Split on what we actually have. */}
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
      </div>

      <div class={styles.cardMeta}>
        <Switch>
          {/* No directory at all, because this agent keeps its sessions
              somewhere only its protocol reaches. Naming a path that will never
              exist would read as a misconfiguration rather than as a design. */}
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

      {/* What the chat surface can actually do with this agent, beside the
          probes rather than on a page of its own: "is it installed" and "how
          much of Sway works with it" are the same question asked twice.

          Each entry publishes the *qualified* value, never the bare feature
          name. A chip reading "rewind" would promise the unqualified capability
          when what shipped is a fork the agent still remembers. */}
      <div class={styles.cardMeta}>
        <Show
          when={capabilities().length}
          fallback={<>Terminal only. Sway has no chat transport for this agent.</>}
        >
          Chat:{" "}
          <For each={capabilities()}>
            {(cap, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <code title={CAPABILITY_NOTES[cap.key]}>{cap.label}</code>
              </>
            )}
          </For>
        </Show>
      </div>
      {/* What it cannot do, and why - separate from the list above, which is a
          promise. An affordance is omitted from that list rather than published
          as `none`, and omission alone would leave a user with a control that
          is simply not there and nothing to read about it. */}
      <Show when={missing().length}>
        <div class={styles.cardMeta}>
          Not available:{" "}
          <For each={missing()}>
            {(gap, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <code>{gap.key}</code>
              </>
            )}
          </For>
        </div>
        {/* The reasons in full, visible rather than behind hover text: they are
            the answer to "why is this control missing", and a tooltip on a
            terse key would make finding it the user's problem. */}
        <ul class={styles.hint}>
          <For each={missing()}>{(gap) => <li>{gap.why}</li>}</For>
        </ul>
      </Show>
      <Show when={steerCostDetail(tier())}>
        {(detail) => <div class={styles.hint}>{detail()}</div>}
      </Show>

      <Show when={a().overridePath}>
        {(path) => <div class={styles.hint}>Overridden by {path()}</div>}
      </Show>
    </div>
  );
}

/** One agent the ACP Registry describes, which Sway can start but has not run. */
type CatalogRow = {
  id: string;
  label: string;
  description: string;
  registryVersion: string | null;
  website: string | null;
  command: string;
  needs: "npx" | "uvx" | "on-path";
  /** The adapter that already covers this agent, when one does. */
  coveredBy: string | null;
};

type CatalogSource = {
  source: string;
  registryCommit: string;
  generatedOn: string | null;
};

const NEEDS_NOTE: Record<CatalogRow["needs"], string> = {
  npx: "runs straight from npm, no install step",
  uvx: "runs straight from PyPI with uv, no install step",
  "on-path": "if you have installed it yourself",
};

/**
 * Everything else that speaks this protocol.
 *
 * Kept visibly apart from the cards above, because the two lists make different
 * promises. A card is a harness Sway measured; a row here is a launch command
 * read off the registry and **run by nobody**. Conflating them is exactly how a
 * listing ends up promising what nobody tested, so these rows get no status dot,
 * no capability list and no version of Sway's own - and they are not offered
 * anywhere a chat can be started from, since starting one means writing the
 * adapter that makes it a measured harness.
 */
function CatalogList() {
  const [rows] = createResource(() => invoke<CatalogRow[]>("acp_catalog"));
  const [source] = createResource(() => invoke<CatalogSource>("acp_catalog_source"));
  // The ones Sway already ships an adapter for are dropped rather than shown as
  // duplicates: a second, unmeasured way to start an agent the user already has
  // properly is a downgrade dressed as a choice.
  const untested = () => (rows() ?? []).filter((r) => !r.coveredBy);

  return (
    <Show when={untested().length}>
      <div class={styles.sectionTitle}>Other agents that speak ACP</div>
      <div class={styles.hint}>
        Sway can drive any of these over the same protocol as OpenCode, but has run none of them,
        so none is a supported harness. Add one by dropping a four-line TOML into{" "}
        <code>~/.config/sway/agents/</code> with its command below (see ADAPTERS.md), and it becomes
        an agent you have tested.
      </div>
      <ul class={styles.hint}>
        <For each={untested()}>
          {(row) => (
            <li>
              <strong>{row.label}</strong> · untested · <code>{row.command}</code>{" "}
              <span>({NEEDS_NOTE[row.needs]})</span>
              <Show when={row.description}>
                <div>{row.description}</div>
              </Show>
            </li>
          )}
        </For>
      </ul>
      {/* Provenance, so the list cannot rot silently: where it came from, which
          upstream commit, and when. `node dev/acp-catalog.mjs --check` says
          whether the registry has moved since. */}
      <Show when={source()}>
        {(src) => (
          <div class={styles.hint}>
            From the ACP Registry ({src().source}) at commit{" "}
            <code>{src().registryCommit.slice(0, 8)}</code>
            <Show when={src().generatedOn}>{(on) => <>, {on()}</>}</Show>. Refresh with{" "}
            <code>node dev/acp-catalog.mjs</code>.
          </div>
        )}
      </Show>
    </Show>
  );
}

export default function AgentsSection() {
  const [health] = createResource(() => invoke<AgentHealth[]>("agent_health"));
  // The tier is read off the resolved adapter, which the sidebar usually has
  // already asked for. Asking again is a no-op after the first call, and it is
  // what makes this section correct when Settings is the first thing opened.
  onMount(() => ensureAgentsLoaded());

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>Agents</div>
      <Switch>
        <Match when={health.loading}>
          <div class={styles.hint}>Checking which agent CLIs are installed…</div>
        </Match>
        <Match when={health.error}>
          <div class={styles.hint}>Could not check agent CLIs: {String(health.error)}</div>
        </Match>
        <Match when={health()}>
          <For each={health()}>{(agent) => <AgentCard agent={agent} />}</For>
        </Match>
      </Switch>
      <CatalogList />
    </section>
  );
}

import { For, Show, Switch, Match, createResource, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../components/Button/Button";
import { ensureAgentsLoaded, findAgent } from "../../utils/agents";
import {
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  unavailableCapabilities,
  type PublishedCapability,
} from "../../utils/chatCapabilities";
import {
  ensureAgentHealthLoaded,
  refreshAgentHealth,
  type AgentHealth,
  type BinaryStatus,
} from "../../utils/agentHealth";
import AgentAccounts from "./AgentAccounts";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import { TOAST, emitWith, type ToastEvent } from "../../utils/events";
import styles from "./Settings.module.css";
import Checkbox from "../../components/Checkbox/Checkbox";

// One card per registered adapter, answering the question a new user actually
// has: "which of my agent CLIs does this thing work with?" The backend
// (`agent_health`) resolves each launch binary against the login-shell PATH,
// so an agent installed via nvm/asdf shows as found rather than missing.
//
// Tone matters here: a missing agent is not an error. Nobody has all three
// installed, so an uninstalled one gets an install hint, and an unparseable
// version gets neutral text - never red, never a warning icon.

// Moved to utils/agentHealth so the chat picker reads the same answer these
// cards render. Re-exported because the section's tests import it from here.
export type { AgentHealth } from "../../utils/agentHealth";

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

function AgentCard(props: {
  agent: AgentHealth;
  onRecheck: () => Promise<unknown>;
  rechecking: boolean;
}) {
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
          {/* "Reopen Sway" was true while the sweep was memoized for the app's
              lifetime. It is not any more: the health cache is invalidatable,
              so the honest instruction is to install and press the button
              below. */}
          <Match when={a().status === "notFound"}>
            Not installed. Install <code>{a().program}</code>, then check again.
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
        {/* The third state Phase 1 could not render, because nothing produced
            it yet: installed and signed-out are two independent facts, and this
            one is the harness's own answer rather than Sway's inference. Said
            in its own sentence rather than folded into the line above, which is
            about the binary. */}
        <Show when={a().status !== "notFound" && a().signIn === "signedOut"}>
          {" "}
          Nobody is signed in, so it is not offered for a new session.
        </Show>
        <Show when={a().signIn === "signedIn" && a().account}>
          {(account) => <> Signed in as {account()}.</>}
        </Show>
      </div>
      {/* The harness's own statement about which credential it will bill
          against, not Sway reading its environment and guessing which variables
          matter to which agent. Never a block: the session still runs. */}
      <Show when={a().apiKeySource}>
        {(source) => (
          <div class={styles.hint}>
            <code>{source()}</code> is set in this environment, so {a().label} bills against that
            API key rather than the subscription it is signed in with.
          </div>
        )}
      </Show>

      {/* One primary action per non-ready state, so none of them is a dead
          entry the user can only read. Both actions are the same button
          because both states are resolved the same way: change something
          outside Sway, then have Sway look again. Drift keeps it because
          updating the CLI is the fix, and drift is a notice rather than a
          gate: the harness still starts either way.

          Not-installed does not offer to *do* the install. Phase 5 owns
          fetching from the registry, and a button that installed nothing
          would be the dead entry this is meant to remove. */}
      <Show when={a().status === "notFound" || a().status === "versionDrift"}>
        <div class={styles.cardActions}>
          <Button size="sm" onClick={() => void props.onRecheck()} disabled={props.rechecking}>
            {props.rechecking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </Show>

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

      {/* Below everything else, and only for an installed harness: an account
          list for a binary that is not there would be a set of controls with
          nothing behind them. It renders itself away for an adapter that
          declares no `[accounts]` table. */}
      <Show when={a().status !== "notFound"}>
        <AgentAccounts agentId={a().id} agentLabel={a().label} />
      </Show>
    </div>
  );
}

/** One platform's download, mirroring `crate::catalog::Build`. */
type Build = {
  archive: string;
  /** Null when the publisher supplies none, which is over half of them. */
  sha256: string | null;
  cmd: string;
  args: string[];
  env: Record<string, string>;
};

/** One agent the ACP Registry describes, which Sway can start but has not run. */
type CatalogRow = {
  id: string;
  label: string;
  description: string;
  registryVersion: string | null;
  website: string | null;
  command: string;
  needs: "npx" | "uvx" | "install" | "on-path";
  /** The adapter that already covers this agent, when one does. */
  coveredBy: string | null;
  /** What installing this would fetch on this machine. */
  build: Build | null;
  /** The agent ships binaries, but none for this machine's architecture. */
  noBuildHere: boolean;
  /** The **registry's** own probe. Never a tier of Sway's; see `chatCapabilities`. */
  publishedCapabilities: Record<string, unknown> | null;
};

type CatalogSource = {
  source: string;
  registryCommit: string;
  generatedOn: string | null;
  matrixSource: { source: string; probedOn: string | null; agentsProbed: number } | null;
  hostPlatform: string | null;
};

/** Mirrors `crate::install::Installed`. */
type Installed = {
  id: string;
  registryVersion: string | null;
  platform: string;
  archive: string;
  sha256: string | null;
  program: string;
  args: string[];
  env: Record<string, string>;
  quarantineCleared: boolean;
  installedAt: number;
};

const NEEDS_NOTE: Record<CatalogRow["needs"], string> = {
  npx: "runs straight from npm, no install step",
  uvx: "runs straight from PyPI with uv, no install step",
  install: "Sway can download this one",
  "on-path": "if you have installed it yourself",
};

function toast(message: string, kind: ToastEvent["kind"]) {
  emitWith<ToastEvent>(TOAST, { message, kind });
}

/** Whole days since the snapshot's date, or null when there is no date. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * The sentence a user agrees to before Sway downloads anything.
 *
 * Written here rather than in the backend because it has to name *this* row's
 * publisher and *this* row's checksum, and because the two cases genuinely read
 * differently: a checksum that exists bounds tampering in flight, and one that
 * does not bounds nothing at all. Neither claims more than that, since both live
 * in the same file as the URL they describe.
 */
function installConsent(
  row: CatalogRow,
  build: Build,
  onDarwin: boolean,
  clearQuarantine: boolean,
): string {
  const checksum = build.sha256
    ? `The registry publishes a sha256, so Sway checks the download against it. That proves the bytes were not swapped in transit; it cannot prove who published them, because the checksum sits in the same file as the URL.`
    : `The registry publishes no checksum for this download, so there is nothing to check it against.`;
  // Only on macOS, because only macOS has the flag. Saying it elsewhere would be
  // describing a step that does not happen.
  const gatekeeper = !onDarwin
    ? null
    : clearQuarantine
      ? `Sway will clear the macOS quarantine flag, which is the check that would otherwise stop an unnotarized binary from running.`
      : `Sway will leave the macOS quarantine flag on, so macOS may refuse to run it until you clear it yourself.`;
  return [
    `Sway will download ${build.archive} and unpack it into its own directory. Nothing goes on your PATH.`,
    checksum,
    gatekeeper,
    `Installing ${row.label} is trusting the ACP Registry. Sway has run none of these agents, and installing one does not change that.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

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
function CatalogRowItem(props: {
  row: CatalogRow;
  installed: Installed | undefined;
  hostPlatform: string | null;
  onChanged: () => void;
  confirm: (title: string, message: string, label: string) => Promise<boolean>;
}) {
  const row = () => props.row;
  const [busy, setBusy] = createSignal(false);
  // Off by default. The flag is macOS refusing to run something it did not see
  // notarized, and turning that off is the user's call to make deliberately
  // rather than a default they never noticed.
  const [clearQuarantine, setClearQuarantine] = createSignal(false);
  const onDarwin = () => props.hostPlatform?.startsWith("darwin") ?? false;

  const install = async (build: Build) => {
    const ok = await props.confirm(
      `Install ${row().label} from the ACP Registry?`,
      installConsent(row(), build, onDarwin(), clearQuarantine()),
      "Download and install",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await invoke<Installed>("install_agent", {
        id: row().id,
        allowQuarantineBypass: clearQuarantine(),
      });
      props.onChanged();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await invoke("remove_installed_agent", { id: row().id });
      props.onChanged();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      {/* "untested" stays on the row whether or not it is installed. Downloading
          a binary is not measuring one, and the label is the whole reason this
          list is separate from the cards above. */}
      <strong>{row().label}</strong> · untested · <code>{row().command}</code>{" "}
      <span>({NEEDS_NOTE[row().needs]})</span>
      <Show when={row().description}>
        <div>{row().description}</div>
      </Show>
      {/* An architecture with no build says so, rather than disappearing or
          offering a download for somebody else's machine. */}
      <Show when={row().noBuildHere}>
        <div>
          No build for {props.hostPlatform ?? "this machine"}, so there is nothing to install here.
        </div>
      </Show>
      <Show when={props.installed}>
        {(it) => (
          <div>
            Installed at <code>{it().program}</code>.{" "}
            {it().sha256
              ? "Verified against the registry's sha256."
              : "The registry published no checksum, so this download was never verified."}{" "}
            Sway has still run nothing: add an adapter TOML naming that path to use it.
          </div>
        )}
      </Show>
      <Show when={!props.installed && row().build}>
        {(build) => (
          <div class={styles.cardActions}>
            <Button size="sm" onClick={() => void install(build())} disabled={busy()}>
              Install
            </Button>
            {/* Only where the flag exists. A control that provably does nothing
                is worse than no control: it reads as a choice being made. */}
            <Show when={onDarwin()}>
              <Checkbox
                checked={clearQuarantine()}
                onChange={setClearQuarantine}
                label="Clear the macOS quarantine flag, so Gatekeeper does not check it"
              />
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.installed}>
        <div class={styles.cardActions}>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy()}>
            Remove
          </Button>
        </div>
      </Show>
    </li>
  );
}

function CatalogList() {
  const [rows, { refetch: refetchRows }] = createResource(() =>
    invoke<CatalogRow[]>("acp_catalog"),
  );
  const [source] = createResource(() => invoke<CatalogSource>("acp_catalog_source"));
  const [installed, { refetch: refetchInstalled }] = createResource(() =>
    invoke<Installed[]>("installed_agents"),
  );
  // The ones Sway already ships an adapter for are dropped rather than shown as
  // duplicates: a second, unmeasured way to start an agent the user already has
  // properly is a downgrade dressed as a choice.
  const untested = () => (rows() ?? []).filter((r) => !r.coveredBy);
  const installedFor = (id: string) => (installed() ?? []).find((i) => i.id === id);

  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const askConfirm = (title: string, message: string, confirmLabel: string) =>
    new Promise<boolean>((resolve) => setConfirmReq({ title, message, confirmLabel, resolve }));
  const resolveConfirm = (v: boolean) => {
    const req = confirmReq();
    setConfirmReq(null);
    req?.resolve(v);
  };

  const changed = () => {
    void refetchInstalled();
    void refetchRows();
  };

  const age = () => daysSince(source()?.generatedOn ?? null);

  return (
    <Show when={untested().length}>
      <div class={styles.sectionTitle}>Other agents that speak ACP</div>
      <div class={styles.hint}>
        Sway can drive any of these over the same protocol as OpenCode, but has run none of them,
        so none is a supported harness. Add one by dropping a four-line TOML into{" "}
        <code>~/.config/sway/agents/</code> with its command below (see ADAPTERS.md), and it becomes
        an agent you have tested. Installing one downloads a binary and nothing more: it stays
        untested, and it goes nowhere near your PATH.
      </div>
      <ul class={styles.hint}>
        <For each={untested()}>
          {(row) => (
            <CatalogRowItem
              row={row}
              installed={installedFor(row.id)}
              hostPlatform={source()?.hostPlatform ?? null}
              onChanged={changed}
              confirm={askConfirm}
            />
          )}
        </For>
      </ul>
      {/* Provenance, so the list cannot rot silently: where it came from, which
          upstream commit, when, and how old that makes it. The list is a pinned
          snapshot rather than a fetch on open, so it renders offline, and the age
          is what keeps "pinned" from reading as "current". */}
      <Show when={source()}>
        {(src) => (
          <div class={styles.hint}>
            From the ACP Registry ({src().source}) at commit{" "}
            <code>{src().registryCommit.slice(0, 8)}</code>
            <Show when={src().generatedOn}>{(on) => <>, {on()}</>}</Show>
            <Show when={age() != null}>
              {" "}
              ({age() === 0 ? "today" : age() === 1 ? "1 day old" : `${age()} days old`})
            </Show>
            . Refresh with <code>node dev/acp-catalog.mjs</code>.
            {/* Whose measurement the capabilities are, said beside them. A tier
                is Sway's own and lives on the cards above; this is somebody
                else's probe on a date, and the two never merge. */}
            <Show when={src().matrixSource}>
              {(m) => (
                <>
                  {" "}
                  Any capabilities shown come from the registry's own probe of{" "}
                  {m().agentsProbed} agents
                  <Show when={m().probedOn}>{(on) => <> on {on()}</>}</Show>, not from anything Sway
                  measured.
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={confirmReq()}>
        {(req) => (
          <ConfirmDialog
            title={req().title}
            message={req().message}
            confirmLabel={req().confirmLabel}
            onConfirm={() => resolveConfirm(true)}
            onCancel={() => resolveConfirm(false)}
          />
        )}
      </Show>
    </Show>
  );
}

export default function AgentsSection() {
  const [health, { refetch }] = createResource(() => invoke<AgentHealth[]>("agent_health"));
  const [rechecking, setRechecking] = createSignal(false);
  /** Re-probe now. Goes through the shared store as well as this resource so
   *  the chat picker and these cards cannot end up disagreeing about what is
   *  installed. The second call is a cache hit. */
  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshAgentHealth();
      await refetch();
    } finally {
      setRechecking(false);
    }
  };
  // The tier is read off the resolved adapter, which the sidebar usually has
  // already asked for. Asking again is a no-op after the first call, and it is
  // what makes this section correct when Settings is the first thing opened.
  onMount(() => {
    ensureAgentsLoaded();
    // Populate the shared store too, not just this resource. Otherwise the
    // claim above ("the picker reads the same answer") only becomes true after
    // a re-check, and until then the picker is running on "unknown".
    ensureAgentHealthLoaded();
  });

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
          <For each={health()}>
            {(agent) => (
              <AgentCard agent={agent} onRecheck={recheck} rechecking={rechecking()} />
            )}
          </For>
        </Match>
      </Switch>
      <CatalogList />
    </section>
  );
}

import { For, Show, Switch, Match, createMemo, createResource, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import { ensureAgentsLoaded } from "../../../../utils/agents";
import {
  catalogFor,
  distinctModelCount,
  dueCount,
  ensureModelCatalogsLoaded,
  isProbing,
  refreshDueCatalogs,
} from "../../../../utils/modelCatalog";
import {
  ensureAgentHealthLoaded,
  refreshAgentHealth,
  type AgentHealth,
  type BinaryStatus,
} from "../../../../utils/agentHealth";
import HarnessDetail from "./HarnessDetail";
import ConfirmDialog, { type ConfirmReq } from "../../../../components/Dialogs/ConfirmDialog";
import { TOAST, emitWith, type ToastEvent } from "../../../../utils/events";
import styles from "../../Settings.module.css";
import Checkbox from "../../../../components/Checkbox/Checkbox";

// One row per registered adapter, grouped by whether the binary is on this
// machine, and each one opening a page of its own. The backend (`agent_health`)
// resolves each launch binary against the login-shell PATH, so an agent
// installed via nvm/asdf shows as found rather than missing.
//
// Tone matters here: a missing agent is not an error. Nobody has all four
// installed, so an uninstalled one gets an install hint, and an unparseable
// version gets neutral text - never red, never a warning icon.

// Moved to utils/agentHealth so the chat picker reads the same answer these
// cards render. Re-exported because the section's tests import it from here.
export type { AgentHealth } from "../../../../utils/agentHealth";

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

/** The same four states as a word, and in the same three tones as the dot.
 *  "Ready" covers both healthy statuses for the reason above: a CLI that does
 *  not report a version is not a worse install, only a quieter one. */
const STATE_LABEL: Record<BinaryStatus, string> = {
  versionMatch: "Ready",
  versionUnknown: "Ready",
  versionDrift: "Version drift",
  notFound: "Not installed",
};

const STATE_PILL: Record<BinaryStatus, string> = {
  versionMatch: styles.statePillOk,
  versionUnknown: styles.statePillOk,
  versionDrift: styles.statePillWarn,
  notFound: "",
};

/**
 * One harness at a glance: is it here, which build, and who is signed in.
 *
 * A button rather than a div with a handler, so it is reachable and announced
 * without inventing a role. Everything it used to carry (capabilities, gaps,
 * accounts, the sessions directory) moved to `HarnessDetail`, which is what
 * lets four of these be read in one look.
 */
function HarnessCard(props: { agent: AgentHealth; onOpen: () => void }) {
  const a = () => props.agent;
  const catalog = () => catalogFor(a().id);
  // The pill is for the states that need acting on. Painting "READY" on every
  // healthy card spends the reader's attention on the answer they expected.
  const settled = () => a().status === "versionMatch" || a().status === "versionUnknown";
  return (
    <button
      type="button"
      class={styles.hcard}
      data-harness={a().id}
      onClick={() => props.onOpen()}
    >
      <span class={`${styles.dot} ${TONE[a().status]}`} />
      <span class={styles.hcardName}>{a().label}</span>
      <Show when={a().version}>{(v) => <span class={styles.hcardVersion}>{v()}</span>}</Show>
      <Show when={!settled()}>
        <span class={`${styles.statePill} ${STATE_PILL[a().status]}`}>
          {STATE_LABEL[a().status]}
        </span>
      </Show>
      {/* One line, and the fact it carries differs by group: an installed
          harness is asked who it is signed in as, a missing one what it would
          take to get it. Neither question is interesting for the other. */}
      <span class={styles.hcardMeta}>
        <Switch>
          <Match when={a().status === "notFound"}>
            Install <code>{a().program}</code> to use it
          </Match>
          <Match when={a().apiKeySource}>
            {(source) => <>Billing against {source()}</>}
          </Match>
          <Match when={a().signIn === "signedOut"}>Signed out</Match>
          <Match when={a().account}>{(account) => <>Signed in as {account()}</>}</Match>
          <Match when={a().signIn === "signedIn"}>Signed in</Match>
          <Match when={true}>
            <code>{a().program}</code>
          </Match>
        </Switch>
        {/* The count is a claim about what the installed binary can run, so it
            comes from the probe cache and nowhere else. Three states, and the
            first is why the count is not simply a number: a harness nobody has
            asked shows *nothing* here, because "0 models" would read as a broken
            install rather than as an unasked question. */}
        <Switch>
          <Match when={isProbing(a().id)}>
            <span class={styles.hcardModels}>· checking…</span>
          </Match>
          <Match when={catalog()?.state === "failed" && !catalog()?.catalogue}>
            <span class={`${styles.hcardModels} ${styles.hcardModelsBad}`}>· Error</span>
          </Match>
          {/* A failed probe that still has an older answer shows the answer, not
              the error: stale-but-real beats fresh-but-empty, and the detail page
              is where the failure is explained. */}
          <Match when={catalog()?.catalogue}>
            <span class={styles.hcardModels}>
              · {distinctModelCount(catalog())} model{distinctModelCount(catalog()) === 1 ? "" : "s"}
            </span>
          </Match>
        </Switch>
      </span>
      <span class={styles.hcardGo} aria-hidden="true">
        <Icon icon={ChevronRight} size={14} />
      </span>
    </button>
  );
}

/** Installed first, then the rest, alphabetical inside each so the order does
 *  not shuffle when a re-check changes one harness's state. */
function byLabel(list: AgentHealth[]) {
  return [...list].sort((x, y) => x.label.localeCompare(y.label));
}

function HarnessGroup(props: { heading: string; agents: AgentHealth[]; onOpen: (id: string) => void }) {
  return (
    <Show when={props.agents.length}>
      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>{props.heading}</span>
        <span class={styles.sectionRule} />
        <span class={styles.groupCount}>{props.agents.length}</span>
      </div>
      <div class={styles.cardGrid}>
        <For each={props.agents}>
          {(agent) => <HarnessCard agent={agent} onOpen={() => props.onOpen(agent.id)} />}
        </For>
      </div>
    </Show>
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

/** The three ways to narrow the catalogue, named after what they cost you
 *  rather than after the packaging: what Sway can fetch, and what runs from a
 *  package registry without anything being installed at all. */
type CatalogFilter = "All" | "Downloadable" | "No install step";

const CATALOG_FILTERS: CatalogFilter[] = ["All", "Downloadable", "No install step"];

const MATCHES_FILTER: Record<CatalogFilter, (r: CatalogRow) => boolean> = {
  All: () => true,
  // The build for *this* machine, not the fact that the agent publishes some
  // binary: a row offering a download that cannot run here is the case
  // `noBuildHere` exists to say out loud.
  Downloadable: (r) => r.build !== null,
  "No install step": (r) => r.needs === "npx" || r.needs === "uvx",
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
  clearQuarantine: boolean;
  onChanged: () => void;
  confirm: (title: string, message: string, label: string) => Promise<boolean>;
}) {
  const row = () => props.row;
  const [busy, setBusy] = createSignal(false);
  const onDarwin = () => props.hostPlatform?.startsWith("darwin") ?? false;

  const install = async (build: Build) => {
    const ok = await props.confirm(
      `Install ${row().label} from the ACP Registry?`,
      installConsent(row(), build, onDarwin(), props.clearQuarantine),
      "Download and install",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await invoke<Installed>("install_agent", {
        id: row().id,
        allowQuarantineBypass: props.clearQuarantine,
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
    <li class={styles.catalogRow}>
      <div class={styles.catalogMain}>
        <div class={styles.catalogName}>
          {row().label}
          {/* "untested" stays on the row whether or not it is installed.
              Downloading a binary is not measuring one, and the label is the
              whole reason this list is separate from the cards above. */}
          <span class={styles.catalogTag}>untested · {NEEDS_NOTE[row().needs]}</span>
        </div>
        {/* One line each, clipped rather than wrapped: an upstream description
            and a launch command are unbounded strings, and 31 rows of wrapped
            prose is the wall this list exists to replace. */}
        <Show when={row().description}>
          <div class={styles.catalogDesc}>{row().description}</div>
        </Show>
        <div class={styles.catalogCmd}>{row().command}</div>
        {/* An architecture with no build says so, rather than disappearing or
            offering a download for somebody else's machine. */}
        <Show when={row().noBuildHere}>
          <div class={styles.catalogNote}>
            No build for {props.hostPlatform ?? "this machine"}, so there is nothing to install here.
          </div>
        </Show>
        <Show when={props.installed}>
          {(it) => (
            <div class={styles.catalogNote}>
              Installed at <code>{it().program}</code>.{" "}
              {it().sha256
                ? "Verified against the registry's sha256."
                : "The registry published no checksum, so this download was never verified."}{" "}
              Sway has still run nothing: add an adapter TOML naming that path to use it.
            </div>
          )}
        </Show>
      </div>
      <div class={styles.catalogAction}>
        <Show when={!props.installed && row().build}>
          {(build) => (
            <Button size="sm" onClick={() => void install(build())} disabled={busy()}>
              Install
            </Button>
          )}
        </Show>
        <Show when={props.installed}>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy()}>
            Remove
          </Button>
        </Show>
      </div>
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

  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<CatalogFilter>("All");
  // Off by default. The flag is macOS refusing to run something it did not see
  // notarized, and turning that off is the user's call to make deliberately
  // rather than a default they never noticed. One control rather than one per
  // row: it is a policy about installing, not a fact about an agent, and the
  // consent dialog names the choice again at the moment it is acted on.
  const [clearQuarantine, setClearQuarantine] = createSignal(false);
  const onDarwin = () => source()?.hostPlatform?.startsWith("darwin") ?? false;

  /** Matched over the three strings a reader can actually see, so a row that
   *  answers a query is a row they can then point at. */
  const shownRows = () => {
    const q = query().trim().toLowerCase();
    return untested().filter((r) => {
      if (!MATCHES_FILTER[filter()](r)) return false;
      if (!q) return true;
      return `${r.label} ${r.description} ${r.command}`.toLowerCase().includes(q);
    });
  };

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
      <div class={styles.groupHead}>
        <span class={styles.groupTitle}>Other agents that speak ACP</span>
        <span class={styles.sectionRule} />
        <span class={styles.groupCount}>
          {shownRows().length} of {untested().length}
        </span>
      </div>
      <div class={styles.note}>
        Sway can drive any of these over the same protocol as OpenCode, but has run none of them,
        so none is a supported harness. Add one by dropping a four-line TOML into{" "}
        <code>~/.config/sway/agents/</code> with its command below (see ADAPTERS.md), and it becomes
        an agent you have tested. Installing one downloads a binary and nothing more: it stays
        untested, and it goes nowhere near your PATH.
      </div>
      {/* This list's own filter box, not the panel's: the panel's searches
          settings, and 31 rows that are neither settings nor harnesses would
          have to be excluded from it or explained inside it. */}
      <div class={styles.catalogFilters}>
        <input
          class={styles.input}
          type="search"
          aria-label="Filter agents"
          placeholder={`Filter ${untested().length} agents`}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <For each={CATALOG_FILTERS}>
          {(f) => (
            <button
              type="button"
              class={styles.filterChip}
              classList={{ [styles.filterChipOn]: filter() === f }}
              aria-pressed={filter() === f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          )}
        </For>
      </div>
      {/* Capped and scrolling in place. The catalogue is a snapshot of an
          upstream registry that only grows, and a list that grows the pane it
          sits in makes every setting under it harder to reach for. */}
      <ul class={styles.catalogList}>
        <For each={shownRows()}>
          {(row) => (
            <CatalogRowItem
              row={row}
              installed={installedFor(row.id)}
              hostPlatform={source()?.hostPlatform ?? null}
              clearQuarantine={clearQuarantine()}
              onChanged={changed}
              confirm={askConfirm}
            />
          )}
        </For>
        <Show when={shownRows().length === 0}>
          <li class={styles.catalogEmpty}>
            No agent matches that. Any ACP agent can be added with a four-line TOML in{" "}
            <code>~/.config/sway/agents/</code>, whether or not the registry lists it.
          </li>
        </Show>
      </ul>
      {/* Only where the flag exists. A control that provably does nothing is
          worse than no control: it reads as a choice being made. */}
      <Show when={onDarwin()}>
        <Checkbox
          class={styles.catalogFoot}
          checked={clearQuarantine()}
          onChange={setClearQuarantine}
          label="Clear the macOS quarantine flag, so Gatekeeper does not check it"
        />
      </Show>
      {/* Provenance, so the list cannot rot silently: where it came from, which
          upstream commit, when, and how old that makes it. The list is a pinned
          snapshot rather than a fetch on open, so it renders offline, and the age
          is what keeps "pinned" from reading as "current". */}
      <Show when={source()}>
        {(src) => (
          <div class={styles.catalogFoot}>
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
  const [checkingAll, setCheckingAll] = createSignal(false);
  const [openId, setOpenId] = createSignal<string | null>(null);

  // Guarded rather than defaulted: `agent_health` is an IPC call, and a reply
  // that is not a list must empty the groups rather than throw through them.
  const all = () => {
    const h = health();
    return Array.isArray(h) ? h : [];
  };
  const installed = createMemo(() => byLabel(all().filter((a) => a.status !== "notFound")));
  const supported = createMemo(() => byLabel(all().filter((a) => a.status === "notFound")));
  const opened = createMemo(() => all().find((a) => a.id === openId()));

  /** Back to the card that opened the page, not to the top of the list: a
   *  keyboard user who drilled in has to land where they left. */
  const close = () => {
    const id = openId();
    setOpenId(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`[data-harness="${id}"]`)?.focus(),
    );
  };

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
    // The cache, never a probe. `model_catalogs` reads files; opening Settings
    // must not launch every agent binary on the machine, which is why the read
    // and the refreshes are separate commands at all.
    ensureModelCatalogsLoaded();
  });

  /** Ask every harness that has never answered or whose binary changed.
   *
   *  Deliberate rather than automatic: this spawns one process per due harness,
   *  and a settings page that did it on open would be doing exactly what the
   *  read/probe split exists to prevent. */
  const checkAll = async () => {
    setCheckingAll(true);
    try {
      await refreshDueCatalogs();
    } finally {
      setCheckingAll(false);
    }
  };

  return (
    <section class={styles.section}>
      <Show
        when={opened()}
        fallback={
          <>
            <div class={styles.sectionTitle}>
              <span>Harnesses</span>
              <span class={styles.sectionRule} />
              {/* Disabled when nothing is due, rather than doing nothing:
                  `refreshDueCatalogs` skips every harness with a current
                  answer, so on a settled machine this would flash and stop. */}
              <Button
                size="sm"
                onClick={() => void checkAll()}
                disabled={checkingAll() || dueCount() === 0}
              >
                {checkingAll() ? "Asking…" : "Check models"}
              </Button>
            </div>
            <Switch>
              <Match when={health.loading}>
                <div class={styles.note}>Checking which agent CLIs are installed…</div>
              </Match>
              <Match when={health.error}>
                <div class={styles.note}>Could not check agent CLIs: {String(health.error)}</div>
              </Match>
              <Match when={health()}>
                {/* Split on the one question a reader arrives with. A harness
                    Sway supports but this machine does not have is not a
                    failure, so it gets a group rather than a warning. */}
                <HarnessGroup heading="Installed" agents={installed()} onOpen={setOpenId} />
                <HarnessGroup heading="Supported" agents={supported()} onOpen={setOpenId} />
              </Match>
            </Switch>
            <CatalogList />
          </>
        }
      >
        {(agent) => (
          <HarnessDetail
            agent={agent()}
            tone={TONE}
            stateLabel={STATE_LABEL}
            statePill={STATE_PILL}
            onBack={close}
            onRecheck={recheck}
            rechecking={rechecking()}
          />
        )}
      </Show>
    </section>
  );
}

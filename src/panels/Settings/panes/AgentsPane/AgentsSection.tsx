import { For, Show, Switch, Match, createMemo, createResource, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-solid";
import Icon from "../../../../components/Icon/Icon";
import AgentGlyph from "../../../../components/Icon/AgentGlyph";
import { ensureAdaptersLoaded } from "../../../../utils/agents";
import {
  catalogFor,
  distinctModelCount,
  // dueCount and refreshDueCatalogs are parked with `checkAll` below.
  ensureModelCatalogsLoaded,
  isProbing,
} from "../../../../utils/modelCatalog";
import {
  ensureAgentHealthLoaded,
  refreshAgentHealth,
  type AgentHealth,
  type BinaryStatus,
} from "../../../../utils/agentHealth";
import AgentDetail from "./AgentDetail";
import styles from "../../Settings.module.css";

// One flat list, one card per bundled agent, each opening a page of its own.
// The backend (`agent_health`, which keeps the ecosystem's word on the wire)
// resolves each launch binary against the login-shell PATH, so an agent
// installed via nvm/asdf shows as found rather than missing.
//
// Installed agents sort first and each half is alphabetical, so the order
// answers the reader's first question without shuffling every time a re-check
// changes one agent's state. No group headings: seven cards fit in one look,
// and the dot plus the "Not installed" pill already draw the line a heading
// would restate.
//
// Tone matters here: a missing agent is not an error. Nobody has all seven
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
 * One agent at a glance: is it here, which build, and who is signed in.
 *
 * A button rather than a div with a handler, so it is reachable and announced
 * without inventing a role. Everything it used to carry (capabilities, gaps,
 * accounts, the sessions directory) moved to `AgentDetail`, which is what
 * lets four of these be read in one look.
 */
function AgentCard(props: { agent: AgentHealth; onOpen: () => void }) {
  const a = () => props.agent;
  const catalog = () => catalogFor(a().id);
  // The pill is for the states that need acting on. Painting "READY" on every
  // healthy card spends the reader's attention on the answer they expected.
  const settled = () => a().status === "versionMatch" || a().status === "versionUnknown";
  return (
    <button
      type="button"
      class={styles.hcard}
      data-agent={a().id}
      onClick={() => props.onOpen()}
    >
      {/* The logo takes the leading slot the bare dot used to hold, and the
          dot rides its corner: the mark says which agent, the dot says whether
          it is usable, and stacking them keeps both without spending two
          columns on one subject. */}
      <span class={styles.hcardGlyph}>
        <AgentGlyph id={a().id} label={a().label} size={22} />
        <span class={`${styles.dot} ${TONE[a().status]}`} />
      </span>
      <span class={styles.hcardName}>{a().label}</span>
      <Show when={a().version}>{(v) => <span class={styles.hcardVersion}>{v()}</span>}</Show>
      <Show when={!settled()}>
        <span class={`${styles.statePill} ${STATE_PILL[a().status]}`}>
          {STATE_LABEL[a().status]}
        </span>
      </Show>
      {/* One line, and the fact it carries differs by group: an installed
          agent is asked who it is signed in as, a missing one what it would
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
            first is why the count is not simply a number: a agent nobody has
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

/** Alphabetical by label. The installed-first split lives at the call site, so
 *  this stays a pure sort both halves share. */
function byLabel(list: AgentHealth[]) {
  return [...list].sort((x, y) => x.label.localeCompare(y.label));
}

export default function AgentsSection() {
  const [health, { refetch }] = createResource(() => invoke<AgentHealth[]>("agent_health"));
  const [rechecking, setRechecking] = createSignal(false);
  // const [checkingAll, setCheckingAll] = createSignal(false);
  const [openId, setOpenId] = createSignal<string | null>(null);

  // Guarded rather than defaulted: `agent_health` is an IPC call, and a reply
  // that is not a list must empty the list rather than throw through it.
  const all = () => {
    const h = health();
    return Array.isArray(h) ? h : [];
  };
  const ordered = createMemo(() => [
    ...byLabel(all().filter((a) => a.status !== "notFound")),
    ...byLabel(all().filter((a) => a.status === "notFound")),
  ]);
  const opened = createMemo(() => all().find((a) => a.id === openId()));

  /** Back to the card that opened the page, not to the top of the list: a
   *  keyboard user who drilled in has to land where they left. */
  const close = () => {
    const id = openId();
    setOpenId(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`[data-agent="${id}"]`)?.focus(),
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
    ensureAdaptersLoaded();
    // Populate the shared store too, not just this resource. Otherwise the
    // claim above ("the picker reads the same answer") only becomes true after
    // a re-check, and until then the picker is running on "unknown".
    ensureAgentHealthLoaded();
    // The cache, never a probe. `model_catalogs` reads files; opening Settings
    // must not launch every agent binary on the machine, which is why the read
    // and the refreshes are separate commands at all.
    ensureModelCatalogsLoaded();
  });

  /** Ask every agent that has never answered or whose binary changed.
   *
   *  Deliberate rather than automatic: this spawns one process per due agent,
   *  and a settings page that did it on open would be doing exactly what the
   *  read/probe split exists to prevent.
   *
   *  Parked with the button that called it, see the section title below.
  const checkAll = async () => {
    setCheckingAll(true);
    try {
      await refreshDueCatalogs();
    } finally {
      setCheckingAll(false);
    }
  }; */

  return (
    <section class={styles.section}>
      <Show
        when={opened()}
        fallback={
          <>
            {/* Parked, not deleted: the redesign in progress puts this row's job
                somewhere else, and `checkAll` below is parked with it.
            <div class={styles.sectionTitle}>
              <span>Agents</span>
              <span class={styles.sectionRule} />
              <Button
                size="sm"
                onClick={() => void checkAll()}
                disabled={checkingAll() || dueCount() === 0}
              >
                {checkingAll() ? "Asking…" : "Check models"}
              </Button>
            </div> */}
            <Switch>
              <Match when={health.loading}>
                <div class={styles.note}>Checking which agent CLIs are installed…</div>
              </Match>
              <Match when={health.error}>
                <div class={styles.note}>Could not check agent CLIs: {String(health.error)}</div>
              </Match>
              <Match when={health()}>
                <div class={styles.cardGrid}>
                  <For each={ordered()}>
                    {(h) => <AgentCard agent={h} onOpen={() => setOpenId(h.id)} />}
                  </For>
                </div>
              </Match>
            </Switch>
          </>
        }
      >
        {(agent) => (
          <AgentDetail
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

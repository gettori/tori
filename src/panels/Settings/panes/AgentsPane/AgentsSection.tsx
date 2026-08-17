import { For, Show, Switch, Match, createMemo, createResource, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-solid";
import Icon from "../../../../components/Icon/Icon";
import AgentGlyph from "../../../../components/Icon/AgentGlyph";
import { agents, ensureAdaptersLoaded, type Adapter } from "../../../../utils/agents";
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
// **The list never waits for the sweep.** The adapters are known synchronously
// (the fallback, then `list_agents`), and the health sweep spawns a subprocess
// or three per agent, so gating the cards on it held an empty panel open for
// however long seven probes take. The cards render at once from the adapter
// and each carries a quiet "Checking" state until its health row lands; a card
// with no row yet claims nothing - no dot, no verdict - because a spinner that
// sat where "Not installed" goes would still be an answer-shaped hole.
//
// Installed agents sort first and each half is alphabetical, so the order
// answers the reader's first question without shuffling every time a re-check
// changes one agent's state. Unswept cards sit between the two groups: they
// are not yet either answer. No group headings: seven cards fit in one look,
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
 * lets seven of these be read in one look.
 *
 * `health` is optional because the card renders before the sweep answers.
 * Until it does, the card names the agent and claims nothing else. It stays
 * clickable: the detail page is made of health facts and waits for the row,
 * so an early click is remembered rather than swallowed - a click that does
 * nothing reads as a broken card, not as a pending one.
 */
function AgentCard(props: { adapter: CardAgent; health: AgentHealth | undefined; onOpen: () => void }) {
  const a = () => props.adapter;
  const h = () => props.health;
  const catalog = () => catalogFor(a().id);
  // The pill is for the states that need acting on. Painting "READY" on every
  // healthy card spends the reader's attention on the answer they expected.
  const settled = () => h()?.status === "versionMatch" || h()?.status === "versionUnknown";
  return (
    <button
      type="button"
      class={styles.hcard}
      data-agent={a().id}
      aria-busy={!h()}
      onClick={() => props.onOpen()}
    >
      {/* The logo takes the leading slot the bare dot used to hold, and the
          dot rides its corner: the mark says which agent, the dot says whether
          it is usable, and stacking them keeps both without spending two
          columns on one subject. No dot before the sweep answers: an unlit one
          would read as a verdict. */}
      <span class={styles.hcardGlyph}>
        <AgentGlyph id={a().id} label={a().label} size={22} />
        <Show when={h()}>{(row) => <span class={`${styles.dot} ${TONE[row().status]}`} />}</Show>
      </span>
      <span class={styles.hcardName}>{a().label}</span>
      <Show when={h()?.version}>{(v) => <span class={styles.hcardVersion}>{v()}</span>}</Show>
      <Show when={h() && !settled()}>
        {(_) => (
          <span class={`${styles.statePill} ${STATE_PILL[h()!.status]}`}>
            {STATE_LABEL[h()!.status]}
          </span>
        )}
      </Show>
      <Show when={!h()}>
        <span class={styles.statePill}>Checking</span>
      </Show>
      {/* One line, and the fact it carries differs by group: an installed
          agent is asked who it is signed in as, a missing one what it would
          take to get it. Neither question is interesting for the other. An
          unswept card shows the program alone, which is the one fact the
          adapter already knows. */}
      <span class={styles.hcardMeta}>
        <Switch>
          <Match when={h()?.status === "notFound"}>
            Install <code>{a().program}</code> to use it
          </Match>
          <Match when={h()?.apiKeySource}>
            {(source) => <>Billing against {source()}</>}
          </Match>
          <Match when={h()?.signIn === "signedOut"}>Signed out</Match>
          <Match when={h()?.account}>{(account) => <>Signed in as {account()}</>}</Match>
          <Match when={h()?.signIn === "signedIn"}>Signed in</Match>
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

/** One card's worth of input: what the card reads off the adapter, plus its
 *  health row once the sweep has answered for it. A `Pick` rather than the
 *  whole `Adapter` because a row can also be built *from* a health row - see
 *  the join below. */
type CardAgent = Pick<Adapter, "id" | "label" | "program">;
type CardRow = { adapter: CardAgent; health: AgentHealth | undefined };

/** Installed, then still-checking, then not installed - alphabetical inside
 *  each. Checking sits between the verdicts because it is not yet either one,
 *  and before the sweep answers at all this degrades to plain alphabetical,
 *  so the first paint is stable rather than a shuffle waiting to happen. */
function orderRows(rows: CardRow[]): CardRow[] {
  const rank = (r: CardRow) => (r.health ? (r.health.status === "notFound" ? 2 : 0) : 1);
  return [...rows]
    .sort((x, y) => x.adapter.label.localeCompare(y.adapter.label))
    .sort((x, y) => rank(x) - rank(y));
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
  // Joined from the adapters, not mapped from the sweep: the adapters are the
  // list, and health decorates whichever rows it has answered for. That is
  // what lets the cards paint before a single subprocess has run.
  //
  // A union, not a left join: the sweep covers the whole registry, which can
  // be wider than the resolved adapter list (a user adapter's row can land
  // before `list_agents` does). A health row is proof its adapter exists and
  // carries the three facts a card needs, so it gets one either way.
  const ordered = createMemo(() => {
    const byId = new Map(all().map((row) => [row.id, row] as const));
    const known = new Set(agents().map((a) => a.id));
    // Once a health row lands it also supplies the card's naming facts: it
    // carries the registry's own label and program, so it is the same answer
    // from one hop closer, and the sweep can be ahead of `list_agents` (an
    // override, a user adapter) without the card saying two different things.
    const facet = (row: AgentHealth): CardAgent => ({
      id: row.id,
      label: row.label,
      program: row.program,
    });
    const rows: CardRow[] = agents().map((adapter) => {
      const health = byId.get(adapter.id);
      return { adapter: health ? facet(health) : adapter, health };
    });
    for (const row of all()) {
      if (!known.has(row.id)) rows.push({ adapter: facet(row), health: row });
    }
    return orderRows(rows);
  });
  const rowById = createMemo(() => new Map(ordered().map((r) => [r.adapter.id, r] as const)));
  // Ids, not row objects: `For` keys by reference, and the join builds fresh
  // objects every recompute, so iterating rows would tear every card down each
  // time health or the adapters landed. A card keyed by its id keeps its DOM
  // and updates in place, which is also what keeps a click from landing on a
  // node the join just replaced.
  const orderedIds = createMemo(() => ordered().map((r) => r.adapter.id));
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
            {/* The failure is a note above the cards rather than a screen of
                its own: the list is real either way, and the cards degrade to
                their unswept state, which already claims nothing. */}
            <Show when={health.error}>
              <div class={styles.note}>Could not check agent CLIs: {String(health.error)}</div>
            </Show>
            <div class={styles.cardGrid}>
              <For each={orderedIds()}>
                {(id) => (
                  <AgentCard
                    adapter={rowById().get(id)!.adapter}
                    health={rowById().get(id)?.health}
                    onOpen={() => setOpenId(id)}
                  />
                )}
              </For>
            </div>
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

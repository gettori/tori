import { For, Show, Switch, Match, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-solid";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
// Aliased: this module already imports Solid's control-flow `Switch`, and the
// two are unrelated things wearing one word.
import Toggle from "../../../../components/Switch/Switch";
import AgentGlyph from "../../../../components/Icon/AgentGlyph";
import { agentChosen, enableBlockedReason, setAgentEnabled } from "../../../../utils/agentEnabled";
import {
  agents,
  ensureAdaptersLoaded,
  findAdapter,
  isLaunchOnly,
  type Adapter,
  type ChatTransport,
} from "../../../../utils/agents";
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
  signedOutEverywhere,
  type AgentHealth,
  type BinaryStatus,
} from "../../../../utils/agentHealth";
import { clearWantedAgentCard, wantedAgentCard } from "../../../../utils/agentCard";
import { behindVerified } from "../../../../utils/versions";
import AgentDetail from "./AgentDetail";
import styles from "../../Settings.module.css";
import NeedsFixing from "../../components/NeedsFixing";

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
// user's install, and dimming two of three healthy agents over Tori's own
// missing bookkeeping reads as "these are worse off" when they are fine.
// Version detail belongs in the status text below, where it can be explained.
const TONE: Record<BinaryStatus, string> = {
  versionMatch: styles.dotOk,
  versionUnknown: styles.dotOk,
  // Green here; `rowTone` overrides to warn for the one drift direction that
  // matters. Newer than the measurement is the steady state of a fast-shipping
  // vendor, older than it means a release provably exists to move to.
  versionDrift: styles.dotOk,
  notFound: styles.dotOff,
};

/** Who ships the agent, as the row's quiet fact. Frontend-owned branding, the
 *  same trade `agentMarks` makes: adding it to the TOML schema would buy
 *  nothing but churn for a string only this row reads. An id Tori has never
 *  heard of has no entry and falls back below. */
const PROVIDER: Record<string, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  copilot: "GitHub",
  gemini: "Google",
  kimi: "Moonshot AI",
  opencode: "SST",
  pi: "Mario Zechner",
};

/** How Tori drives the agent. "Native" is the first-class adapter with a
 *  transport of its own; protocol agents say the protocol's name. */
const TRANSPORT_LABEL: Record<ChatTransport, string> = {
  claude_stream_json: "Native",
  acp: "ACP",
};

/** "GitHub · ACP": provider, then transport, or "Terminal" for a launch-only
 *  adapter. Read off the resolved adapter, so before `list_agents` lands (the
 *  fallback carries no chat table) the note is the provider alone rather than
 *  a wrong claim; an adapter Tori knows neither fact about shows its program,
 *  the one fact the adapter itself states. */
function rowNote(id: string, program: string): string {
  const adapter = findAdapter(id);
  const transport = adapter.chat?.transport;
  const drive = transport ? TRANSPORT_LABEL[transport] : isLaunchOnly(adapter) && "Terminal";
  const parts = [PROVIDER[id], drive].filter(Boolean);
  return parts.length ? parts.join(" · ") : program;
}

/**
 * What the STATE column says. One verdict per row, most actionable first:
 * a signed-out agent says "Sign in" because signing in is the thing the
 * reader can do from here. Version drift is deliberately not a verdict:
 * vendors ship weekly, so it would be the permanent state of every row.
 * "Ready" is painted (unlike the old cards, which suppressed it) because an
 * empty cell in a filled column reads as a rendering bug, not as calm.
 *
 * Health only. Whether the agent is switched on is the ON column's answer and
 * never leaks in here: the dependency runs one way, since the switch is what
 * needs a verdict to move and the verdict needs nothing from the switch.
 */
function rowState(h: AgentHealth | undefined): { label: string; cls: string } {
  if (!h) return { label: "Checking", cls: "" };
  if (h.status === "notFound") return { label: "Not installed", cls: "" };
  if (signedOutEverywhere(h)) return { label: "Sign in", cls: styles.statePillWarn };
  // A warning, not "Not installed": the terminal works, only chat cannot spawn.
  if (h.chatProgramMissing) return { label: `Chat needs ${h.chatProgramMissing}`, cls: styles.statePillWarn };
  // Only the behind direction: older than the measured version means a newer
  // release provably exists, which is actionable in a way "newer than what we
  // measured" never is.
  if (h.status === "versionDrift" && behindVerified(h.version, h.verifiedAgainst))
    return { label: "Outdated", cls: styles.statePillWarn };
  return { label: "Ready", cls: styles.statePillOk };
}

/** The dot beside the mark, agreeing with the pill: warn only for the drift
 *  direction the pill warns about. */
function rowTone(h: AgentHealth): string {
  if (h.chatProgramMissing) return styles.dotWarn;
  if (h.status === "versionDrift" && behindVerified(h.version, h.verifiedAgainst)) return styles.dotWarn;
  return TONE[h.status];
}

/**
 * One agent as a table row: name, build, model count, verdict, and the switch
 * that decides whether anything offers it.
 *
 * The facts are a button rather than a div with a handler, so they are
 * reachable and announced without inventing a role. The switch is its sibling
 * rather than its child, since a control nested in a button is neither.
 * Everything the row used to carry (capabilities, gaps, accounts, the sessions
 * directory) lives on `AgentDetail`, which is what lets seven of these be read
 * in one look.
 *
 * `health` is optional because the row renders before the sweep answers.
 * Until it does, the row names the agent and claims nothing else. It stays
 * clickable: the detail page is made of health facts and waits for the row,
 * so an early click is remembered rather than swallowed - a click that does
 * nothing reads as a broken row, not as a pending one.
 */
function AgentRow(props: {
  adapter: CardAgent;
  health: AgentHealth | undefined;
  accounts: number | undefined;
  onOpen: () => void;
}) {
  const a = () => props.adapter;
  const h = () => props.health;
  const catalog = () => catalogFor(a().id);
  const on = () => agentChosen(a().id);
  // Why the switch cannot be turned on, or null. The STATE cell is already
  // printing the same fact in words, so the switch needs no tooltip of its own.
  const blocked = () => enableBlockedReason(a().id);
  const state = () => rowState(h());
  return (
    <div class={styles.agentRowWrap}>
      <button type="button" class={styles.agentRow} data-agent={a().id} aria-busy={!h()} onClick={() => props.onOpen()}>
        <span class={styles.agentCell}>
          {/* The logo keeps the leading slot, with the status dot on its corner:
            the mark says which agent, the dot says whether it is usable. No dot
            before the sweep answers - an unlit one would read as a verdict. */}
          <span class={styles.hcardGlyph}>
            <AgentGlyph id={a().id} label={a().label} size={20} />
            <Show when={h()}>{(row) => <span class={`${styles.dot} ${rowTone(row())}`} />}</Show>
          </span>
          <span class={styles.agentName}>{a().label}</span>
          {/* Standing facts, not status: who ships it and how Tori drives it.
            Who is signed in, what to install, which key bills - all of that
            lives on the agent's page, where there is room to say it in words;
            here the state cell already carries the verdict. */}
          <span class={styles.agentNote}>{rowNote(a().id, a().program)}</span>
        </span>
        <span class={styles.agentVersion}>{h()?.version ?? "-"}</span>
        {/* The count is a claim about what the installed binary can run for the
          **default account**, which is what a session started without choosing
          one runs as; the agent's page lists every account. It comes from the
          probe cache and nowhere else. A row nobody has asked
          shows "-" rather than 0, because "0 models" reads as a broken install
          rather than as an unasked question. A failed probe that still holds
          an older answer shows the answer, not the error: stale-but-real beats
          fresh-but-empty, and the detail page is where the failure is
          explained. */}
        <span class={styles.agentModels}>
          <Switch>
            <Match when={isProbing(a().id)}>…</Match>
            <Match when={catalog()?.catalogue}>{distinctModelCount(catalog())}</Match>
            <Match when={catalog()?.state === "failed"}>
              <span class={styles.agentModelsBad}>Error</span>
            </Match>
            <Match when={true}>-</Match>
          </Switch>
        </span>
        {/* Stored profiles, counted off the accounts file with no probe: how
          many logins Tori holds, not whether any of them works. "-" for an
          adapter that declares no [accounts], because a default "1" would
          claim an account Tori has nothing true to say about. */}
        <span class={styles.agentCount}>{props.accounts ?? "-"}</span>
        <span class={styles.agentState}>
          <span class={`${styles.statePill} ${state().cls}`}>{state().label}</span>
        </span>
      </button>
      {/* Off is the default for every agent, so this is where a machine's set
          gets built rather than a rarely-touched override. Refused rather than
          hidden when the agent cannot run: a missing switch says nothing about
          why, and the STATE cell beside it is already saying what to fix.

          Only turning one *on* is refused. An agent that was on and then broke
          keeps a live switch, or the reader would be looking at something they
          turned on and cannot turn off. */}
      <Toggle
        class={styles.agentToggle}
        checked={on()}
        disabled={blocked() !== null && !on()}
        aria-label={`Offer ${a().label} in Tori`}
        tooltip={blocked() ?? (on() ? "Disable in Tori" : "Enable in Tori")}
        onChange={(next) => setAgentEnabled(a().id, next)}
      />
    </div>
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
  return [...rows].sort((x, y) => x.adapter.label.localeCompare(y.adapter.label)).sort((x, y) => rank(x) - rank(y));
}

export default function AgentsSection(props: { projectRoot?: string | null }) {
  const [health, { refetch }] = createResource(() => invoke<AgentHealth[]>("agent_health"));
  // Counts come from the stored accounts file, no subprocess behind them, so
  // fetching on every open is as cheap as the read it is.
  const [accountCounts, { refetch: refetchCounts }] = createResource(() =>
    invoke<Record<string, number>>("agent_account_counts").catch(() => ({}) as Record<string, number>),
  );
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
  // objects every recompute, so iterating rows would tear every row down each
  // time health or the adapters landed. A row keyed by its id keeps its DOM
  // and updates in place, which is also what keeps a click from landing on a
  // node the join just replaced.
  const orderedIds = createMemo(() => ordered().map((r) => r.adapter.id));
  // The little filter beside the title. Matched against what the row actually
  // shows (name, program, the provider note), so typing what you can read
  // always works, and against nothing invisible, so a match is never
  // inexplicable. "github" finding Copilot is the note earning its keep.
  const [query, setQuery] = createSignal("");
  const visibleIds = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return orderedIds();
    return ordered()
      .filter((r) =>
        [r.adapter.label, r.adapter.program, rowNote(r.adapter.id, r.adapter.program)]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
      .map((r) => r.adapter.id);
  });
  const opened = createMemo(() => all().find((a) => a.id === openId()));

  /** Back to the card that opened the page, not to the top of the list: a
   *  keyboard user who drilled in has to land where they left. */
  const close = () => {
    const id = openId();
    setOpenId(null);
    // The page is where accounts get added and removed, so the count a reader
    // returns to has to be the count they just changed.
    void refetchCounts();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-agent="${id}"]`)?.focus());
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

  // Somewhere else sent the reader here to fix one agent (the chat palette's
  // "Fix" row). An effect rather than a mount read, so an already-open panel
  // answers too; consumed, or it would re-open the card the user just closed.
  createEffect(() => {
    const id = wantedAgentCard();
    if (id === null) return;
    clearWantedAgentCard();
    setOpenId(id);
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
            {/* One row does all the chrome: the title, the rule, the re-probe,
                and the filter. The filter is this section's own rather than the
                panel-wide search above, which shows and hides whole panes; this
                one narrows rows inside a list that is already on screen. */}
            <div class={styles.sectionTitle}>
              <span>Agents</span>
              <span class={styles.sectionRule} />
              <IconButton
                size="sm"
                icon={<Icon icon={RefreshCw} />}
                tooltip="Check again"
                onClick={() => void recheck()}
                disabled={rechecking()}
              />
              <input
                type="text"
                class={styles.tableFilter}
                placeholder="Search"
                aria-label="Search agents"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
            <NeedsFixing kind="agents" />
            {/* The failure is a note above the rows rather than a screen of
                its own: the list is real either way, and the rows degrade to
                their unswept state, which already claims nothing. */}
            <Show when={health.error}>
              <div class={styles.note}>Could not check agent CLIs: {String(health.error)}</div>
            </Show>
            <div class={styles.agentTable}>
              <div class={styles.agentTableHead}>
                <div class={styles.agentHeadCols}>
                  {/* Empty on purpose: every row opens with the agent's own
                      name, so a column label would restate what the column is
                      made of. The span stays so the grid keeps its shape. */}
                  <span />
                  <span>Version</span>
                  <span class={styles.agentColEnd}>Models</span>
                  <span class={styles.agentColEnd}>Accounts</span>
                  <span class={styles.agentColEnd}>State</span>
                </div>
                <span class={styles.agentColEnd}>On</span>
              </div>
              <For each={visibleIds()}>
                {(id) => (
                  <AgentRow
                    adapter={rowById().get(id)!.adapter}
                    health={rowById().get(id)?.health}
                    accounts={accountCounts()?.[id]}
                    onOpen={() => setOpenId(id)}
                  />
                )}
              </For>
            </div>
            <Show when={query().trim() && visibleIds().length === 0}>
              <div class={styles.cardMeta}>No agent matches "{query().trim()}".</div>
            </Show>
          </>
        }
      >
        {(agent) => (
          <AgentDetail
            agent={agent()}
            projectRoot={props.projectRoot ?? null}
            onBack={close}
            onRecheck={recheck}
            rechecking={rechecking()}
          />
        )}
      </Show>
    </section>
  );
}

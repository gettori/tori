import { For, Match, Show, Switch, createSignal } from "solid-js";
import { ChevronRight, Search, Settings, Tag } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { fallbackColor, rgbTriple } from "../../src/utils/spaceTint";
import { ProjectMark } from "./icons";
import type { RemoteClient } from "./remote";
import { inUnit, matches, projectRows, rollupOf, sessionLabel, type Project, type SessionRow, type Space, type Topic, type Tree, type Unit } from "./tree";
import styles from "./shell.module.css";

export type RootTab = "projects" | "topics";

export const DOT = "\u00b7";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Chevron() {
  return <Icon icon={ChevronRight} size={16} strokeWidth={2} class={styles.chevron} />;
}

export function StateMark(props: { rows: SessionRow[] }) {
  const rollup = () => rollupOf(props.rows);
  const needs = () => rollup().waitingForApproval + rollup().waitingForAnswer;
  return (
    <Switch>
      <Match when={needs() > 0}>
        <span class={styles.needs}>{needs()}</span>
      </Match>
      <Match when={rollup().executing > 0}>
        <span class={styles.working}>Working</span>
      </Match>
    </Switch>
  );
}

export function Offline(props: { client: RemoteClient }) {
  const status = () => props.client.status();
  return (
    <Show when={status() === "offline" || status() === "connecting"}>
      <p class={styles.banner} role="status">
        {status() === "offline" ? "Offline, reconnecting" : "Connecting to Tori"}
      </p>
    </Show>
  );
}

function ProjectItem(props: { client: RemoteClient; project: Project; live: SessionRow[]; onOpen: () => void }) {
  const rows = () => projectRows(props.project, props.live);
  const meta = () => {
    const units = plural(props.project.units.length, "worktree");
    return rows().length > 0 ? `${units} ${DOT} ${plural(rows().length, "session")}` : units;
  };
  return (
    <li>
      <button class={styles.item} onClick={() => props.onOpen()}>
        <ProjectMark client={props.client} project={props.project} />
        <span class={styles.text}>
          <span class={styles.name}>{props.project.name}</span>
          <span class={styles.meta}>{meta()}</span>
        </span>
        <StateMark rows={rows()} />
        <Chevron />
      </button>
    </li>
  );
}

function SessionItem(props: { row: SessionRow; meta: string; onOpen: () => void }) {
  return (
    <li>
      <button class={styles.item} onClick={() => props.onOpen()}>
        <span class={styles.text}>
          <span class={styles.name}>{sessionLabel(props.row)}</span>
          <span class={styles.meta}>{props.meta}</span>
        </span>
        <StateMark rows={[props.row]} />
        <Chevron />
      </button>
    </li>
  );
}

function Results(props: {
  client: RemoteClient;
  tree: Tree;
  live: SessionRow[];
  query: string;
  onProject: (project: Project) => void;
  onUnit: (unit: Unit, back: string) => void;
  onSession: (row: SessionRow) => void;
}) {
  const projects = () => props.tree.spaces.flatMap((space) => space.projects);
  const found = () => projects().filter((p) => matches(p.name, props.query));
  const units = () =>
    projects().flatMap((project) =>
      project.units.filter((u) => matches(u.label, props.query) || matches(u.branch, props.query)).map((unit) => ({ project, unit })),
    );
  const sessions = () => props.live.filter((row) => matches(sessionLabel(row), props.query));
  const nothing = () => found().length + units().length + sessions().length === 0;
  return (
    <>
      <Show when={found().length > 0}>
        <h2 class={styles.label}>Projects</h2>
        <ul class={styles.group}>
          <For each={found()}>{(project) => <ProjectItem client={props.client} project={project} live={props.live} onOpen={() => props.onProject(project)} />}</For>
        </ul>
      </Show>
      <Show when={units().length > 0}>
        <h2 class={styles.label}>Worktrees</h2>
        <ul class={styles.group}>
          <For each={units()}>
            {({ project, unit }) => (
              <li>
                <button class={styles.item} onClick={() => props.onUnit(unit, project.name)}>
                  <span class={styles.text}>
                    <span class={styles.name}>{unit.label}</span>
                    <span class={styles.meta}>{project.name}</span>
                  </span>
                  <StateMark rows={props.live.filter((row) => inUnit(row.home, unit))} />
                  <Chevron />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={sessions().length > 0}>
        <h2 class={styles.label}>Sessions</h2>
        <ul class={styles.group}>
          <For each={sessions()}>
            {(row) => <SessionItem row={row} meta={row.home?.branch ?? row.cwd ?? ""} onOpen={() => props.onSession(row)} />}
          </For>
        </ul>
      </Show>
      <Show when={nothing()}>
        <p class={styles.empty}>Nothing loaded matches "{props.query}"</p>
      </Show>
    </>
  );
}

export default function Root(props: {
  client: RemoteClient;
  tree: Tree | undefined;
  space: Space | undefined;
  tab: RootTab;
  live: () => SessionRow[];
  notice: string | null;
  onProject: (project: Project) => void;
  onTopic: (topic: Topic) => void;
  onUnit: (unit: Unit, back: string) => void;
  onSession: (row: SessionRow) => void;
  onSettings: () => void;
}) {
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const homeless = () => props.live().filter((row) => !row.home);
  const topics = () => props.tree?.topics ?? [];

  return (
    <div class={styles.glow}>
      <header class={styles.top}>
        <span class={styles.titles}>
          <Show when={props.tab === "projects"} fallback={<span class={styles.bigTitle}>Topics</span>}>
            <span class={styles.bigTitle}>{props.space?.name ?? "Tori"}</span>
            <span class={styles.rootLabel}>{DOT} Spaces</span>
          </Show>
        </span>
        <button
          class={styles.circle}
          aria-label="Search"
          aria-pressed={searching()}
          onClick={() => {
            setSearching(!searching());
            setQuery("");
          }}
        >
          <Icon icon={Search} size={18} strokeWidth={2} />
        </button>
        <button class={styles.circle} aria-label="Settings" onClick={() => props.onSettings()}>
          <Icon icon={Settings} size={19} strokeWidth={1.9} />
        </button>
      </header>
      <Show when={searching()}>
        <label class={styles.search}>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            type="search"
            placeholder="Projects, worktrees, sessions"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </Show>
      <Offline client={props.client} />
      <Show when={props.notice}>
        <p class={styles.banner}>{props.notice}</p>
      </Show>
      <div class={styles.scroll}>
        <Show when={props.tree} fallback={<p class={styles.empty}>Loading</p>}>
          {(tree) => (
            <Switch>
              <Match when={searching() && query().trim()}>
                {(q) => (
                  <Results client={props.client} tree={tree()} live={props.live()} query={q()} onProject={props.onProject} onUnit={props.onUnit} onSession={props.onSession} />
                )}
              </Match>
              <Match when={props.tab === "projects"}>
                <h2 class={styles.label}>Projects {DOT} {props.space?.projects.length ?? 0}</h2>
                <ul class={styles.group}>
                  <For each={props.space?.projects ?? []} fallback={<li class={styles.empty}>No projects in this space</li>}>
                    {(project) => <ProjectItem client={props.client} project={project} live={props.live()} onOpen={() => props.onProject(project)} />}
                  </For>
                </ul>
                <Show when={homeless().length > 0}>
                  <h2 class={styles.label}>Elsewhere</h2>
                  <ul class={styles.group}>
                    <For each={homeless()}>{(row) => <SessionItem row={row} meta={row.cwd ?? ""} onOpen={() => props.onSession(row)} />}</For>
                  </ul>
                </Show>
              </Match>
              <Match when={props.tab === "topics"}>
                <h2 class={styles.label}>Topics {DOT} {topics().length}</h2>
                <ul class={styles.group}>
                  <For each={topics()} fallback={<li class={styles.empty}>No topics yet</li>}>
                    {(topic) => (
                      <li>
                        <button class={styles.item} onClick={() => props.onTopic(topic)}>
                          <span class={`${styles.tile} ${styles.tagTile}`} style={{ "--tint": rgbTriple(fallbackColor(topic.name)) }}>
                            <Icon icon={Tag} size={16} strokeWidth={2} />
                          </span>
                          <span class={styles.text}>
                            <span class={styles.name}>{topic.name}</span>
                            <span class={styles.meta}>{topic.members.map((m) => m.displayName).join(", ")}</span>
                          </span>
                          <span class={styles.count}>{topic.members.length}</span>
                          <Chevron />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  );
}

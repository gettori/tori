import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { ChevronDown, ChevronRight, Folder, Settings } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { BranchMark, WorktreeMark } from "../../src/components/Icon/gitMarks";
import StatusBubble from "../../src/panels/LeftSidebar/StatusBubble";
import type { RemoteClient } from "./remote";
import { inUnit, rollupOf, sessionLabel, type Project, type SessionRow, type Space, type Unit } from "./tree";
import styles from "./mobile.module.css";

function UnitIcon(props: { unit: Unit; active: boolean }) {
  return (
    <Switch fallback={<Icon icon={Folder} />}>
      <Match when={props.unit.kind === "worktree" || props.unit.kind === "incomplete"}>
        <WorktreeMark active={props.active} current={props.unit.isCurrent} stub={props.unit.kind === "incomplete"} />
      </Match>
      <Match when={props.unit.kind === "plain"}>
        <BranchMark active={props.active} current={props.unit.isCurrent} />
      </Match>
    </Switch>
  );
}

function ProjectGroup(props: { project: Project; live: () => SessionRow[]; onUnit: (unit: Unit) => void }) {
  const inProject = () => props.live().filter((row) => props.project.units.some((unit) => inUnit(row.home, unit)));
  // Until tapped, a project is open exactly while something in it is live.
  const [picked, setPicked] = createSignal<boolean | null>(null);
  const open = () => picked() ?? inProject().length > 0;
  return (
    <li>
      <button class={styles.row} onClick={() => setPicked(!open())}>
        <Icon icon={open() ? ChevronDown : ChevronRight} />
        <span class={styles.rowTitle}>{props.project.name}</span>
        <Show when={!open()}>
          <span class={styles.rowEnd}>
            <StatusBubble rollup={() => rollupOf(inProject())} />
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <ul class={styles.sublist}>
          <For each={props.project.units}>
            {(unit) => {
              const rollup = () => rollupOf(props.live().filter((row) => inUnit(row.home, unit)));
              return (
                <li>
                  <button class={`${styles.row} ${styles.unit}`} onClick={() => props.onUnit(unit)}>
                    <UnitIcon unit={unit} active={rollup().executing > 0} />
                    <span class={styles.rowTitle}>{unit.label}</span>
                    <span class={styles.rowEnd}>
                      <StatusBubble rollup={rollup} />
                    </span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </li>
  );
}

export default function Home(props: {
  client: RemoteClient;
  live: () => SessionRow[];
  notice: string | null;
  onUnit: (unit: Unit) => void;
  onSession: (row: SessionRow) => void;
  onSettings: () => void;
}) {
  const [tree] = createResource<{ spaces: Space[] }, number>(
    () => props.client.generation() || undefined,
    // A failed load keeps the last tree: the reconnect that follows refetches.
    (_, info) =>
      props.client
        .request<{ spaces: Space[] }>("projects.list")
        .catch(() => info.value ?? { spaces: [] as Space[] }),
  );
  const homeless = () => props.live().filter((row) => !row.home);

  return (
    <div class={styles.screen}>
      <header class={styles.bar}>
        <span class={styles.title}>{props.client.saved.name}</span>
        <span class={styles.status} data-status={props.client.status()}>
          {props.client.status()}
        </span>
        <button class={styles.back} aria-label="Settings" onClick={() => props.onSettings()}>
          <Icon icon={Settings} />
        </button>
      </header>
      <Show when={props.notice}>
        <p class={styles.error}>{props.notice}</p>
      </Show>
      <div class={styles.list}>
        <Show when={tree()} fallback={<p class={styles.hint}>Loading</p>}>
          {(t) => (
            <For each={t().spaces}>
              {(space) => (
                <section>
                  <h2 class={styles.section}>{space.name}</h2>
                  <ul class={styles.plain}>
                    <For each={space.projects}>
                      {(project) => <ProjectGroup project={project} live={props.live} onUnit={props.onUnit} />}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          )}
        </Show>
        <Show when={homeless().length > 0}>
          <section>
            <h2 class={styles.section}>Elsewhere</h2>
            <ul class={styles.plain}>
              <For each={homeless()}>
                {(row) => (
                  <li>
                    <button class={styles.row} onClick={() => props.onSession(row)}>
                      <span class={styles.dot} data-dot={row.dot ?? ""} />
                      <span class={styles.rowText}>
                        <span class={styles.rowTitle}>{sessionLabel(row)}</span>
                        <span class={styles.rowMeta}>{row.cwd}</span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>
    </div>
  );
}

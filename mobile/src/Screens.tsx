import { For, Match, Show, Switch, createResource, onCleanup, type JSX } from "solid-js";
import { ChevronLeft, Folder, Tag } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { BranchMark, WorktreeMark } from "../../src/components/Icon/gitMarks";
import SyncMarks from "../../src/components/SyncMarks/SyncMarks";
import PrLine from "../../src/panels/LeftSidebar/PrLine";
import { syncMarks } from "../../src/utils/branchSync";
import type { UnitStatus } from "../../src/utils/forgeTypes";
import type { BranchSync } from "../../src/utils/gitActions";
import { ago } from "../../src/utils/relativeTime";
import type { Crew } from "./Autopilot";
import { ProjectMark } from "./icons";
import type { RemoteClient } from "./remote";
import { Chevron, DOT, Offline, StateMark } from "./Root";
import { SessionList, unitSessions } from "./Unit";
import { agentHolds, atUnit, inUnit, kindName, newest, unitCounts, unitsHeading, rollupOf, type Project, type SessionRow, type Topic, type Tree, type Unit, type UnitGit } from "./tree";
import styles from "./shell.module.css";

// Git runs once per folder on the Mac; a project with many worktrees on a slow
// link can take longer than the default reply window.
const GIT_REPLY_MS = 30_000;
const GIT_FOLDERS_MAX = 64;
const MINUS = "\u2212";
// The desktop polls the forge every two minutes; the phone asks no more often.
const SYNC_EVERY_MS = 30_000;
const PR_EVERY_MS = 120_000;

export function watchGit(client: RemoteClient, folders: () => string[]) {
  const [git] = createResource<Record<string, UnitGit>, string[]>(
    () => (client.generation() ? folders() : undefined),
    (list, info) =>
      client
        .request<Record<string, UnitGit>>("units.git", { folders: list.slice(0, GIT_FOLDERS_MAX) }, GIT_REPLY_MS)
        .catch(() => info.value ?? {}),
  );
  return git;
}

const syncKey = (unit: Unit) => `${unit.folder}\u0000${unit.branch ?? ""}`;

function every(ms: number, refetch: () => void) {
  const timer = setInterval(refetch, ms);
  onCleanup(() => clearInterval(timer));
}

export function watchSync(client: RemoteClient, units: () => Unit[]) {
  const [sync, { refetch }] = createResource<Record<string, BranchSync>, Unit[]>(
    () => (client.generation() ? units() : undefined),
    (list, info) =>
      client
        .request<Record<string, BranchSync>>(
          "units.sync",
          { units: list.filter((u) => u.branch).slice(0, GIT_FOLDERS_MAX).map((u) => ({ path: u.folder, branch: u.branch })) },
          GIT_REPLY_MS,
        )
        .catch(() => info.value ?? {}),
  );
  every(SYNC_EVERY_MS, () => void refetch());
  return (unit: Unit) => sync()?.[syncKey(unit)];
}

export function watchPr(client: RemoteClient, project: () => Project) {
  const [report, { refetch }] = createResource<UnitStatus[], Project>(
    () => (client.generation() ? project() : undefined),
    (p, info) =>
      client
        .request<{ statuses: UnitStatus[] }>("units.pr", { project: p.path, branches: p.units.flatMap((u) => (u.branch ? [u.branch] : [])) }, GIT_REPLY_MS)
        .then((r) => r.statuses)
        .catch(() => info.value ?? []),
  );
  every(PR_EVERY_MS, () => void refetch());
  return (unit: Unit) => report()?.find((s) => s.headRef === unit.branch && s.pullRequest);
}

export function GitCounts(props: { git: UnitGit | undefined; lead?: JSX.Element }) {
  return (
    <span class={styles.diff}>
      {props.lead}
      <Show when={props.git}>
        {(git) => (
          <>
            <Show when={git().added > 0}>
              <span class={styles.added}>+{git().added}</span>
            </Show>
            <Show when={git().deleted > 0}>
              <span class={styles.deleted}>
                {MINUS}
                {git().deleted}
              </span>
            </Show>
          </>
        )}
      </Show>
    </span>
  );
}

function UnitIcon(props: { unit: Unit; active: boolean }) {
  return (
    <Switch fallback={<Icon icon={Folder} size={18} />}>
      <Match when={props.unit.kind === "worktree" || props.unit.kind === "incomplete"}>
        <WorktreeMark active={props.active} current={props.unit.isCurrent} stub={props.unit.kind === "incomplete"} />
      </Match>
      <Match when={props.unit.kind === "plain"}>
        <BranchMark active={props.active} current={props.unit.isCurrent} />
      </Match>
    </Switch>
  );
}

function UnitItem(props: { unit: Unit; name?: string; meta: string; live: SessionRow[]; onOpen: () => void }) {
  const rows = () => props.live.filter((row) => atUnit(row, props.unit));
  return (
    <li>
      <button class={styles.item} onClick={() => props.onOpen()}>
        <UnitIcon unit={props.unit} active={rollupOf(rows()).executing > 0} />
        <span class={styles.text}>
          <span class={styles.name}>{props.name ?? props.unit.label}</span>
          <span class={styles.meta}>{props.meta}</span>
        </span>
        <Chevron />
      </button>
    </li>
  );
}

export function PushTop(props: { back: string; space?: boolean; onBack: () => void; end?: JSX.Element }) {
  return (
    <header class={styles.pushTop}>
      <button class={styles.circle} aria-label="Back" onClick={() => props.onBack()}>
        <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
      </button>
      <span class={styles.backLabel} data-space={props.space || undefined}>
        {props.back}
      </span>
      {props.end}
    </header>
  );
}

function WorktreeCard(props: {
  unit: Unit;
  live: SessionRow[];
  git: UnitGit | undefined;
  sync: BranchSync | undefined;
  pr: UnitStatus | undefined;
  topics: Topic[];
  crewed: boolean;
  onOpen: () => void;
}) {
  const rows = () => props.live.filter((row) => inUnit(row.home, props.unit));
  const meta = () => {
    const last = newest(rows());
    return last ? `${rows().length} live ${DOT} ${ago(last.last_active)}` : kindName(props.unit);
  };
  return (
    <li>
      <button class={styles.card} data-crew={props.crewed} onClick={() => props.onOpen()}>
        <span class={styles.cardHead}>
          <UnitIcon unit={props.unit} active={props.crewed || rollupOf(rows()).executing > 0} />
          <span class={styles.name}>{props.unit.label}</span>
          <Show when={props.unit.issue}>{(issue) => <span class={styles.issueKey}>{issue()}</span>}</Show>
          <For each={props.topics}>
            {(topic) => (
              <span class={styles.topicChip}>
                <Icon icon={Tag} size={12} strokeWidth={2.2} />
                {topic.name}
              </span>
            )}
          </For>
          <SyncMarks marks={agentHolds(rows()) ? [] : syncMarks(props.sync)} class={styles.sync} />
          <StateMark rows={rows()} />
          <Chevron />
        </span>
        <span class={styles.cardMeta}>
          <Show when={props.pr} fallback={<span>{meta()}</span>}>
            {(pr) => <PrLine status={pr()} />}
          </Show>
          <GitCounts git={props.git} />
        </span>
      </button>
    </li>
  );
}

export function ProjectScreen(props: {
  client: RemoteClient;
  project: Project;
  space: string;
  topics: Topic[];
  live: () => SessionRow[];
  crew: () => Crew;
  onUnit: (unit: Unit) => void;
  onBack: () => void;
}) {
  const git = watchGit(props.client, () => props.project.units.map((unit) => unit.folder));
  const sync = watchSync(props.client, () => props.project.units);
  const pr = watchPr(props.client, () => props.project);
  const sessions = () => props.live().filter((row) => props.project.units.some((unit) => inUnit(row.home, unit))).length;
  const meta = () => {
    const units = unitCounts(props.project.units, DOT);
    return sessions() > 0 ? `${units} ${DOT} ${sessions()} live` : units;
  };
  return (
    <div class={styles.glow}>
      <PushTop back={props.space} space onBack={props.onBack} />
      <Offline client={props.client} />
      <div class={styles.scroll}>
        <div class={styles.projectHead}>
          <ProjectMark client={props.client} project={props.project} big />
          <span class={styles.text}>
            <span class={styles.headTitle}>{props.project.name}</span>
            <span class={styles.headMeta}>{meta()}</span>
          </span>
        </div>
        <h2 class={styles.label}>{unitsHeading(props.project.units)}</h2>
        <ul class={styles.cards}>
          <For each={props.project.units}>
            {(unit) => (
              <WorktreeCard
                unit={unit}
                live={props.live()}
                git={git()?.[unit.folder]}
                sync={sync(unit)}
                pr={pr(unit)}
                topics={props.topics.filter((topic) => topic.members.some((m) => m.worktreePath === unit.folder))}
                crewed={props.crew().worktrees.has(unit.folder)}
                onOpen={() => props.onUnit(unit)}
              />
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}

export function memberUnit(tree: Tree | undefined, topic: Topic, member: Topic["members"][number]): Unit {
  const folder = member.worktreePath ?? member.checkout?.path ?? member.repoPath;
  const branch = member.worktreePath ? topic.branch : (member.checkout?.branch ?? null);
  const known = tree?.spaces.flatMap((s) => s.projects.flatMap((p) => p.units)).find((u) => u.folder === folder);
  return known ?? { label: member.displayName, folder, branch, kind: "worktree", isCurrent: false };
}

export function TopicScreen(props: {
  client: RemoteClient;
  topic: Topic;
  tree: Tree | undefined;
  live: () => SessionRow[];
  crew: () => Crew;
  autopilotOn: boolean;
  onUnit: (unit: Unit) => void;
  onOpen: (row: SessionRow) => void;
  onBack: () => void;
}) {
  const members = () =>
    [...props.topic.members].sort((a, b) => a.order - b.order).map((member) => ({ member, unit: memberUnit(props.tree, props.topic, member) }));
  const { here, earlier } = unitSessions(props.client, () => members().map((m) => m.unit), props.live, props.topic);
  const where = (row: SessionRow) => members().find((m) => atUnit(row, m.unit))?.member.displayName;
  return (
    <div class={styles.glow}>
      <PushTop back="Topics" onBack={props.onBack} />
      <Offline client={props.client} />
      <div class={styles.scroll}>
        <h1 class={styles.screenTitle}>{props.topic.name}</h1>
        <h2 class={styles.label}>Members {DOT} {members().length}</h2>
        <ul class={styles.group}>
          <For each={members()} fallback={<li class={styles.empty}>No members</li>}>
            {({ member, unit }) => (
              <UnitItem unit={unit} name={member.displayName} meta={unit.branch ?? props.topic.branch} live={props.live()} onOpen={() => props.onUnit(unit)} />
            )}
          </For>
        </ul>
        <SessionList here={here()} earlier={earlier()} crew={props.crew} autopilotOn={props.autopilotOn} where={where} onOpen={props.onOpen} />
      </div>
    </div>
  );
}

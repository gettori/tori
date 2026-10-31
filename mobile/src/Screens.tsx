import { For, Match, Show, Switch, createResource, createSignal, onCleanup, type JSX } from "solid-js";
import { ChevronLeft, Ellipsis, Folder, Tag } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { BranchMark, WorktreeMark } from "../../src/components/Icon/gitMarks";
import SyncMarks from "../../src/components/SyncMarks/SyncMarks";
import BranchLine from "../../src/panels/LeftSidebar/BranchLine";
import { syncMarks } from "../../src/utils/branchSync";
import type { UnitStatus } from "../../src/utils/forgeTypes";
import type { BranchSync } from "../../src/utils/gitActions";
import { ago } from "../../src/utils/relativeTime";
import AskSheet, { type Ask } from "./AskSheet";
import type { Crew } from "./Autopilot";
import { ChoiceSheet, type Choice } from "./Organize";
import { branchStem } from "../../src/panels/LeftSidebar/attempts";
import { ProjectMark } from "./icons";
import type { RemoteClient } from "./remote";
import { Chevron, DOT, ConnectionBanner, StateMark } from "./Root";
import { SessionList, unitSessions } from "./Unit";
import {
  agentHolds,
  atUnit,
  inUnit,
  kindName,
  newest,
  unitCounts,
  unitsHeading,
  rollupOf,
  type Project,
  type SessionRow,
  type Topic,
  type Tree,
  type Unit,
  type UnitGit,
} from "./tree";
import styles from "./shell.module.css";

// Git runs once per folder on the Mac; a project with many worktrees on a slow
// link can take longer than the default reply window.
const GIT_REPLY_MS = 30_000;
const GIT_FOLDERS_MAX = 64;
// Each attempt clones the project's dependency folders before it answers.
const ATTEMPT_REPLY_MS = 60_000;
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
          {
            units: list
              .filter((u) => u.branch)
              .slice(0, GIT_FOLDERS_MAX)
              .map((u) => ({ path: u.folder, branch: u.branch })),
          },
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
        .request<{ statuses: UnitStatus[] }>(
          "units.pr",
          { project: p.path, branches: p.units.flatMap((u) => (u.branch ? [u.branch] : [])) },
          GIT_REPLY_MS,
        )
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
            {(pr) => <BranchLine status={pr()} />}
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
  onChanged: () => void;
}) {
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const [fanOut, setFanOut] = createSignal<string | null>(null);
  const fan = () =>
    setAsk({
      title: "Fan out: what are these attempts for?",
      message: "Recorded with the group, so a promotion later can still say what was being attempted.",
      input: { label: "Goal", value: "" },
      confirm: "Next",
      run: async (goal) => {
        if (!goal) throw new Error("Say what the attempts are for.");
        setFanOut(goal);
      },
    });
  const makeAttempts = async (goal: string, count: number) => {
    const stem = branchStem(goal);
    const groupId = `${stem}-${Date.now().toString(36)}`;
    let made = 0;
    try {
      for (let i = 1; i <= count; i++) {
        await props.client.request(
          "attempt.new",
          { project: props.project.path, group_id: groupId, goal, branch: `${stem}-${i}` },
          ATTEMPT_REPLY_MS,
        );
        made++;
      }
    } catch (e) {
      throw new Error(`Created ${made} of ${count} attempts. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      props.onChanged();
    }
  };
  const attach = () =>
    setAsk({
      title: "Attach a branch",
      message: "An existing local branch, by name. It shows here as on the Mac.",
      input: { label: "Branch", value: "" },
      confirm: "Attach",
      run: (branch) =>
        props.client.request("branch.attach", { project: props.project.path, branch }).then(props.onChanged),
    });
  const git = watchGit(props.client, () => props.project.units.map((unit) => unit.folder));
  const sync = watchSync(props.client, () => props.project.units);
  const pr = watchPr(props.client, () => props.project);
  const sessions = () =>
    props.live().filter((row) => props.project.units.some((unit) => inUnit(row.home, unit))).length;
  const meta = () => {
    const units = unitCounts(props.project.units, DOT);
    return sessions() > 0 ? `${units} ${DOT} ${sessions()} live` : units;
  };
  return (
    <div class={styles.glow}>
      <PushTop back={props.space} space onBack={props.onBack} />
      <ConnectionBanner client={props.client} />
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
        <Show when={props.project.units.some((unit) => unit.kind === "worktree" || unit.kind === "plain")}>
          <ul class={styles.group}>
            <li>
              <button class={`${styles.item} ${styles.setting}`} onClick={fan}>
                <span class={styles.text}>Fan out</span>
              </button>
            </li>
          </ul>
        </Show>
        <Show when={props.project.units.some((unit) => unit.kind === "plain")}>
          <ul class={styles.group}>
            <li>
              <button class={`${styles.item} ${styles.setting}`} onClick={attach}>
                <span class={styles.text}>Attach a branch</span>
              </button>
            </li>
          </ul>
        </Show>
      </div>
      <Show when={ask()}>{(open) => <AskSheet ask={open()} onDone={() => setAsk(null)} />}</Show>
      <Show when={!ask() && fanOut()}>
        {(goal) => (
          <ChoiceSheet
            title="How many attempts?"
            message={goal()}
            choices={["2", "3", "4"].map((n) => ({ label: n, value: n }))}
            onPick={(n) => makeAttempts(goal(), Number(n))}
            onDone={() => setFanOut(null)}
          />
        )}
      </Show>
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
  onChanged: () => void;
}) {
  const [menu, setMenu] = createSignal(false);
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const [choice, setChoice] = createSignal<Parameters<typeof ChoiceSheet>[0] | null>(null);
  const id = () => props.topic.id;
  const call = (method: string, params: object) => props.client.request(method, params).then(props.onChanged);
  const done = { onDone: () => setChoice(null) };
  const open = (action: () => void) => () => {
    setMenu(false);
    action();
  };
  const rename = () =>
    setAsk({
      title: "Rename Topic",
      input: { label: "Name", value: props.topic.name },
      confirm: "Rename",
      run: (name) => call("topic.rename", { topic_id: id(), name }),
    });
  const remove = () =>
    setAsk({
      title: `Delete Topic \u201c${props.topic.name}\u201d?`,
      message: "Only the Topic goes. Its worktrees and branches stay as they are.",
      confirm: "Delete Topic",
      danger: true,
      run: () => call("topic.delete", { topic_id: id() }).then(props.onBack),
    });
  const addRepo = () => {
    const inTopic = new Set(props.topic.members.map((m) => m.repoPath));
    const repos: Choice[] = (props.tree?.spaces.flatMap((s) => s.projects) ?? [])
      .filter((p) => !inTopic.has(p.path))
      .map((p) => ({ label: p.name, meta: p.path, value: p.path }));
    let repoPath: string | null = null;
    const asMode = (repo: string) => ({
      title: "As a worktree or a reference?",
      message: "Reference is read only: the repository's own checkout.",
      choices: [
        { label: "Worktree", meta: `On ${props.topic.branch}`, value: "worktree" },
        { label: "Reference", value: "reference" },
      ],
      ...done,
      onPick: (mode: string) => call("topic.member.add", { topic_id: id(), repo_path: repo, mode }),
    });
    setChoice({
      title: `Add repository to ${props.topic.name}`,
      choices: repos,
      onPick: async (picked) => {
        repoPath = picked;
      },
      onDone: () => setChoice(repoPath ? asMode(repoPath) : null),
    });
  };
  const promote = () =>
    setChoice({
      title: "Promote a member",
      message: "A reference member gets its own worktree on the Topic branch.",
      choices: members()
        .filter(({ member }) => member.worktreePath === null)
        .map(({ member }) => ({ label: member.displayName, value: member.repoPath })),
      ...done,
      onPick: (repoPath) => call("topic.promote", { topic_id: id(), repo_path: repoPath }),
    });
  const moveUp = () =>
    setChoice({
      title: "Move a member up",
      choices: members()
        .slice(1)
        .map(({ member }) => ({ label: member.displayName, value: member.repoPath })),
      ...done,
      onPick: (repoPath) => {
        const order = members().map(({ member }) => member.repoPath);
        const at = order.indexOf(repoPath);
        [order[at - 1], order[at]] = [order[at], order[at - 1]];
        return call("topic.member.order", { topic_id: id(), repo_paths: order });
      },
    });
  const members = () =>
    [...props.topic.members]
      .sort((a, b) => a.order - b.order)
      .map((member) => ({ member, unit: memberUnit(props.tree, props.topic, member) }));
  const { here, earlier } = unitSessions(props.client, () => members().map((m) => m.unit), props.live, props.topic);
  const where = (row: SessionRow) => members().find((m) => atUnit(row, m.unit))?.member.displayName;
  return (
    <div class={styles.glow}>
      <PushTop
        back="Topics"
        onBack={props.onBack}
        end={
          <span class={styles.menuAnchor}>
            <button class={styles.more} aria-label="More" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
              <Icon icon={Ellipsis} size={20} strokeWidth={2} />
            </button>
            <Show when={menu()}>
              <span class={styles.menuDim} onClick={() => setMenu(false)} />
              <span class={styles.menu} role="menu">
                <button role="menuitem" onClick={open(rename)}>
                  Rename
                </button>
                <button role="menuitem" onClick={open(addRepo)}>
                  Add a repository
                </button>
                <button role="menuitem" onClick={open(promote)}>
                  Promote a member
                </button>
                <button role="menuitem" disabled={members().length < 2} onClick={open(moveUp)}>
                  Move a member up
                </button>
                <button role="menuitem" onClick={open(remove)}>
                  Delete Topic
                </button>
              </span>
            </Show>
          </span>
        }
      />
      <ConnectionBanner client={props.client} />
      <div class={styles.scroll}>
        <h1 class={styles.screenTitle}>{props.topic.name}</h1>
        <h2 class={styles.label}>
          Members {DOT} {members().length}
        </h2>
        <ul class={styles.group}>
          <For each={members()} fallback={<li class={styles.empty}>No members</li>}>
            {({ member, unit }) => (
              <UnitItem
                unit={unit}
                name={member.displayName}
                meta={unit.branch ?? props.topic.branch}
                live={props.live()}
                onOpen={() => props.onUnit(unit)}
              />
            )}
          </For>
        </ul>
        <SessionList
          here={here()}
          earlier={earlier()}
          crew={props.crew}
          autopilotOn={props.autopilotOn}
          where={where}
          onOpen={props.onOpen}
        />
      </div>
      <Show when={ask()}>{(a) => <AskSheet ask={a()} onDone={() => setAsk(null)} />}</Show>
      <Show when={choice()} keyed>
        {(c) => <ChoiceSheet {...c} />}
      </Show>
    </div>
  );
}

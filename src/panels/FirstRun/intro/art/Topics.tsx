import { For, Show, createMemo } from "solid-js";
import {
  Bug,
  ChevronRight,
  Ellipsis,
  FilePlus2,
  Files,
  GitCompare,
  GitPullRequest,
  ListTree,
  ListX,
  Plus,
  RefreshCw,
  Replace,
  Search,
  SquareTerminal,
  Star,
  Tag,
  Tags,
  TriangleAlert,
  type LucideIcon,
} from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Chevron from "../../../../components/Chevron/Chevron";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import ProjectIcon from "../../../../components/Icon/ProjectIcon";
import { BranchMark, WorktreeMark } from "../../../../components/Icon/gitMarks";
import MemberChip, { TabMemberChip } from "../../../../components/MemberChip/MemberChip";
import OverflowTabBar from "../../../../components/OverflowTabBar";
import Tab from "../../../../components/Tab/Tab";
import FileIcon from "../../../../seti/FileIcon";
import { Field, MatchToggles } from "../../../Editor/SearchFields";
import SpaceTile, { ModeTile } from "../../../LeftSidebar/SpaceTile";
import TopicItem from "../../../LeftSidebar/TopicItem";
import { BranchRow, ProjectRow } from "../../../LeftSidebar/SidebarRows";
import { DEFAULT_SEARCH_OPTIONS } from "../../../../utils/searchOptions";
import { paintRows } from "../../../../utils/syntaxRows";
import type { DiffRow } from "../../../../utils/diffView";
import { tintedMembers, type SpaceTint, type TintedMember } from "../../../../utils/topicMembers";
import type { Member, Topic } from "../../../../utils/topics";
import editor from "../../../Editor/Editor.module.css";
import search from "../../../Editor/SearchPanel.module.css";
import tree from "../../../Editor/FileTree/FileTree.module.css";
import sidebar from "../../../LeftSidebar/LeftSidebar.module.css";
import rows from "../../../LeftSidebar/SidebarRows.module.css";
import topicList from "../../../LeftSidebar/TopicList.module.css";
import toolbar from "../../../../components/Toolbar/Toolbar.module.css";
import MiniWindow from "./MiniWindow";
import styles from "./Topics.module.css";

const WORK = "~/Projects/work";
const PERSONAL = "~/Projects/personal";

const SPACES: SpaceTint[] = [
  { name: "work", color: "Sky", projects: [{ path: `${WORK}/api` }, { path: `${WORK}/web` }, { path: `${WORK}/infra` }] },
  { name: "personal", color: "Emerald", projects: [{ path: `${PERSONAL}/blog` }] },
];

function member(repoPath: string, branch: string, order: number): Member {
  const displayName = repoPath.split("/").pop()!;
  return { repoPath, displayName, worktreePath: `${repoPath}/.tori/worktrees/${branch}`, state: { kind: "present" }, order };
}

function topic(name: string, branch: string, repos: string[]): Topic {
  return { id: branch, name, branch, members: repos.map((r, i) => member(r, branch, i)), createdAt: 1 };
}

const WEBHOOKS = topic("Webhooks", "webhooks", [`${WORK}/api`, `${WORK}/web`]);
const DARK_MODE = topic("Dark mode", "dark-mode", [`${WORK}/web`, `${PERSONAL}/blog`]);

const MEMBERS = tintedMembers(WEBHOOKS, SPACES);
const [API, WEB] = MEMBERS;

const baseName = (rel: string) => rel.split("/").pop()!;

function Crumb() {
  return (
    <span class={styles.crumbBar}>
      <nav class={toolbar.tbCrumb} aria-label="location">
        <span class={`${toolbar.crumb} ${toolbar.leaf}`}>{WEBHOOKS.name}</span>
        <Icon icon={ChevronRight} class={`${toolbar.crumbSep} dim`} />
        <span class={`${toolbar.crumb} dim`}>{API.label}</span>
        <Icon icon={ChevronRight} class={`${toolbar.crumbSep} dim`} />
        <span class={`${toolbar.crumb} dim`}>{WEBHOOKS.branch}</span>
      </nav>
      <span class={toolbar.members}>
        <For each={MEMBERS}>
          {(m) => (
            <span class={toolbar.member} classList={{ [toolbar.memberActive]: m === API }} style={m.style}>
              <ProjectIcon {...m.icon} />
            </span>
          )}
        </For>
      </span>
    </span>
  );
}

function TopicsSidebar() {
  return (
    <div class={styles.sidebar}>
      <div class={`${sidebar.tree} ${rows.rowScope}`}>
        <div class={sidebar.treeHead}>
          <span class={sidebar.headStrut} aria-hidden="true" />
          <div class={sidebar.spaceHeader}>
            <span class={sidebar.spaceHeaderName}>Topics</span>
          </div>
          <Button class={sidebar.headAdd} variant="ghost" size="md" aria-label="New Topic" icon={<Icon icon={Plus} />} />
          <Button class={sidebar.searchToggle} variant="ghost" size="md" aria-label="Filter" icon={<Icon icon={Search} />} />
        </div>
        <div class={`${topicList.list} ${sidebar.topicList}`}>
          <ul class={topicList.items}>
            <TopicItem topic={DARK_MODE} spaces={SPACES} onRepair={() => {}} />
            <TopicItem topic={WEBHOOKS} spaces={SPACES} onRepair={() => {}} active expanded onExpand={() => {}} />
          </ul>
        </div>
        <div class={sidebar.spaceBar}>
          <div class={sidebar.stripNav}>
            <div class={sidebar.spaceScroll}>
              <SpaceTile name="work" color="Sky" />
              <SpaceTile name="personal" color="Emerald" />
            </div>
            <div class={sidebar.spaceDivider} />
            <ModeTile label="Topics" glyph={Tags} active nameWidth="60px" />
          </div>
          <span class={`${sidebar.stripBtn} ${sidebar.dockBtn}`}>
            <Icon icon={SquareTerminal} />
          </span>
        </div>
      </div>
    </div>
  );
}

type FileTab = { id: string; rel: string; member: TintedMember };

const FILE_TABS: FileTab[] = [
  { id: "retry", rel: "src/webhooks/retry.ts", member: API },
  { id: "deliver", rel: "src/webhooks/deliver.ts", member: API },
  { id: "settings", rel: "src/pages/settings/webhooks.tsx", member: WEB },
];

const RETRY = `import { deliver } from "./deliver";
import type { Webhook } from "./types";
import { sleep } from "../util/sleep";

// Seconds between tries, then give up.
const BACKOFF = [1, 5, 30, 120];

export async function retry(
  hook: Webhook,
  attempt = 0,
) {
  const res = await deliver(hook);
  if (res.ok) return res;
  const wait = BACKOFF[attempt];
  if (wait === undefined) return res;
  await sleep(wait * 1000);
  return retry(hook, attempt + 1);
}`;

const CARET_LINE = 13;

// Coloured by the diff rows' highlighter, which runs the editor's own tag
// table, so a keyword here is the colour it is in the real editor.
function Code(props: { path: string; text: string }) {
  const lines = props.text.split("\n");
  const asRows: DiffRow[] = lines.map((text, i) => ({ kind: "context", text: ` ${text}`, oldLine: i + 1, newLine: i + 1 }));
  const painted = createMemo(() => paintRows(asRows, props.path));
  return (
    <div class={styles.code}>
      <For each={lines}>
        {(line, i) => (
          <div class={styles.line} classList={{ [styles.caretLine]: i() + 1 === CARET_LINE }}>
            <span class={styles.lineNo}>{i() + 1}</span>
            <span>
              <Show when={painted()?.[i()]} fallback={line || " "}>
                {(spans) => <For each={spans()}>{(s) => <span class={s.cls ?? ""}>{s.text}</span>}</For>}
              </Show>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function EditorColumn() {
  return (
    <div class={styles.editor}>
      <OverflowTabBar
        class={editor.editorTabs}
        items={FILE_TABS}
        activeId="retry"
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={() => {}}
        renderTab={(t) => (
          <Tab
            value={t.id}
            icon={
              <>
                <TabMemberChip member={t.member} />
                <FileIcon name={baseName(t.rel)} />
              </>
            }
            onClose={() => {}}
          >
            {baseName(t.rel)}
          </Tab>
        )}
        renderMenuItem={(t) => <span>{`${t.member.label} / ${t.rel}`}</span>}
      />
      <Code path={FILE_TABS[0].rel} text={RETRY} />
    </div>
  );
}

type RightTab = { mode: string; label: string; icon: LucideIcon; count?: number };

const RIGHT_TABS: RightTab[] = [
  { mode: "files", label: "Files", icon: Files },
  { mode: "changes", label: "Changes", icon: GitCompare, count: 4 },
  { mode: "pulls", label: "Pull requests", icon: GitPullRequest },
  { mode: "problems", label: "Problems", icon: TriangleAlert },
  { mode: "search", label: "Search", icon: Search },
  { mode: "debug", label: "Debug", icon: Bug },
];

type Hit = { line: number; before: string; after: string };
type HitFile = { rel: string; hits: Hit[] };

const QUERY = "deliver";

const HITS: { member: TintedMember; files: HitFile[] }[] = [
  {
    member: API,
    files: [
      {
        rel: "src/webhooks/deliver.ts",
        hits: [
          { line: 9, before: "  const ", after: "yId = crypto.randomUUID();" },
          { line: 14, before: "  log.warn(`", after: "y to ${hook.url} failed`);" },
        ],
      },
      {
        rel: "src/webhooks/retry.ts",
        hits: [
          { line: 1, before: "import { ", after: ' } from "./deliver";' },
          { line: 12, before: "  const res = await ", after: "(hook);" },
        ],
      },
    ],
  },
  {
    member: WEB,
    files: [
      {
        rel: "src/pages/settings/webhooks.tsx",
        hits: [
          { line: 21, before: "  const { ", after: "ies } = useWebhook(id);" },
          { line: 48, before: "      <h2>Recent ", after: "ies</h2>" },
        ],
      },
    ],
  },
];

const hitsIn = (files: HitFile[]) => files.reduce((n, f) => n + f.hits.length, 0);
const indent = (depth: number, extra = 0) => ({ "padding-left": `calc(${depth * 12 + 8}px + ${extra} * var(--control-icon))` });

function SearchView() {
  return (
    <div class={search.searchPanel}>
      <div class={search.topBar}>
        <span class={search.title}>Search</span>
        <span class={search.spacer} />
        <IconButton size="sm" icon={<Icon icon={RefreshCw} />} aria-label="Refresh" />
        <IconButton size="sm" icon={<Icon icon={FilePlus2} />} aria-label="Open New Search Editor" />
        <IconButton size="sm" icon={<Icon icon={Star} />} aria-label="Saved Searches" />
        <IconButton size="sm" icon={<Icon icon={ListTree} />} aria-label="View as Tree" />
        <IconButton size="sm" icon={<Icon icon={Ellipsis} />} aria-label="Toggle Search Details" />
      </div>
      <div class={search.form}>
        <div class={search.queryRow}>
          <IconButton icon={<Icon icon={Replace} />} aria-label="Toggle Replace" />
          <Field value={QUERY} label="Search" onInput={() => {}}>
            <MatchToggles options={DEFAULT_SEARCH_OPTIONS} unsupported={[]} backend="rg" onToggle={() => {}} />
          </Field>
          <IconButton icon={<Icon icon={ListX} />} aria-label="Clear Search Results" />
        </div>
      </div>
      <div class={search.message}>
        {hitsIn(HITS.flatMap((s) => s.files))} results in {HITS.flatMap((s) => s.files).length} files{" - "}
        <span class={search.link}>Open in editor</span>
      </div>
      <div class={search.results}>
        <For each={HITS}>
          {(s) => (
            <div class={search.section}>
              <div class={`${tree.treeRow} ${search.row} ${search.memberRow}`}>
                <Chevron open />
                <MemberChip icon={s.member.icon} chipStyle={s.member.style} decorative />
                <span class={search.fileName}>{s.member.label}</span>
                <span class={search.rowEnd}>
                  <span class={search.badge}>{hitsIn(s.files)}</span>
                </span>
              </div>
              <For each={s.files}>
                {(f) => (
                  <>
                    <div class={`${tree.treeRow} ${search.row}`} style={indent(1)}>
                      <Chevron open />
                      <FileIcon name={baseName(f.rel)} />
                      <span class={search.fileName}>{baseName(f.rel)}</span>
                      <span class={search.fileDir}>{f.rel.slice(0, -baseName(f.rel).length - 1)}</span>
                      <span class={search.rowEnd}>
                        <span class={search.badge}>{f.hits.length}</span>
                      </span>
                    </div>
                    <For each={f.hits}>
                      {(h) => (
                        <div class={`${tree.treeRow} ${search.row}`} style={indent(1, 1.5)}>
                          <span class={search.matchText}>
                            {h.before}
                            <mark class={search.hit}>{QUERY}</mark>
                            {h.after}
                          </span>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function RightPanel() {
  return (
    <div class={`${editor.rightPanel} ${styles.right}`}>
      <OverflowTabBar
        class={editor.rightTabs}
        items={RIGHT_TABS}
        activeId="search"
        idOf={(t) => t.mode}
        onActivate={() => {}}
        onReorder={() => {}}
        renderTab={(t) => (
          <Tab
            value={t.mode}
            icon={<Icon icon={t.icon} />}
            aria-label={t.label}
            trailing={
              <Show when={t.count}>
                <span class={editor.tabCount}>{t.count}</span>
              </Show>
            }
          />
        )}
        renderMenuItem={(t) => <span>{t.label}</span>}
      />
      <SearchView />
    </div>
  );
}

function tagChip(t: Topic) {
  return <IconButton size="xs" class={rows.topicChip} icon={<Icon icon={Tag} />} aria-label={`Open Topic ${t.name}`} />;
}

// The same worktrees seen from their Space: ordinary branch rows, each with
// the tag that leads back to the Topic it was made for.
function SpaceCard() {
  return (
    <div class={`${rows.rowScope} ${styles.spaceCard}`}>
      <div class={sidebar.spaceHeader}>
        <span class={sidebar.spaceHeaderName}>work</span>
        <span class={sidebar.spaceHeaderKind}>{"\u00b7 Spaces"}</span>
      </div>
      <ProjectRow name="api" icon={<ProjectIcon seed={`${WORK}/api`} />} disclosure open>
        <BranchRow label="main" icon={<BranchMark active={false} current />} />
        <BranchRow label="fix/rate-limit" icon={<WorktreeMark active={false} />} />
        <BranchRow label="webhooks" icon={<WorktreeMark active={false} />} selected end={tagChip(WEBHOOKS)} />
      </ProjectRow>
      <ProjectRow name="web" icon={<ProjectIcon seed={`${WORK}/web`} />} disclosure open>
        <BranchRow label="main" icon={<BranchMark active={false} current />} />
        <BranchRow label="feat/search" icon={<WorktreeMark active={false} />} />
        <BranchRow label="webhooks" icon={<WorktreeMark active={false} />} end={tagChip(WEBHOOKS)} />
        <BranchRow label="dark-mode" icon={<WorktreeMark active={false} />} end={tagChip(DARK_MODE)} />
      </ProjectRow>
    </div>
  );
}

/** A Tori window in Topics mode: the real sidebar, editor tabs and Search
 *  panel on the Webhooks Topic, with the Space tree's tagged rows beside it. */
export default function TopicsArt() {
  return (
    <div class={styles.stage}>
      <MiniWindow height={400} zoom={0.62} bar={<Crumb />} class={styles.window}>
        <div class={styles.app}>
          <TopicsSidebar />
          <div class={styles.card}>
            <EditorColumn />
            <RightPanel />
          </div>
        </div>
      </MiniWindow>
      <SpaceCard />
    </div>
  );
}

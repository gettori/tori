import { For, type JSX } from "solid-js";
import { FileCode, Search, SquareTerminal, Tag, Tags } from "lucide-solid";
import AutopilotSwitch from "../../../../components/Autopilot/AutopilotSwitch";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import ProjectIcon from "../../../../components/Icon/ProjectIcon";
import { BranchMark, WorktreeMark } from "../../../../components/Icon/gitMarks";
import SyncMarks from "../../../../components/SyncMarks/SyncMarks";
import Tab from "../../../../components/Tab/Tab";
import { Tabs } from "../../../../lib/tabs";
import type { UnitStatus } from "../../../../utils/forgeTypes";
import type { Rollup } from "../../../../utils/sessionStatus";
import type { ToolSummary } from "../../../../utils/chatTypes";
import Composer from "../../../Chat/Composer";
import MessageList from "../../../Chat/MessageList";
import type { ChatItem, ToolItem } from "../../../Chat/chatStore";
import chat from "../../../Chat/Chat.module.css";
import BranchLine from "../../../LeftSidebar/BranchLine";
import { BranchRow, ProjectRow } from "../../../LeftSidebar/SidebarRows";
import SpaceTile, { ModeTile } from "../../../LeftSidebar/SpaceTile";
import StatusBubble from "../../../LeftSidebar/StatusBubble";
import sidebar from "../../../LeftSidebar/LeftSidebar.module.css";
import rows from "../../../LeftSidebar/SidebarRows.module.css";
import TabMark from "../../../Terminal/TabMark";
import MiniWindow from "./MiniWindow";
import styles from "./Sessions.module.css";

const API = "~/Projects/work/api";

const WEBHOOKS_PR: UnitStatus = {
  headRef: "feat/webhooks",
  pullRequest: {
    number: 216,
    title: "Sign webhook payloads",
    body: null,
    state: "open",
    isDraft: false,
    createdAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    comments: 2,
    author: "arif",
    headRef: "feat/webhooks",
    baseRef: "main",
    headSha: "4ea4d77",
    headRepoIsOrigin: true,
    url: "https://github.com/work/api/pull/216",
    mergeableState: "clean",
  },
  checks: { state: "success", total: 4, failing: 0, contexts: [] },
  reviewDecision: "reviewRequired",
};

function rollup(r: Partial<Rollup>): () => Rollup {
  return () => ({ waitingForApproval: 0, waitingForAnswer: 0, prAttention: 0, executing: 0, idle: 0, running: 0, ...r });
}

const bubble = (r: Partial<Rollup>) => <StatusBubble rollup={rollup(r)} />;

function tool(id: string, name: string, toolKind: ToolItem["toolKind"], input: unknown, summary: ToolSummary | null, running = false): ToolItem {
  return {
    kind: "tool",
    id,
    toolUseId: id,
    agentId: null,
    turnId: "t1",
    name,
    title: null,
    toolKind,
    locations: [],
    input,
    state: running ? "running" : "ok",
    approval: null,
    output: null,
    outputTruncated: false,
    summary,
    patch: [],
    files: [],
    durationMs: running ? null : 900,
    edits: [],
  };
}

const CHAT: ChatItem[] = [
  {
    kind: "user",
    id: "u1",
    blocks: [{ type: "text", text: "Cap the limiter at 100 a minute per key and send Retry-After" }],
    steer: false,
  },
  tool("e1", "Edit", "edit", { file_path: `${API}/src/limiter.ts` }, { type: "edit", added: 14, removed: 3 }),
  tool("b1", "Bash", "execute", { command: "pnpm test limiter" }, { type: "execute", exitCode: 0, lines: 18 }),
  {
    kind: "text",
    id: "a2",
    turnId: "t1",
    agentId: null,
    text: "Each key now gets 100 requests a minute, and a 429 carries `Retry-After` from the bucket's reset time. Limiter tests pass, running the full suite.",
  },
  tool("b2", "Bash", "execute", { command: "pnpm test" }, null, true),
];

function Sidebar() {
  return (
    <div class={`${sidebar.tree} ${rows.rowScope}`}>
      <div class={sidebar.treeHead}>
        <span class={sidebar.headStrut} />
        <div class={sidebar.spaceHeader}>
          <span class={sidebar.spaceHeaderName}>work</span>
          <span class={sidebar.spaceHeaderKind}>{"\u00b7 Spaces"}</span>
        </div>
        <Button class={sidebar.searchToggle} variant="ghost" size="md" aria-label="Filter" icon={<Icon icon={Search} />} />
      </div>
      <div class={`${sidebar.treeScroll} ${styles.treeScroll}`}>
        <ProjectRow name="api" icon={<ProjectIcon seed={API} />} disclosure open>
          <BranchRow label="main" icon={<BranchMark active={false} current />} />
          <BranchRow
            label="fix/rate-limit"
            icon={<WorktreeMark active />}
            selected
            end={
              <>
                <SyncMarks marks={[{ kind: "push", count: 2, tone: "muted", title: "2 commits to push" }]} label="2 commits to push" />
                {bubble({ executing: 1 })}
              </>
            }
          />
          <BranchRow
            label="feat/webhooks"
            icon={<WorktreeMark active={false} />}
            meta={<BranchLine status={WEBHOOKS_PR} />}
            end={
              <>
                <IconButton size="xs" class={rows.topicChip} icon={<Icon icon={Tag} />} aria-label="Open Topic Webhooks" />
                {bubble({ waitingForApproval: 1 })}
              </>
            }
          />
        </ProjectRow>
        <ProjectRow name="web" icon={<ProjectIcon seed="~/Projects/work/web" />} disclosure end={bubble({ waitingForAnswer: 1, executing: 1, idle: 1 })} />
        <ProjectRow name="infra" icon={<ProjectIcon seed="~/Projects/work/infra" />} disclosure open>
          <BranchRow label="main" icon={<BranchMark active={false} current />} end={bubble({ idle: 1 })} />
        </ProjectRow>
      </div>
      <div class={sidebar.spaceBar}>
        <div class={sidebar.stripNav}>
          <div class={sidebar.spaceScroll}>
            <SpaceTile name="work" color="Sky" active />
            <SpaceTile name="personal" icon="House" color="Emerald" rollup={rollup({ waitingForApproval: 1, executing: 1 })} />
          </div>
          <div class={sidebar.spaceDivider} />
          <ModeTile label="Topics" glyph={Tags} />
        </div>
        <span class={`${sidebar.stripBtn} ${sidebar.dockBtn}`}>
          <Icon icon={SquareTerminal} />
        </span>
      </div>
    </div>
  );
}

function Session(): JSX.Element {
  return (
    <div class={styles.card}>
      <Tabs.Root value="claude">
        <Tabs.List class={`unified-strip ${styles.strip}`} aria-label="Open tabs">
          <Tab value="claude" icon={<TabMark agentId="claude" status="executing" />} onClose={() => {}}>
            Cap the rate limiter
          </Tab>
          <Tab value="codex" icon={<TabMark agentId="codex" status="idle" />} onClose={() => {}}>
            Review limiter tests
          </Tab>
          <Tab value="file" icon={<Icon icon={FileCode} size={13} />} onClose={() => {}}>
            limiter.ts
          </Tab>
        </Tabs.List>
      </Tabs.Root>
      <div class={styles.stage}>
        <div class={`${chat.chat} ${chat.active}`}>
          <MessageList
            items={CHAT}
            streaming
            sessionId="intro-sessions"
            cwd={API}
            modelLabelFor={() => "Opus"}
            onSetMode={() => {}}
            onRevertHunk={async () => false}
          />
          <Composer
            running
            steering
            steerCost={null}
            queue={[]}
            attachments={[]}
            held={false}
            disabled={false}
            commands={[]}
            loadFiles={async () => []}
            onSend={() => {}}
            onInterrupt={() => {}}
            onDropQueued={() => {}}
            onDropAttachment={() => {}}
            onAttachFile={() => null}
            uploads={{ kinds: ["image"], gap: null }}
            onAttachUploads={async () => []}
            onAttachRejected={() => {}}
            onAttachPaths={() => []}
            draft=""
            onDraftChange={() => {}}
            history={[]}
            onSendQueued={() => {}}
            onDiscardQueued={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

const LEGEND: { label: string; rollup: Partial<Rollup> }[] = [
  { label: "Working", rollup: { executing: 1 } },
  { label: "Needs you", rollup: { waitingForApproval: 1 } },
  { label: "Done", rollup: { idle: 1 } },
  { label: "Rolled up", rollup: { waitingForAnswer: 1, executing: 1, idle: 1 } },
];

/** Slide 01: the real sidebar tree beside the session it has selected, in one miniature window. */
export default function SessionsArt() {
  return (
    <div class={styles.frame}>
      <MiniWindow height={470} zoom={0.8} end={<AutopilotSwitch view="workspace" state="idle" />}>
        <div class={styles.app}>
          <aside class={styles.sidebar}>
            <Sidebar />
          </aside>
          <div class={styles.workspace}>
            <Session />
          </div>
        </div>
      </MiniWindow>
      <div class={styles.legend} inert>
        <For each={LEGEND}>
          {(l) => (
            <>
              <span class={styles.legendMark}>{bubble(l.rollup)}</span>
              <span>{l.label}</span>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

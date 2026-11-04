import { For, Show } from "solid-js";
import { ChevronDown, ChevronLeft, ChevronRight, History, Plus, SquareTerminal } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import OverflowTabBar from "../../../../components/OverflowTabBar";
import SegmentedControl from "../../../../components/SegmentedControl/SegmentedControl";
import Tab from "../../../../components/Tab/Tab";
import popover from "../../../../components/Popover/Popover.module.css";
import toolbar from "../../../../components/Toolbar/Toolbar.module.css";
import Composer from "../../../Chat/Composer";
import MessageList from "../../../Chat/MessageList";
import ModeSelector from "../../../Chat/ModeSelector";
import type { ChatItem, ToolItem } from "../../../Chat/chatStore";
import chat from "../../../Chat/Chat.module.css";
import timeline from "../../../Editor/CheckpointTimeline.module.css";
import DiffRows, { diffRowClasses } from "../../../Editor/DiffRows";
import review from "../../../Editor/ReviewPanel.module.css";
import TabMark from "../../../Terminal/TabMark";
import term from "../../../Terminal/Terminal.module.css";
import { buildRows } from "../../../../utils/diffView";
import type { SessionStatus } from "../../../../utils/sessionStatus";
import MiniWindow from "./MiniWindow";
import styles from "./Terminal.module.css";

type SessionTab = { id: string; title: string; agent?: string; status?: SessionStatus };

const TABS: SessionTab[] = [
  { id: "chat", title: "Cap the rate limiter", agent: "claude", status: "executing" },
  { id: "codex", title: "Review the limiter", agent: "codex", status: "waitingForApproval" },
  { id: "shell", title: "zsh" },
];

const CWD = "~/Projects/work/api/fix";

function tool(id: string, over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id,
    toolUseId: id,
    agentId: null,
    turnId: "t12",
    name: "Bash",
    title: null,
    toolKind: "execute",
    locations: [],
    input: {},
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    state: "ok",
    durationMs: null,
    approval: null,
    edits: [],
    secret: null,
    blindEdits: [],
    files: [],
    ...over,
  };
}

const say = (id: string, text: string): ChatItem => ({
  kind: "user",
  id,
  blocks: [{ type: "text", text }],
  steer: false,
});

const ITEMS: ChatItem[] = [
  say("u12", "cap the limiter at 100 requests a minute per key"),
  tool("e1", {
    name: "Edit",
    toolKind: "edit",
    input: { file_path: `${CWD}/src/limiter.ts` },
    summary: { type: "edit", added: 14, removed: 3 },
    durationMs: 90,
  }),
  tool("b1", {
    name: "Bash",
    input: { command: "pnpm test limiter" },
    summary: { type: "execute", exitCode: 0, lines: 22 },
    durationMs: 4200,
  }),
  {
    kind: "text",
    id: "x12",
    turnId: "t12",
    agentId: null,
    text: "Each key now gets 100 requests a minute from a sliding window in `src/limiter.ts`, and the 101st is refused with a 429. All 18 limiter tests pass.",
  },
  say("u13", "now send the Retry-After header"),
  tool("e2", {
    turnId: "t13",
    name: "Edit",
    toolKind: "edit",
    input: { file_path: `${CWD}/src/limiter.ts` },
    summary: { type: "edit", added: 3, removed: 1 },
    durationMs: 70,
  }),
  tool("b2", { turnId: "t13", name: "Bash", input: { command: "pnpm test limiter" }, state: "running" }),
];

const DOT = "\u00b7";

const FILES = [
  { name: "limiter.ts", dir: "src", added: 3, removed: 1, open: true },
  { name: "limiter.test.ts", dir: "test", added: 12, removed: 0, open: false },
];

const HUNK = [
  "   if (bucket.count >= LIMIT) {",
  "-    return res.status(429).end()",
  "+    const wait = bucket.resetIn()",
  "+    res.setHeader('Retry-After', wait)",
  "+    return res.status(429).end()",
  "   }",
];

function Strip() {
  return (
    <OverflowTabBar
      class={`unified-strip ${term.termTabs}`}
      items={TABS}
      activeId="chat"
      idOf={(t) => t.id}
      onActivate={() => {}}
      onReorder={() => {}}
      renderTab={(t) => (
        <Tab
          value={t.id}
          icon={
            t.agent ? (
              <TabMark agentId={t.agent} status={t.status ?? null} certainty="exact" />
            ) : (
              <Icon icon={SquareTerminal} />
            )
          }
          onClose={() => {}}
        >
          {t.title}
        </Tab>
      )}
      renderMenuItem={(t) => <span>{t.title}</span>}
      trailing={
        <>
          <div class={term.termNewSplit}>
            <button type="button" class={`${term.termNew} ${term.termNewMain}`} aria-label="New chat">
              <Icon icon={Plus} />
            </button>
            <span class={term.termNewCaretWrap}>
              <button type="button" class={`${term.termNew} ${term.termNewCaret}`} aria-label="Launch an agent session">
                <Icon icon={ChevronDown} class={term.termNewChevron} />
              </button>
            </span>
          </div>
          <button type="button" class={`${term.termNew} ${term.termHistory}`} aria-label="Session history">
            <Icon icon={History} />
          </button>
        </>
      }
    />
  );
}

function Session() {
  return (
    <div class={`${chat.chat} ${chat.active}`}>
      <MessageList
        items={ITEMS}
        streaming
        sessionId="intro"
        cwd={CWD}
        modelLabelFor={() => null}
        onSetMode={() => {}}
        onRevertHunk={async () => false}
      />
      <Composer
        running
        steering
        steerCost={null}
        queue={[]}
        attachments={[]}
        parked={false}
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
        controls={
          <ModeSelector
            mode="acceptEdits"
            modes={[{ id: "acceptEdits", label: "Accept edits", hint: "", args: [] }]}
            pending={false}
            disabled={false}
            onSelect={() => {}}
          />
        }
      />
    </div>
  );
}

const HISTORY_TABS = [
  { id: "graph", label: "Graph", count: 0 },
  { id: "stashes", label: "Stashes", count: 0 },
  { id: "checkpoints", label: "Checkpoints", count: 13 },
];

// The Changes panel's Checkpoints tab with a turn opened, drawn from its own
// stylesheets: the live panel lists refs through the backend, so its markup is
// repeated here.
function Checkpoints() {
  return (
    <div class={`${popover.surface} ${styles.card}`} inert>
      <OverflowTabBar
        class={`${review.tabStrip} ${styles.cardTabs}`}
        items={HISTORY_TABS}
        activeId="checkpoints"
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={() => {}}
        renderTab={(t) => (
          <Tab
            quiet
            value={t.id}
            trailing={
              <Show when={t.count}>
                <span class={review.tabCount}>{t.count}</span>
              </Show>
            }
          >
            {t.label}
          </Tab>
        )}
        renderMenuItem={(t) => <span>{t.label}</span>}
      />
      <div class={timeline.panel}>
        <button type="button" class={timeline.back}>
          <Icon icon={ChevronLeft} />
          Checkpoints
        </button>
        <div class={timeline.detailHead}>
          <div class={timeline.detailTitle}>now send the Retry-After header</div>
          <div class={timeline.detailMeta}>{["10:24", "Chat", "Cap the rate limiter"].join(` ${DOT} `)}</div>
        </div>
        <SegmentedControl
          class={timeline.range}
          size="sm"
          aria-label="Which changes to list"
          value="turn"
          onChange={() => {}}
          options={[
            { value: "turn", label: `This turn ${DOT} 2` },
            { value: "since", label: `Since here ${DOT} 2` },
          ]}
        />
        <For each={FILES}>
          {(f) => (
            <div>
              <div class={timeline.fileRow}>
                <span class={timeline.fileStatus}>M</span>
                <button type="button" class={timeline.fileMain} aria-expanded={f.open}>
                  <span class={timeline.fileName}>{f.name}</span>
                  <span class={timeline.fileDir}>{f.dir}</span>
                </button>
                <span class={timeline.added}>+{f.added}</span>
                <span class={timeline.removed}>-{f.removed}</span>
              </div>
              <Show when={f.open}>
                <div class={timeline.fileDiff}>
                  <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>@@ -31,4 +31,6 @@</div>
                  <DiffRows rows={buildRows(HUNK, { old: 31, new: 31 })} path="src/limiter.ts" twoColumn={false} />
                </div>
              </Show>
            </div>
          )}
        </For>
        <div class={timeline.footer}>
          <Button variant="primary" class={timeline.action}>
            Revert tree to 10:24
          </Button>
          <Button class={timeline.action}>Rewind chat to here</Button>
          <div class={timeline.footNote}>Current state is saved as a backstop first.</div>
        </div>
      </div>
    </div>
  );
}

/** Slide 04: the real tab strip and chat on a session mid-turn, with the
 *  Changes panel's Checkpoints tab open on the turn it is running. */
export default function TerminalArt() {
  return (
    <div class={styles.art}>
      <MiniWindow
        height={470}
        zoom={0.7}
        bar={
          <nav class={toolbar.tbCrumb} aria-label="location">
            <span class={`${toolbar.crumb} dim`}>work</span>
            <Icon icon={ChevronRight} class={`${toolbar.crumbSep} dim`} />
            <span class={`${toolbar.crumb} dim`}>api</span>
            <Icon icon={ChevronRight} class={`${toolbar.crumbSep} dim`} />
            <span class={`${toolbar.crumb} ${toolbar.leaf}`}>fix/rate-limit</span>
          </nav>
        }
      >
        <div class={styles.center}>
          <Strip />
          <div class={styles.stage}>
            <Session />
          </div>
        </div>
      </MiniWindow>
      <Checkpoints />
    </div>
  );
}

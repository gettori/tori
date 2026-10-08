import { For, Show } from "solid-js";
import { ChevronDown, ChevronRight, History, Plus, SquareTerminal } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import OverflowTabBar from "../../../../components/OverflowTabBar";
import Switch from "../../../../components/Switch/Switch";
import Tab from "../../../../components/Tab/Tab";
import popover from "../../../../components/Popover/Popover.module.css";
import toolbar from "../../../../components/Toolbar/Toolbar.module.css";
import Composer from "../../../Chat/Composer";
import MessageList from "../../../Chat/MessageList";
import ModeSelector from "../../../Chat/ModeSelector";
import type { ChatItem, ToolItem } from "../../../Chat/chatStore";
import chat from "../../../Chat/Chat.module.css";
import timeline from "../../../Editor/CheckpointTimeline.module.css";
import review from "../../../Editor/ReviewPanel.module.css";
import TabMark from "../../../Terminal/TabMark";
import term from "../../../Terminal/Terminal.module.css";
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

const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
const CHIPS = Array.from({ length: 13 }, (_, i) => ({ at: clock(580 + i * 6), files: [2, 1, 3, 1, 2][i % 5] }));

const DIFF: { kind: "hunk" | "ctx" | "add" | "del"; text: string }[] = [
  { kind: "hunk", text: "@@ -31,4 +31,6 @@" },
  { kind: "ctx", text: "   if (bucket.count >= LIMIT) {" },
  { kind: "del", text: "-    return res.status(429).end()" },
  { kind: "add", text: "+    const wait = bucket.resetIn()" },
  { kind: "add", text: "+    res.setHeader('Retry-After', wait)" },
  { kind: "add", text: "+    return res.status(429).end()" },
  { kind: "ctx", text: "   }" },
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

// The Changes panel's Checkpoints tab, drawn from its own stylesheets: the live
// timeline lists refs through the backend, so its markup is repeated here.
function Checkpoints() {
  const tabs = [{ label: "Graph" }, { label: "Stashes" }, { label: "Checkpoints", count: 13, on: true }];
  return (
    <div class={`${popover.surface} ${styles.card}`} inert>
      <div class={`${review.tabStrip} ${styles.cardTabs}`}>
        <div class={review.tabs} role="tablist" aria-label="History">
          <For each={tabs}>
            {(t) => (
              <button type="button" role="tab" class={review.tab} aria-selected={!!t.on}>
                <span>{t.label}</span>
                <Show when={t.count}>
                  <span class={review.tabCount}>{t.count}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class={timeline.timeline}>
        <div class={timeline.timelineHeader}>
          <span class={timeline.timelineTitle}>Timeline</span>
          <Switch class={timeline.cumulativeToggle} checked={false} onChange={() => {}} label="workspace since here" />
        </div>
        <div class={`${timeline.strip} ${styles.chips}`}>
          <For each={[...CHIPS].reverse()}>
            {(c, i) => (
              <button type="button" class={`${timeline.turnChip} ${i() === 0 ? timeline.turnChipActive : ""}`}>
                <span class={timeline.turnTime}>{c.at}</span>
                <span class={timeline.turnCount}>{c.files}</span>
              </button>
            )}
          </For>
        </div>
        <div class={timeline.timelineActions}>
          <Button size="sm">Revert tree to here</Button>
        </div>
        <div class={timeline.timelineRow}>
          <span class={`${timeline.timelineStatus} ${timeline.modified}`}>M</span>
          <span class={timeline.timelineName}>src/limiter.ts</span>
        </div>
        <div class={timeline.timelineDiff}>
          <For each={DIFF}>
            {(l) => <div class={`${timeline.diffLine} ${l.kind === "ctx" ? "" : timeline[l.kind]}`}>{l.text}</div>}
          </For>
        </div>
        <div class={timeline.timelineRow}>
          <span class={`${timeline.timelineStatus} ${timeline.modified}`}>M</span>
          <span class={timeline.timelineName}>test/limiter.test.ts</span>
        </div>
      </div>
    </div>
  );
}

/** Slide 04: the real tab strip and chat on a session mid-turn, with the
 *  Changes panel's checkpoint timeline for the turn it is running. */
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

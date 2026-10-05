import { For, Show } from "solid-js";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  Ellipsis,
  FileCode,
  Files,
  GitBranch,
  GitCompare,
  GitPullRequest,
  GitPullRequestArrow,
  MessageSquare,
  MessagesSquare,
  Minus,
  Pilcrow,
  Plus,
  RefreshCw,
  Search,
  SquareCode,
  Undo2,
} from "lucide-solid";
import AutopilotSwitch from "../../../../components/Autopilot/AutopilotSwitch";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import Tab from "../../../../components/Tab/Tab";
import Tooltip from "../../../../components/Tooltip/Tooltip";
import { Tabs } from "../../../../lib/tabs";
import FileIcon from "../../../../seti/FileIcon";
import { parseDiffHunks } from "../../../../utils/diffHunks";
import { buildRows } from "../../../../utils/diffView";
import { composeHunkComment } from "../../../../utils/safeSend";
import MessageList from "../../../Chat/MessageList";
import type { ChatItem } from "../../../Chat/chatStore";
import chat from "../../../Chat/Chat.module.css";
import DiffRows, { diffRowClasses } from "../../../Editor/DiffRows";
import diffView from "../../../Editor/DiffView.module.css";
import editor from "../../../Editor/Editor.module.css";
import hunkStyles from "../../../Editor/HunkCommentInput.module.css";
import review from "../../../Editor/ReviewPanel.module.css";
import TabMark from "../../../Terminal/TabMark";
import MiniWindow from "./MiniWindow";
import styles from "./Review.module.css";

const API = "~/Projects/work/api";
const FILE = "src/limiter.ts";
const COMMENT = "Use the reset timestamp, not the window length.";
const MESSAGE = "Send Retry-After when the limiter caps";

const DIFF = [
  "@@ -15,7 +15,10 @@ export function take(key: string, res: Response) {",
  "   const limit = limits.perMinute",
  "   const reset = limits.windowSeconds",
  "   const bucket = buckets.get(key)",
  "-  if (bucket.count > limit) return false",
  "+  if (bucket.count >= limit) {",
  "+    res.setHeader('Retry-After', reset)",
  "+    return false",
  "+  }",
  "   bucket.count++",
  "   return true",
  " }",
].join("\n");

const HUNK = parseDiffHunks(DIFF)[0];

type Change = { status: string; path: string };
const STAGED: Change[] = [
  { status: "A", path: "src/middleware/retry.ts" },
  { status: "M", path: "src/limiter.test.ts" },
];
const UNSTAGED: Change[] = [{ status: "M", path: FILE }];

const STATUS_CLASS: Record<string, string> = { A: review.added, M: review.modified };

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// Built by the same function the comment box sends through, so the turn the
// session receives is word for word what the app would write.
const SENT = composeHunkComment(
  { sessionId: "s1", agent: "claude", profile: null, sessionCwd: API, folderPath: API },
  `${API}/${FILE}`,
  HUNK.startLine,
  HUNK.endLine,
  COMMENT,
);

const CHAT: ChatItem[] = [
  { kind: "user", id: "u1", blocks: [{ type: "text", text: SENT }], steer: false },
  {
    kind: "text",
    id: "a1",
    turnId: "t1",
    agentId: null,
    text: "Right, it should count down to the bucket's reset. Sending `bucket.resetAt` instead.",
  },
];

function FileRow(props: { change: Change; staged: boolean; active?: boolean }) {
  return (
    <div class={review.reviewRow} classList={{ [review.active]: props.active }}>
      <FileIcon name={baseName(props.change.path)} />
      <span class={review.reviewName}>{baseName(props.change.path)}</span>
      <Show when={dirName(props.change.path)}>
        <span class={review.reviewDir}>{dirName(props.change.path)}</span>
      </Show>
      <span class={review.rowEnd}>
        <IconButton size="xs" icon={<Icon icon={FileCode} />} aria-label="Open file" />
        <IconButton size="xs" icon={<Icon icon={Copy} />} aria-label="Copy diff" />
        <Show when={!props.staged}>
          <IconButton size="xs" icon={<Icon icon={Undo2} />} aria-label="Discard" />
        </Show>
        <IconButton
          size="xs"
          icon={<Icon icon={props.staged ? Minus : Plus} />}
          aria-label={props.staged ? "Unstage" : "Stage"}
        />
      </span>
      <span class={`${review.reviewStatus} ${STATUS_CLASS[props.change.status]}`}>{props.change.status}</span>
    </div>
  );
}

/** The Changes panel's own markup and classes, filled by hand: the component
 *  itself reads git through the backend on mount. */
function ChangesPanel() {
  const tabs = [
    { mode: "files", label: "Files", icon: Files },
    { mode: "changes", label: "Changes", icon: GitCompare },
    { mode: "pulls", label: "Pull requests", icon: GitPullRequest },
    { mode: "search", label: "Search", icon: Search },
    { mode: "session", label: "Session", icon: MessagesSquare },
  ];
  return (
    <div class={`${editor.rightPanel} ${styles.right}`}>
      <Tabs.Root value="changes">
        <Tabs.List class={editor.rightTabs} aria-label="Right panel">
          <For each={tabs}>
            {(t) => (
              <Tab
                value={t.mode}
                icon={<Icon icon={t.icon} />}
                aria-label={t.label}
                trailing={
                  <Show when={t.mode === "changes"}>
                    <span class={editor.tabCount}>3</span>
                  </Show>
                }
              />
            )}
          </For>
        </Tabs.List>
      </Tabs.Root>
      <div class={review.reviewPanel}>
        <div class={review.topBar}>
          <span class={review.title}>Source Control</span>
          <span class={review.spacer} />
          <IconButton size="sm" icon={<Icon icon={RefreshCw} />} aria-label="Refresh" />
          <IconButton size="sm" icon={<Icon icon={Ellipsis} />} aria-label="More Actions" />
        </div>
        <div class={review.branchBar}>
          <Icon icon={GitBranch} />
          <span class={review.branchName}>fix/rate-limit</span>
          <span class={review.spacer} />
          <Tooltip as="button" type="button" class={review.aheadPill} label="Push">
            {"\u21913"}
          </Tooltip>
          <IconButton size="sm" icon={<Icon icon={GitPullRequestArrow} />} aria-label="Open PR" />
        </div>
        <div class={review.commitCard}>
          <textarea class={review.commitInput} rows={1} placeholder="Message">
            {MESSAGE}
          </textarea>
          <div class={review.commitFooter}>
            <span class={review.commitStats}>2 files</span>
            <div class={review.commitActions}>
              <Button size="sm" variant="ghost">
                AI Draft
              </Button>
              <span class={review.splitButton}>
                <Button variant="primary" size="sm" class={review.commitButton}>
                  Commit
                </Button>
                <IconButton
                  size="sm"
                  class={review.splitMore}
                  icon={<Icon icon={ChevronDown} />}
                  aria-label="More commit actions"
                />
              </span>
            </div>
          </div>
        </div>
        <div class={review.stack}>
          <div class={review.changesBody}>
            <div class={review.memberSection}>
              <div class={review.groupHeader}>Staged Changes</div>
              <For each={STAGED}>{(c) => <FileRow change={c} staged />}</For>
              <div class={review.groupHeader}>Changes</div>
              <For each={UNSTAGED}>{(c) => <FileRow change={c} staged={false} active />}</For>
            </div>
          </div>
          <section class={review.history}>
            <div class={review.tabStrip}>
              <div class={review.tabs} role="tablist" aria-label="History">
                <button type="button" role="tab" class={review.tab} aria-selected="true">
                  <span>Graph</span>
                </button>
                <button type="button" role="tab" class={review.tab} aria-selected="false">
                  <span>Stashes</span>
                </button>
                <button type="button" role="tab" class={review.tab} aria-selected="false">
                  <span>Checkpoints</span>
                  <span class={review.tabCount}>13</span>
                </button>
              </div>
              <span class={review.spacer} />
              <IconButton size="sm" icon={<Icon icon={ChevronUp} />} aria-label="Expand" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function gap(lines: number) {
  return <div class={`${diffRowClasses.line} ${diffView.diffGap}`}>{`\u22ef ${lines} unchanged lines`}</div>;
}

/** The diff tab: DiffView's chrome around the real DiffRows, with the hunk's
 *  comment box open on the line the agent got wrong. */
function DiffPane() {
  return (
    <div class={styles.center}>
      <Tabs.Root value="diff">
        <Tabs.List class={editor.editorTabs} aria-label="Open files">
          <Tab value="diff" icon={<Icon icon={GitCompare} />} onClose={() => {}}>
            limiter.ts (Working tree)
          </Tab>
          <Tab value="retry" icon={<FileIcon name="retry.ts" />} onClose={() => {}}>
            retry.ts
          </Tab>
          <Tab value="test" icon={<FileIcon name="limiter.test.ts" />} onClose={() => {}}>
            limiter.test.ts
          </Tab>
        </Tabs.List>
      </Tabs.Root>
      <div class={diffView.diffView}>
        <div class={diffView.topBar}>
          <span class={`${diffView.status} ${diffView.modified}`}>M</span>
          <span class={diffView.name}>limiter.ts</span>
          <span class={diffView.dir}>src</span>
          <span class={diffView.mode}>Working tree</span>
          <span class={diffView.spacer} />
          <IconButton size="sm" icon={<Icon icon={Plus} />} aria-label="Stage this file" />
          <IconButton size="sm" icon={<Icon icon={Undo2} />} aria-label="Discard" />
          <IconButton size="sm" icon={<Icon icon={Copy} />} aria-label="Copy diff" />
          <IconButton size="sm" icon={<Icon icon={FileCode} />} aria-label="Open the file" />
          <IconButton size="sm" icon={<Icon icon={Pilcrow} />} aria-label="Ignore whitespace" />
          <IconButton size="sm" icon={<Icon icon={Columns2} />} aria-label="Side by side" />
          <IconButton size="sm" icon={<Icon icon={SquareCode} />} aria-label="Editor layout" />
          <IconButton size="sm" icon={<Icon icon={RefreshCw} />} aria-label="Re-read" />
        </div>
        <div class={diffView.body}>
          {gap(14)}
          <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${hunkStyles.hunkHeaderRow}`}>
            <span class={hunkStyles.hunkHeaderText}>{HUNK.header}</span>
            <IconButton size="sm" icon={<Icon icon={Plus} />} aria-label="Stage this hunk" />
            <IconButton size="sm" icon={<Icon icon={Undo2} />} aria-label="Throw away this hunk" />
            <IconButton size="sm" icon={<Icon icon={MessageSquare} />} active aria-label="Comment on this hunk" />
            <div class={`${hunkStyles.commentBox} ${styles.commentBox}`}>
              <input class={hunkStyles.commentInput} type="text" value={COMMENT} />
              <Button size="xs">Send</Button>
            </div>
          </div>
          <DiffRows
            rows={buildRows(HUNK.lines, { old: HUNK.oldStart, new: HUNK.startLine })}
            path={FILE}
            twoColumn={false}
          />
          {gap(38)}
        </div>
      </div>
    </div>
  );
}

/** Slide 05: the diff tab beside the real Changes panel, and the hunk comment
 *  landing in the session at full size. */
export default function ReviewArt() {
  return (
    <div class={styles.stage}>
      <MiniWindow height={470} zoom={0.72} bar={<AutopilotSwitch view="workspace" state="idle" />}>
        <div class={styles.body}>
          <DiffPane />
          <ChangesPanel />
        </div>
      </MiniWindow>
      <div class={styles.session} inert>
        <Tabs.Root value="claude">
          <Tabs.List class={`unified-strip ${styles.sessionStrip}`} aria-label="Session">
            <Tab value="claude" icon={<TabMark agentId="claude" status="executing" />}>
              Cap the rate limiter
            </Tab>
          </Tabs.List>
        </Tabs.Root>
        <div class={styles.transcript}>
          <div class={`${chat.chat} ${chat.active}`}>
            <MessageList
              items={CHAT}
              streaming={false}
              sessionId="intro-review"
              cwd={API}
              modelLabelFor={() => null}
              onSetMode={() => {}}
              onRevertHunk={async () => false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

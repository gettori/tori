import { For, Show, createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import Composer from "./Composer";
import LaneStrip from "./LaneStrip";
import PlanCard from "./PlanCard";
import AskCard from "./AskCard";
import ModelPicker from "./ModelPicker";
import ModeSelector from "./ModeSelector";
import ConfigMirror from "./ConfigMirror";
import FollowToggle from "./FollowToggle";
import LockedBar from "../../components/Autopilot/LockedBar";
import { lockedProvider } from "./agentPaletteData";
import type { Lane, QueuedInput } from "./chatStore";
import type { StashEntry } from "./promptStash";
import type { UploadFile } from "./composerAttachments";
import {
  attachmentKind,
  diagnosticBlocks,
  fileMentionBlocks,
  hunkCommentBlocks,
  selectionBlocks,
  todoBlocks,
  type AttachmentKind,
  type AttachmentSource,
  type PendingBlock,
} from "../../utils/chatCompose";
import type { Adapter, ChatMode } from "../../utils/agents";
import type { PickableModel } from "../../utils/chatModels";
import type { ChatConfigOption, ContentBlock, PlanItem, SlashCommand } from "../../utils/chatTypes";
import type { PullRequest } from "../../utils/forgeTypes";
import type { SessionMeta } from "../../utils/sessionStore";
import type { NavSpace } from "../../utils/mentionNavigator";
import type { SocketAsk } from "../../utils/socketAsks";
import { prLabel, prRef } from "../../utils/prMention";
import styles from "./Chat.module.css";

const ROOT = "/work/tori";
const NOW = Date.now();

function shot(hue: number, caption: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="hsl(${hue} 45% 30%)"/><rect x="16" y="16" width="288" height="24" rx="4" fill="hsl(${hue} 45% 45%)"/><rect x="16" y="56" width="180" height="12" rx="3" fill="hsl(${hue} 30% 60%)"/><rect x="16" y="76" width="240" height="12" rx="3" fill="hsl(${hue} 30% 60%)"/><text x="16" y="180" font-family="sans-serif" font-size="16" fill="white">${caption}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const IMAGE_FILES: Record<string, string> = {
  [`${ROOT}/.tori/attachments/screenshot-2026-10-28.png`]: shot(210, "screenshot"),
  [`${ROOT}/.tori/attachments/login-error.png`]: shot(0, "login error"),
  [`${ROOT}/.tori/attachments/mockup.jpg`]: shot(140, "mockup"),
  [`${ROOT}/docs/diagram-with-a-really-long-file-name-that-will-not-fit.webp`]: shot(280, "diagram"),
};

// Image chips draw through the asset protocol, and the workshop has no Tauri
// host behind it, so the protocol is answered with drawn placeholders.
function stubAssets() {
  mockConvertFileSrc("macos");
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } })
    .__TAURI_INTERNALS__;
  internals.convertFileSrc = (path) => IMAGE_FILES[path] ?? shot(30, path.split("/").pop() ?? "image");
}

const KIND_NAMES: Record<AttachmentKind, string> = { image: "Image", pdf: "PDF", file: "File" };

function chip(id: string, block: ContentBlock): PendingBlock {
  return { id, block };
}

function upload(id: string, path: string, n: number): PendingBlock {
  const kind = attachmentKind(path) ?? "file";
  return chip(id, fileMentionBlocks(path, `[${KIND_NAMES[kind]} ${n}]`)[0]);
}

const IMAGE_1 = upload("img1", `${ROOT}/.tori/attachments/screenshot-2026-10-28.png`, 1);
const IMAGE_2 = upload("img2", `${ROOT}/.tori/attachments/login-error.png`, 2);
const IMAGE_3 = upload("img3", `${ROOT}/.tori/attachments/mockup.jpg`, 3);
const IMAGE_LONG = upload("img4", `${ROOT}/docs/diagram-with-a-really-long-file-name-that-will-not-fit.webp`, 4);
const IMAGE_BYTES = chip("bytes", {
  type: "image",
  mediaType: "image/svg+xml",
  data: shot(50, "pasted bytes").split(",")[1],
});

const PDF_1 = upload("pdf1", `${ROOT}/.tori/attachments/spec-v2.pdf`, 1);
const PDF_2 = upload("pdf2", `${ROOT}/.tori/attachments/invoice-october.pdf`, 2);

const FILE_1_PATH = `${ROOT}/src/panels/Chat/Composer.tsx`;
const FILE_1 = upload("file1", FILE_1_PATH, 1);
const FILE_2 = upload("file2", `${ROOT}/src-tauri/src/chat/mod.rs`, 2);
const FILE_PASTED = upload("file3", `${ROOT}/.tori/attachments/pasted.txt`, 3);
const FILE_JSON = upload("file4", `${ROOT}/package.json`, 4);

const MENTION = chip("mention", fileMentionBlocks(`${ROOT}/src/utils/chatCompose.ts`)[0]);
const SELECTION = chip(
  "sel",
  selectionBlocks(`${ROOT}/src/panels/Chat/LaneStrip.tsx`, 40, 58, "const isLive = (l: Lane) => ...")[0],
);
const SELECTION_LINE = chip("sel1", selectionBlocks(`${ROOT}/src/App.tsx`, 12, 12, "import Chat from ...")[0]);
const PDF_PAGES = chip("pages", selectionBlocks(`${ROOT}/.tori/attachments/spec-v2.pdf`, 3, 5, "")[0]);

const [HUNK_REF, HUNK_TEXT] = hunkCommentBlocks(
  `${ROOT}/src/utils/queue.ts`,
  88,
  96,
  "This loop never exits when the queue is parked.",
);
const [DIAG_REF, DIAG_TEXT] = diagnosticBlocks(
  `${ROOT}/src/panels/Chat/ChatView.tsx`,
  2588,
  2588,
  "error",
  "Property 'onQueue' does not exist on type 'IntrinsicAttributes'.",
);
const [TODO_REF, TODO_TEXT] = todoBlocks(`${ROOT}/src/utils/relativeTime.ts`, 31, "TODO", "handle negative offsets");

function pr(number: number, title: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title,
    body: null,
    state: "open",
    isDraft: false,
    author: "skarif2",
    createdAt: "2026-10-20T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    comments: 0,
    headRef: `feat/${number}`,
    baseRef: "main",
    headSha: "abc1234",
    headRepoIsOrigin: true,
    url: `https://github.com/gettori/tori/pull/${number}`,
    mergeableState: "clean",
    stack: null,
    ...extra,
  };
}

const PRS = [
  pr(412, "Chat input: queue reorder by drag"),
  pr(409, "Inbox: allow one command for every worker", { isDraft: true }),
  pr(398, "Phone: count a waiting permission once"),
];

const PR_CHIP = chip("pr", prRef(PRS[0]));

function session(id: string, title: string, agent = "claude"): SessionMeta {
  return {
    id,
    path: `${ROOT}/.sessions/${id}.jsonl`,
    cwd: ROOT,
    branch: "main",
    title,
    last_active: NOW / 1000 - 600,
    created_at: NOW / 1000 - 7200,
    name: null,
    agent,
  };
}

const SESSIONS = [
  session("a1b2c3d4", "Fix the lane strip timer"),
  session("e5f6a7b8", "Inbox permissions tab", "codex"),
  session("c9d0e1f2", "Docs: composer page"),
];

const SESSION_CHIP = chip("ses", {
  type: "ref",
  label: "[Session: Fix the lane strip timer]",
  target: { kind: "session", id: "a1b2c3d4", title: "Fix the lane strip timer", agent: "claude", project: ROOT },
});
const PROJECT_CHIP = chip("proj", {
  type: "ref",
  label: "[Project: web]",
  target: { kind: "project", name: "web", folder: "/work/web", space: "Tori" },
});
const SPACE_CHIP = chip("space", {
  type: "ref",
  label: "[Space: Tori]",
  target: {
    kind: "space",
    name: "Tori",
    projects: [
      { name: "tori", folder: ROOT },
      { name: "web", folder: "/work/web" },
    ],
  },
});

const SPACES: NavSpace[] = [
  {
    name: "Tori",
    path: "/work",
    projects: [
      {
        name: "tori",
        path: ROOT,
        branchUnits: [
          { label: "main", folderPath: ROOT, branch: "main", kind: "root", isCurrent: true },
          {
            label: "chat-input",
            folderPath: `${ROOT}/.tori/worktrees/chat-input`,
            branch: "chat-input",
            kind: "worktree",
            isCurrent: false,
          },
        ],
      },
      { name: "web", path: "/work/web", branchUnits: [] },
    ],
  },
  { name: "Saga", path: "/work/saga", projects: [{ name: "saga-api", path: "/work/saga/api", branchUnits: [] }] },
];

const FILES = [
  "src/panels/Chat/Composer.tsx",
  "src/panels/Chat/ChatView.tsx",
  "src/panels/Chat/LaneStrip.tsx",
  "src/panels/Chat/Chat.module.css",
  "src/utils/chatCompose.ts",
  "src/utils/composerCompletion.ts",
  "src-tauri/src/chat/mod.rs",
  "package.json",
  "README.md",
];

const COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    description: "Clear history but keep a summary in context",
    argumentHint: "[instructions]",
    aliases: [],
  },
  { name: "clear", description: "Clear conversation history", argumentHint: null, aliases: ["reset"] },
  { name: "review", description: "Review a pull request", argumentHint: "<pr>", aliases: [] },
  { name: "init", description: "Initialize a CLAUDE.md file", argumentHint: null, aliases: [] },
  { name: "cost", description: "Show the total cost of this session", argumentHint: null, aliases: [] },
  { name: "plan", description: "", argumentHint: null, aliases: [] },
];

function lane(agentId: string, extra: Partial<Lane> = {}): Lane {
  return {
    agentId,
    taskType: "local_agent",
    toolUseId: `tool-${agentId}`,
    agentType: "general-purpose",
    description: null,
    prompt: null,
    status: null,
    activity: null,
    lastToolName: null,
    usage: null,
    summary: null,
    parentId: null,
    startedAt: NOW - 42_000,
    ...extra,
  };
}

function done(agentId: string, description: string, tokens: number): Lane {
  return lane(agentId, {
    description,
    status: "completed",
    usage: { totalTokens: tokens, toolUses: 12, durationMs: 60_000 },
  });
}

const LANE_RUNNING = lane("sub-explore", { description: "Find every caller of pendingFor", agentType: "Explore" });
const LANE_RUNNING_LONG = lane("sub-plan", {
  description: "Design the queue persistence migration",
  agentType: "Plan",
  startedAt: NOW - 185_000,
});
const LANE_BLOCKED = lane("sub-blocked", { description: "Run the migration script" });
const LANE_FAILED = lane("sub-failed", { description: "Bump undici", status: "failed" });
const LANE_STOPPED = lane("sub-stopped", { description: "Refactor the picker", status: "stopped" });
const LANE_LAUNCHED = lane("sub-launched", { description: "Audit the CSS tokens", status: "async_launched" });
const LANE_UNNAMED = lane("7f3e9a1c55d2", { agentType: null });
const LANE_DONE = [
  done("sub-done-1", "Read the composer tests", 18_400),
  done("sub-done-2", "Summarise the ADRs on attachments", 7_200),
  done("sub-done-3", "List the slash commands", 640),
  done("sub-done-4", "Check the a11y addon config", 3_100),
];

function task(id: string, description: string, ageMs: number): Lane {
  return lane(id, { taskType: "local_bash", agentType: null, description, toolUseId: null, startedAt: NOW - ageMs });
}

const TASKS = [task("bash-1", "pnpm test --watch", 320_000), task("bash-2", "cargo build --release", 12_000)];

const PLAN: PlanItem[] = [
  { text: "Read the composer and its tests", status: "completed" },
  { text: "Write a story for every composer state", status: "completed" },
  { text: "Stub the asset protocol for image chips", status: "inProgress" },
  { text: "Run tsc and the composer tests", status: "pending" },
  { text: "Draft the PR", status: "pending" },
];

function model(value: string, label: string, effort = true): PickableModel {
  return {
    value,
    resolvedModel: value,
    label,
    description: "",
    effortLevels: effort
      ? ["low", "medium", "high", "max"].map((level) => ({ level, label: level, disabled: false, note: "" }))
      : [],
    contextWindow: 200_000,
    live: true,
    userConfigured: false,
    fastMode: false,
    supportsAutoMode: true,
  };
}

const MODELS = [
  model("default", "Default"),
  model("opus", "Opus 5.5"),
  model("sonnet", "Sonnet 5.5"),
  model("haiku", "Haiku 5.5", false),
];

const ADAPTER: Adapter = {
  id: "claude",
  label: "Claude",
  program: "claude",
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat: null,
};

const MODES: ChatMode[] = [
  { id: "default", label: "Ask", hint: "Ask before edits and commands.", args: [], default: true },
  { id: "acceptEdits", label: "Accept edits", hint: "Auto-accept edits.", args: [] },
  { id: "plan", label: "Plan", hint: "Read only, propose a plan.", args: [] },
  { id: "bypassPermissions", label: "Bypass", hint: "Runs without asking.", args: [], permissive: true },
];

const CONFIG: ChatConfigOption[] = [
  {
    id: "output_style",
    name: "Output style",
    description: "How replies are written",
    category: "style",
    disabled: false,
    note: "",
    kind: "select",
    current: "default",
    choices: [
      { value: "default", label: "Default", description: "" },
      { value: "explanatory", label: "Explanatory", description: "" },
    ],
  },
  {
    id: "fast",
    name: "Fast mode",
    description: "Faster output on the same model",
    category: "speed",
    disabled: false,
    note: "",
    kind: "boolean",
    value: true,
  },
];

const ALL_KINDS: AttachmentSource = { kinds: ["image", "pdf", "file"], gap: null };
const IMAGES_ONLY: AttachmentSource = { kinds: ["image"], gap: null };
const NO_UPLOADS: AttachmentSource = { kinds: [], gap: "This agent reads no attached files." };

function queued(id: string, text: string, blocks: ContentBlock[] = [], extra: Partial<QueuedInput> = {}): QueuedInput {
  return { id, blocks: [...blocks, ...(text ? [{ type: "text" as const, text }] : [])], ...extra };
}

const STASH: StashEntry[] = [
  { id: "st1", text: "Try the queue strip as a popover instead", chips: [], at: NOW - 3_600_000 },
  {
    id: "st2",
    text: "Compare these two screenshots\nand tell me which spacing is right",
    chips: [IMAGE_1.block, IMAGE_2.block],
    at: NOW - 600_000,
  },
  { id: "st3", text: "", chips: [FILE_1.block], at: NOW - 60_000 },
];

const LONG_DRAFT = Array.from(
  { length: 14 },
  (_, i) => `${i + 1}. Another line of a long prompt that keeps going so the box has to grow and then scroll.`,
).join("\n");

const HUGE_DRAFT = "Here is the whole spec pasted inline rather than as a file. ".repeat(60);

type ChatInputProps = {
  draft?: string;
  running?: boolean;
  steering?: boolean;
  steerCost?: string | null;
  queue?: QueuedInput[];
  parked?: boolean;
  restored?: boolean;
  editing?: string | null;
  attachments?: PendingBlock[];
  uploads?: AttachmentSource;
  disabled?: boolean;
  linked?: string | null;
  holding?: boolean;
  notice?: string | null;
  stash?: StashEntry[];
  missing?: string[];
  lanes?: Lane[];
  tasks?: Lane[];
  blocked?: string[];
  selectedLane?: string | null;
  busy?: boolean;
  plan?: PlanItem[];
  asks?: SocketAsk[];
  locked?: { now: string; waiting?: boolean } | null;
  /** False drops the model, mode and config pills, as a cockpit chat does. */
  controls?: boolean;
  modelPending?: boolean;
  effortPending?: boolean;
  modePending?: boolean;
  mode?: string;
  config?: ChatConfigOption[];
  /** Without the session list and navigator, `@` offers project files only. */
  toriMcp?: boolean;
};

function ChatInput(props: ChatInputProps) {
  const [draft, setDraft] = createSignal(props.draft ?? "");
  const [attachments, setAttachments] = createSignal<PendingBlock[]>(props.attachments ?? []);
  const [queue, setQueue] = createSignal<QueuedInput[]>(props.queue ?? []);
  const [parked, setParked] = createSignal(props.parked ?? false);
  const [editing, setEditing] = createSignal<string | null>(props.editing ?? null);
  const [stash, setStash] = createSignal<StashEntry[]>(props.stash ?? []);
  const [running, setRunning] = createSignal(props.running ?? false);
  const [selected, setSelected] = createSignal<string | null>(props.selectedLane ?? null);
  const [mode, setMode] = createSignal(props.mode ?? "default");
  const [modelValue, setModelValue] = createSignal("opus");
  const [effort, setEffort] = createSignal<string | null>("high");
  const counters: Record<string, number> = {};
  let nextId = 0;

  const add = (block: ContentBlock) => setAttachments((list) => [...list, chip(`new-${nextId++}`, block)]);
  function attachPath(path: string): string {
    const kind = attachmentKind(path) ?? "file";
    counters[kind] = (counters[kind] ?? 0) + 1;
    const label = `[${KIND_NAMES[kind]} ${counters[kind]}]`;
    add(fileMentionBlocks(path, label)[0]);
    return label;
  }
  const watching = () => {
    const id = selected();
    if (!id) return null;
    const l = props.lanes?.find((x) => x.agentId === id);
    return l ? (l.description ?? l.agentType ?? id) : null;
  };

  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <div class={`${styles.chat} ${styles.active}`}>
        <div style={{ flex: "1" }} />
        <For each={props.asks ?? []}>{(ask) => <AskCard ask={ask} here="this-session" />}</For>
        <PlanCard items={props.plan ?? []} />
        <LaneStrip
          lanes={props.lanes ?? []}
          tasks={props.tasks ?? []}
          blocked={new Set(props.blocked ?? [])}
          selected={selected()}
          busy={props.busy ?? running()}
          mark="claude"
          onSelect={setSelected}
          active={true}
        />
        <Show
          when={!props.locked}
          fallback={<LockedBar now={props.locked!.now} progress={0.4} waiting={props.locked!.waiting} />}
        >
          <Composer
            watching={watching()}
            running={running()}
            steering={props.steering ?? true}
            steerCost={props.steerCost ?? null}
            queue={queue()}
            attachments={attachments()}
            draft={draft()}
            onDraftChange={setDraft}
            history={["Run the composer tests", "Why does the queue strip jump?"]}
            commands={COMMANDS}
            loadFiles={() => Promise.resolve(FILES)}
            prs={PRS}
            loadPrs={() => {}}
            onAttachPr={(p) => {
              add(prRef(p));
              return prLabel(p.number);
            }}
            resolvePr={(n) => Promise.resolve(pr(n, `Looked up #${n}`))}
            sessions={props.toriMcp === false ? undefined : SESSIONS}
            loadSessions={() => {}}
            onAttachSession={(s) => {
              const label = `[Session: ${s.title}]`;
              add({
                type: "ref",
                label,
                target: { kind: "session", id: s.id, title: s.title, agent: s.agent ?? "claude", project: ROOT },
              });
              return label;
            }}
            navigator={
              props.toriMcp === false
                ? undefined
                : {
                    spaces: () => SPACES,
                    here: () => SPACES[0],
                    sessionsOf: () => SESSIONS,
                    filesOf: () => FILES,
                    loadSessionsOf: () => {},
                    loadFilesOf: () => {},
                    onAttachProject: (space, p) => {
                      const label = `[Project: ${p.name}]`;
                      add({
                        type: "ref",
                        label,
                        target: { kind: "project", name: p.name, folder: p.path, space: space.name },
                      });
                      return label;
                    },
                    onAttachSpace: (space) => {
                      const label = `[Space: ${space.name}]`;
                      add({
                        type: "ref",
                        label,
                        target: {
                          kind: "space",
                          name: space.name,
                          projects: space.projects.map((p) => ({ name: p.name, folder: p.path })),
                        },
                      });
                      return label;
                    },
                    onAttachSession: (s) => `[Session: ${s.title}]`,
                  }
            }
            parked={parked()}
            restored={props.restored}
            disabled={props.disabled ?? false}
            onSend={(text) => {
              if (running())
                setQueue((q) => [
                  ...q,
                  queued(
                    `q-${nextId++}`,
                    text,
                    attachments().map((a) => a.block),
                  ),
                ]);
              setDraft("");
              setAttachments([]);
            }}
            onQueue={(text) => {
              setQueue((q) => [
                ...q,
                queued(
                  `q-${nextId++}`,
                  text,
                  attachments().map((a) => a.block),
                ),
              ]);
              setDraft("");
              setAttachments([]);
            }}
            onAttachFile={(rel) => attachPath(`${ROOT}/${rel}`)}
            onAttachPaths={(paths) => paths.map(attachPath)}
            uploads={props.uploads ?? ALL_KINDS}
            onAttachUploads={(files: UploadFile[]) =>
              Promise.resolve(files.map((f) => attachPath(`${ROOT}/.tori/attachments/${f.name}`)))
            }
            onAttachRejected={(reason) => console.info("rejected:", reason)}
            fileExists={(path) => Promise.resolve(!(props.missing ?? []).includes(path))}
            linked={props.linked ?? null}
            onOpenInEditor={() => {}}
            onUnlink={() => {}}
            stash={stash()}
            onStash={() => {
              setStash((s) => [
                ...s,
                { id: `st-${nextId++}`, text: draft(), chips: attachments().map((a) => a.block), at: Date.now() },
              ]);
              setDraft("");
              setAttachments([]);
            }}
            onRestoreStash={(id) => {
              const entry = stash().find((s) => s.id === id);
              if (!entry) return;
              setDraft(entry.text);
              setAttachments(entry.chips.map((b) => chip(`new-${nextId++}`, b)));
              setStash((s) => s.filter((x) => x.id !== id));
            }}
            onDiscardStash={(id) => setStash((s) => s.filter((x) => x.id !== id))}
            holding={props.holding}
            onInterrupt={() => setRunning(false)}
            onDropQueued={(id) => setQueue((q) => q.filter((x) => x.id !== id))}
            onReorderQueued={(ids) => setQueue((q) => ids.map((id) => q.find((x) => x.id === id)!))}
            onSteerQueued={(id) => setQueue((q) => q.map((x) => (x.id === id ? { ...x, steering: true } : x)))}
            editing={editing()}
            onEditQueued={setEditing}
            onSaveEdit={() => setEditing(null)}
            onCancelEdit={() => setEditing(null)}
            onDropAttachment={(id) => setAttachments((list) => list.filter((a) => a.id !== id))}
            onSendQueued={() => {
              setParked(false);
              setQueue([]);
            }}
            onDiscardQueued={() => {
              setParked(false);
              setQueue([]);
            }}
            notice={props.notice ?? undefined}
            controls={
              props.controls === false ? undefined : (
                <>
                  <ModelPicker
                    models={MODELS}
                    providers={[lockedProvider(ADAPTER, MODELS)]}
                    value={modelValue()}
                    agentId="claude"
                    profile={null}
                    profileLabel={null}
                    effort={effort()}
                    modelPending={props.modelPending ?? false}
                    effortPending={props.effortPending ?? false}
                    disabled={props.disabled ?? false}
                    onSelectModel={(_, __, m) => setModelValue(m.value)}
                    onSelectEffort={setEffort}
                  />
                  <ModeSelector
                    mode={mode()}
                    modes={MODES}
                    pending={props.modePending ?? false}
                    disabled={props.disabled ?? false}
                    onSelect={setMode}
                  />
                  <ConfigMirror options={props.config ?? []} disabled={props.disabled ?? false} onSet={() => {}} />
                  <FollowToggle />
                </>
              )
            }
          />
        </Show>
      </div>
    </div>
  );
}

function textarea(canvas: HTMLElement): HTMLTextAreaElement {
  return canvas.querySelector("textarea")!;
}

/** Focus the input with the caret at the end of the draft, which is what opens
 *  a completion menu for the token there and what the fence notice reads. */
async function caretAtEnd({ canvasElement }: { canvasElement: HTMLElement }) {
  const input = textarea(canvasElement);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("select", { bubbles: true }));
}

async function openStash({ canvasElement }: { canvasElement: HTMLElement }) {
  const input = textarea(canvasElement);
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
}

async function dragOver({ canvasElement }: { canvasElement: HTMLElement }) {
  const data = new DataTransfer();
  data.items.add("screenshot.png", "text/plain");
  textarea(canvasElement).dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true }));
}

const meta = {
  title: "Chat/ChatInput",
  component: ChatInput,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => {
      stubAssets();
      return <Story />;
    },
  ],
} satisfies Meta<typeof ChatInput>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh chat: nothing typed, nothing attached, nothing running. */
export const Empty: Story = {};

export const WithDraft: Story = {
  args: { draft: "Why does the queue strip jump when a steer lands?\nLook at Composer.tsx first." },
};

/** Past nine lines the box stops growing and scrolls. */
export const LongDraft: Story = { args: { draft: LONG_DRAFT } };

/** Past about 500 tokens the bar shows a token estimate. */
export const TokenReadout: Story = { args: { draft: HUGE_DRAFT } };

/** Caret inside an open fence: Enter adds a line, the hint says Cmd+Enter sends. */
export const InsideCodeFence: Story = {
  args: { draft: "Why does this throw?\n```ts\nconst lanes = props.lanes.filter(isLive)" },
  play: caretAtEnd,
};

/** A session that ended or a claim that was refused. */
export const Disabled: Story = { args: { disabled: true, draft: "Can't send this" } };

/** The draft lives in a scratch tab; the input is read only. */
export const LinkedToEditor: Story = {
  args: { draft: "Drafted in the editor.\n\nSecond paragraph.", linked: "draft-chat-input.md" },
};

/** One line above the input when a model, effort or mode pick waits for the next turn. */
export const PendingSwitches: Story = {
  args: {
    modelPending: true,
    effortPending: true,
    modePending: true,
    mode: "plan",
    notice: "Model, thinking effort and permission mode apply from the next turn.",
  },
};

/** Agent-published options beside the built-in pills. */
export const WithAgentConfig: Story = { args: { config: CONFIG } };

/** A cockpit chat drops the session controls from the bar. */
export const NoControls: Story = { args: { controls: false, draft: "Cockpit reply" } };

/** The autopilot owns the session and the bar replaces the composer. */
export const LockedByAutopilot: Story = { args: { locked: { now: "running pnpm test auth" } } };

export const LockedWaitingOnYou: Story = { args: { locked: { now: "waiting for approval", waiting: true } } };

/** The agent reads no uploads, so the attach button is disabled. */
export const NoUploads: Story = { args: { uploads: NO_UPLOADS } };

export const ImagesOnly: Story = { args: { uploads: IMAGES_ONLY } };

export const DropHint: Story = { play: dragOver };

export const DropHintNoUploads: Story = { args: { uploads: NO_UPLOADS }, play: dragOver };

export const AttachedImages: Story = {
  args: { attachments: [IMAGE_1, IMAGE_2, IMAGE_3], draft: "Compare [Image 1] and [Image 2] against [Image 3]." },
};

/** Bytes rather than a path: a replayed image block with no file behind it. */
export const AttachedImageBytes: Story = { args: { attachments: [IMAGE_BYTES] } };

export const AttachedLongImageName: Story = { args: { attachments: [IMAGE_LONG] } };

export const AttachedPdfs: Story = {
  args: { attachments: [PDF_1, PDF_2], draft: "Summarise [PDF 1] and check totals in [PDF 2]." },
};

export const AttachedFiles: Story = {
  args: {
    attachments: [FILE_1, FILE_2, FILE_JSON, FILE_PASTED],
    draft: "[File 1] calls into [File 2]. The log is in [File 3].",
  },
};

/** An `@` mention with no label, and editor selections by line and by page. */
export const AttachedMentionsAndSelections: Story = {
  args: { attachments: [MENTION, SELECTION, SELECTION_LINE, PDF_PAGES] },
};

/** Hunk comments, diagnostics and TODOs arrive as a file reference plus a prose pill. */
export const AttachedReviewNotes: Story = {
  args: {
    attachments: [
      chip("hunk", HUNK_REF),
      chip("hunk-text", HUNK_TEXT),
      chip("diag", DIAG_REF),
      chip("diag-text", DIAG_TEXT),
      chip("todo", TODO_REF),
      chip("todo-text", TODO_TEXT),
    ],
  },
};

/** Pull requests, sessions, projects and spaces named with `#` and `@`. */
export const AttachedRefs: Story = {
  args: {
    attachments: [PR_CHIP, SESSION_CHIP, PROJECT_CHIP, SPACE_CHIP],
    draft: "Pick up from [Session: Fix the lane strip timer] and finish [PR 412] across [Space: Tori].",
  },
};

/** A file deleted after it was attached: the chip stays and turns red. */
export const AttachedMissingFile: Story = {
  args: { attachments: [FILE_1, IMAGE_2], missing: [FILE_1_PATH] },
};

/** Every kind of chip at once, at the ten-attachment limit and past it. */
export const AttachedEverything: Story = {
  args: {
    attachments: [
      IMAGE_1,
      IMAGE_2,
      IMAGE_BYTES,
      PDF_1,
      FILE_1,
      FILE_PASTED,
      MENTION,
      SELECTION,
      PDF_PAGES,
      chip("hunk", HUNK_REF),
      chip("hunk-text", HUNK_TEXT),
      PR_CHIP,
      SESSION_CHIP,
      SPACE_CHIP,
    ],
    draft: "Everything: [Image 1] [Image 2] [PDF 1] [File 1] [File 3] [PR 412].",
  },
};

/** Tokens in the prose with no chip behind them (a chip removed, or typed by hand). */
export const InlineTokensWithoutChips: Story = {
  args: { draft: "See [Image 1] next to [File 2] and [PR 412]. Then [Session: Docs: composer page]." },
};

/** Tokens repeated, at line starts and inside a code fence. */
export const InlineTokensMixedLayout: Story = {
  args: {
    attachments: [IMAGE_1, FILE_1, PDF_1],
    draft:
      "[Image 1]\nThis is the bug. Same layout as [Image 1] but in [File 1].\n```\n[PDF 1] p.3\n```\nUse [PDF 1] as the spec.",
  },
};

export const SlashCommands: Story = { args: { draft: "/" }, play: caretAtEnd };

export const SlashCommandsFiltered: Story = { args: { draft: "/re" }, play: caretAtEnd };

/** Bare `@`: recent sessions first, then project files. */
export const MentionMixed: Story = { args: { draft: "Look at @" }, play: caretAtEnd };

export const MentionFilesOnly: Story = { args: { draft: "Look at @comp", toriMcp: false }, play: caretAtEnd };

export const MentionSessions: Story = { args: { draft: "@session/" }, play: caretAtEnd };

export const MentionSpaces: Story = { args: { draft: "@spaces/" }, play: caretAtEnd };

export const MentionProjects: Story = { args: { draft: "@projects/" }, play: caretAtEnd };

export const PullRequests: Story = { args: { draft: "Finish #" }, play: caretAtEnd };

/** A number the open list does not hold offers a lookup. */
export const PullRequestLookup: Story = { args: { draft: "Finish #1234" }, play: caretAtEnd };

/** Cmd+S on an empty box opens the stash. */
export const StashMenu: Story = { args: { stash: STASH }, play: openStash };

export const RunningSteerable: Story = { args: { running: true, steerCost: "1.5-5.4s" } };

export const RunningSteerUnmeasured: Story = { args: { running: true } };

/** Before the turn is acknowledged, or for an agent that cannot take input mid-turn. */
export const RunningQueueOnly: Story = { args: { running: true, steering: false } };

export const Queue: Story = {
  args: {
    running: true,
    queue: [
      queued("q1", "Also run the lints"),
      queued("q2", "And check this screenshot", [IMAGE_1.block]),
      queued("q3", "", [FILE_1.block, PDF_1.block]),
    ],
  },
};

export const QueueSteering: Story = {
  args: {
    running: true,
    queue: [queued("q1", "Stop and use the other API", [], { steering: true }), queued("q2", "Then commit")],
  },
};

export const QueueNotSteerable: Story = {
  args: { running: true, steering: false, queue: [queued("q1", "Also run the lints")] },
};

/** The turn was stopped, so the queue waits for Send now or Discard. */
export const QueueParked: Story = {
  args: { parked: true, queue: [queued("q1", "Also run the lints"), queued("q2", "Then commit")] },
};

/** Held from a session that closed with messages still queued. */
export const QueueRestored: Story = {
  args: { parked: true, restored: true, queue: [queued("q1", "Pick up where we left off")] },
};

export const EditingQueued: Story = {
  args: {
    running: true,
    editing: "q2",
    draft: "And check this screenshot",
    queue: [queued("q1", "Also run the lints"), queued("q2", "And check this screenshot", [IMAGE_1.block])],
  },
};

export const LongQueue: Story = {
  args: {
    running: true,
    queue: Array.from({ length: 8 }, (_, i) =>
      queued(`q${i}`, `Queued message ${i + 1} that is long enough to wrap onto a second line of the strip`),
    ),
  },
};

export const SubagentsRunning: Story = {
  args: { running: true, lanes: [LANE_RUNNING, LANE_RUNNING_LONG] },
};

/** Running, waiting on you, failed, stopped, launched with no recorded end, unnamed, done. */
export const SubagentsEveryState: Story = {
  args: {
    running: true,
    lanes: [LANE_RUNNING, LANE_BLOCKED, LANE_FAILED, LANE_STOPPED, LANE_LAUNCHED, LANE_UNNAMED, LANE_DONE[0]],
    blocked: [LANE_BLOCKED.agentId],
  },
};

/** Past two finished lanes the rest fold behind one chip. */
export const SubagentsFolded: Story = { args: { lanes: [LANE_RUNNING, ...LANE_DONE] } };

/** Reading a subagent's lane changes the placeholder, not where text goes. */
export const WatchingSubagent: Story = {
  args: { running: true, lanes: [LANE_RUNNING, LANE_RUNNING_LONG], selectedLane: LANE_RUNNING.agentId },
};

/** Past nine chips the Option+N shortcut stops. */
export const ManySubagents: Story = {
  args: {
    running: true,
    lanes: Array.from({ length: 11 }, (_, i) =>
      lane(`sub-${i}`, { description: `Worker ${i + 1}`, startedAt: NOW - (i + 1) * 9_000 }),
    ),
  },
};

export const BackgroundTasks: Story = { args: { tasks: TASKS } };

export const SubagentsAndBackgroundTasks: Story = {
  args: {
    running: true,
    lanes: [LANE_RUNNING, LANE_BLOCKED, ...LANE_DONE.slice(0, 2)],
    blocked: [LANE_BLOCKED.agentId],
    tasks: TASKS,
  },
};

export const WithPlan: Story = { args: { running: true, plan: PLAN } };

/** Folded to a pill on the composer's edge, the list a hover away. */
export const WithPlanFolded: Story = {
  args: { running: true, plan: PLAN },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>("[class*='planHead']")?.click();
  },
};

/** Past about six steps the list scrolls inside the card. */
export const WithLongPlan: Story = {
  args: {
    running: true,
    plan: Array.from({ length: 14 }, (_, i) => ({
      text: `Step ${i + 1}: ${i % 3 === 0 ? "a longer step that says more about what it is going to change and why" : "a short step"}`,
      status: i < 8 ? ("completed" as const) : i === 8 ? ("inProgress" as const) : ("pending" as const),
    })),
  },
};

export const WithAsk: Story = {
  args: {
    asks: [
      {
        id: "ask1",
        session: "other-session",
        question: "Merge PR 412 now or wait for CI?",
        options: ["Merge", "Wait"],
      },
    ],
  },
};

const ASK: SocketAsk = {
  id: "ask1",
  session: "other-session",
  question: "Merge PR 412 now or wait for CI?",
  options: ["Merge", "Wait"],
};

/** Everything that stacks above the input, with the gaps between them. */
export const WithAskPlanAndLanes: Story = {
  args: { running: true, asks: [ASK], plan: PLAN, lanes: [LANE_RUNNING, LANE_DONE[0]] },
};

/** The folded pill sticks up past the input box, toward whatever sits above. */
export const WithAskAndFoldedPlan: Story = {
  args: { running: true, asks: [ASK], plan: PLAN },
  play: WithPlanFolded.play,
};

export const KitchenSink: Story = {
  args: {
    running: true,
    steerCost: "1.5-5.4s",
    plan: PLAN,
    lanes: [LANE_RUNNING, LANE_BLOCKED, LANE_FAILED, ...LANE_DONE],
    blocked: [LANE_BLOCKED.agentId],
    tasks: TASKS,
    queue: [queued("q1", "Also run the lints"), queued("q2", "And this one", [IMAGE_2.block])],
    attachments: [
      IMAGE_1,
      PDF_1,
      FILE_1,
      SELECTION,
      chip("hunk", HUNK_REF),
      chip("hunk-text", HUNK_TEXT),
      PR_CHIP,
      SESSION_CHIP,
    ],
    missing: [FILE_1_PATH],
    draft: "With [Image 1] and [PDF 1], fix [File 1] for [PR 412].\nContinue from [Session: Fix the lane strip timer].",
    notice: "Model applies from the next turn.",
    modelPending: true,
    config: CONFIG,
  },
};

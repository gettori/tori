import { For, Show, createSignal } from "solid-js";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import Composer from "../Composer";
import LaneStrip from "../LaneStrip";
import PlanCard from "../PlanCard";
import AskCard from "../AskCard";
import ModelPicker from "../ModelPicker";
import ModeSelector from "../ModeSelector";
import ConfigMirror from "../ConfigMirror";
import FollowToggle from "../FollowToggle";
import LockedBar from "../../../components/Autopilot/LockedBar";
import { lockedProvider } from "../agentPaletteData";
import type { Lane, QueuedInput } from "../chatStore";
import type { StashEntry } from "../promptStash";
import type { UploadFile } from "../composerAttachments";
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
} from "../../../utils/chatCompose";
import type { Adapter, ChatMode } from "../../../utils/agents";
import type { PickableModel } from "../../../utils/chatModels";
import type { ChatConfigOption, ContentBlock, PlanItem, SlashCommand } from "../../../utils/chatTypes";
import type { PullRequest } from "../../../utils/forgeTypes";
import type { SessionMeta } from "../../../utils/sessionStore";
import type { NavSpace } from "../../../utils/mentionNavigator";
import type { SocketAsk } from "../../../utils/socketAsks";
import { prLabel, prRef } from "../../../utils/prMention";
import type { HostHandler } from "../../../dev/stubHost";
import styles from "../Chat.module.css";

const ROOT = "/work/tori";
export const NOW = Date.now();

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

const SOURCE = Array.from(
  { length: 80 },
  (_, i) => `export function step${i + 1}(input: string): string {\n  return input.trim(); // line ${i * 3 + 2}\n}`,
).join("\n");

// The workshop has no Tauri host behind it: image chips draw through the asset
// protocol, and the preview reads files, so both are answered here.
export const chatInputHost: HostHandler = (cmd, args) => {
  if (cmd !== "fs_read_file") return undefined;
  const path = args.path as string;
  if (path.endsWith(".md")) return "# Notes\n\nA **markdown** file, previewed.\n\n- one\n- two\n";
  if (path.endsWith(".txt")) return "2026-10-28 18:37:24 ERROR queue parked\n".repeat(40);
  return SOURCE;
};

export function stubAssetUrls() {
  mockConvertFileSrc("macos");
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } })
    .__TAURI_INTERNALS__;
  internals.convertFileSrc = (path) => IMAGE_FILES[path] ?? shot(30, path.split("/").pop() ?? "image");
}

const KIND_NAMES: Record<AttachmentKind, string> = { image: "Image", pdf: "PDF", file: "File" };

export function chip(id: string, block: ContentBlock): PendingBlock {
  return { id, block };
}

function upload(id: string, path: string, n: number): PendingBlock {
  const kind = attachmentKind(path) ?? "file";
  return chip(id, fileMentionBlocks(path, `[${KIND_NAMES[kind]} ${n}]`)[0]);
}

export const IMAGE_1 = upload("img1", `${ROOT}/.tori/attachments/screenshot-2026-10-28.png`, 1);
export const IMAGE_2 = upload("img2", `${ROOT}/.tori/attachments/login-error.png`, 2);
export const IMAGE_3 = upload("img3", `${ROOT}/.tori/attachments/mockup.jpg`, 3);
export const IMAGE_LONG = upload("img4", `${ROOT}/docs/diagram-with-a-really-long-file-name-that-will-not-fit.webp`, 4);
export const IMAGE_BYTES = chip("bytes", {
  type: "image",
  mediaType: "image/svg+xml",
  data: shot(50, "pasted bytes").split(",")[1],
});

export const PDF_1 = upload("pdf1", `${ROOT}/.tori/attachments/spec-v2.pdf`, 1);
export const PDF_2 = upload("pdf2", `${ROOT}/.tori/attachments/invoice-october.pdf`, 2);

export const FILE_1_PATH = `${ROOT}/src/panels/Chat/Composer.tsx`;
export const FILE_1 = upload("file1", FILE_1_PATH, 1);
export const FILE_2 = upload("file2", `${ROOT}/src-tauri/src/chat/mod.rs`, 2);
export const FILE_PASTED = upload("file3", `${ROOT}/.tori/attachments/pasted.txt`, 3);
export const FILE_JSON = upload("file4", `${ROOT}/package.json`, 4);

export const MENTION = chip("mention", fileMentionBlocks(`${ROOT}/src/utils/chatCompose.ts`)[0]);
export const SELECTION = chip(
  "sel",
  selectionBlocks(`${ROOT}/src/panels/Chat/LaneStrip.tsx`, 40, 58, "const isLive = (l: Lane) => ...")[0],
);
export const SELECTION_LINE = chip("sel1", selectionBlocks(`${ROOT}/src/App.tsx`, 12, 12, "import Chat from ...")[0]);
export const PDF_PAGES = chip("pages", selectionBlocks(`${ROOT}/.tori/attachments/spec-v2.pdf`, 3, 5, "")[0]);

export const [HUNK_REF, HUNK_TEXT] = hunkCommentBlocks(
  `${ROOT}/src/utils/queue.ts`,
  88,
  96,
  "This loop never exits when the queue is parked.",
);
export const [DIAG_REF, DIAG_TEXT] = diagnosticBlocks(
  `${ROOT}/src/panels/Chat/ChatView.tsx`,
  2588,
  2588,
  "error",
  "Property 'onQueue' does not exist on type 'IntrinsicAttributes'.",
);
export const [TODO_REF, TODO_TEXT] = todoBlocks(
  `${ROOT}/src/utils/relativeTime.ts`,
  31,
  "TODO",
  "handle negative offsets",
);

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

export const PR_CHIP = chip("pr", prRef(PRS[0]));

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

export const SESSION_CHIP = chip("ses", {
  type: "ref",
  label: "[Session: Fix the lane strip timer]",
  target: { kind: "session", id: "a1b2c3d4", title: "Fix the lane strip timer", agent: "claude", project: ROOT },
});
export const PROJECT_CHIP = chip("proj", {
  type: "ref",
  label: "[Project: web]",
  target: { kind: "project", name: "web", folder: "/work/web", space: "Tori" },
});
export const SPACE_CHIP = chip("space", {
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

const SKILLS = ["review", "simplify", "security-review"];

export function lane(agentId: string, extra: Partial<Lane> = {}): Lane {
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

export const LANE_RUNNING = lane("sub-explore", {
  description: "Find every caller of pendingFor",
  agentType: "Explore",
});
export const LANE_RUNNING_LONG = lane("sub-plan", {
  description: "Design the queue persistence migration",
  agentType: "Plan",
  startedAt: NOW - 185_000,
});
export const LANE_BLOCKED = lane("sub-blocked", { description: "Run the migration script" });
export const LANE_FAILED = lane("sub-failed", { description: "Bump undici", status: "failed" });
export const LANE_STOPPED = lane("sub-stopped", { description: "Refactor the picker", status: "stopped" });
export const LANE_LAUNCHED = lane("sub-launched", { description: "Audit the CSS tokens", status: "async_launched" });
export const LANE_UNNAMED = lane("7f3e9a1c55d2", { agentType: null });
export const LANE_DONE = [
  done("sub-done-1", "Read the composer tests", 18_400),
  done("sub-done-2", "Summarise the ADRs on attachments", 7_200),
  done("sub-done-3", "List the slash commands", 640),
  done("sub-done-4", "Check the a11y addon config", 3_100),
];

function task(id: string, description: string, ageMs: number): Lane {
  return lane(id, { taskType: "local_bash", agentType: null, description, toolUseId: null, startedAt: NOW - ageMs });
}

export const TASKS = [task("bash-1", "pnpm test --watch", 320_000), task("bash-2", "cargo build --release", 12_000)];

export const PLAN: PlanItem[] = [
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

export const CONFIG: ChatConfigOption[] = [
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
export const IMAGES_ONLY: AttachmentSource = { kinds: ["image"], gap: null };
export const NO_UPLOADS: AttachmentSource = { kinds: [], gap: "This agent reads no attached files." };

export function queued(
  id: string,
  text: string,
  blocks: ContentBlock[] = [],
  extra: Partial<QueuedInput> = {},
): QueuedInput {
  return { id, blocks: [...blocks, ...(text ? [{ type: "text" as const, text }] : [])], ...extra };
}

export const STASH: StashEntry[] = [
  { id: "st1", text: "Try the queue strip as a popover instead", chips: [], at: NOW - 3_600_000 },
  {
    id: "st2",
    text: "Compare these two screenshots\nand tell me which spacing is right",
    chips: [IMAGE_1.block, IMAGE_2.block],
    at: NOW - 600_000,
  },
  { id: "st3", text: "", chips: [FILE_1.block], at: NOW - 60_000 },
];

export const LONG_DRAFT = Array.from(
  { length: 14 },
  (_, i) => `${i + 1}. Another line of a long prompt that keeps going so the box has to grow and then scroll.`,
).join("\n");

export const HUGE_DRAFT = "Here is the whole spec pasted inline rather than as a file. ".repeat(60);

export type ChatInputProps = {
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
  /** Which commands are skills, the only ones a mid-sentence `/` offers. */
  skills?: string[];
  height?: string;
};

export function ChatInput(props: ChatInputProps) {
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
    <div style={{ position: "relative", height: props.height ?? "100vh" }}>
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
            skills={props.skills ?? SKILLS}
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

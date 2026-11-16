import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { EditorView } from "@codemirror/view";
import type { SocketAsk } from "../../utils/socketAsks";
import { stubHost } from "../../dev/stubHost";
import {
  CONFIG,
  ChatInput,
  DIAG_REF,
  DIAG_TEXT,
  FILE_1,
  FILE_1_PATH,
  FILE_2,
  FILE_JSON,
  FILE_PASTED,
  HUGE_DRAFT,
  HUNK_REF,
  HUNK_TEXT,
  IMAGES_ONLY,
  IMAGE_1,
  IMAGE_2,
  IMAGE_3,
  IMAGE_BYTES,
  IMAGE_LONG,
  LANE_BLOCKED,
  LANE_DONE,
  LANE_FAILED,
  LANE_LAUNCHED,
  LANE_RUNNING,
  LANE_RUNNING_LONG,
  LANE_STOPPED,
  LANE_UNNAMED,
  LONG_DRAFT,
  MENTION,
  NOW,
  NO_UPLOADS,
  PDF_1,
  PDF_2,
  PDF_PAGES,
  PLAN,
  PROJECT_CHIP,
  PR_CHIP,
  SELECTION,
  SELECTION_LINE,
  SESSION_CHIP,
  SPACE_CHIP,
  STASH,
  TASKS,
  TODO_REF,
  TODO_TEXT,
  chatInputHost,
  chip,
  lane,
  queued,
  stubAssetUrls,
} from "./__fixtures__/chatInput";

function editor(canvas: HTMLElement): EditorView {
  return EditorView.findFromDOM(canvas.querySelector<HTMLElement>(".cm-editor")!)!;
}

/** Focus the input with the caret at the end of the draft, which is what opens
 *  a completion menu for the token there and what the fence notice reads. */
async function caretAtEnd({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = editor(canvasElement);
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length } });
}

async function openStash({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = editor(canvasElement);
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
}

async function dragOver({ canvasElement }: { canvasElement: HTMLElement }) {
  const data = new DataTransfer();
  data.items.add("screenshot.png", "text/plain");
  editor(canvasElement).contentDOM.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true }));
}

const meta = {
  title: "Chat/ChatInput",
  component: ChatInput,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => {
      stubHost([chatInputHost]);
      stubAssetUrls();
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

function previewChip(name: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    canvasElement.querySelector<HTMLButtonElement>(`button[aria-label^="Preview"][aria-label*="${name}"]`)?.click();
  };
}

/** Clicking a chip opens it in a dialog, by the viewer the editor uses for it. */
export const PreviewImage: Story = { args: { attachments: [IMAGE_1, FILE_1] }, play: previewChip("screenshot") };

export const PreviewSourceFile: Story = { args: { attachments: [IMAGE_1, FILE_1] }, play: previewChip("Composer.tsx") };

export const PreviewSelection: Story = { args: { attachments: [SELECTION] }, play: previewChip("LaneStrip.tsx") };

export const PreviewPullRequest: Story = { args: { attachments: [PR_CHIP] }, play: previewChip("PR 412") };

export const PreviewNote: Story = {
  args: { attachments: [chip("hunk", HUNK_REF), chip("hunk-text", HUNK_TEXT)] },
  play: previewChip("never exits"),
};

export const PreviewMissingFile: Story = {
  args: { attachments: [FILE_1], missing: [FILE_1_PATH] },
  play: previewChip("Composer.tsx"),
};

/** Markdown as it is typed: emphasis, inline code, and a fenced block in its
 *  own language, with the held attachments drawn as chips in the sentence. */
export const EditorMarkdownAndChips: Story = {
  args: {
    attachments: [IMAGE_1, FILE_1, PDF_1, PR_CHIP, SESSION_CHIP],
    draft: [
      "The **queue** jumps after a steer. Compare [Image 1] with [File 1], and check `pendingFor` against [PDF 1].",
      "",
      "```ts",
      "const lanes = props.lanes.filter((l) => l.status === null);",
      "// why does this run twice?",
      "createEffect(() => setQueue(lanes.length));",
      "```",
      "",
      "Then finish [PR 412] and pick up from [Session: Fix the lane strip timer].",
    ].join("\n"),
  },
};

export const EditorSlashCommand: Story = { args: { draft: "/compact keep the queue design notes" } };

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

/** Mid-sentence, `/` offers only skills: the agent takes one there as leave to
 *  load it, where a built-in like `/compact` would be words that do nothing. */
export const SkillMidSentence: Story = { args: { draft: "Fix the queue, then /" }, play: caretAtEnd };

/** A command at the start and a skill named mid-sentence, each in its colour. */
export const CommandAndSkill: Story = {
  args: { draft: "/compact then /review the queue, and /simplify it. `/review` in code stays code." },
};

/** An agent that does not say which commands are skills offers nothing there. */
export const SkillMidSentenceUnknown: Story = {
  args: { draft: "Fix the queue, then /", skills: [] },
  play: caretAtEnd,
};

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

function hover(selector: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const target = canvasElement.querySelector(selector);
    if (!target) return;
    for (const type of ["pointerenter", "pointerover", "pointermove"]) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    }
  };
}

/** The tooltips, one open per story, for checking what each one says. */
export const TooltipImageTile: Story = {
  args: { attachments: [IMAGE_1, FILE_1] },
  play: hover('button[aria-label^="Preview [Image 1]"]'),
};

export const TooltipSelectionTile: Story = {
  args: { attachments: [SELECTION] },
  play: hover('button[aria-label^="Preview @LaneStrip"]'),
};

export const TooltipMissingFile: Story = {
  args: { attachments: [FILE_1], missing: [FILE_1_PATH] },
  play: hover('button[aria-label^="Preview [File 1]"]'),
};

export const TooltipPullRequest: Story = {
  args: { attachments: [PR_CHIP] },
  play: hover('button[aria-label^="Preview [PR 412]"]'),
};

export const TooltipRunningSubagent: Story = {
  args: { running: true, lanes: [{ ...LANE_RUNNING, activity: "Reading Composer.tsx" }] },
  play: hover('[aria-label="Subagent lanes"] button:nth-child(2)'),
};

export const TooltipDoneSubagent: Story = {
  args: { lanes: [LANE_DONE[0]] },
  play: hover('[aria-label="Subagent lanes"] button:nth-child(2)'),
};

export const TooltipBackgroundTask: Story = {
  args: { tasks: TASKS },
  play: hover('[class*="laneStill"]'),
};

/** Hovering a token in the text lights the attachment it names above. */
export const InlineTokenPointsAtAttachment: Story = {
  args: { attachments: [IMAGE_1, FILE_1, PR_CHIP], draft: "Compare [Image 1] with what [PR 412] changed." },
  play: async ({ canvasElement }) => {
    canvasElement
      .querySelector('.cm-chip button[aria-label^="Preview [PR 412]"]')
      ?.dispatchEvent(new MouseEvent("mouseenter"));
  },
};

export const TooltipQueuedMessage: Story = {
  args: { running: true, queue: [queued("q1", "Also run the lints\nand then the type check", [IMAGE_1.block])] },
  play: hover('span[class*="queueText"]'),
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

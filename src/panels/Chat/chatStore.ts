// The per-session chat state: an ordered item list, a tool-call index, the
// streaming buffers, the composer queue, and the status a chat reports to the
// rest of Sway.
//
// Pure core, thin wrapper (see the pure-core-for-global-stores lesson). Every
// function here mutates a plain `ChatState` draft and touches nothing global,
// so the whole event pipeline is testable without Solid, without a DOM and
// without a live `claude`. `ChatView` owns the only reactive wrapper, applying
// these through `produce`.
//
// Mutating rather than returning a new state is deliberate: a session runs for
// thousands of events and copying the item list on every delta is the one thing
// that would make streaming cost O(n^2).
//
// Two ordering facts drive the whole design:
//
//   - Nothing here depends on the order a tool call is announced in. This was
//     written when the approval prompt arrived over a Unix socket from a forked
//     hook helper while the `assistant` frame declaring the same call arrived on
//     the child's stdout, with nothing ordering the two. That socket is gone -
//     the agent asks in-protocol now - but the property is kept rather than
//     leaned on: a tool card is materialized on first reference to a
//     `toolUseId` from whichever frame lands first, and the later one fills in
//     what it knows without resetting what is already there. Two transports
//     feed this store and neither is asked to promise an order.
//   - Deltas interleave with tool calls. Text after a tool call is a new
//     bubble, not an append to the one before it, so the open bubble is closed
//     whenever anything else is appended.

import type {
  ChatAccount,
  ChatCapabilities,
  ChatEvent,
  ChatConfigOption,
  ChatModeInfo,
  ChatModelInfo,
  ChatQuestion,
  ContentBlock,
  FileEditKind,
  HookPhase,
  McpServer,
  PermissionMode,
  PatchHunk,
  PermissionSuggestion,
  PlanItem,
  QuestionAnswer,
  SlashCommand,
  SubagentUsage,
  ToolKind,
  ToolLocation,
  ToolSummary,
  Usage,
} from "../../utils/chatTypes";
import type { ChatTransport } from "../../utils/agents";
import { chatPlugins, stringList, type ChatPlugin } from "../../utils/chatCapabilities";
import { contextTokens, reportedWindows } from "../../utils/chatModels";
import { rateLimitFrom, type RateLimitState } from "../../utils/chatRateLimit";
import type { ProbeState } from "../../utils/safeSend";
import type { SessionStatus } from "../../utils/sessionStatus";

/** How far back the message list renders before "load earlier" is offered. */
export const WINDOW_STEP = 60;

export type ToolCardState = "awaitingApproval" | "running" | "ok" | "error" | "denied";

export type PendingApproval = {
  requestId: string;
  autoDenyAtMs: number | null;
  /** Actions the agent itself offered for this call. Empty for a agent that
   *  offers none rather than meaning it offered nothing. */
  suggestions: PermissionSuggestion[];
  /** The subagent that made the call, or null for the main agent. */
  agentId: string | null;
};

export type ChatFileEdit = {
  path: string;
  kind: FileEditKind;
  beforeBlob: string | null;
};

/** `steer` marks a message delivered *into* a turn that was already running,
 *  rather than one that opened a turn of its own. The transcript renders the
 *  two differently, because reading a steer as an ordinary prompt would suggest
 *  the reply below it answers only that. */
export type UserItem = { kind: "user"; id: string; blocks: ContentBlock[]; steer: boolean };
export type TextItem = { kind: "text"; id: string; turnId: string; text: string; agentId: string | null };
/** `startedAt` is when the model went quiet (the frame before this block),
 *  `endedAt` when its last delta landed, so a settled block can say how long the
 *  thinking took. **Not the first delta to the last**: thinking usually arrives
 *  whole, in one frame, and a span measured inside that frame is always ~0. The
 *  wait is what the reader sat through, so the wait is what is measured.
 *
 *  A replay folds every frame in one tick, so its span really is ~0 and renders
 *  as unmeasured rather than as a fabricated duration. */
export type ThinkingItem = {
  kind: "thinking";
  id: string;
  turnId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  agentId: string | null;
};
/** `details` is the long half of a notice, shown behind a disclosure: the line
 *  itself has to stay readable at a glance in the middle of a conversation, and
 *  a compaction summary is several hundred words. Absent on a notice that is
 *  only its line. */
export type NoticeItem = {
  kind: "notice";
  id: string;
  text: string;
  level: "info" | "error";
  details?: string;
  /** Set while the thing the line describes is still happening, and cleared
   *  when it lands. The only one so far is a compaction, which takes half a
   *  minute of complete wire silence: the row is what says the session is
   *  working rather than wedged, and the stamp is what lets it count. */
  pendingSince?: number;
  /** Kept in `items` but dropped by the view, the same move a folded hook row
   *  makes. Set on a compaction whose turn ended without a boundary: removing
   *  the row would move every index in `toolIndex` under it. */
  hidden?: boolean;
};
export type ToolItem = {
  kind: "tool";
  id: string;
  toolUseId: string;
  /** The subagent that made the call, or null for the main agent. Filled from
   *  whichever frame names the lane first: `subagentCall`, or the permission
   *  prompt for a call that had to ask. */
  agentId: string | null;
  /** Null until a frame that knows the turn arrives: a permission prompt is
   *  session-scoped on the wire and can materialize the card first. */
  turnId: string | null;
  name: string | null;
  /** The agent's own prose for the call, when it sent any. ACP fills this and
   *  Claude does not, whose `name` is already the human-readable thing. */
  title: string | null;
  /** What the call is doing, in ACP's vocabulary. Picks the renderer, so a
   *  running call already has a body shape before any result lands. Not `kind`,
   *  which every row spends on its own discriminant. */
  toolKind: ToolKind;
  /** Every file the call reached for, wider than `files`, which is only what it
   *  wrote. */
  locations: ToolLocation[];
  input: unknown;
  state: ToolCardState;
  approval: PendingApproval | null;
  output: string | null;
  /** `output` is an extract and the rest is held in the backend, so the card
   *  offers to fetch it. False for every output that fitted, and for a replayed
   *  one whose remainder nothing kept. */
  outputTruncated: boolean;
  /** What the call did, in numbers. Null while it runs, and null for a result
   *  whose shape no summariser recognised. */
  summary: ToolSummary | null;
  /** The diff the call made, where the transport measured one. Empty for a call
   *  that wrote nothing, and for every ACP agent, whose cards diff the call's
   *  own arguments instead. */
  patch: PatchHunk[];
  files: string[];
  durationMs: number | null;
  edits: ChatFileEdit[];
};

/** One hook frame, as a transcript row.
 *
 *  One row per frame rather than one per hook execution: the `started` and
 *  `finished` frames both appear. A hook that ran as configured is folded away
 *  by default, which is what keeps a 60-tool-call turn from adding 120 rows of
 *  plumbing; `swayOwned` names whose hook a surviving row belongs to, since
 *  `name` cannot - it reports the *tool*, so Sway's hook on a `Write` and a
 *  user's hook on the same `Write` are both `PreToolUse:Write`. */
export type HookItem = {
  kind: "hook";
  id: string;
  hookId: string;
  name: string;
  event: string;
  phase: HookPhase;
  swayOwned: boolean;
  outcome: string | null;
  exitCode: number | null;
  output: string | null;
  stderr: string | null;
};

/** A question the agent asked, as a transcript row.
 *
 *  **Its own item rather than a tool card**, because the two are answered
 *  differently: a tool card's prompt is allow or deny, and this is a form. It
 *  also means the vendor's answer string never surfaces as a denied call, which
 *  is what it literally is on the wire.
 *
 *  Assembled from two sources that do not both exist. Live, `questionRequest`
 *  brings the form and the `requestId` that makes it answerable. Replayed,
 *  `history.rs` emits neither, so the row is rebuilt from the tool call's own
 *  input and its result, and `requestId` stays null. **Null is what makes a
 *  replayed question read only**, rather than a separate flag that could
 *  disagree with it.
 *
 *  There is no deadline field. Measured: neither the CLI nor Sway arms one, so
 *  the only things that end an unanswered question are the user and an explicit
 *  withdrawal. */
export type QuestionItem = {
  kind: "question";
  id: string;
  toolUseId: string;
  /** Null until a frame that knows the turn arrives, exactly like `ToolItem`'s:
   *  the request is session-scoped on the wire and can land first. */
  turnId: string | null;
  /** Null on a replayed question, which is what makes it read only. */
  requestId: string | null;
  /** The subagent that asked, or null for the main agent. Rendered, so a
   *  question about work the user did not ask for directly says so. */
  agentId: string | null;
  questions: ChatQuestion[];
  /** What the user sent, held from the moment they send it so the form settles
   *  immediately rather than waiting for the round trip. */
  submitted: QuestionAnswer[] | null;
  /** The tool result once the call settled: the agent's own record of the
   *  answer. Present from the first render on a replayed question. */
  result: string | null;
};

export type ChatItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem | HookItem | QuestionItem;

/** The lane a row belongs to: the subagent that produced it, or null for the
 *  main agent. A notice, a hook row and a user message are the session's rather
 *  than any one agent's, so they are always the main agent's. */
export function laneOf(it: ChatItem): string | null {
  switch (it.kind) {
    case "tool":
    case "question":
    case "text":
    case "thinking":
      return it.agentId;
    default:
      return null;
  }
}

/** The main agent's key in the per-lane maps. Empty rather than a word: a
 *  subagent's id is the CLI's `task_id`, which no reserved name can rule out. */
const MAIN_LANE = "";

function laneKey(agentId: string | null): string {
  return agentId ?? MAIN_LANE;
}

/** One subagent, as the lane strip reads it. Everything but `agentId` is
 *  nullable because three frames patch this a piece at a time, and `status`
 *  stays the agent's own word so `cancelled` cannot fold into "finished". */
export type Lane = {
  agentId: string;
  /** The `Agent` call that launched it: the way back into the lane from the
   *  parent's transcript once the lane leaves the strip. */
  toolUseId: string | null;
  agentType: string | null;
  /** What it was asked to do. `activity` is what it is doing now. */
  description: string | null;
  prompt: string | null;
  status: string | null;
  activity: string | null;
  lastToolName: string | null;
  usage: SubagentUsage | null;
  summary: string | null;
  /** The lane this one was launched from, or null for one the main agent
   *  opened. Only a null-parent lane reaches the strip: a deeper agent renders
   *  as cards inside its ancestor's lane, so the strip stays a list. */
  parentId: string | null;
  startedAt: number;
};

/** The tool whose call is a question. Named here as well as in the Rust mapper
 *  because a replayed session carries no `questionRequest` to recognise: the
 *  name on the tool call is the only signal history preserves. */
export const ASK_USER_QUESTION = "AskUserQuestion";

/** Whether this question can still be answered.
 *
 *  Three ways it cannot: it was replayed from history (no `requestId`), the user
 *  already sent an answer, or the call has settled. Stated once here because the
 *  card and the store both need the same answer. */
export function answerable(item: QuestionItem): boolean {
  return item.requestId !== null && item.submitted === null && item.result === null;
}

/**
 * Human prompts this store holds, replayed history included.
 *
 * Counted off the items rather than read back from the transcript scan, which
 * lags a turn: the scan is triggered by the same `turnCompleted` the store
 * folds in memory, but the CLI has not necessarily flushed that turn to disk
 * yet. Steers count, because a steer is a message the person sent and the
 * transcript records it as one.
 *
 * Nothing is ever dropped from `items` (the render window is a view, not
 * storage), so this is a total rather than a count of what is on screen.
 *
 * Unscoped by lane, unlike `toolCallsSeen`: nothing can talk to a subagent, so
 * a `user` row is the main agent's by construction.
 */
export function promptsSent(s: ChatState): number {
  return s.items.reduce((n, it) => n + (it.kind === "user" ? 1 : 0), 0);
}

/**
 * Tool calls this store has seen, replayed history included.
 *
 * One per `toolUseId`, which is what a tool card is keyed by, so a call
 * announced twice (the permission prompt and the assistant frame race) counts
 * once. Same reason as `promptsSent` for not asking the scan.
 *
 * **The main agent's calls only.** One `Agent` call that fanned out into twenty
 * is one call the session made, and the strip pairs this with the prompt count.
 */
export function toolCallsSeen(s: ChatState): number {
  return s.items.reduce((n, it) => n + (it.kind === "tool" && laneOf(it) === null ? 1 : 0), 0);
}

/**
 * The transcript rows to render, given whether hook plumbing is shown.
 *
 * A hook that succeeded is an answer to a question nobody asked: it ran, as
 * configured, the way it does on every session. So a hook earns a row only by
 * **failing** (a non-zero exit), which is the one time it is the most important
 * thing on screen and nothing else explains what happened.
 *
 * **A failure is shown whoever's hook it was.** This used to fold Sway's own
 * rows away even then, which read as correct only because the marker was never
 * actually landing: Sway's hook decided tool calls, and its verdict already
 * rendered on the tool card it gated. Sway's only hook now captures a
 * before-state and decides nothing, so its failing is news nothing else
 * carries - the diffs are silently gone. `swayOwned` decides the row's *label*
 * rather than whether it appears.
 *
 * The setting reveals everything, and nothing is ever dropped from the state,
 * so the toggle works on a session already in progress.
 *
 * `lane` narrows it to one agent's rows, null being the main agent's. A hidden
 * notice survives neither: it is kept only so the indexes above it stay put.
 */
export function visibleItems(items: readonly ChatItem[], showAllHooks: boolean, lane: string | null): ChatItem[] {
  return items.filter((it) => {
    if (laneOf(it) !== lane) return false;
    if (it.kind === "notice" && it.hidden) return false;
    return showAllHooks || it.kind !== "hook" || hookFailed(it);
  });
}

/** The one outcome worth a transcript row: the agent reported a non-zero
 *  exit. A `started` frame (exit still null) is never a failure yet. */
export function hookFailed(it: Pick<HookItem, "exitCode">): boolean {
  return it.exitCode !== null && it.exitCode !== 0;
}

export type QueuedInput = { id: string; text: string };

/** `model` is the resolved id `turnStarted` reported for this turn, or null
 *  for a turn that never named one (replayed history has no turn frames). The
 *  transcript's per-turn header reads it, so an old turn keeps the model that
 *  actually ran it rather than inheriting whatever the session switched to. */
type TurnRecord = {
  completed: boolean;
  model: string | null;
  /** The agent opened this turn, not anything the user sent: a background
   *  subagent finishing makes the CLI open one. The transcript must not hang
   *  the user's last prompt on it. */
  agentInitiated: boolean;
};

export type ChatState = {
  sessionId: string;
  items: ChatItem[];
  /** `toolUseId` -> index into `items`. Items are only ever appended, so an
   *  index stays valid for the life of the session. */
  toolIndex: Record<string, number>;
  /** `toolUseId` -> index into `items`, for question rows. Separate from
   *  `toolIndex` rather than shared: one id is either a tool card or a question,
   *  never both, and one map holding two item types is how a lookup starts
   *  returning the wrong shape. */
  questionIndex: Record<string, number>;
  /** Whether `AskUserQuestion` renders as a form here. Held on the state rather
   *  than read at the call site because the reducer is pure, and a replayed
   *  session has nothing but the tool name to go on. */
  answerQuestionsInline: boolean;
  turns: Record<string, TurnRecord>;
  activeTurnId: string | null;
  /** Lane key -> index in `items` of the bubble a further delta appends to,
   *  absent when the next must open a fresh one. An index per lane, because a
   *  subagent's card landing between two deltas made the old "is it still the
   *  last row" check answer no and split the paragraph in half. */
  openText: Record<string, number>;
  openThinking: Record<string, number>;
  /** Every subagent this session has heard of. Nothing is ever removed: a lane
   *  leaves the *strip* when it ends, and its rows stay readable. */
  lanes: Record<string, Lane>;
  /** The lane being read, or null for the main agent. Never restored from a
   *  previous session, whose subagents are gone. */
  selectedLane: string | null;
  /** `toolUseId` -> the lane a subagent's call ran in. Kept because a card can
   *  be made before the frame naming its lane, and because a nested `Agent`
   *  call is how a depth-2 lane finds its parent. */
  laneOfCall: Record<string, string>;
  /** When this chat last showed a sign of life, of any kind. Read by nothing
   *  but the thinking span, which needs to know when the model went quiet, and
   *  the last frame is the only thing that knows. */
  lastFrameAt: number;
  /** The child answered the `initialize` handshake. Weaker than `started`:
   *  the process is alive and talking, but no turn has run, so nothing has
   *  named the model or the mode yet. */
  ready: boolean;
  started: boolean;
  ended: boolean;
  /** A turn has been sent that the child has not acknowledged with its
   *  `turnStarted` yet. Without this the composer would read as idle for the
   *  round trip after Enter, and the queue would flush its whole backlog into
   *  that window instead of one turn at a time. */
  awaitingTurn: boolean;
  /** Input typed before the sent turn was acknowledged, in the order it was
   *  typed. An *acknowledged* running turn takes input directly (`steerable`),
   *  so this window is now the only one that queues. */
  queue: QueuedInput[];
  /** A cancelled turn parks the queue instead of flushing it: an interrupt
   *  reports as a completion, and flushing on it would send exactly the
   *  messages the user pressed stop to prevent. */
  queueHeld: boolean;
  /** Set when a spend ceiling stopped this chat. Held in the store rather than
   *  in the panel so `chatStatus` can report it, which is what puts a stopped
   *  session on the same needs-you edge as one blocked on a permission prompt. */
  budgetStopped: boolean;
  /** The **resolved** model id the child reports (`claude-sonnet-5`), which is
   *  not what `--model` takes and not what the picker selects on. */
  model: string | null;
  /** The `--model` value last sent from the picker, and the only record of
   *  *which* value is in force: several values resolve to one id, so the
   *  session's own report cannot say. Null until something picks. */
  modelValue: string | null;
  /** A model picked that the next turn has not confirmed yet, carrying both
   *  ids: the value is what was sent, the resolved id is what the next init has
   *  to report for the pick to count as landed. */
  pendingModel: { value: string; resolvedModel: string } | null;
  /** The effort level in force, and one picked but not yet applied. Unlike the
   *  model and the mode, **nothing on the wire reports effort back**, so the
   *  applied value is what was last sent rather than what was confirmed.
   *
   *  `null` on either is a real state and not an absence: it is the level Sway
   *  has never sent, so whatever the CLI itself runs. That is why the pending
   *  slot has **three** states rather than two - `undefined` for "nothing
   *  picked", `null` for "picked: back to the CLI's own default", a string for
   *  a level. Overloading `null` as both left the default unpickable, and left
   *  the menu with no row to tick while the pill read "Default". */
  effort: string | null;
  pendingEffort: string | null | undefined;
  /** The live model catalogue from the handshake. Empty means "fall back to the
   *  adapter table", not "no models". */
  models: ChatModelInfo[];
  /** The live mode catalogue, on the same rule. For an ACP agent this is the
   *  only source: its adapter declares no `[[chat.modes]]` because a mode there
   *  is a request rather than a flag. */
  modes: ChatModeInfo[];
  /** Every configuration lever the agent published, model and mode included.
   *  The mirror renders the ones with no bespoke control of their own; the
   *  three that have one are here too, so nothing has to be told twice which
   *  categories those are. Empty for a agent that publishes none, which is
   *  claude. */
  configOptions: ChatConfigOption[];
  /** `system/init`'s fast-mode state, and the agent's reason when it is
   *  unavailable. */
  fastModeState: string | null;
  fastModeDisabledReason: string | null;
  /** Compactions this session has been through, and the tokens they reclaimed.
   *  Counted here rather than read back from the transcript scan because the
   *  replay emits `compacted` for a resumed session's earlier ones too, so the
   *  store's count is complete as well as live - unlike turns, which replayed
   *  history carries no frames for. */
  compactions: number;
  compactionReclaimed: number;
  /** The notice a running compaction is writing itself into, or null when none
   *  is running. Held as an id rather than a boolean because the boundary that
   *  ends it has to land *in that row* - a compaction that announced itself and
   *  then reported its result three rows later would read as two events. */
  compactingItemId: string | null;
  /** Context windows the agent reported, keyed by every id it named them
   *  under, accumulated across turns. The authoritative source: it is measured
   *  per model and per provider by the session itself. Empty until the first
   *  turn completes, which is what the adapter's declared figure covers. */
  contextWindows: Record<string, number>;
  /** The window the session stated for *itself*, whatever model is running:
   *  ACP's `size`, which arrives with every usage update. Null for an agent
   *  that states none, which is every Claude session (it reports per model
   *  instead, above). */
  contextWindow: number | null;
  /** Who the session is signed in as. Null until the handshake answers, and
   *  forever for a session that never handshook - which renders as nothing
   *  rather than as a guessed tier. */
  account: ChatAccount | null;
  /** What the running agent advertised about itself at `initialize`, or null for
   *  a agent that advertises nothing because its capabilities are measured and
   *  pinned instead. Never overwritten by a later frame that did not carry one:
   *  the handshake is the only source. */
  capabilities: ChatCapabilities | null;
  /** The mode the session is actually in, as the child re-declares it on every
   *  turn. Never set from a click: a control that moved on its own would claim
   *  an effect the CLI cannot deliver mid-turn. */
  permissionMode: PermissionMode | null;
  /** A mode the user picked that has not taken effect yet. The CLI applies a
   *  switch at the next turn boundary, so until then the two disagree and the
   *  control has to say so. */
  pendingMode: PermissionMode | null;
  /// Modes this agent answered with a refusal, and the reason it gave. Kept so
  /// the control can mark a row that can never land instead of offering it
  /// again; the agent is the only thing that knows, so this is its answer.
  refusedModes: Record<string, string>;
  tools: string[];
  slashCommands: SlashCommand[];
  mcpServers: McpServer[];
  /** Skills, subagents and plugins the session loaded, from `system/init`.
   *  Measured shapes (claude 2.1.220): `skills` and `agents` are arrays of
   *  plain strings, `plugins` an array of objects. They live in `extra` on the
   *  wire because they are Claude-specific, and are lifted here so the UI does
   *  not have to know that. */
  skills: string[];
  agents: string[];
  plugins: ChatPlugin[];
  plan: PlanItem[];
  /** Tokens the conversation is holding right now, or null before anything has
   *  measured it.
   *
   *  **The newest measurement, never a sum**, and there are two kinds:
   *
   *    - a **per-response** usage event, which is the request the model was
   *      last given (`contextTokens`: input plus both cache figures, output
   *      excluded because it becomes input on the next request);
   *    - a **compaction boundary**, which reports the size it left behind.
   *
   *  Whichever arrived last is the answer, so there is no precedence rule to
   *  get wrong: a compaction supersedes the response before it, and the next
   *  response supersedes the compaction.
   *
   *  What must never land here is a `result` frame's usage. That is the whole
   *  turn added up across every API call it made, so a turn with thirty tool
   *  calls reports thirty cache reads of the same conversation - 7.8M against a
   *  1M window, which is not a context size, it is a bill. Anthropic's own
   *  status line defines the context as the figures "from the most recent API
   *  response"; the turn's total is kept under the two names that mean it. */
  contextTokens: number | null;
  /** The last **completed** turn's usage, paired with `lastCostUsd` from the
   *  same `result` frame. Kept apart from `lastUsage` because that one moves
   *  mid-turn while the cost cannot: showing them together would caption a
   *  running turn's tokens with the previous turn's price. */
  lastTurnUsage: Usage | null;
  lastCostUsd: number | null;
  /** Every completed turn's usage and cost added up, plus how many turns went
   *  into them.
   *
   *  Summed rather than read off the newest `result`, because the field named
   *  `total_cost_usd` is **per turn** despite the name. Measured on the
   *  two-turn capture: both result frames report `num_turns: 1` and the same
   *  `input_tokens: 2` / `output_tokens: 3`, which a session-cumulative figure
   *  could not do. Taking the last frame as the session total would therefore
   *  have shown the newest turn's cost labelled as the whole session's.
   *
   *  `totalCostUsd` stays null until some turn actually reports a cost, so a
   *  session whose turns carried none reads as unknown rather than as free. */
  totalUsage: Usage;
  totalCostUsd: number | null;
  turnsCompleted: number;
  /** The newest `rate_limit_event`, whatever it said. Null until one arrives.
   *  Whether it is worth a banner is `isLimited`'s decision, not this field's. */
  rateLimit: RateLimitState | null;
  /** Monotonic id source, so replaying the same events twice yields the same
   *  item ids and tests can assert on them. */
  seq: number;
};

export function initialChat(sessionId: string, answerQuestionsInline = true): ChatState {
  return {
    sessionId,
    items: [],
    toolIndex: {},
    questionIndex: {},
    answerQuestionsInline,
    turns: {},
    activeTurnId: null,
    openText: {},
    openThinking: {},
    lanes: {},
    selectedLane: null,
    laneOfCall: {},
    lastFrameAt: Date.now(),
    ready: false,
    started: false,
    ended: false,
    awaitingTurn: false,
    queue: [],
    queueHeld: false,
    budgetStopped: false,
    model: null,
    modelValue: null,
    pendingModel: null,
    effort: null,
    pendingEffort: undefined,
    models: [],
    modes: [],
    configOptions: [],
    fastModeState: null,
    fastModeDisabledReason: null,
    account: null,
    capabilities: null,
    compactions: 0,
    compactionReclaimed: 0,
    compactingItemId: null,
    contextWindows: {},
    contextWindow: null,
    permissionMode: null,
    pendingMode: null,
    refusedModes: {},
    tools: [],
    slashCommands: [],
    mcpServers: [],
    skills: [],
    agents: [],
    plugins: [],
    plan: [],
    contextTokens: null,
    lastTurnUsage: null,
    lastCostUsd: null,
    totalUsage: zeroUsage(),
    totalCostUsd: null,
    turnsCompleted: 0,
    rateLimit: null,
    seq: 0,
  };
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 };
}

/** Add one turn's usage into the running session total, field by field so a new
 *  field on `Usage` fails the typecheck here rather than being silently dropped
 *  from every total. */
function addUsage(total: Usage, turn: Usage) {
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.cacheReadTokens += turn.cacheReadTokens;
  total.cacheWriteTokens += turn.cacheWriteTokens;
  total.thinkingTokens += turn.thinkingTokens;
}

/** Token counts as the notices show them. Same rounding as the context meter,
 *  so one session never reports two different figures for one number. */
function fmtTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function nextId(s: ChatState, prefix: string): string {
  s.seq += 1;
  return `${prefix}${s.seq}`;
}

/**
 * The notice a running compaction is writing itself into, released from the
 * state as it is handed back. Null when none is running, which is every
 * compaction Sway learns about only from the boundary: a resumed session's
 * replayed history, and any agent that reports no start of its own.
 */
function settleCompaction(s: ChatState): NoticeItem | null {
  const id = s.compactingItemId;
  if (!id) return null;
  s.compactingItemId = null;
  const item = s.items.find((i) => i.id === id);
  return item?.kind === "notice" ? item : null;
}

/** Appending closes both streaming bubbles **of its own lane**, so text after a
 *  tool call opens a fresh bubble while a subagent's card, which renders
 *  nowhere near it, leaves the main agent's paragraph alone. */
function push(s: ChatState, item: ChatItem) {
  const lane = laneKey(laneOf(item));
  delete s.openText[lane];
  delete s.openThinking[lane];
  s.items.push(item);
}

/** The card for a tool call, created on first reference from whichever channel
 *  got here first. Never returns a second card for the same `toolUseId`. */
function ensureTool(s: ChatState, toolUseId: string, turnId: string | null): ToolItem {
  const at = s.toolIndex[toolUseId];
  if (at !== undefined) {
    const existing = s.items[at] as ToolItem;
    if (existing.turnId === null && turnId !== null) existing.turnId = turnId;
    return existing;
  }
  const card: ToolItem = {
    kind: "tool",
    id: nextId(s, "tool"),
    toolUseId,
    agentId: s.laneOfCall[toolUseId] ?? null,
    turnId,
    name: null,
    title: null,
    toolKind: "other",
    locations: [],
    input: null,
    state: "running",
    approval: null,
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    files: [],
    durationMs: null,
    edits: [],
  };
  s.toolIndex[toolUseId] = s.items.length;
  push(s, card);
  return card;
}

/** The question row for this call, creating it if this is the first frame.
 *
 *  **A tool card already made for this id is taken over rather than left
 *  beside a second row.** Reachable in one window: the backend reads the
 *  preference when it spawns and this store reads it when it mounts, so a
 *  remount after the setting was flipped leaves a store that suppresses nothing
 *  talking to a child that still asks. The declaration made a card, then the
 *  request arrives, and without this the call renders twice.
 *
 *  The slot is reused in place, never spliced: `toolIndex` and this index are
 *  positions into `items`, and every other entry would move under them. */
function ensureQuestion(s: ChatState, toolUseId: string, turnId: string | null): QuestionItem {
  const at = s.questionIndex[toolUseId];
  if (at !== undefined) {
    const existing = s.items[at] as QuestionItem;
    if (existing.turnId === null && turnId !== null) existing.turnId = turnId;
    return existing;
  }
  const cardAt = s.toolIndex[toolUseId];
  if (cardAt !== undefined) {
    const card = s.items[cardAt] as ToolItem;
    const adopted: QuestionItem = {
      kind: "question",
      id: card.id,
      toolUseId,
      turnId: card.turnId ?? turnId,
      requestId: null,
      agentId: card.agentId,
      questions: parseQuestions(card.input) ?? [],
      submitted: null,
      result: card.output,
    };
    s.items[cardAt] = adopted;
    s.questionIndex[toolUseId] = cardAt;
    // Removed, or a `toolIndex` lookup would hand back a question wearing a
    // card's name, which is the exact hazard the two maps are separate to
    // avoid.
    delete s.toolIndex[toolUseId];
    return adopted;
  }
  const item: QuestionItem = {
    kind: "question",
    id: nextId(s, "question"),
    toolUseId,
    turnId,
    requestId: null,
    agentId: s.laneOfCall[toolUseId] ?? null,
    questions: [],
    submitted: null,
    result: null,
  };
  s.questionIndex[toolUseId] = s.items.length;
  push(s, item);
  return item;
}

/** An `AskUserQuestion` input, as a form.
 *
 *  A second reader of the shape the Rust mapper already parses, and not a
 *  duplicate for its own sake: a replayed session carries no `questionRequest`,
 *  so the tool call's own input is the only place the questions survive.
 *
 *  **All or nothing, the same rule the mapper applies.** A form one row short
 *  would show the user fewer questions than the agent asked, and on a replayed
 *  row it would silently disagree with the recorded answer. `null` sends the
 *  call back to an ordinary tool card, which is honest about not being read. */
export function parseQuestions(input: unknown): ChatQuestion[] | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: ChatQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return null;
    const { question, header, multiSelect, options } = q as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options) || options.length === 0) return null;
    const parsed = [];
    for (const o of options) {
      if (typeof o !== "object" || o === null) return null;
      const { label, description, preview } = o as Record<string, unknown>;
      if (typeof label !== "string") return null;
      parsed.push({
        label,
        description: typeof description === "string" ? description : "",
        preview: typeof preview === "string" ? preview : null,
      });
    }
    questions.push({
      question,
      header: typeof header === "string" ? header : "",
      multiSelect: multiSelect === true,
      options: parsed,
    });
  }
  return questions;
}

/** Record a turn as live. Deltas can arrive before their `turnStarted` (two
 *  threads, no ordering), so any turn-scoped event routes through this rather
 *  than assuming the turn exists. */
function touchTurn(s: ChatState, turnId: string) {
  const known = s.turns[turnId];
  if (known) {
    // A completed turn never reopens: a late delta belongs to history.
    if (!known.completed) s.activeTurnId = turnId;
    return;
  }
  s.turns[turnId] = { completed: false, model: null, agentInitiated: false };
  s.activeTurnId = turnId;
  s.awaitingTurn = false;
  // A new turn is the boundary the CLI applies a queued effort switch at, and
  // **nothing on the wire reports effort back** the way init reports the model
  // and the mode. So a pending level is taken as applied at the first boundary
  // after it was sent rather than confirmed - which is the whole reason the
  // control promises "from the next turn" and never "switched to".
  //
  // Here rather than in the `turnStarted` arm because a boundary is whatever
  // first reveals a turn id this session has not seen, which is sometimes a
  // delta that overtook its own `turnStarted`.
  if (s.pendingEffort !== undefined) {
    s.effort = s.pendingEffort;
    s.pendingEffort = undefined;
  }
}

/** The lane a subagent's rows land in: itself when the main agent launched it,
 *  its topmost ancestor when another subagent did. Flattened here rather than
 *  at render, so the strip stays a list instead of becoming a tree. */
function rootLane(s: ChatState, agentId: string): string {
  const seen = new Set<string>([agentId]);
  let id = agentId;
  for (;;) {
    const parent = s.lanes[id]?.parentId;
    // Nothing on the wire can make a cycle. Guarded anyway because the cost of
    // being wrong is a hung fold rather than a misplaced row.
    if (!parent || seen.has(parent)) return id;
    seen.add(parent);
    id = parent;
  }
}

/** The lane record, created empty on first mention: a permission prompt carries
 *  the `task_id` alone and can beat `task_started` to the panel. */
function ensureLane(s: ChatState, agentId: string): Lane {
  const known = s.lanes[agentId];
  if (known) return known;
  const lane: Lane = {
    agentId,
    toolUseId: null,
    agentType: null,
    description: null,
    prompt: null,
    status: null,
    activity: null,
    lastToolName: null,
    usage: null,
    summary: null,
    parentId: null,
    startedAt: Date.now(),
  };
  s.lanes[agentId] = lane;
  return lane;
}

/** Attribute one call to a lane, and to whichever row was already made for it:
 *  the card and the frame naming its lane race on the wire. */
function noteLane(s: ChatState, toolUseId: string, agentId: string) {
  ensureLane(s, agentId);
  const lane = rootLane(s, agentId);
  s.laneOfCall[toolUseId] = lane;
  const at = s.toolIndex[toolUseId];
  if (at !== undefined) (s.items[at] as ToolItem).agentId = lane;
  const askedAt = s.questionIndex[toolUseId];
  if (askedAt !== undefined) (s.items[askedAt] as QuestionItem).agentId = lane;
}

/** The lanes the strip offers: one per subagent the **main** agent launched, in
 *  start order. A deeper agent is absent by design - its rows render inside its
 *  ancestor's lane. */
export function laneStrip(s: ChatState): Lane[] {
  return Object.values(s.lanes).filter((l) => l.parentId === null && !retired(s, l));
}

/** A lane leaves the strip once it succeeded *and* its launching call settled,
 *  from which point that card is the way back in. Only success retires: the rule
 *  that clears finished work must not clear a failure. */
function retired(s: ChatState, lane: Lane): boolean {
  if (lane.status !== "completed" || lane.toolUseId === null) return false;
  const at = s.toolIndex[lane.toolUseId];
  if (at === undefined) return false;
  const card = s.items[at] as ToolItem;
  return card.state !== "running" && card.state !== "awaitingApproval";
}

/** Read another lane, or main with `null`. One this session never had falls
 *  back to main rather than to an empty transcript. */
export function selectLane(s: ChatState, agentId: string | null) {
  s.selectedLane = agentId !== null && s.lanes[agentId] ? rootLane(s, agentId) : null;
}

/** Record the mode the child says it is in, and settle any pending pick: at the
 *  boundary rather than on the click, and whether or not the switch landed, since
 *  a refusal would otherwise leave the control promising a mode forever. */
function noteMode(s: ChatState, mode: PermissionMode) {
  s.permissionMode = mode;
  s.pendingMode = null;
}

/**
 * Record the **resolved** model id the child reports, and clear a pending pick
 * once that id says the pick landed.
 *
 * The comparison goes through `resolvedModel` and never through the picked
 * value, because init reports the former and never the latter: comparing the
 * value would mark every successful switch as failed. That is also why a
 * pending pick carries both halves - the fold would otherwise need the adapter
 * table to resolve one, and threading config through the reducer to answer a
 * question the picker already knew the answer to is how the two end up
 * disagreeing about what was picked.
 */
function noteModel(s: ChatState, resolvedModel: string) {
  s.model = resolvedModel;
  if (s.pendingModel === null) return;
  if (s.pendingModel.resolvedModel !== resolvedModel) return;
  s.modelValue = s.pendingModel.value;
  s.pendingModel = null;
}

/** Appends into the bubble of the lane the text came from. A subagent's prose
 *  arrives whole, in one frame, so it opens and closes in a single call and
 *  never interleaves with the main agent's the way two streams would. */
function appendText(s: ChatState, turnId: string, text: string, thinking: boolean, agentId: string | null) {
  touchTurn(s, turnId);
  const lane = laneKey(agentId);
  const open = thinking ? s.openThinking : s.openText;
  const at = open[lane];
  if (at !== undefined) {
    const block = s.items[at] as TextItem | ThinkingItem;
    block.text += text;
    if (block.kind === "thinking") block.endedAt = Date.now();
    return;
  }
  const item: TextItem | ThinkingItem = thinking
    ? // Opens at the previous frame, not at this one: the silence before the
      // block is the thinking, the block itself is only its transcript.
      {
        kind: "thinking",
        id: nextId(s, "think"),
        turnId,
        text,
        startedAt: s.lastFrameAt,
        endedAt: Date.now(),
        agentId,
      }
    : { kind: "text", id: nextId(s, "text"), turnId, text, agentId };
  push(s, item);
  open[lane] = s.items.length - 1;
}

/**
 * The files this event says the session wrote, for the consumers that want to
 * know sooner than the fs watcher's debounce can tell them (the gutter, the
 * Changes panel).
 *
 * Read off the events the transport already emits rather than off a second
 * source: `toolCallCompleted` carries the tool's write targets, and `fileEdit`
 * names one file each. Anything else writes nothing, which is most events.
 */
export function filesWritten(ev: ChatEvent): readonly string[] {
  if (ev.type === "toolCallCompleted") return ev.files;
  if (ev.type === "fileEdit") return [ev.path];
  return [];
}

/**
 * The assistant's last word before a tool call: the nearest text or thinking
 * item preceding it in the transcript.
 *
 * This is what lets the diff view answer "why is this line here" without
 * storing a second copy of the reasoning beside the diff. The transcript
 * already holds it in order; the diff only needs a way back in.
 *
 * Nearest-preceding rather than whole-turn, because a turn with six tool calls
 * has six separate justifications and attributing all of them to every hunk
 * would be worse than showing none.
 */
export function reasoningFor(items: readonly ChatItem[], toolUseId: string): string | null {
  const at = items.findIndex((it) => it.kind === "tool" && it.toolUseId === toolUseId);
  if (at < 0) return null;
  // Within the calling agent's own lane. A subagent's edit sits among the main
  // agent's rows, and the nearest paragraph above it is usually the main
  // agent's, which explains a different call entirely.
  const lane = laneOf(items[at]!);
  for (let i = at - 1; i >= 0; i--) {
    const it = items[i];
    // A user turn boundary means the model said nothing before this call.
    if (it.kind === "user") return null;
    if (laneOf(it) !== lane) continue;
    if (it.kind === "text" || it.kind === "thinking") {
      const text = it.text.trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Fold one event into the state.
 *
 * Tolerant by construction: an event for another session is ignored, a repeated
 * `turnStarted`/`turnCompleted`/`permissionRequest` is absorbed rather than
 * duplicated, and an event that arrives before the one that "should" have come
 * first creates what it needs. Nothing here throws: a chat panel must not go
 * down mid-turn over a frame it did not expect.
 */
export function applyEvent(s: ChatState, ev: ChatEvent) {
  if (ev.sessionId !== s.sessionId) return;
  foldEvent(s, ev);
  // After the fold, never before: the handlers read `lastFrameAt` to find out
  // how long the model was quiet, and stamping first would answer "no time at
  // all" every time.
  s.lastFrameAt = Date.now();
}

function foldEvent(s: ChatState, ev: ChatEvent) {
  switch (ev.type) {
    case "sessionStarted": {
      // `system/init` re-emits every turn; only the first is a session start,
      // and treating a later one as one would reset the transcript mid-chat.
      noteModel(s, ev.model);
      noteMode(s, ev.permissionMode);
      s.tools = ev.tools;
      s.slashCommands = ev.slashCommands;
      s.mcpServers = ev.mcpServers;
      s.skills = stringList(ev.extra, "skills");
      s.agents = stringList(ev.extra, "agents");
      s.plugins = chatPlugins(ev.extra);
      s.models = ev.models;
      s.modes = ev.modes;
      s.fastModeState = ev.fastModeState;
      s.fastModeDisabledReason = ev.fastModeDisabledReason;
      // Guarded like the catalogues below and for the same reason: this event
      // re-fires every turn, and the account has one source (the handshake), so
      // a later frame that never saw it must not erase what the first delivered.
      if (ev.account) s.account = ev.account;
      if (s.started) return;
      s.started = true;
      return;
    }
    case "sessionReady": {
      // The answered handshake: the child is alive before any turn has run.
      // The catalogues are taken only when the response actually carried them,
      // so a bare acknowledgement cannot erase what a fuller frame delivered.
      s.ready = true;
      if (ev.slashCommands.length) s.slashCommands = ev.slashCommands;
      if (ev.models.length) s.models = ev.models;
      if (ev.modes.length) s.modes = ev.modes;
      if (ev.account) s.account = ev.account;
      if (ev.capabilities) s.capabilities = ev.capabilities;
      return;
    }
    case "configOptions": {
      // Replaced wholesale, never merged: the agent republishes its whole set
      // on every change, and merging would keep a lever it had just withdrawn.
      s.configOptions = ev.options;
      return;
    }
    case "turnStarted": {
      noteModel(s, ev.model);
      noteMode(s, ev.permissionMode);
      touchTurn(s, ev.turnId);
      s.turns[ev.turnId].model = ev.model;
      // Assigned rather than or-ed in: a delta that overtook this frame created
      // the record already, and `false` is what it had to assume.
      s.turns[ev.turnId].agentInitiated = ev.agentInitiated;
      return;
    }
    case "modeRefused": {
      // The pick is settled here rather than at the next boundary: a refusal is
      // answered on the control channel, so the answer is already in hand.
      s.refusedModes[ev.mode] = ev.reason;
      if (s.pendingMode === ev.mode) s.pendingMode = null;
      return;
    }
    case "hookFired": {
      // Only the response carries Sway's marker, so the `started` frame that
      // preceded it was pushed as unattributed. Settle it now, or the pair
      // splits: the row that starts Sway's hook would stay visible while the
      // row that finishes it folds away.
      //
      // Searched from the end and stopped at the first hit: a `hookId` is
      // unique to one execution and its `started` frame is almost always the
      // row just pushed, so scanning the whole transcript per hook response
      // would be O(items) sixty times over on a tool-heavy turn.
      if (ev.swayOwned) {
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i];
          if (it.kind === "hook" && it.hookId === ev.hookId) {
            it.swayOwned = true;
            break;
          }
        }
      }
      // Kept as an item even when Sway owns it, rather than dropped here: the
      // collapse is a *view* decision, so the opt-in toggle can reveal the
      // folded rows without needing the session replayed to recover them.
      s.items.push({
        kind: "hook",
        id: `hook-${s.seq++}`,
        hookId: ev.hookId,
        name: ev.name,
        event: ev.event,
        phase: ev.phase,
        swayOwned: ev.swayOwned,
        outcome: ev.outcome ?? null,
        exitCode: ev.exitCode ?? null,
        output: ev.output ?? null,
        stderr: ev.stderr ?? null,
      });
      return;
    }
    case "userMessage":
      // A user turn the panel did not send. Deliberately does **not** touch the
      // turn or set `awaitingTurn` the way `pushUserTurn` does: replayed history
      // is finished, and marking it in flight would leave a reopened tab reading
      // as busy with nothing running.
      // Never a steer: the wire frame carries no such distinction, so a replayed
      // steer reads as an ordinary message rather than being guessed at.
      push(s, { kind: "user", id: nextId(s, "user"), blocks: ev.blocks, steer: false });
      return;
    case "compacted": {
      s.compactions += 1;
      // The boundary says how much it left behind, and that is the context from
      // here until the next response reports its own. Anthropic's status line
      // blanks the figure at this moment instead; a measured size is the better
      // answer where the agent gives one, and where it does not, the reading
      // stands until the next API call rather than being replaced by a zero
      // that was never true. Nothing invented either way.
      if (ev.postTokens !== null) s.contextTokens = ev.postTokens;
      // Only when the agent reported both ends. A compaction that named
      // neither reclaimed an unknown amount, not zero, and adding zero would
      // quietly understate the total.
      if (ev.preTokens !== null && ev.postTokens !== null) {
        s.compactionReclaimed += Math.max(0, ev.preTokens - ev.postTokens);
      }
      // Inline, in place, because that is where the conversation's middle went.
      // A transcript that silently jumps is indistinguishable from one that
      // lost turns to a bug, and the summary is the only record of what the
      // model still knows.
      const reclaimed =
        ev.preTokens !== null && ev.postTokens !== null
          ? ` (${fmtTokens(ev.preTokens)} to ${fmtTokens(ev.postTokens)})`
          : "";
      const how = ev.trigger === "auto" ? "automatically" : "manually";
      const settled = {
        text: `Compacted ${how}${reclaimed}.`,
        level: "info" as const,
        // Kept, but folded away. It is the agent's own text and the only
        // record of what the model still remembers past the boundary, so
        // dropping it would lose the one thing a reader might come back for -
        // and it is several hundred words, which inline is a wall the
        // conversation has to be scrolled past every time.
        details: ev.summary ?? undefined,
        pendingSince: undefined,
      };
      // Into the row that announced it, where there is one. The running row and
      // the result are one event and belong in one place; pushing a second
      // notice would leave "Compacting the conversation" sitting above its own
      // outcome forever.
      const running = settleCompaction(s);
      if (running) Object.assign(running, settled);
      else push(s, { kind: "notice", id: nextId(s, "notice"), ...settled });
      return;
    }
    case "slashCommands":
      // Replaced, never merged: the update is the agent's current list, and one
      // it has stopped publishing is one it will refuse.
      s.slashCommands = ev.commands;
      return;
    case "compactionStarted": {
      // Nothing else reaches the wire for the whole compaction - measured at 33
      // seconds of silence on the captured run - so this row is the only thing
      // between "working" and "wedged" for the person watching.
      if (s.compactingItemId) return;
      const id = nextId(s, "notice");
      s.compactingItemId = id;
      push(s, {
        kind: "notice",
        id,
        text: "Compacting the conversation",
        level: "info",
        pendingSince: Date.now(),
      });
      return;
    }
    case "compactionFailed": {
      const running = settleCompaction(s);
      const settled = {
        text: `Compaction failed: ${ev.error}`,
        level: "error" as const,
        pendingSince: undefined,
      };
      if (running) Object.assign(running, settled);
      else push(s, { kind: "notice", id: nextId(s, "notice"), ...settled });
      return;
    }
    case "textDelta":
      appendText(s, ev.turnId, ev.text, false, ev.agentId);
      return;
    case "thinkingDelta":
      appendText(s, ev.turnId, ev.text, true, ev.agentId);
      return;
    case "toolCallStarted": {
      touchTurn(s, ev.turnId);
      // The question owns this call, so no tool card is made for it. Two ways
      // in, because `questionRequest` and this frame race each other on the
      // wire and a replayed session carries only this one.
      const opened = s.questionIndex[ev.toolUseId] !== undefined;
      if (opened || (s.answerQuestionsInline && ev.name === ASK_USER_QUESTION)) {
        // Parsed before the row is claimed, not after: an input this cannot
        // read has to fall through to an ordinary tool card, and a row created
        // first would already have swallowed the call.
        const form = parseQuestions(ev.input);
        if (opened || form) {
          const item = ensureQuestion(s, ev.toolUseId, ev.turnId);
          // Never overwritten: `questionRequest` carries the same form and is
          // the authority on it, so whichever landed first stays.
          if (item.questions.length === 0 && form) item.questions = form;
          return;
        }
      }
      const card = ensureTool(s, ev.toolUseId, ev.turnId);
      // Merged, not replaced. `toolCallStarted` is an upsert and a later
      // emission carries only what that frame said, so an empty name or a null
      // input is the transport declining to speak about the field. Assigning
      // them anyway would blank a card that an ACP `tool_call_update` merely
      // described.
      if (ev.name) card.name = ev.name;
      if (ev.title) card.title = ev.title;
      // `other` and an empty list are what a patch that did not mention the
      // field carries, so both mean unchanged here.
      if (ev.kind !== "other") card.toolKind = ev.kind;
      if (ev.locations.length) card.locations = ev.locations;
      if (ev.input !== null && ev.input !== undefined) card.input = ev.input;
      // Never walk a card backwards: the completion (or a pending approval) can
      // legitimately have landed before the declaration.
      if (card.state === "running" && card.approval) card.state = "awaitingApproval";
      return;
    }
    case "toolCallProgress": {
      touchTurn(s, ev.turnId);
      ensureTool(s, ev.toolUseId, ev.turnId);
      return;
    }
    case "toolCallCompleted": {
      touchTurn(s, ev.turnId);
      // Suppressed here too, and not only at the declaration: `ensureTool`
      // creates on miss, so a completion alone would resurrect the very card
      // the branch above refused to make, carrying the answer string as a
      // denied call.
      const askedAt = s.questionIndex[ev.toolUseId];
      if (askedAt !== undefined) {
        const item = s.items[askedAt] as QuestionItem;
        if (item.turnId === null) item.turnId = ev.turnId;
        item.result = ev.output;
        return;
      }
      const card = ensureTool(s, ev.toolUseId, ev.turnId);
      card.state = ev.status === "ok" ? "ok" : ev.status === "denied" ? "denied" : "error";
      card.approval = null;
      card.output = ev.output;
      card.outputTruncated = ev.outputTruncated;
      card.summary = ev.summary;
      card.patch = ev.patch;
      card.files = ev.files;
      card.durationMs = ev.durationMs;
      return;
    }
    case "fileEdit": {
      touchTurn(s, ev.turnId);
      const card = ensureTool(s, ev.toolUseId, ev.turnId);
      if (!card.edits.some((e) => e.path === ev.path)) {
        card.edits.push({ path: ev.path, kind: ev.kind, beforeBlob: ev.beforeBlob });
      }
      return;
    }
    case "permissionRequest": {
      // Before the card is made, not after: a card born in the main lane would
      // close the paragraph the main agent is midway through.
      if (ev.agentId) noteLane(s, ev.toolUseId, ev.agentId);
      const card = ensureTool(s, ev.toolUseId, null);
      if (card.approval?.requestId === ev.requestId) return;
      // A prompt for a call that already finished is stale (the auto-deny
      // raced us); leave the settled card alone.
      if (card.state === "ok" || card.state === "error" || card.state === "denied") return;
      card.approval = {
        requestId: ev.requestId,
        autoDenyAtMs: ev.autoDenyAtMs,
        suggestions: ev.suggestions ?? [],
        agentId: ev.agentId,
      };
      card.state = "awaitingApproval";
      if (card.name === null) card.name = ev.toolName;
      if (card.input === null) card.input = ev.input;
      return;
    }
    case "questionRequest": {
      if (ev.agentId) noteLane(s, ev.toolUseId, ev.agentId);
      const item = ensureQuestion(s, ev.toolUseId, null);
      // A request for a call that already settled is stale, the same race a
      // permission prompt can lose; leave the answered row alone.
      if (item.result !== null) return;
      item.requestId = ev.requestId;
      item.questions = ev.questions;
      return;
    }
    case "subagentStarted": {
      const lane = ensureLane(s, ev.agentId);
      lane.toolUseId = ev.toolUseId;
      lane.agentType = ev.agentType;
      lane.description = ev.description;
      lane.prompt = ev.prompt;
      // The call that opened this lane may itself belong to one, which is what
      // makes this a depth-2 agent. Read from `laneOfCall`, so this frame has
      // to precede the lane's own calls - which is the order measured.
      lane.parentId = s.laneOfCall[ev.toolUseId] ?? null;
      return;
    }
    case "subagentCall":
      noteLane(s, ev.toolUseId, ev.agentId);
      return;
    case "subagentUpdate": {
      // Three frames patch this record and each sends a different subset, so
      // null is "not reported now" rather than "cleared".
      const lane = ensureLane(s, ev.agentId);
      if (ev.status !== null) lane.status = ev.status;
      if (ev.activity !== null) lane.activity = ev.activity;
      if (ev.lastToolName !== null) lane.lastToolName = ev.lastToolName;
      if (ev.usage !== null) lane.usage = ev.usage;
      if (ev.summary !== null) lane.summary = ev.summary;
      return;
    }
    case "planUpdate":
      touchTurn(s, ev.turnId);
      s.plan = ev.items;
      return;
    case "usage": {
      touchTurn(s, ev.turnId);
      s.contextTokens = contextTokens(ev.usage);
      // ACP states the window beside the occupancy it measured ("used" of
      // "size"), for a session rather than per model, so it cannot go in the
      // per-model map Claude's `modelUsage` fills. See `contextWindowFor` for
      // where the two meet.
      const stated = ev.extra?.contextWindow;
      if (typeof stated === "number" && stated > 0) s.contextWindow = stated;
      return;
    }
    case "rateLimit":
      // Recorded whatever the status, so the banner's own rule decides what is
      // worth showing. Every captured frame says `allowed`, and rendering on
      // the event rather than on the status would pin a permanent banner to
      // every chat.
      s.rateLimit = rateLimitFrom(ev);
      return;
    case "turnCompleted": {
      const known = s.turns[ev.turnId];
      if (known?.completed) return;
      s.turns[ev.turnId] = {
        completed: true,
        model: known?.model ?? null,
        agentInitiated: known?.agentInitiated ?? false,
      };
      if (s.activeTurnId === ev.turnId) s.activeTurnId = null;
      s.awaitingTurn = false;
      // The main agent's bubbles only. A background subagent runs on past the
      // turn that launched it, and closing its lane here would cut whatever it
      // is midway through saying.
      delete s.openText[MAIN_LANE];
      delete s.openThinking[MAIN_LANE];
      // A compaction cannot outlive its turn: one still saying "Compacting"
      // after the turn ended claims work nothing recorded. Hidden rather than
      // removed, because `toolIndex` holds positions into `items` and splicing
      // moved every entry above it.
      const unsettled = settleCompaction(s);
      if (unsettled) unsettled.hidden = true;
      // Not `lastUsage`: this frame is the turn added up across every API call
      // it made, and reading it as the context is what put 7.8M in a 1M window.
      s.lastTurnUsage = ev.usage;
      s.lastCostUsd = ev.costUsd;
      // Merged rather than replaced: a turn reports only the models it touched,
      // so the model that ran the *previous* turn would drop out of a straight
      // assignment and take its window with it.
      Object.assign(s.contextWindows, reportedWindows(ev.extra));
      // Safe from double counting because a repeated `turnCompleted` returned
      // above: this runs exactly once per turn id.
      addUsage(s.totalUsage, ev.usage);
      s.turnsCompleted += 1;
      if (ev.costUsd !== null) s.totalCostUsd = (s.totalCostUsd ?? 0) + ev.costUsd;
      // The load-bearing distinction: an interrupt is a completion on the wire
      // but the opposite of one in intent.
      if (ev.outcome !== "completed" && s.queue.length) s.queueHeld = true;
      return;
    }
    case "sessionError": {
      push(s, { kind: "notice", id: nextId(s, "note"), text: ev.message, level: "error" });
      if (ev.fatal) {
        s.ended = true;
        s.activeTurnId = null;
        s.awaitingTurn = false;
        if (s.queue.length) s.queueHeld = true;
      }
      return;
    }
    case "sessionEnded": {
      s.ended = true;
      s.activeTurnId = null;
      s.awaitingTurn = false;
      if (s.queue.length) s.queueHeld = true;
      push(s, {
        kind: "notice",
        id: nextId(s, "note"),
        text: ev.reason ? `Session ended: ${ev.reason}` : "Session ended.",
        level: "info",
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Local (non-event) mutations
// ---------------------------------------------------------------------------

/** Record the answers the user just sent.
 *
 *  Held locally rather than waited for, the same move `pushUserTurn` makes: the
 *  form has to stop being answerable the instant Submit is pressed, or a second
 *  press sends a second answer to a request that can only take one. The agent's
 *  own record replaces nothing, it arrives alongside as `result`. */
export function pushQuestionAnswers(s: ChatState, toolUseId: string, answers: QuestionAnswer[]) {
  const at = s.questionIndex[toolUseId];
  if (at === undefined) return;
  const item = s.items[at] as QuestionItem;
  if (item.submitted !== null) return;
  item.submitted = answers;
  // The agent was blocked on the user, not thinking. Whatever it thinks next
  // starts here.
  s.lastFrameAt = Date.now();
}

/** Record what the user actually sent, so their turn appears immediately rather
 *  than only once the child echoes it back, and mark the turn as in flight. */
export function pushUserTurn(s: ChatState, blocks: ContentBlock[]) {
  push(s, { kind: "user", id: nextId(s, "user"), blocks, steer: false });
  s.awaitingTurn = true;
  // Stamped here as well as in `applyEvent`: this is the frame that starts the
  // model thinking, and it is one the transport never sends back.
  s.lastFrameAt = Date.now();
}

/**
 * Record a message delivered into the turn that is already running.
 *
 * Deliberately *not* `pushUserTurn`: `awaitingTurn` says "a turn was sent that
 * the child has not acknowledged", and setting it here would make the composer
 * read as busy waiting for a `turnStarted` that is never coming - the running
 * turn already started, and a steer does not open a second one.
 */
export function pushSteer(s: ChatState, blocks: ContentBlock[]) {
  push(s, { kind: "user", id: nextId(s, "steer"), blocks, steer: true });
  s.lastFrameAt = Date.now();
}

/**
 * Can a message be delivered *into* the running turn right now?
 *
 * Requires the child's own `turnStarted`, not merely `isRunning`. Between Enter
 * and that acknowledgement there is no turn to steer yet, and a second `user`
 * frame written into that window would race the first rather than redirect it.
 * That window is what the queue is for, and it is the only thing still queuing
 * now that a running turn takes input directly.
 *
 * Phase 2's spike 5 measured the delivery this gates: three trials of three,
 * consumed before the next tool call. It is a behavioural observation against
 * one CLI version, not a contract - if a later version starts buffering to turn
 * end, this is the predicate to turn off.
 */
export function steerable(s: ChatState): boolean {
  return s.activeTurnId !== null && !s.ended;
}

/**
 * This session's answer to [[concept_safe_send]]'s probe, for a steer.
 *
 * A session blocked on a permission prompt is **refused**, not queued behind
 * the prompt: the tool call is waiting on the user, and writing past the
 * question would leave them answering something the agent has already been
 * told to abandon. Same rule and same wording as the PTY route, which is why
 * the gate is shared rather than reimplemented here.
 *
 * Never `not-ready`: `steerable` established a turn is running before this is
 * consulted, so there is no becoming-ready to wait for.
 */
export function steerProbe(s: ChatState): ProbeState {
  return pendingApprovals(s).length ? "blocked" : "ready";
}

/** The send never left. Roll back the in-flight mark so the composer is usable
 *  again rather than stuck reading as busy. */
export function clearAwaitingTurn(s: ChatState) {
  s.awaitingTurn = false;
}

/** The resolved model id that ran a turn, or null when the turn never named
 *  one (replayed history). For the transcript's per-turn header. */
export function turnModel(s: ChatState, turnId: string): string | null {
  return s.turns[turnId]?.model ?? null;
}

/** Is a turn in flight? True from the moment the user hits Enter, not from the
 *  child's acknowledgement, so the stop button is live for the round trip too. */
export function isRunning(s: ChatState): boolean {
  return s.activeTurnId !== null || s.awaitingTurn;
}

/**
 * Settle a replayed backfill: everything read off disk is finished work.
 *
 * The transcript has no `turnCompleted` frames, so replaying it leaves the
 * last `hist-turn-*` registered as the active turn - a session that would
 * read "working", with a live stop button, about turns that ended before the
 * tab was even opened. Marking them completed also arms `touchTurn`'s
 * "a completed turn never reopens" guard, so a stray late delta for a
 * replayed turn lands as history rather than resurrecting the spinner.
 *
 * Called once, after the backfill fold and before parked live events drain:
 * a genuinely running turn re-opens through its own live events, which carry
 * `turn-*` ids that can never collide with the replay's.
 */
export function settleBackfill(s: ChatState) {
  for (const id of Object.keys(s.turns)) s.turns[id].completed = true;
  s.activeTurnId = null;
  s.awaitingTurn = false;
}

/** How a frame arriving on the live channel should actually be folded. */
export type ReplayFold = {
  /** `history` folds and nothing else. `settle` folds and closes the window,
   *  the replay's own end-of-history. `live` is the ordinary path. */
  as: "history" | "settle" | "live";
  /** Whether the window is still open after this frame. */
  replaying: boolean;
};

/**
 * The replay window, for a transport that delivers history on the live channel.
 *
 * An ACP agent has no transcript Sway can read, so `session/load` re-sends the
 * whole conversation as `session/update` notifications - indistinguishable, on
 * arrival, from work happening now. Read as live they open a turn nothing will
 * ever close, and re-announce another session's file writes to the git gutter.
 *
 * `SessionStarted` is the boundary: it is emitted once the session is open,
 * which is after `session/load` has answered, so everything before it is the
 * conversation and everything after it is the session. A session that dies
 * while opening ends the window too, or the frame that says so would be folded
 * as history and the message held for that session never handed back.
 */
export function replayFold(ev: ChatEvent, replaying: boolean): ReplayFold {
  if (!replaying) return { as: "live", replaying: false };
  if (ev.type === "sessionStarted") return { as: "settle", replaying: false };
  if (ev.type === "sessionError" && ev.fatal) return { as: "live", replaying: false };
  return { as: "history", replaying: true };
}

/** Input typed before the sent turn was acknowledged. Queued, never dropped,
 *  and never sent from here: the flush driver decides. */
export function enqueue(s: ChatState, text: string): QueuedInput {
  const item = { id: nextId(s, "q"), text };
  s.queue.push(item);
  return item;
}

/** The next queued message that may be sent right now, or null. Null while a
 *  turn is running, null while the queue is held after a cancelled turn - which
 *  is what stops "stop" from firing the very messages it prevented - and null
 *  under a spend ceiling.
 *
 *  The ceiling is checked **here** rather than by holding the queue, because a
 *  hold is releasable: `releaseQueue` is wired to a "send now" button, and a
 *  budget stop that a button could lift would not be a ceiling. Left in the
 *  queue rather than refused, so raising the limit sends what was already
 *  typed. */
export function pendingFlush(s: ChatState): QueuedInput | null {
  if (s.budgetStopped || s.queueHeld || isRunning(s) || s.ended) return null;
  return s.queue[0] ?? null;
}

/** Take the head of the queue for sending, in one step.
 *
 *  Atomic on purpose: the flush driver is a reactive effect that re-reads this
 *  state the instant it changes, so taking the message and marking the turn in
 *  flight in two writes would let it observe the gap and flush the *whole*
 *  backlog into the window before the first turn was acknowledged. */
export function takeForSend(s: ChatState): QueuedInput | null {
  const next = pendingFlush(s);
  if (!next) return null;
  s.queue.shift();
  s.awaitingTurn = true;
  return next;
}

/** "Send now" on a held queue: the user has looked at what was parked and wants
 *  it after all. */
export function releaseQueue(s: ChatState) {
  s.queueHeld = false;
}

export function discardQueue(s: ChatState) {
  s.queue = [];
  s.queueHeld = false;
}

export function removeQueued(s: ChatState, id: string) {
  s.queue = s.queue.filter((q) => q.id !== id);
  if (!s.queue.length) s.queueHeld = false;
}

/** Clear a card's prompt once it has been answered, so the card stops rendering
 *  as blocked while the tool actually runs. The final state still comes from
 *  `toolCallCompleted`. */
export function resolveApproval(s: ChatState, toolUseId: string) {
  const at = s.toolIndex[toolUseId];
  if (at === undefined) return;
  const card = s.items[at] as ToolItem;
  card.approval = null;
  if (card.state === "awaitingApproval") card.state = "running";
  // Same reason as `pushQuestionAnswers`: the agent was blocked on the user for
  // however long that took, and none of it was thinking.
  s.lastFrameAt = Date.now();
}

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/** Record the user's mode pick. Kept apart from `permissionMode` so the control
 *  shows the pick immediately without claiming it is in force yet. */
export function selectMode(s: ChatState, mode: PermissionMode) {
  // Picking the mode already in force is a cancellation of any pending switch,
  // not a switch of its own.
  s.pendingMode = mode === s.permissionMode ? null : mode;
}

/**
 * The mode the control shows as selected: the pick if there is one, otherwise
 * what the session is actually in.
 *
 * `fallback` is the adapter's declared default, used only before a session has
 * reported a mode. It is a parameter rather than the literal `"default"` this
 * used to return, because that string is *Claude's* spelling: on a agent
 * whose modes are `auto_edit|yolo` it names no mode at all, so the pill would
 * show a value absent from its own menu. A caller with no adapter yet passes
 * null and gets null, which renders as "no mode known" rather than as a guess.
 */
export function shownMode(s: ChatState, fallback: PermissionMode | null = null): PermissionMode | null {
  return s.pendingMode ?? s.permissionMode ?? fallback;
}

/** Is the shown mode a promise about the next turn rather than a fact about
 *  this one? */
export function modePending(s: ChatState): boolean {
  return s.pendingMode !== null;
}

/** Why this agent refused this mode, in its own words, or null if it has not. */
export function modeRefusal(s: ChatState, mode: PermissionMode): string | null {
  return s.refusedModes[mode] ?? null;
}

/**
 * Record the user's model pick, the same way `selectMode` records a mode: shown
 * at once, in force only when the next turn says so.
 *
 * Takes the whole entry rather than a value string because confirming the pick
 * needs its `resolvedModel`, and asking the fold to look that up would put the
 * catalogue in a second place.
 */
export function selectModel(s: ChatState, model: { value: string; resolvedModel: string }) {
  // Re-picking what is already in force cancels a pending switch rather than
  // queueing a no-op. Compared on the *value*, since that is what identifies a
  // pick - two values can share `resolvedModel`, and comparing on that would
  // silently swallow a real switch between them.
  s.pendingModel = model.value === s.modelValue ? null : { ...model };
}

/** The model value the picker shows as selected, or null before anything has
 *  been picked and no session model is known. */
export function shownModelValue(s: ChatState): string | null {
  return s.pendingModel?.value ?? s.modelValue;
}

export function modelPending(s: ChatState): boolean {
  return s.pendingModel !== null;
}

/**
 * Undo a pick whose request never left, so the control stops promising a switch
 * the session will never make.
 *
 * Guarded on the value rather than clearing unconditionally: by the time a
 * rejection comes back the user may have picked again, and dropping *that* pick
 * would leave the picker showing a model nothing is going to apply.
 */
export function revertModelPick(s: ChatState, value: string) {
  if (s.pendingModel?.value === value) s.pendingModel = null;
}

export function revertEffortPick(s: ChatState, effort: string | null) {
  if (s.pendingEffort === effort) s.pendingEffort = undefined;
}

/**
 * The level the session was *opened* on, which is already in force: it rode the
 * argv the child was started with.
 *
 * Applied rather than pending, and not a pick: there is nothing to send and
 * nothing to wait for. It exists because nothing on the wire reports effort
 * back - `system/init` names the model and the permission mode and stops there
 * - so a session started at `high`, or resumed onto it after a reload, had a
 * control reading "Default" about a child running something else.
 */
export function seedEffort(s: ChatState, effort: string | null) {
  if (s.effort === null && s.pendingEffort === undefined) s.effort = effort;
}

/** Record an effort pick. Nothing reports effort back, so there is no confirmed
 *  value to compare against beyond the last one sent. */
export function selectEffort(s: ChatState, effort: string | null) {
  s.pendingEffort = effort === s.effort ? undefined : effort;
}

export function shownEffort(s: ChatState): string | null {
  return s.pendingEffort !== undefined ? s.pendingEffort : s.effort;
}

export function effortPending(s: ChatState): boolean {
  return s.pendingEffort !== undefined;
}

/**
 * What is waiting for the next turn boundary, as one line, or null when nothing
 * is.
 *
 * One sentence for all three because they land together: the CLI applies a
 * model, a level and a mode at the same boundary, so three copies of the same
 * promise said the same thing three times. It also used to say it *inside the
 * bar*, beside whichever pill was pending, which moved every control to its
 * right the moment anything was picked - the control you had just used slid out
 * from under the cursor.
 *
 * The names are the controls' own (`Model`, `Thinking effort`, `Permission
 * mode`), so the line names things the user can point at rather than describing
 * them again in different words.
 */
export function pendingSwitchNotice(s: ChatState): string | null {
  const waiting = [
    modelPending(s) && "model",
    effortPending(s) && "thinking effort",
    modePending(s) && "permission mode",
  ].filter((n): n is string => typeof n === "string");
  if (!waiting.length) return null;
  const list =
    waiting.length === 1 ? waiting[0] : `${waiting.slice(0, -1).join(", ")} and ${waiting[waiting.length - 1]}`;
  const verb = waiting.length === 1 ? "applies" : "apply";
  return `${list[0].toUpperCase()}${list.slice(1)} ${verb} from the next turn.`;
}

/** Every card still blocked on the user. */
export function pendingApprovals(s: ChatState): ToolItem[] {
  return s.items.filter((i): i is ToolItem => i.kind === "tool" && i.approval !== null);
}

/** Every question still open for an answer. A replayed one carries no
 *  `requestId` and an answered one has its result, so neither blocks. */
export function pendingQuestions(s: ChatState): QuestionItem[] {
  return s.items.filter((i): i is QuestionItem => i.kind === "question" && answerable(i));
}

/**
 * What this chat reports to the rest of Sway (the sidebar dot, the revert
 * blast-radius guard). Phase 11 owns the presentation; this is the signal.
 *
 * Blocked wins over "executing": a turn parked on the user is the more
 * specific truth, and it is the one a user needs to see. A question counts as
 * much as a permission does - the turn is just as stopped, and reporting it as
 * "executing" is what left an asked question with no notification behind it
 * while the user was in another space.
 */
export function chatStatus(s: ChatState): SessionStatus {
  if (s.ended) return "none";
  if (pendingApprovals(s).length) return "waitingForApproval";
  if (pendingQuestions(s).length) return "waitingForAnswer";
  // Ahead of idle, and deliberately not folded into it: a chat that stopped at
  // its ceiling looks idle from the outside, and reporting it as idle is how it
  // would sit there unnoticed until someone wondered why it never finished.
  if (s.budgetStopped) return "budgetStopped";
  if (isRunning(s)) return "executing";
  // A ready child that has not run a turn is idle, not busy: the spinner
  // covers only the genuine gap between spawn and the answered handshake.
  return s.started || s.ready ? "idle" : "running";
}

/**
 * Whether this chat still has a child behind it.
 *
 * Derived rather than stored, from the two flags that already say it: the
 * transport emits a fatal `sessionError` the moment the child's stdout hits
 * EOF, which is what sets `ended`. So a child killed from outside Sway shows up
 * here as fast as the OS closes the pipe - there is no poll and no timeout to
 * tune, which is the whole reason this reads off the event stream rather than
 * off a liveness probe.
 *
 * `connecting` is its own state, not folded into `connected`: between the
 * spawn and the answered handshake there is genuinely nothing to talk to yet.
 * The answered handshake (`ready`) counts as connected, because `system/init`
 * does not arrive until the first turn starts - waiting for `started` here is
 * what kept a fresh chat on "Connecting" until the user's first message.
 */
export type ConnectionHealth = "connecting" | "connected" | "disconnected";

export function connectionHealth(s: ChatState): ConnectionHealth {
  if (s.ended) return "disconnected";
  return s.started || s.ready ? "connected" : "connecting";
}

/**
 * Whether this session can take a turn, which is **not** the same as having a
 * child, and is not the same question per transport.
 *
 * Claude answers the `initialize` control request before any session exists and
 * opens one with the first turn, so the answered handshake is the readiness that
 * counts and waiting for `started` would wait for the very turn being asked
 * about. An ACP agent answers the handshake first and opens its session in a
 * second round trip, and a turn sent in between is refused for a reason the user
 * did nothing to cause - so there it is `session/new` having returned, which is
 * what `SessionStarted` reports.
 *
 * Asked by anything holding a message for a session that is still opening: a
 * draft tab's first send, and "send this to a new chat". `connectionHealth`
 * deliberately answers a *different* question - whether there is anything to
 * talk to - and calls an ACP session connected while it is still opening, which
 * is right for a status strip and wrong for a send.
 */
export function sendCapable(s: ChatState, transport: ChatTransport | undefined): boolean {
  return transport === "acp" ? s.started : s.ready;
}

/**
 * Put the state back to "a child is starting" for a reconnect attempt.
 *
 * `started` is cleared as well as `ended` so the panel reads as connecting
 * until the resumed child's own `system/init` arrives - leaving it set would
 * show connected the instant the button was pressed, which is a claim about a
 * process that has not answered yet.
 *
 * The item list is deliberately untouched. The reconnect resumes the same
 * session, so its transcript is still the truth; clearing it would throw away
 * the conversation to reflect a dropped pipe. The queue is likewise kept, held
 * flag and all: whatever the user typed during the outage is still what they
 * wanted to send.
 */
export function beginReconnect(s: ChatState) {
  s.ended = false;
  // Both liveness flags, for the same reason: the new child has answered
  // nothing yet, and either one left set would claim it has.
  s.ready = false;
  s.started = false;
  s.activeTurnId = null;
  s.awaitingTurn = false;
}

/** The tail of the list that renders, with "load earlier" raising the limit.
 *  Windowing rather than virtualization: a chat is read from the bottom, and a
 *  windowed list keeps CM6-style measurement out of the hot path entirely. */
export function windowed(items: readonly ChatItem[], limit: number): ChatItem[] {
  return limit >= items.length ? items.slice() : items.slice(items.length - limit);
}

export function hasEarlier(items: readonly ChatItem[], limit: number): boolean {
  return items.length > limit;
}

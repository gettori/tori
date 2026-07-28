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
//   - Events arrive on two unsynchronised channels. The approval prompt comes
//     over the Unix socket from a forked hook helper; the `assistant` frame
//     declaring the same tool call comes over the child's stdout on another
//     thread. Nothing orders them, so a tool card is materialized on first
//     reference to a `toolUseId` from whichever lands first, and the later one
//     fills in what it knows without resetting what is already there.
//   - Deltas interleave with tool calls. Text after a tool call is a new
//     bubble, not an append to the one before it, so the open bubble is closed
//     whenever anything else is appended.

import type {
  ChatEvent,
  ChatModelInfo,
  ContentBlock,
  FileEditKind,
  McpServer,
  PermissionMode,
  PlanItem,
  SlashCommand,
  Usage,
} from "../../utils/chatTypes";
import type { SessionStatus } from "../../utils/sessionStatus";

/** How far back the message list renders before "load earlier" is offered. */
export const WINDOW_STEP = 60;

export type ToolCardState = "awaitingApproval" | "running" | "ok" | "error" | "denied";

export type PendingApproval = {
  requestId: string;
  autoDenyAtMs: number | null;
};

export type ChatFileEdit = {
  path: string;
  kind: FileEditKind;
  beforeBlob: string | null;
};

export type UserItem = { kind: "user"; id: string; blocks: ContentBlock[] };
export type TextItem = { kind: "text"; id: string; turnId: string; text: string };
export type ThinkingItem = { kind: "thinking"; id: string; turnId: string; text: string };
export type NoticeItem = { kind: "notice"; id: string; text: string; level: "info" | "error" };
export type ToolItem = {
  kind: "tool";
  id: string;
  toolUseId: string;
  /** Null until a frame that knows the turn arrives: a permission prompt is
   *  session-scoped on the wire and can materialize the card first. */
  turnId: string | null;
  name: string | null;
  input: unknown;
  state: ToolCardState;
  approval: PendingApproval | null;
  output: string | null;
  files: string[];
  durationMs: number | null;
  edits: ChatFileEdit[];
};

export type ChatItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem;

export type QueuedInput = { id: string; text: string };

type TurnRecord = { completed: boolean };

export type ChatState = {
  sessionId: string;
  items: ChatItem[];
  /** `toolUseId` -> index into `items`. Items are only ever appended, so an
   *  index stays valid for the life of the session. */
  toolIndex: Record<string, number>;
  turns: Record<string, TurnRecord>;
  activeTurnId: string | null;
  /** The bubble a further delta of the same kind appends to, or null when the
   *  next delta must open a fresh one. */
  openTextId: string | null;
  openThinkingId: string | null;
  started: boolean;
  ended: boolean;
  /** A turn has been sent that the child has not acknowledged with its
   *  `turnStarted` yet. Without this the composer would read as idle for the
   *  round trip after Enter, and the queue would flush its whole backlog into
   *  that window instead of one turn at a time. */
  awaitingTurn: boolean;
  /** Input typed while a turn was running, in the order it was typed. */
  queue: QueuedInput[];
  /** A cancelled turn parks the queue instead of flushing it: an interrupt
   *  reports as a completion, and flushing on it would send exactly the
   *  messages the user pressed stop to prevent. */
  queueHeld: boolean;
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
   *  applied value is what was last sent rather than what was confirmed. */
  effort: string | null;
  pendingEffort: string | null;
  /** The live model catalogue from the handshake. Empty means "fall back to the
   *  adapter table", not "no models". */
  models: ChatModelInfo[];
  /** `system/init`'s fast-mode state, and the harness's reason when it is
   *  unavailable. */
  fastModeState: string | null;
  fastModeDisabledReason: string | null;
  /** The mode the session is actually in, as the child re-declares it on every
   *  turn. Never set from a click: a control that moved on its own would claim
   *  an effect the CLI cannot deliver mid-turn. */
  permissionMode: PermissionMode | null;
  /** A mode the user picked that has not taken effect yet. The CLI applies a
   *  switch at the next turn boundary, so until then the two disagree and the
   *  control has to say so. */
  pendingMode: PermissionMode | null;
  tools: string[];
  slashCommands: SlashCommand[];
  mcpServers: McpServer[];
  plan: PlanItem[];
  lastUsage: Usage | null;
  lastCostUsd: number | null;
  /** Monotonic id source, so replaying the same events twice yields the same
   *  item ids and tests can assert on them. */
  seq: number;
};

export function initialChat(sessionId: string): ChatState {
  return {
    sessionId,
    items: [],
    toolIndex: {},
    turns: {},
    activeTurnId: null,
    openTextId: null,
    openThinkingId: null,
    started: false,
    ended: false,
    awaitingTurn: false,
    queue: [],
    queueHeld: false,
    model: null,
    modelValue: null,
    pendingModel: null,
    effort: null,
    pendingEffort: null,
    models: [],
    fastModeState: null,
    fastModeDisabledReason: null,
    permissionMode: null,
    pendingMode: null,
    tools: [],
    slashCommands: [],
    mcpServers: [],
    plan: [],
    lastUsage: null,
    lastCostUsd: null,
    seq: 0,
  };
}

function nextId(s: ChatState, prefix: string): string {
  s.seq += 1;
  return `${prefix}${s.seq}`;
}

/** Appending anything closes both streaming bubbles, so text that resumes after
 *  a tool call renders as its own bubble in the right place. */
function push(s: ChatState, item: ChatItem) {
  s.openTextId = null;
  s.openThinkingId = null;
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
    turnId,
    name: null,
    input: null,
    state: "running",
    approval: null,
    output: null,
    files: [],
    durationMs: null,
    edits: [],
  };
  s.toolIndex[toolUseId] = s.items.length;
  push(s, card);
  return card;
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
  s.turns[turnId] = { completed: false };
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
  if (s.pendingEffort !== null) {
    s.effort = s.pendingEffort;
    s.pendingEffort = null;
  }
}

/** Record the mode the child says it is in. The per-turn init re-emission is the
 *  only confirmation a switch landed, so a pending pick clears here and nowhere
 *  else - clearing it on the click would show the new mode a turn early. */
function noteMode(s: ChatState, mode: PermissionMode) {
  s.permissionMode = mode;
  if (s.pendingMode === mode) s.pendingMode = null;
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

function appendText(s: ChatState, turnId: string, text: string, thinking: boolean) {
  touchTurn(s, turnId);
  const openId = thinking ? s.openThinkingId : s.openTextId;
  if (openId !== null) {
    const last = s.items[s.items.length - 1] as TextItem | ThinkingItem;
    if (last.id === openId) {
      last.text += text;
      return;
    }
  }
  const item: TextItem | ThinkingItem = thinking
    ? { kind: "thinking", id: nextId(s, "think"), turnId, text }
    : { kind: "text", id: nextId(s, "text"), turnId, text };
  push(s, item);
  if (thinking) s.openThinkingId = item.id;
  else s.openTextId = item.id;
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
  switch (ev.type) {
    case "sessionStarted": {
      // `system/init` re-emits every turn; only the first is a session start,
      // and treating a later one as one would reset the transcript mid-chat.
      noteModel(s, ev.model);
      noteMode(s, ev.permissionMode);
      s.tools = ev.tools;
      s.slashCommands = ev.slashCommands;
      s.mcpServers = ev.mcpServers;
      s.models = ev.models;
      s.fastModeState = ev.fastModeState;
      s.fastModeDisabledReason = ev.fastModeDisabledReason;
      if (s.started) return;
      s.started = true;
      return;
    }
    case "turnStarted": {
      noteModel(s, ev.model);
      noteMode(s, ev.permissionMode);
      touchTurn(s, ev.turnId);
      return;
    }
    case "textDelta":
      appendText(s, ev.turnId, ev.text, false);
      return;
    case "thinkingDelta":
      appendText(s, ev.turnId, ev.text, true);
      return;
    case "toolCallStarted": {
      touchTurn(s, ev.turnId);
      const card = ensureTool(s, ev.toolUseId, ev.turnId);
      card.name = ev.name;
      card.input = ev.input;
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
      const card = ensureTool(s, ev.toolUseId, ev.turnId);
      card.state = ev.status === "ok" ? "ok" : ev.status === "denied" ? "denied" : "error";
      card.approval = null;
      card.output = ev.output;
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
      const card = ensureTool(s, ev.toolUseId, null);
      if (card.approval?.requestId === ev.requestId) return;
      // A prompt for a call that already finished is stale (the auto-deny
      // raced us); leave the settled card alone.
      if (card.state === "ok" || card.state === "error" || card.state === "denied") return;
      card.approval = { requestId: ev.requestId, autoDenyAtMs: ev.autoDenyAtMs };
      card.state = "awaitingApproval";
      if (card.name === null) card.name = ev.toolName;
      if (card.input === null) card.input = ev.input;
      return;
    }
    case "planUpdate":
      touchTurn(s, ev.turnId);
      s.plan = ev.items;
      return;
    case "usage":
      touchTurn(s, ev.turnId);
      s.lastUsage = ev.usage;
      return;
    case "rateLimit":
      return;
    case "turnCompleted": {
      const known = s.turns[ev.turnId];
      if (known?.completed) return;
      s.turns[ev.turnId] = { completed: true };
      if (s.activeTurnId === ev.turnId) s.activeTurnId = null;
      s.awaitingTurn = false;
      s.openTextId = null;
      s.openThinkingId = null;
      s.lastUsage = ev.usage;
      s.lastCostUsd = ev.costUsd;
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

/** Record what the user actually sent, so their turn appears immediately rather
 *  than only once the child echoes it back, and mark the turn as in flight. */
export function pushUserTurn(s: ChatState, blocks: ContentBlock[]) {
  push(s, { kind: "user", id: nextId(s, "user"), blocks });
  s.awaitingTurn = true;
}

/** The send never left. Roll back the in-flight mark so the composer is usable
 *  again rather than stuck reading as busy. */
export function clearAwaitingTurn(s: ChatState) {
  s.awaitingTurn = false;
}

/** Is a turn in flight? True from the moment the user hits Enter, not from the
 *  child's acknowledgement, so the stop button is live for the round trip too. */
export function isRunning(s: ChatState): boolean {
  return s.activeTurnId !== null || s.awaitingTurn;
}

/** Input typed while a turn was running. Queued, never dropped, and never sent
 *  from here: the flush driver decides. */
export function enqueue(s: ChatState, text: string): QueuedInput {
  const item = { id: nextId(s, "q"), text };
  s.queue.push(item);
  return item;
}

/** The next queued message that may be sent right now, or null. Null while a
 *  turn is running, and null while the queue is held after a cancelled turn -
 *  which is what stops "stop" from firing the very messages it prevented. */
export function pendingFlush(s: ChatState): QueuedInput | null {
  if (s.queueHeld || isRunning(s) || s.ended) return null;
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

/** The mode the control shows as selected: the pick if there is one, otherwise
 *  what the session is actually in. */
export function shownMode(s: ChatState): PermissionMode {
  return s.pendingMode ?? s.permissionMode ?? "default";
}

/** Is the shown mode a promise about the next turn rather than a fact about
 *  this one? */
export function modePending(s: ChatState): boolean {
  return s.pendingMode !== null;
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

export function revertEffortPick(s: ChatState, effort: string) {
  if (s.pendingEffort === effort) s.pendingEffort = null;
}

/** Record an effort pick. Nothing reports effort back, so there is no confirmed
 *  value to compare against beyond the last one sent. */
export function selectEffort(s: ChatState, effort: string) {
  s.pendingEffort = effort === s.effort ? null : effort;
}

export function shownEffort(s: ChatState): string | null {
  return s.pendingEffort ?? s.effort;
}

export function effortPending(s: ChatState): boolean {
  return s.pendingEffort !== null;
}

/** Every card still blocked on the user. */
export function pendingApprovals(s: ChatState): ToolItem[] {
  return s.items.filter((i): i is ToolItem => i.kind === "tool" && i.approval !== null);
}

/**
 * What this chat reports to the rest of Sway (the sidebar dot, the revert
 * blast-radius guard). Phase 11 owns the presentation; this is the signal.
 *
 * "waitingForApproval" wins over "executing": a blocked call is the more
 * specific truth, and it is the one a user needs to see.
 */
export function chatStatus(s: ChatState): SessionStatus {
  if (s.ended) return "none";
  if (pendingApprovals(s).length) return "waitingForApproval";
  if (isRunning(s)) return "executing";
  // Alive but nothing known yet: the child is spawning and has not sent its
  // first init.
  return s.started ? "idle" : "running";
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

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
  ContentBlock,
  FileEditKind,
  HookPhase,
  McpServer,
  PermissionMode,
  PermissionSuggestion,
  PlanItem,
  SlashCommand,
  Usage,
} from "../../utils/chatTypes";
import type { ChatTransport } from "../../utils/agents";
import { chatPlugins, stringList, type ChatPlugin } from "../../utils/chatCapabilities";
import { reportedWindows } from "../../utils/chatModels";
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
export type TextItem = { kind: "text"; id: string; turnId: string; text: string };
export type ThinkingItem = { kind: "thinking"; id: string; turnId: string; text: string };
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
};
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

export type ChatItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem | HookItem;

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
 */
export function toolCallsSeen(s: ChatState): number {
  return s.items.reduce((n, it) => n + (it.kind === "tool" ? 1 : 0), 0);
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
 */
export function visibleItems(items: readonly ChatItem[], showAllHooks: boolean): ChatItem[] {
  if (showAllHooks) return items.slice();
  return items.filter((it) => it.kind !== "hook" || hookFailed(it));
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
type TurnRecord = { completed: boolean; model: string | null };

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
  /** Context windows the agent reported, keyed by every id it named them
   *  under, accumulated across turns. The authoritative source: it is measured
   *  per model and per provider by the session itself. Empty until the first
   *  turn completes, which is what the adapter's declared figure covers. */
  contextWindows: Record<string, number>;
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
  /** The newest usage figure of any kind, including the mid-turn `usage`
   *  events. The context meter wants this: it asks "how full is the window
   *  right now", and waiting for the turn to end would leave it stale for the
   *  whole turn. */
  lastUsage: Usage | null;
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

export function initialChat(sessionId: string): ChatState {
  return {
    sessionId,
    items: [],
    toolIndex: {},
    turns: {},
    activeTurnId: null,
    openTextId: null,
    openThinkingId: null,
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
    contextWindows: {},
    permissionMode: null,
    pendingMode: null,
    tools: [],
    slashCommands: [],
    mcpServers: [],
    skills: [],
    agents: [],
    plugins: [],
    plan: [],
    lastUsage: null,
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
  s.turns[turnId] = { completed: false, model: null };
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
  for (let i = at - 1; i >= 0; i--) {
    const it = items[i];
    // A user turn boundary means the model said nothing before this call.
    if (it.kind === "user") return null;
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
      push(s, {
        kind: "notice",
        id: nextId(s, "notice"),
        text: `Compacted ${how}${reclaimed}.`,
        level: "info",
        // Kept, but folded away. It is the agent's own text and the only
        // record of what the model still remembers past the boundary, so
        // dropping it would lose the one thing a reader might come back for -
        // and it is several hundred words, which inline is a wall the
        // conversation has to be scrolled past every time.
        details: ev.summary ?? undefined,
      });
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
    case "planUpdate":
      touchTurn(s, ev.turnId);
      s.plan = ev.items;
      return;
    case "usage":
      touchTurn(s, ev.turnId);
      s.lastUsage = ev.usage;
      return;
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
      s.turns[ev.turnId] = { completed: true, model: known?.model ?? null };
      if (s.activeTurnId === ev.turnId) s.activeTurnId = null;
      s.awaitingTurn = false;
      s.openTextId = null;
      s.openThinkingId = null;
      s.lastUsage = ev.usage;
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

/** Record what the user actually sent, so their turn appears immediately rather
 *  than only once the child echoes it back, and mark the turn as in flight. */
export function pushUserTurn(s: ChatState, blocks: ContentBlock[]) {
  push(s, { kind: "user", id: nextId(s, "user"), blocks, steer: false });
  s.awaitingTurn = true;
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

// The TypeScript mirror of `src-tauri/src/chat/model.rs`.
//
// Field names match that model's JSON 1:1, which is checked rather than
// trusted: the Rust round-trip test serializes one sample per variant into
// `dev/fixtures/chat/`, and chatTypes.test.ts parses that exact file. A renamed
// field on either side fails there instead of surviving as two internally
// consistent halves that disagree on the wire.
//
// Agent-specific payload lives in `extra`, never in a new field - see the
// Rust module docs for why. `extra` is optional here because serde omits it
// when empty.

/// A permission mode, as the id its own agent names it.
///
/// **Deliberately `string` and not a union**, mirroring the Rust newtype. The
/// union used to list Claude's four, which made a shared type carry one
/// agent's vocabulary: Gemini's `--approval-mode` speaks `auto_edit|yolo`,
/// and Codex has no fixed set at all - it lists its profiles at runtime. What a
/// mode is checked against is the adapter's `[[chat.modes]]` declaration, and
/// beneath that the real CLI; see `capabilitiesFor` in `utils/chatModels.ts`.
///
/// A mode means what the agent says it means. Tori's own hook used to run
/// ahead of every one of them, so a permissive mode was not really permissive;
/// the hook stopped deciding, so the agent's answer is now the answer.
export type PermissionMode = string;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/// How a turn ended. `cancelled` is deliberately distinct from `errored`: an
/// interrupt arrives looking like a failure but is the user getting what they
/// asked for, and the composer queue must hold on it rather than flush.
export type TurnOutcome = "completed" | "cancelled" | "errored";

export type ToolStatus = "ok" | "error" | "denied";

export type FileEditKind = "created" | "modified" | "deleted";

/// What a tool call is doing, in ACP's published vocabulary. An unrecognised
/// kind arrives as `other` rather than failing to parse.
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switchMode"
  | "other";

/// A file a call reached for. Wider than `toolCallCompleted.files`, which is
/// only the paths a call wrote.
export type ToolLocation = { path: string; line: number | null };

/// One hunk of a measured diff, in the shape Claude's `structuredPatch` sends:
/// each entry of `lines` carries its own `+`, `-` or space marker.
///
/// The only place a call's *file* line numbers exist. An `Edit`'s arguments name
/// a fragment and never say where in the file it sits, and a `Write` over an
/// existing file carries no before-state at all.
export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

/// What a finished call did, in numbers a collapsed row can say. Chosen by the
/// result's payload, never by the tool's name: Claude's `Grep` answers with
/// hits, with paths, or with a count depending on its `output_mode`.
///
/// Each variant is a named type because `CHAT_NESTED_KEYS` pins them one at a
/// time; see the comment there for why the union cannot be pinned as one.
/// `files` is nullable because Grep's `content` mode reports `numFiles: 0` for
/// a result spanning two files, so that mode has no count worth showing.
export type ToolSummarySearch = { type: "search"; hits: number; files: number | null };
export type ToolSummaryPaths = { type: "paths"; count: number };
/// `total` is the file's length, not the end of the range; the end is
/// `from + lines - 1`, and the length is the half that cannot be derived.
export type ToolSummaryRead = { type: "read"; lines: number; from: number; total: number | null };
/// `exitCode` is nullable because Claude reports none at all: measured on
/// 2.1.241, a `Bash` result carries no exit status anywhere.
export type ToolSummaryExecute = { type: "execute"; exitCode: number | null; lines: number };
export type ToolSummaryEdit = { type: "edit"; added: number; removed: number };
/// `status` and `bytes` are what a fetch reports; `host` only repeats what the
/// call asked for. Both nullable because ACP publishes neither.
export type ToolSummaryFetch = { type: "fetch"; host: string; status: number | null; bytes: number | null };

export type ToolSummary =
  | ToolSummarySearch
  | ToolSummaryPaths
  | ToolSummaryRead
  | ToolSummaryExecute
  | ToolSummaryEdit
  | ToolSummaryFetch;

/// The only two answers the approval bridge gives. `ask` is absent because it
/// degrades to a denial headless.
export type PermissionDecision = "allow" | "deny";

export type PermissionScope = "once" | "session" | "project";

/// One rule the agent proposed, in its own grammar. `ruleContent` is optional
/// because a rule can name a whole tool with no argument pattern.
export type SuggestedRule = { toolName: string; ruleContent?: string };

/// An action the agent offered alongside a permission question.
///
/// Mirrors Rust's `PermissionSuggestion`. The mapper drops any type it does not
/// know, so this union is closed on purpose: an unrecognised offer never
/// reaches here to be rendered as a button nobody can honour.
export type PermissionSuggestion =
  | { type: "addRules"; rules: SuggestedRule[]; behavior: string; destination: string }
  | { type: "addDirectories"; directories: string[]; destination: string }
  | { type: "setMode"; mode: PermissionMode; destination: string };

/// One offered answer to a question.
///
/// `preview` is a worked example of what the option means, present on a
/// minority of options and echoed back inside the answer when it is the one
/// chosen, so a surface that dropped it would send the agent less than it
/// offered.
export type ChatQuestionOption = { label: string; description: string; preview: string | null };

/// One question the agent wants answered before it goes on.
///
/// `question` is the prose and `header` is the short chip above it. The answer
/// the agent reads back quotes the prose, so the two are not interchangeable.
export type ChatQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ChatQuestionOption[];
};

/// What the user chose for one question.
///
/// `picks` holds option *labels*, never descriptions and never previews: the
/// label is the only part of an option the agent can match against what it
/// offered. The two fields are not exclusive, since a multi-select question can
/// be answered with picks and an addition.
export type QuestionAnswer = { question: string; picks: string[]; freeText: string | null };

export type PlanItemStatus = "pending" | "inProgress" | "completed";

/// Free-form agent-specific data. Deliberately unknown-valued: a renderer
/// that wants a field opts in and narrows it itself.
export type Extra = Record<string, unknown>;

export type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string | null;
  aliases: string[];
};

export type McpServer = {
  name: string;
  status: string;
  toolCount: number | null;
  error: string | null;
};

/// Which half of a hook execution a `hookFired` event carries.
export type HookPhase = "started" | "finished";

/// One model the live agent says it can run.
///
/// `value` is what `--model` takes and what the picker keeps as the authority
/// for its own selection; `resolvedModel` is what `system/init.model` reports
/// back. Several values resolve to one `resolvedModel`, so init alone can never
/// say which was picked - comparing a picked value against init's model is the
/// trap these two separate fields exist to prevent.
/// One row of the effort picker: a level, and whether it can be taken.
///
/// `disabled`/`note` rather than a state word, the same pair `ChatConfigOption`
/// carries, because "a lever the agent has but cannot currently take" is one
/// idea and effort should not get a second vocabulary for it.
export type ChatEffortLevel = {
  level: string;
  label: string;
  disabled: boolean;
  note: string;
};

export type ChatModelInfo = {
  value: string;
  resolvedModel: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  /// Empty for a model with no effort control, which hides the control rather
  /// than rendering an inert one.
  supportedEffortLevels: string[];
  /// The same levels as picker rows, plus any level Tori measured that this
  /// agent never advertises.
  ///
  /// Optional, unlike everything else here, because this type is also the shape
  /// of a **cached** catalogue on disk and one written before this field existed
  /// genuinely does not carry it. Absent is read as "nobody filled this in" and
  /// falls back to `supportedEffortLevels`, which is what that cache recorded.
  effortLevels?: ChatEffortLevel[];
  /// Whether this model honours `--permission-mode auto`. Measured: a model
  /// without it accepts the flag, exits 0, and silently runs `default`, so
  /// nothing at runtime would contradict an ungated row.
  supportsAutoMode: boolean;
  /// Whether this model has a fast mode to toggle, **as the CLI publishes it**.
  /// Tori used to restate the same fact in an adapter table keyed on a spelling
  /// the catalogue does not use, so the lookup never matched anything.
  supportsFastMode: boolean;
  /// Whether this model has an adaptive-thinking lever. Absent on Haiku, which
  /// declares none of the model-scoped capabilities.
  supportsAdaptiveThinking: boolean;
};

/// One mode the live agent says it can run.
///
/// Thinner than the adapter's `ChatMode` on purpose, and the missing fields are
/// the point. No `args`, because an ACP mode is a request rather than a flag.
/// No `permissive` and no `default`: an agent publishes an id, a label and a
/// description, so calling one of its modes dangerous would mean reading danger
/// out of the words in an id. Tori does not, and such a row renders without the
/// permissive caution instead of with a guessed one.
export type ChatModeInfo = {
  id: string;
  label: string;
  hint: string;
};

/// One configuration lever the agent published, in the shape a generic control
/// can render.
///
/// **Tori does not have to recognise an option to show it.** Model, mode and
/// thinking level have controls of their own; everything else the agent
/// publishes reaches the user only through the mirror, which renders by `kind`
/// and shows the agent's own label and description verbatim.
///
/// `category` is the agent's own word, and empty means it published none. That
/// empty case is the interesting one: an uncategorized option is exactly the one
/// no bespoke control claims.
export type ChatConfigOption = {
  id: string;
  name: string;
  description: string;
  category: string;
  /// A lever the agent has but cannot currently take, rendered rather than
  /// hidden: a control that is absent says nothing about why.
  disabled: boolean;
  /// Why it is disabled, in the agent's own words. Empty when nothing is.
  note: string;
} & (
  | { kind: "select"; current: string; choices: ChatConfigChoice[] }
  | { kind: "boolean"; value: boolean }
);

export type ChatConfigChoice = { value: string; label: string; description: string };

/// What a switch sends back: a select's value id, or a toggle's state.
export type ChatConfigValue = string | boolean;

/// What a agent said it can do, read off its own handshake.
///
/// **Advertised, not measured.** Tori's per-transport tier records what shipped
/// against a agent somebody sat down and measured; this records what *this*
/// agent, at this version, on this machine, claims about itself. One generic
/// transport carries agents that genuinely differ, so a tier that knew only the
/// transport would publish the same answer for an agent that can reopen a
/// conversation and one that cannot.
export type ChatCapabilities = {
  /// The agent can replay a conversation it still holds (`session/load`).
  loadSession: boolean;
  /// The agent can enumerate its own sessions. An advertisement, never a
  /// promise of rows: `opencode acp` 1.18.3 advertises it and can answer with
  /// nothing.
  listSessions: boolean;
  /** The agent accepts an ACP image content block in a prompt. */
  imageInput: boolean;
};

/// Who the session is signed in as, from the `initialize` handshake, which is
/// its only source. `null` wherever it appears means the handshake did not
/// happen, which is why every field can be trusted once the object exists.
///
/// No `email`: the response carries one and nothing here reads it, so it is
/// dropped at the Rust boundary rather than carried into the UI.
export type ChatAccount = {
  /// The agent's own wording, e.g. `Claude Pro`. Rendered as-is; a plan Tori
  /// has never seen should read as itself rather than as "unknown".
  subscriptionType: string;
  organization: string;
  /// `firstParty` for the Anthropic API, else a gateway. Load-bearing beyond
  /// display: the context window depends on it for models whose id does not
  /// say which window they get.
  apiProvider: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

export type PlanItem = {
  text: string;
  status: PlanItemStatus;
};

/// Not `Usage`: a subagent reports a flat total, a tool count and an elapsed
/// time rather than the token breakdown a `result` frame carries.
export type SubagentUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

/// Mirrors `result.permission_denials`, which measurably carries no reason -
/// the denial reason reaches the model as the tool result instead.
export type PermissionDenial = {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
};

/// One quota window as a source reported it. `kind` is the source's own window
/// name, not an enum: a harness may invent a window Tori has never seen.
export type UsageWindow = {
  kind: string;
  utilization: number;
  resetsAt: number | null;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  /// An image a past turn carried, without the bytes: reading a transcript's
  /// base64 back would hold every screenshot a session sent in memory. Replayed
  /// history is the only thing that makes one, so nothing sends one.
  | { type: "imageRef" }
  | {
      type: "fileRef";
      path: string;
      startLine: number | null;
      endLine: number | null;
      text: string | null;
      /** `[Image 3]`: the token the prose names this attachment by. Only an
       *  attachment carries one; a selection or hunk comment never does. */
      label?: string | null;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ChatEvent =
  /// Emitted once per session, from the first `system/init` only: that frame
  /// re-emits every turn, and treating each as a session start would reset the
  /// transcript mid-chat.
  | {
      type: "sessionStarted";
      sessionId: string;
      cwd: string;
      model: string;
      permissionMode: PermissionMode;
      tools: string[];
      slashCommands: SlashCommand[];
      mcpServers: McpServer[];
      /// The live catalogue from the `initialize` handshake. **Empty when the
      /// handshake did not happen**, which the picker reads as "fall back to
      /// the adapter table" rather than as "no models".
      models: ChatModelInfo[];
      /// The live mode catalogue, on the same rule: empty means "use the
      /// adapter's `[[chat.modes]]`". A Claude-shaped adapter declares its modes
      /// and sends none live; an ACP one declares none and sends the agent's own,
      /// which for some agents is the only lever on whether it asks before
      /// writing.
      modes: ChatModeInfo[];
      /// From `system/init`. A disabled fast mode carries the agent's own
      /// reason, which the toggle renders instead of an inert control.
      fastModeState: string | null;
      fastModeDisabledReason: string | null;
      /// From the handshake, not from `system/init`. Null when there was none.
      account: ChatAccount | null;
      extra?: Extra;
    }
  /// The child answered the `initialize` handshake: alive and talking, but no
  /// turn has run yet, so `system/init` has not opened the session. Emitted
  /// once, before `sessionStarted`, carrying the catalogues the response held
  /// so the UI is off its fallbacks before the first message.
  | {
      type: "sessionReady";
      sessionId: string;
      slashCommands: SlashCommand[];
      models: ChatModelInfo[];
      modes: ChatModeInfo[];
      /// Carried here as well as on `sessionStarted` because this event can
      /// arrive a whole turn earlier, and the handshake is the only source.
      account: ChatAccount | null;
      /// What this agent advertised about itself. Null for a agent whose
      /// capabilities are measured and pinned in Tori's tier rather than asked
      /// for on the wire, which reads as "the tier is all there is".
      capabilities: ChatCapabilities | null;
    }
  /// The agent's configuration levers, as they now stand: once when the session
  /// opens, and again whenever the agent reports a change. **The whole set every
  /// time, never a delta**, because one option can re-cut another's choices and
  /// a mirror rebuilt from the whole answer cannot drift from it.
  | { type: "configOptions"; sessionId: string; options: ChatConfigOption[] }
  /// One hook execution, from the in-band `hook_started`/`hook_response` frames
  /// that `--include-hook-events` turns on. One event per **frame**: a hook
  /// produces a `started` and then a `finished` sharing one `hookId`.
  | {
      type: "hookFired";
      sessionId: string;
      /// Pairs `started` with its `finished`, and is what lets a `started` be
      /// attributed to Tori retroactively.
      hookId: string;
      /// As the agent names it, e.g. `PreToolUse:Bash`. **Reports the tool,
      /// not the configured matcher** (measured, claude 2.1.220), which is why
      /// it cannot identify whose hook this is.
      name: string;
      /// The lifecycle event, e.g. `PreToolUse`, `SessionStart`.
      event: string;
      phase: HookPhase;
      /// True for Tori's own injected approval hook, identified by the marker it
      /// stamps on its own output. Collapsed by default.
      toriOwned: boolean;
      outcome?: string | null;
      exitCode?: number | null;
      output?: string | null;
      stderr?: string | null;
    }
  /// `model` and `permissionMode` repeat here because the per-turn init
  /// re-emission is how a mid-session switch is confirmed to have taken effect.
  | {
      type: "turnStarted";
      sessionId: string;
      turnId: string;
      model: string;
      permissionMode: PermissionMode;
      /// Opened by the agent, not by anything the user sent: a background
      /// subagent finishing makes the CLI open one. A ceiling works by
      /// declining the next turn, and this is the one it never got to.
      agentInitiated: boolean;
      extra?: Extra;
    }
  /// The agent refused a mode switch outright, in its own words. Distinct from
  /// a switch that merely did not take: the control can stop offering a row
  /// that can never land rather than let it be picked again.
  | { type: "modeRefused"; sessionId: string; mode: PermissionMode; reason: string }
  /// A user turn the panel did not send itself: a replayed transcript, or turns
  /// that happened in a PTY tab or an outside terminal. A live chat pushes its
  /// own user turn locally, so this is history's counterpart to that.
  | { type: "userMessage"; sessionId: string; turnId: string; blocks: ContentBlock[] }
  /// The conversation was compacted: earlier turns were replaced by a summary
  /// to reclaim the context window. Measured: the boundary carries the token
  /// figures, and the **summary is the next user message**, stitched on by
  /// whoever reads the two together - so `summary` is null for a reader that
  /// only saw the boundary rather than being invented.
  | {
      type: "compacted";
      sessionId: string;
      turnId: string;
      /// "manual" (the user ran /compact) or "auto" (the window filled).
      trigger: string | null;
      preTokens: number | null;
      postTokens: number | null;
      summary: string | null;
    }
  /// What a client-side slash command printed. `/usage` and `/context` never
  /// reach a model: the CLI runs them and reports the result itself, so this is
  /// neither speaker's words. `command` is the invocation, null live, where the
  /// wire frame names none and the user's own prompt is the row above.
  | { type: "localCommand"; sessionId: string; turnId: string; command: string | null; output: string }
  /// The commands this session takes. Its own event because for an ACP agent
  /// they arrive after the handshake, on a notification of their own: measured
  /// on pi-acp 0.0.33, `session/new` answers with the models and the modes and
  /// 33 commands follow moments later.
  | { type: "slashCommands"; sessionId: string; commands: SlashCommand[] }
  /// A compaction started. The only warning the panel gets that the next half
  /// minute of silence is work: measured at 33s between this and the boundary,
  /// with nothing on the wire in between.
  | { type: "compactionStarted"; sessionId: string; turnId: string }
  /// A compaction that ended without a boundary, carrying the agent's reason.
  | { type: "compactionFailed"; sessionId: string; turnId: string; error: string }
  /// `agentId` is the subagent whose prose this is, null for the main agent's.
  /// A subagent never streams, so its text arrives as one whole frame rather
  /// than as deltas; this is the only prose a live lane has.
  | { type: "textDelta"; sessionId: string; turnId: string; text: string; agentId: string | null }
  | { type: "thinkingDelta"; sessionId: string; turnId: string; text: string; agentId: string | null }
  /// An upsert: a later emission carries only what that frame said, so an empty
  /// `name` or a null `input` means "unchanged" rather than "cleared".
  | {
      type: "toolCallStarted";
      sessionId: string;
      turnId: string;
      toolUseId: string;
      name: string;
      input: unknown;
      kind: ToolKind;
      locations: ToolLocation[];
      title: string | null;
    }
  | {
      type: "toolCallProgress";
      sessionId: string;
      turnId: string;
      toolUseId: string;
      partialInput: string;
    }
  /// `files` is what lets per-turn attribution stop guessing from a whole-tree
  /// snapshot when several chats share one working tree.
  | {
      type: "toolCallCompleted";
      sessionId: string;
      turnId: string;
      toolUseId: string;
      status: ToolStatus;
      output: string | null;
      files: string[];
      durationMs: number | null;
      summary: ToolSummary | null;
      outputTruncated: boolean;
      /// The diff the call produced, where the transport measured one. Empty for
      /// every call that wrote nothing, for a patch too big for the wire, and
      /// for every ACP agent, none of which publish one.
      patch: PatchHunk[];
    }
  | {
      type: "fileEdit";
      sessionId: string;
      turnId: string;
      toolUseId: string;
      path: string;
      kind: FileEditKind;
      /// `git hash-object` sha of the content before the write, or null when
      /// the folder has no object store.
      beforeBlob: string | null;
    }
  /// Arrives over the approval socket while the frame declaring the same call
  /// arrives on stdout, with nothing ordering the two. Consumers must
  /// materialize a card from whichever lands first, keyed on `toolUseId`.
  | {
      type: "permissionRequest";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      requestId: string;
      autoDenyAtMs: number | null;
      /// The subagent that made the call, or null for the main agent. Only the
      /// in-protocol path can know this; the hook bridge always reports null.
      agentId: string | null;
      /// Actions the agent itself offered. Absent when it offered none.
      suggestions?: PermissionSuggestion[];
    }
  /// The agent asking the *user* something rather than asking permission to
  /// act. Its own variant because a permission is allow or deny and this is a
  /// form, and because a question is answered in the agent's own vocabulary,
  /// which the surface never sees.
  ///
  /// No deadline field: measured, the CLI imposes none on this transport and
  /// Tori arms none, so an unanswered question ends only by being cancelled.
  | {
      type: "questionRequest";
      sessionId: string;
      toolUseId: string;
      requestId: string;
      /// The subagent that asked, or null for the main agent.
      agentId: string | null;
      questions: ChatQuestion[];
    }
  /// A subagent started, and the only frame joining its two ids: `agentId` is
  /// what its `can_use_tool` carries, `toolUseId` is what its nested frames
  /// point at through `parent_tool_use_id`.
  | {
      type: "subagentStarted";
      sessionId: string;
      agentId: string;
      toolUseId: string;
      /// What kind of task this is, and the only thing telling a subagent from
      /// the other work on this channel: `local_agent` for a subagent,
      /// `local_bash` for a backgrounded shell command.
      taskType: string;
      /// Empty for anything that is not a subagent, which sends neither this nor
      /// `prompt`.
      agentType: string;
      description: string;
      prompt: string;
    }
  /// A tool call made inside a subagent, keyed on `toolUseId` so a consumer
  /// attributes the card whichever of the two arrives first. Emitted beside the
  /// call rather than as a field on it; see the Rust variant for why.
  | { type: "subagentCall"; sessionId: string; agentId: string; toolUseId: string }
  /// Three frames patching one record. Fields are nullable because each sends
  /// a different subset, and absent means "not reported now". No `turnId`: a
  /// background subagent's updates outlive its parent's turn.
  | {
      type: "subagentUpdate";
      sessionId: string;
      agentId: string;
      status: string | null;
      /// What it is doing now, not what it was asked to do; the task itself is
      /// `subagentStarted.description`.
      activity: string | null;
      lastToolName: string | null;
      usage: SubagentUsage | null;
      summary: string | null;
    }
  | { type: "planUpdate"; sessionId: string; turnId: string; items: PlanItem[] }
  | { type: "usage"; sessionId: string; turnId: string; usage: Usage; extra?: Extra }
  | {
      type: "rateLimit";
      sessionId: string;
      status: string;
      resetsAt: number | null;
      limitType: string | null;
      /// About `limitType` alone. A frame can carry this without `windows`, or
      /// `windows` without this, so neither is derived from the other.
      utilization: number | null;
      windows: UsageWindow[];
      /// Whether overage spending is available, not whether a limit is hit.
      overageStatus: string | null;
    }
  | {
      type: "turnCompleted";
      sessionId: string;
      turnId: string;
      outcome: TurnOutcome;
      stopReason: string | null;
      usage: Usage;
      costUsd: number | null;
      permissionDenials: PermissionDenial[];
      extra?: Extra;
    }
  /// Not a turn outcome: the child died, stdout was unparseable, the transport
  /// could not start. Never a silent hang.
  | { type: "sessionError"; sessionId: string; message: string; fatal: boolean }
  | { type: "sessionEnded"; sessionId: string; reason: string | null };

export type ChatEventType = ChatEvent["type"];

/// Every event kind, in the order the Rust enum declares them. Exported so a
/// consumer can assert it handles all of them.
export const CHAT_EVENT_TYPES = [
  "sessionStarted",
  "sessionReady",
  "configOptions",
  "hookFired",
  "turnStarted",
  "userMessage",
  "compacted",
  "localCommand",
  "slashCommands",
  "compactionStarted",
  "compactionFailed",
  "textDelta",
  "thinkingDelta",
  "toolCallStarted",
  "toolCallProgress",
  "toolCallCompleted",
  "fileEdit",
  "permissionRequest",
  "questionRequest",
  "subagentStarted",
  "subagentCall",
  "subagentUpdate",
  "planUpdate",
  "usage",
  "rateLimit",
  "turnCompleted",
  "sessionError",
  "sessionEnded",
  "modeRefused",
] as const satisfies readonly ChatEventType[];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type ChatCommand =
  | { type: "sendTurn"; sessionId: string; blocks: ContentBlock[] }
  /// The same content delivered *into* the running turn. Its own variant
  /// because a queued mode or model switch must not be spent on it.
  | { type: "steer"; sessionId: string; blocks: ContentBlock[] }
  | { type: "interrupt"; sessionId: string }
  | {
      type: "respondPermission";
      sessionId: string;
      toolUseId: string;
      requestId: string;
      decision: PermissionDecision;
      scope: PermissionScope;
      reason: string | null;
    }
  /// Answer a blocked `questionRequest`, one entry per question. Every
  /// question must appear: no agent measured so far has a grammar for a partial
  /// answer, so a dropped one reads to the agent as a silent hole in the form.
  | {
      type: "respondQuestion";
      sessionId: string;
      toolUseId: string;
      requestId: string;
      answers: QuestionAnswer[];
    }
  /// Applies from the *next* turn, not the running one.
  | { type: "setMode"; sessionId: string; mode: PermissionMode }
  | { type: "setModel"; sessionId: string; model: string; effort: Effort | null }
  /// Set one of the agent's own options, by the id it published. Tori knows
  /// nothing about what the option governs, so it forwards the switch and
  /// renders whatever the agent reports afterwards.
  | { type: "setConfigOption"; sessionId: string; configId: string; value: ChatConfigValue }
  | { type: "close"; sessionId: string };

export type ChatCommandType = ChatCommand["type"];

export const CHAT_COMMAND_TYPES = [
  "sendTurn",
  "steer",
  "interrupt",
  "respondPermission",
  "respondQuestion",
  "setMode",
  "setModel",
  "setConfigOption",
  "close",
] as const satisfies readonly ChatCommandType[];

/// The frames that are the conversation itself, as opposed to what the session
/// *is* or what was settled in the moment it happened.
///
/// Rust owns this set: `chat/mirror.rs`'s `is_conversation` decides whether a
/// replay brought a conversation back and therefore whether the log is rebuilt
/// from it, and the same question decides whether the panel clears what it drew
/// from that log. Two answers would mean a restored chat showing its history
/// twice, or not at all. `conversationEvents.json` is emitted from the Rust
/// function and compared against this list in `chatTypes.test.ts`, the same
/// contract `events.json` gives the wire shapes.
export const CONVERSATION_EVENTS = [
  "userMessage",
  "compacted",
  "localCommand",
  "textDelta",
  "thinkingDelta",
  "toolCallStarted",
  "toolCallCompleted",
  "subagentStarted",
] as const satisfies readonly ChatEventType[];

export function isConversationEvent(ev: ChatEvent): boolean {
  return (CONVERSATION_EVENTS as readonly string[]).includes(ev.type);
}

// ---------------------------------------------------------------------------
// The wire-shape table
// ---------------------------------------------------------------------------

/// The exact field names each variant carries on the wire.
///
/// This exists because TypeScript cannot check the thing that actually matters
/// here. A JSON import infers wide types (`type: string`, not the literal
/// union), so Rust's output cannot be assigned to `ChatEvent` without a cast -
/// and a cast checks nothing, which was the first version of this and it
/// happily accepted a renamed field. So the field names are declared as data
/// and compared against Rust's own serialized samples at test time.
///
/// `Record<ChatEventType, …>` is what keeps this honest at compile time:
/// adding a variant without adding its keys fails `tsc`.
///
/// `optional` is for fields serde omits when empty (`extra`), not for fields
/// that are merely nullable - a `null` is still a present key.
export const CHAT_EVENT_KEYS: Record<ChatEventType, { required: string[]; optional?: string[] }> = {
  sessionStarted: {
    required: [
      "sessionId",
      "cwd",
      "model",
      "permissionMode",
      "tools",
      "slashCommands",
      "mcpServers",
      "models",
      "modes",
      "fastModeState",
      "fastModeDisabledReason",
      "account",
    ],
    optional: ["extra"],
  },
  sessionReady: {
    required: ["sessionId", "slashCommands", "models", "modes", "account", "capabilities"],
  },
  hookFired: {
    required: ["sessionId", "hookId", "name", "event", "phase", "toriOwned", "outcome", "exitCode", "output", "stderr"],
  },
  turnStarted: {
    required: ["sessionId", "turnId", "model", "permissionMode", "agentInitiated"],
    optional: ["extra"],
  },
  modeRefused: { required: ["sessionId", "mode", "reason"] },
  userMessage: { required: ["sessionId", "turnId", "blocks"] },
  compacted: {
    required: ["sessionId", "turnId", "trigger", "preTokens", "postTokens", "summary"],
  },
  localCommand: { required: ["sessionId", "turnId", "command", "output"] },
  slashCommands: { required: ["sessionId", "commands"] },
  compactionStarted: { required: ["sessionId", "turnId"] },
  compactionFailed: { required: ["sessionId", "turnId", "error"] },
  textDelta: { required: ["sessionId", "turnId", "text", "agentId"] },
  thinkingDelta: { required: ["sessionId", "turnId", "text", "agentId"] },
  toolCallStarted: {
    required: ["sessionId", "turnId", "toolUseId", "name", "input", "kind", "locations", "title"],
  },
  toolCallProgress: { required: ["sessionId", "turnId", "toolUseId", "partialInput"] },
  toolCallCompleted: {
    required: [
      "sessionId",
      "turnId",
      "toolUseId",
      "status",
      "output",
      "files",
      "durationMs",
      "summary",
      "outputTruncated",
      "patch",
    ],
  },
  fileEdit: {
    required: ["sessionId", "turnId", "toolUseId", "path", "kind", "beforeBlob"],
  },
  permissionRequest: {
    required: ["sessionId", "toolUseId", "toolName", "input", "requestId", "autoDenyAtMs", "agentId"],
    // Absent when the agent offered nothing, and absent on every request the
    // `PreToolUse` bridge raises, which has no suggestions to offer.
    optional: ["suggestions"],
  },
  questionRequest: {
    required: ["sessionId", "toolUseId", "requestId", "agentId", "questions"],
  },
  subagentStarted: {
    required: ["sessionId", "agentId", "toolUseId", "taskType", "agentType", "description", "prompt"],
  },
  subagentCall: { required: ["sessionId", "agentId", "toolUseId"] },
  subagentUpdate: {
    required: ["sessionId", "agentId", "status", "activity", "lastToolName", "usage", "summary"],
  },
  planUpdate: { required: ["sessionId", "turnId", "items"] },
  usage: { required: ["sessionId", "turnId", "usage"], optional: ["extra"] },
  rateLimit: {
    required: ["sessionId", "status", "resetsAt", "limitType", "utilization", "windows", "overageStatus"],
  },
  turnCompleted: {
    required: ["sessionId", "turnId", "outcome", "stopReason", "usage", "costUsd", "permissionDenials"],
    optional: ["extra"],
  },
  sessionError: { required: ["sessionId", "message", "fatal"] },
  sessionEnded: { required: ["sessionId", "reason"] },
  configOptions: { required: ["sessionId", "options"] },
};

/// The field names of a type, declared as data.
///
/// `Record<keyof T, true>` is the whole trick: naming a key that is not on `T`,
/// or leaving one out, fails `tsc`. So the returned list cannot drift from the
/// type it describes.
function keysOf<T>(shape: Record<keyof T, true>): string[] {
  return Object.keys(shape);
}

/// The wire field names of the types nested *inside* an event or command.
///
/// `CHAT_EVENT_KEYS` compares an event's own top-level keys and nothing deeper,
/// so a rename inside `ChatQuestion` would pass it untouched. `sessionStarted`
/// covers the same blind spot for `ChatAccount` by reading every field by hand
/// in the test, which works and has to be remembered; this is the enumerated
/// version, so a field added to one of these types is a compile error here
/// rather than an untested field.
///
/// Both directions are covered: a rename on this side fails `tsc` through
/// `keysOf`, and a rename on the Rust side fails the fixture compare in
/// chatTypes.test.ts.
export const CHAT_NESTED_KEYS = {
  question: keysOf<ChatQuestion>({ question: true, header: true, multiSelect: true, options: true }),
  questionOption: keysOf<ChatQuestionOption>({ label: true, description: true, preview: true }),
  questionAnswer: keysOf<QuestionAnswer>({ question: true, picks: true, freeText: true }),
  toolLocation: keysOf<ToolLocation>({ path: true, line: true }),
  subagentUsage: keysOf<SubagentUsage>({ totalTokens: true, toolUses: true, durationMs: true }),
  usageWindow: keysOf<UsageWindow>({ kind: true, utilization: true, resetsAt: true }),
  patchHunk: keysOf<PatchHunk>({ oldStart: true, oldLines: true, newStart: true, newLines: true, lines: true }),
  // One entry per `ToolSummary` variant rather than one `keysOf` over the
  // union. `Record<keyof T, true>` on a union resolves to the keys they *share*,
  // which for these six is only `type`, so a single entry would have pinned the
  // discriminant and nothing else and every payload field would have been
  // unchecked.
  toolSummarySearch: keysOf<ToolSummarySearch>({ type: true, hits: true, files: true }),
  toolSummaryPaths: keysOf<ToolSummaryPaths>({ type: true, count: true }),
  toolSummaryRead: keysOf<ToolSummaryRead>({ type: true, lines: true, from: true, total: true }),
  toolSummaryExecute: keysOf<ToolSummaryExecute>({ type: true, exitCode: true, lines: true }),
  toolSummaryEdit: keysOf<ToolSummaryEdit>({ type: true, added: true, removed: true }),
  toolSummaryFetch: keysOf<ToolSummaryFetch>({ type: true, host: true, status: true, bytes: true }),
} as const;

export const CHAT_COMMAND_KEYS: Record<ChatCommandType, { required: string[]; optional?: string[] }> = {
  sendTurn: { required: ["sessionId", "blocks"] },
  steer: { required: ["sessionId", "blocks"] },
  interrupt: { required: ["sessionId"] },
  respondPermission: {
    required: ["sessionId", "toolUseId", "requestId", "decision", "scope", "reason"],
  },
  respondQuestion: { required: ["sessionId", "toolUseId", "requestId", "answers"] },
  setMode: { required: ["sessionId", "mode"] },
  setModel: { required: ["sessionId", "model", "effort"] },
  setConfigOption: { required: ["sessionId", "configId", "value"] },
  close: { required: ["sessionId"] },
};

/// Where a page of history starts: the prompt whose turn it falls in, by its
/// transcript timestamp, and how many events into that turn.
export type HistoryCursor = { promptTs: number | null; offset: number };

/// What the history before the tail leaves behind in the panel's state.
export type HistorySummary = {
  compactions: number;
  compactionReclaimed: number;
  contextTokens: number | null;
  labels: string[];
  laneEvents: unknown[];
  prompts: number;
  toolCalls: number;
  askCalls: number;
  touched: string[];
};

/// What `chat_history` answers: the tail a chat opens with. Events are raw,
/// parsed on fold like every other frame.
export type HistoryTail = { summary: HistorySummary; events: unknown[]; cursor: HistoryCursor | null };

/// What `chat_history_page` answers: the page before a cursor, and the next one.
export type HistoryPage = { events: unknown[]; cursor: HistoryCursor | null };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Narrow an untrusted value coming off the Tauri channel to a `ChatEvent`.
///
/// Returns `null` rather than throwing: an unrecognised frame is something to
/// drop and log, not something that should take a chat panel down mid-turn.
/// This checks the discriminant and the fields the UI routes on, not every
/// field - a deep validator would be a second copy of the schema to keep in
/// sync, and the wire producer is our own Rust code, not a third party.
export function parseChatEvent(raw: unknown): ChatEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const ev = raw as Record<string, unknown>;
  if (typeof ev.type !== "string" || typeof ev.sessionId !== "string") return null;
  if (!(CHAT_EVENT_TYPES as readonly string[]).includes(ev.type)) return null;
  return raw as ChatEvent;
}

/// The categories the chat already has a control of its own for.
///
/// A mirrored copy of the model picker would be a second control writing one
/// piece of session state, which is how two controls end up disagreeing about
/// what the session is running.
const BESPOKE_CATEGORIES = new Set(["model", "mode", "thought_level"]);

/// The options a generic surface renders: the agent's own, minus the three
/// above. Stated once, here, because both the chat's mirror and the settings
/// page's preview need the same answer and a second copy would drift.
export function mirroredOptions(options: readonly ChatConfigOption[]): ChatConfigOption[] {
  return options.filter((o) => !BESPOKE_CATEGORIES.has(o.category));
}

/// The value in force for the one select of `category`, or null without one.
/// By category and never by id: the id is the agent's own vocabulary (Codex's
/// effort selector is `reasoning_effort`), `category` is the spec's word.
export function currentOf(options: readonly ChatConfigOption[], category: string): string | null {
  const option = options.find((o) => o.category === category && o.kind === "select");
  return option?.kind === "select" ? option.current : null;
}

/// Whether this option can take this value at all. A withdrawn choice and a
/// lever that changed shape both read as no, because sending the wrong shape is
/// the one thing an agent answers by doing nothing at all.
function optionTakes(option: ChatConfigOption, value: ChatConfigValue): boolean {
  return option.kind === "select"
    ? typeof value === "string" && option.choices.some((c) => c.value === value)
    : typeof value === "boolean";
}

/// The picked values this option set still recognises, minus the rest.
///
/// The rule `restoredPicks` applies to a remembered model: a stored value is not
/// a command, and one naming a lever the agent no longer publishes is dropped
/// rather than sent and refused.
export function keptOptionValues(
  options: readonly ChatConfigOption[],
  values: Readonly<Record<string, ChatConfigValue>>,
): Record<string, ChatConfigValue> {
  const out: Record<string, ChatConfigValue> = {};
  for (const option of options) {
    const value = values[option.id];
    if (value !== undefined && optionTakes(option, value)) out[option.id] = value;
  }
  return out;
}

/// The option set with what was picked standing in for what the agent reports.
///
/// Only a draft needs this: there is no agent to echo a switch back, so nothing
/// would move when one is flipped. A live session's answering set replaces it
/// outright, which is why the overlay lives at the surface and not in the store.
export function overlaidOptions(
  options: readonly ChatConfigOption[],
  values: Readonly<Record<string, ChatConfigValue>>,
): ChatConfigOption[] {
  const kept = keptOptionValues(options, values);
  return options.map((option) => {
    const value = kept[option.id];
    if (option.kind === "select") return typeof value === "string" ? { ...option, current: value } : option;
    return typeof value === "boolean" ? { ...option, value } : option;
  });
}

/// True when this event belongs to a turn (and therefore carries a `turnId`).
/// Session-scoped events - the session opening, a permission prompt arriving on
/// its own socket, a rate limit, the session ending - do not.
export function isTurnScoped(ev: ChatEvent): boolean {
  return "turnId" in ev;
}

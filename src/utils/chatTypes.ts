// The TypeScript mirror of `src-tauri/src/chat/model.rs`.
//
// Field names match that model's JSON 1:1, which is checked rather than
// trusted: the Rust round-trip test serializes one sample per variant into
// `dev/fixtures/chat/`, and chatTypes.test.ts parses that exact file. A renamed
// field on either side fails there instead of surviving as two internally
// consistent halves that disagree on the wire.
//
// Harness-specific payload lives in `extra`, never in a new field - see the
// Rust module docs for why. `extra` is optional here because serde omits it
// when empty.

/// The four permission modes, mapped to `--permission-mode`.
///
/// Sway's own approval hook runs ahead of all of them, so `bypassPermissions`
/// does not mean unsupervised.
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/// How a turn ended. `cancelled` is deliberately distinct from `errored`: an
/// interrupt arrives looking like a failure but is the user getting what they
/// asked for, and the composer queue must hold on it rather than flush.
export type TurnOutcome = "completed" | "cancelled" | "errored";

export type ToolStatus = "ok" | "error" | "denied";

export type FileEditKind = "created" | "modified" | "deleted";

/// The only two answers the approval bridge gives. `ask` is absent because it
/// degrades to a denial headless.
export type PermissionDecision = "allow" | "deny";

export type PermissionScope = "once" | "session" | "project";

export type PlanItemStatus = "pending" | "inProgress" | "completed";

/// Free-form harness-specific data. Deliberately unknown-valued: a renderer
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

/// One model the live harness says it can run.
///
/// `value` is what `--model` takes and what the picker keeps as the authority
/// for its own selection; `resolvedModel` is what `system/init.model` reports
/// back. Several values resolve to one `resolvedModel`, so init alone can never
/// say which was picked - comparing a picked value against init's model is the
/// trap these two separate fields exist to prevent.
export type ChatModelInfo = {
  value: string;
  resolvedModel: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  /// Empty for a model with no effort control, which hides the control rather
  /// than rendering an inert one.
  supportedEffortLevels: string[];
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

/// Mirrors `result.permission_denials`, which measurably carries no reason -
/// the denial reason reaches the model as the tool result instead.
export type PermissionDenial = {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | {
      type: "fileRef";
      path: string;
      startLine: number | null;
      endLine: number | null;
      text: string | null;
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
      /// From `system/init`. A disabled fast mode carries the harness's own
      /// reason, which the toggle renders instead of an inert control.
      fastModeState: string | null;
      fastModeDisabledReason: string | null;
      extra?: Extra;
    }
  /// `model` and `permissionMode` repeat here because the per-turn init
  /// re-emission is how a mid-session switch is confirmed to have taken effect.
  | {
      type: "turnStarted";
      sessionId: string;
      turnId: string;
      model: string;
      permissionMode: PermissionMode;
      extra?: Extra;
    }
  | { type: "textDelta"; sessionId: string; turnId: string; text: string }
  | { type: "thinkingDelta"; sessionId: string; turnId: string; text: string }
  | {
      type: "toolCallStarted";
      sessionId: string;
      turnId: string;
      toolUseId: string;
      name: string;
      input: unknown;
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
    }
  | { type: "planUpdate"; sessionId: string; turnId: string; items: PlanItem[] }
  | { type: "usage"; sessionId: string; turnId: string; usage: Usage; extra?: Extra }
  | {
      type: "rateLimit";
      sessionId: string;
      status: string;
      resetsAt: number | null;
      limitType: string | null;
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
  "turnStarted",
  "textDelta",
  "thinkingDelta",
  "toolCallStarted",
  "toolCallProgress",
  "toolCallCompleted",
  "fileEdit",
  "permissionRequest",
  "planUpdate",
  "usage",
  "rateLimit",
  "turnCompleted",
  "sessionError",
  "sessionEnded",
] as const satisfies readonly ChatEventType[];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type ChatCommand =
  | { type: "sendTurn"; sessionId: string; blocks: ContentBlock[] }
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
  /// Applies from the *next* turn, not the running one.
  | { type: "setMode"; sessionId: string; mode: PermissionMode }
  | { type: "setModel"; sessionId: string; model: string; effort: Effort | null }
  | { type: "close"; sessionId: string };

export type ChatCommandType = ChatCommand["type"];

export const CHAT_COMMAND_TYPES = [
  "sendTurn",
  "interrupt",
  "respondPermission",
  "setMode",
  "setModel",
  "close",
] as const satisfies readonly ChatCommandType[];

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
      "fastModeState",
      "fastModeDisabledReason",
    ],
    optional: ["extra"],
  },
  turnStarted: {
    required: ["sessionId", "turnId", "model", "permissionMode"],
    optional: ["extra"],
  },
  textDelta: { required: ["sessionId", "turnId", "text"] },
  thinkingDelta: { required: ["sessionId", "turnId", "text"] },
  toolCallStarted: { required: ["sessionId", "turnId", "toolUseId", "name", "input"] },
  toolCallProgress: { required: ["sessionId", "turnId", "toolUseId", "partialInput"] },
  toolCallCompleted: {
    required: ["sessionId", "turnId", "toolUseId", "status", "output", "files", "durationMs"],
  },
  fileEdit: {
    required: ["sessionId", "turnId", "toolUseId", "path", "kind", "beforeBlob"],
  },
  permissionRequest: {
    required: ["sessionId", "toolUseId", "toolName", "input", "requestId", "autoDenyAtMs"],
  },
  planUpdate: { required: ["sessionId", "turnId", "items"] },
  usage: { required: ["sessionId", "turnId", "usage"], optional: ["extra"] },
  rateLimit: { required: ["sessionId", "status", "resetsAt", "limitType"] },
  turnCompleted: {
    required: ["sessionId", "turnId", "outcome", "stopReason", "usage", "costUsd", "permissionDenials"],
    optional: ["extra"],
  },
  sessionError: { required: ["sessionId", "message", "fatal"] },
  sessionEnded: { required: ["sessionId", "reason"] },
};

export const CHAT_COMMAND_KEYS: Record<ChatCommandType, { required: string[]; optional?: string[] }> = {
  sendTurn: { required: ["sessionId", "blocks"] },
  interrupt: { required: ["sessionId"] },
  respondPermission: {
    required: ["sessionId", "toolUseId", "requestId", "decision", "scope", "reason"],
  },
  setMode: { required: ["sessionId", "mode"] },
  setModel: { required: ["sessionId", "model", "effort"] },
  close: { required: ["sessionId"] },
};

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

/// True when this event belongs to a turn (and therefore carries a `turnId`).
/// Session-scoped events - the session opening, a permission prompt arriving on
/// its own socket, a rate limit, the session ending - do not.
export function isTurnScoped(ev: ChatEvent): boolean {
  return "turnId" in ev;
}

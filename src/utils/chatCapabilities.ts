// Two kinds of capability, kept in one file because both answer "what can this
// chat actually do".
//
//   * **What a session loaded** - its skills, subagents and plugins, read off
//     `system/init`. Per session, and it changes with the user's install.
//   * **What the agent behind it supports** - the chat tier below. Per
//     *transport*, fixed at build time, and the thing the UI gates on.
//
// The tier's rule is that **a value names what shipped, never what the feature
// is called**. A declaration reading `rewind: yes` or `steer: yes` would promise
// a second adapter's user something Tori only measured against one CLI version,
// so every value here is the measured outcome, and a surface reads the value
// rather than the presence of the key. Keyed on `ChatTransport` rather than on
// the agent id, because the transport is what the behaviour belongs to: a user
// adapter pointing at `claude_stream_json` gets the same tier for the same
// reason it gets the same wire protocol.
import type { ChatTransport } from "./agents";
import type { ChatCapabilities, Extra } from "./chatTypes";
import type { AttachmentKind, AttachmentSource } from "./chatCompose";

export type ChatPlugin = {
  name: string;
  version: string | null;
  source: string | null;
  path: string | null;
};

// ---------------------------------------------------------------------------
// The chat tier: what shipped, per transport
// ---------------------------------------------------------------------------

/**
 * How far back a rewind can actually put things.
 *
 * `fork` is what shipped, and it is not the unqualified capability: the files
 * go back and the forked agent still remembers the turns being undone, which is
 * often what the user rewound to escape. `replay` reconstructs the conversation
 * as prose and loses tool results; `files-only` reverts the tree and leaves the
 * conversation alone.
 */
export type RewindTier = "none" | "files-only" | "replay" | "fork";

/**
 * What a agent does with a message written mid-turn.
 *
 * `consumed-before-next-tool` is the measured outcome, not a promise. A agent
 * that reads stdin only at turn end is `buffered-to-turn-end`, which is a
 * *queue*, and calling that a steer would tell the user their interjection
 * changed a turn it could not reach.
 */
export type SteerTier = "none" | "buffered-to-turn-end" | "consumed-before-next-tool";

/** What a steer cost when it was measured, with enough provenance to age
 *  honestly: a range at n=3 against one CLI version is not a guarantee, and a
 *  surface quoting it has to be able to say so. */
export type SteerCost = {
  minMs: number;
  maxMs: number;
  trials: number;
  measuredAgainst: string;
};

/**
 * Who asks the user before a tool runs.
 *
 * `in-protocol` means the agent asks in its own protocol and Tori renders the
 * question; `tori-hook` means Tori asked instead, from a hook that ran ahead of
 * the agent's own permission chain. The distinction is not cosmetic: under
 * `in-protocol` the agent's permission modes are the ones in force, so a mode
 * named after bypassing permissions really does bypass them.
 */
export type ApprovalTier = "none" | "tori-hook" | "in-protocol";

/**
 * Where a tool card's before-and-after comes from.
 *
 * `before-state` is Tori reading the file just ahead of the write, from the
 * capture hook: it happens for every write on that agent, so the card can
 * always show one. `agent-supplied` is the agent sending the prior text with the
 * call, which is exact when it happens and happens only for agents that do it.
 *
 * The distinction had to exist because this used to be a boolean and the boolean
 * was measurably wrong. `ACP: false` was written on the reasoning that an exact
 * diff "rides the Claude-only hook"; measured 2026-08-14,
 * `@agentclientprotocol/codex-acp` 1.2.0 sends a `tool_call` content block
 * carrying `oldText`, `newText` and the path, which is the same before-state the
 * hook produces and arguably a better one - it is what the agent is about to
 * write rather than what happened to be on disk when a helper got there. But
 * `opencode acp` 1.18.3 sends none, so `true` would be as wrong as `false` was.
 * The value names which of the two Tori gets, which is the thing a user's
 * expectation actually turns on.
 */
export type DiffTier = "none" | "agent-supplied" | "before-state";

/**
 * How much a chat can say about the subagents its agent launches. The
 * distinction is **addressability**, not attribution: `observable` is a lane you
 * can read, `addressable` would be a channel to one, and no agent offers that.
 */
export type SubagentTier = "none" | "observable" | "addressable";

/**
 * Where a reopened session's earlier turns come from.
 *
 * `transcript`: the agent wrote a file Tori reads, so history lands through
 * `chat_history` before the child says anything.
 *
 * `session-replay`: the agent has no file Tori can read (`transcript_path`
 * returns `None` for every ACP adapter) and re-sends the conversation as
 * ordinary `session/update` notifications while it opens the session. That
 * history therefore arrives on the *live* channel, and a consumer that does not
 * know it re-fires every side effect a live turn has - a spinner for a turn
 * that ended yesterday, a git gutter lit up by another session's edits.
 */
export type HistorySource = "transcript" | "session-replay";

export type ChatTier = {
  rewind: RewindTier;
  steer: SteerTier;
  /** Null exactly when `steer` is `"none"`: there is no cost to quote for
   *  something that does not happen. */
  steerCost: SteerCost | null;
  /**
   * These three used to be one flag, `hooks`, on the honest grounds that they
   * rode one mechanism: the `PreToolUse` bridge. They no longer do. The hook
   * stopped deciding and now only captures, the agent took over asking, and
   * the ceiling moved to a boundary that needs no hook at all - so a single flag
   * would have to answer three questions with different answers.
   *
   * A fourth, `toriRules`, went with the gate itself: no agent has a
   * Tori-owned rule store to publish, so there is no longer a question to ask.
   */
  approvals: ApprovalTier;
  /** Where a tool card's before-and-after comes from, or `none` when it has
   *  nowhere to come from. See [`DiffTier`] for why this is not a boolean. */
  diffs: DiffTier;
  /** Stated per transport rather than inferred, because the failure is silent:
   *  a transport whose history arrives live and is read as live looks busy
   *  forever. See [`HistorySource`]. */
  historySource: HistorySource;
  /** A spend ceiling can stop this chat. Needs nothing from the agent: it is
   *  Tori declining to open the next turn. */
  spendCeilings: boolean;
  /** Whether this chat can show what a subagent is doing, and whether it could
   *  ever talk to one. See [`SubagentTier`]. */
  subagents: SubagentTier;
  /**
   * What the agent can open when handed a path it already has (a tree drag,
   * an `@` mention), and when handed bytes Tori wrote under its own app data
   * for it (a paste, a Finder drop). Two keys because they can differ: a
   * transport can carry a path as text and still have no measured way to read
   * one outside its cwd, and one published key with a gap is what the tests
   * forbid. Empty means refused, and the gap says why.
   */
  attachmentMentions: readonly AttachmentKind[];
  attachmentUploads: readonly AttachmentKind[];
  /**
   * Why each affordance this agent lacks is missing, in the words a user
   * reads.
   *
   * The published list omits what did not ship, because a listing is a promise
   * and an entry reading `rewind: none` invites reading the key and skipping the
   * value. But omission alone leaves a user with a control that is simply not
   * there and no way to find out why, and "it silently does nothing" is the
   * failure this whole file exists to prevent. So the two are separate surfaces:
   * `publishedCapabilities` promises, and this explains.
   *
   * Authored next to the values it explains, never derived from them, because
   * the reason is the part that differs. Two transports can both lack a spend
   * ceiling - one because its turns are not Tori's to open, one because it
   * reports no cost - and telling the user the wrong reason sends them to fix
   * the wrong thing. `everyGapIsExplained` in the tests is what stops a new
   * transport lacking something silently.
   */
  gaps: Partial<Record<PublishedCapability["key"], string>>;
};

/**
 * Per transport, from what each phase actually shipped.
 *
 * `Record<ChatTransport, ChatTier>` on purpose: a new transport fails to
 * compile until someone states its tier, which is the only thing that stops a
 * second agent inheriting Claude's measurements by silence.
 */
const TIERS: Record<ChatTransport, ChatTier> = {
  claude_stream_json: {
    // Phase 5. The original session keeps its id and its transcript, so this is
    // neither `full` nor `files-only`.
    rewind: "fork",
    // Phase 8's spike 5: a mid-turn `user` frame pre-empted every remaining
    // step, 3 valid trials of 3.
    steer: "consumed-before-next-tool",
    steerCost: { minMs: 1468, maxMs: 5365, trials: 3, measuredAgainst: "claude 2.1.220" },
    // Measured on claude 2.1.231: `--permission-prompt-tool stdio` raises a
    // `can_use_tool` control request, which is the question Tori now renders.
    approvals: "in-protocol",
    diffs: "before-state",
    // The CLI writes a per-session `.jsonl` and `chat_history` reads it, so
    // history has landed before the child is asked for anything.
    historySource: "transcript",
    spendCeilings: true,
    // Measured against claude 2.1.259: the `task_*` frames carry a subagent's
    // lifecycle and its totals, and the sidecar transcript has the rest. Not
    // `addressable` - nothing on this wire carries a message to one.
    subagents: "observable",
    // Measured 2026-09-04 on claude 2.1.259: Read opens all three off disk,
    // and a path under `--add-dir` raises no prompt in default mode.
    attachmentMentions: ["image", "pdf", "file"],
    attachmentUploads: ["image", "pdf", "file"],
    // Nothing missing, so nothing to explain.
    gaps: {},
  },
  // Every ACP agent, behind one transport. So this is a **floor**: what no ACP
  // session can do whichever agent is behind it. What varies per agent is
  // advertised on its handshake and arrives as `ChatCapabilities`, which
  // `publishedCapabilities` folds in - see `capabilityNotes`.
  acp: {
    // Tori's rewind is a fork, a tree snapshot and a replay cut at the turn.
    // The transport forks over `session/fork` when the agent advertises it,
    // which is what a hunk's side question uses, but cutting an ACP replay at a
    // turn is not built, so offering rewind would offer one that fails when
    // clicked.
    rewind: "none",
    // Refused rather than degraded by the transport: ACP has no mid-turn
    // delivery, and a queued turn is indistinguishable upstream from a steer
    // that landed.
    steer: "none",
    steerCost: null,
    // Measured live against `@agentclientprotocol/claude-agent-acp` 0.67.0: the
    // agent blocks on `session/request_permission`, Tori renders the agent's own
    // options, and the answer goes back in its own vocabulary. This is the one
    // tier value ACP earns outright rather than lacking.
    approvals: "in-protocol",
    // **Corrected in Phase 8, and it was wrong for the reason it gave.** This
    // read `false`, on the grounds that a before-state comes from the
    // Claude-only capture hook. It does not have to: `codex-acp` 1.2.0 sends the
    // file's prior text with the tool call, which Tori stores in the same object
    // store the hook writes to, so the card is the same card. `opencode acp`
    // sends none, which is why this is not `before-state` either - an ACP
    // session gets an exact diff exactly when its agent supplies one.
    diffs: "agent-supplied",
    // `sessions.rs::transcript_path` returns `None` for every ACP adapter: the
    // store is the agent's own. So a reopened conversation arrives as the
    // `session/update` notifications `session/load` replays, on the same
    // channel a running turn uses.
    historySource: "session-replay",
    // **Not because it rides the hook** - Phase 2 moved ceilings to the turn
    // boundary, where they need nothing from the agent. Because ACP reports no
    // *cost*: `session/update`'s usage carries context occupancy (`used` of
    // `size`) and no money, so a ceiling in dollars would never fire. Publishing
    // it as armed is the one failure a spend ceiling must not have.
    spendCeilings: false,
    // The protocol has no subagent in it: a `session/update` names the session
    // and nothing inside it, so there is no id to group a nested call under.
    subagents: "none",
    // A mention is text the agent already receives, so a source file costs
    // nothing new. Whether an ACP agent would read an image or a PDF off a
    // path is unmeasured, and so is whether it can reach outside its cwd at
    // all, which is what an upload under Tori's app data needs.
    attachmentMentions: ["file"],
    attachmentUploads: [],
    gaps: {
      attachmentUploads:
        "A pasted or dropped file would be written under Tori's own folder, and nothing has measured whether this agent can read outside its project. Drag a file from the tree instead, or mention it with @.",
      rewind:
        "Rewinding needs Tori to fork the conversation, and it has no way to ask an ACP agent to. Turn checkpoints still restore your files from the Changes panel.",
      steer:
        "A message typed during a turn waits for the next one: this protocol has no way to deliver it mid-turn, so Tori holds it rather than claiming it landed.",
      budgets:
        "A spend ceiling needs the agent to report what a turn cost, and this one reports how full the context is instead. Nothing would ever trip the limit, so it is not offered.",
      subagents:
        "If this agent splits work across helpers, it says so nowhere Tori can hear: the protocol has no message for one starting, working or finishing. Their tool calls arrive as the session's own, so the transcript reads as one agent doing everything.",
    },
  },
};

/** A PTY-only adapter, and the honest answer before `list_agents` resolves. Not
 *  a degraded tier: a PTY-only adapter ships no chat transport at all, so every
 *  value is `none` rather than unknown. */
export const NO_CHAT_TIER: ChatTier = {
  rewind: "none",
  steer: "none",
  steerCost: null,
  approvals: "none",
  diffs: "none",
  // No chat channel to replay onto, so the transcript reader is the only way in
  // and the answer is the same one it gives for an agent with no file: nothing.
  historySource: "transcript",
  // A PTY tab's turns are not Tori's to open, so there is no boundary to hold.
  spendCeilings: false,
  subagents: "none",
  attachmentMentions: [],
  attachmentUploads: [],
  // Deliberately empty. Explaining each absence in turn would be that many ways
  // of saying one thing: this agent has no chat surface at all.
  gaps: {},
};

/** The two sources as `checkAttachment` reads them, with the tier's own words
 *  for a refused one. */
export function attachmentSources(
  tier: ChatTier,
  advertised?: ChatCapabilities | null,
): { mentions: AttachmentSource; uploads: AttachmentSource } {
  const uploadKinds =
    advertised?.imageInput && !tier.attachmentUploads.includes("image")
      ? ["image" as const, ...tier.attachmentUploads]
      : tier.attachmentUploads;
  return {
    mentions: { kinds: tier.attachmentMentions, gap: tier.gaps.attachmentMentions ?? null },
    uploads: {
      kinds: uploadKinds,
      // A partial capability should explain a refused PDF/file by listing the
      // image kind it does accept, not by claiming it accepts no uploads.
      gap: uploadKinds.length ? null : (tier.gaps.attachmentUploads ?? null),
    },
  };
}

/** What the agent behind this chat config supports. */
export function chatTier(transport: ChatTransport | null | undefined): ChatTier {
  return transport ? TIERS[transport] : NO_CHAT_TIER;
}

/** One published capability, split so a caller can look up its explanation by
 *  `key` without parsing `label` back apart. */
export type PublishedCapability = {
  key:
    | "rewind"
    | "steer"
    | "approvals"
    | "diffs"
    | "budgets"
    | "history"
    | "sessions"
    | "subagents"
    | "attachmentMentions"
    | "attachmentUploads";
  value: string;
  label: string;
};

/**
 * The tier as published: one entry per feature that actually shipped.
 *
 * `label` is always `feature: value` with the **qualified** value, never the
 * bare feature name. A feature that did not ship is **omitted** rather than
 * published as `rewind: none` - a listing is a promise, and an entry for
 * something absent invites reading the key and skipping the value.
 */
export function publishedCapabilities(
  tier: ChatTier,
  /** What the running agent advertised, for a agent that advertises. Absent
   *  before a session handshakes and null for one whose capabilities are
   *  measured instead, and in both cases the tier alone is published. */
  live?: ChatCapabilities | null,
): PublishedCapability[] {
  const out: PublishedCapability[] = [];
  const add = (key: PublishedCapability["key"], value: string) => out.push({ key, value, label: `${key}: ${value}` });
  if (tier.rewind !== "none") add("rewind", tier.rewind);
  if (tier.steer !== "none") add("steer", tier.steer);
  // Each of these was once folded into one `hooks: pretooluse` entry, which
  // published the mechanism rather than the outcome. A reader wants to know who
  // asks them and what stops the spending, not which hook event carries it.
  if (tier.approvals !== "none") add("approvals", tier.approvals);
  // The value is the qualification: `agent-supplied` says on its face that the
  // diff arrives when the agent sends one, which is the honest promise for a
  // transport whose agents differ on it. Publishing a bare `diffs: yes` for that
  // case is exactly what this file's "name what shipped" rule forbids.
  if (tier.diffs !== "none") add("diffs", tier.diffs);
  if (tier.spendCeilings) add("budgets", "turn-boundary");
  // The value carries the promise, which is why it is not a bare `subagents:
  // yes`: `observable` says you can read one, not send it anything.
  if (tier.subagents !== "none") add("subagents", tier.subagents);
  // The kinds themselves, so the listing says what can be attached rather
  // than that something can.
  if (tier.attachmentMentions.length) add("attachmentMentions", tier.attachmentMentions.join(", "));
  const uploads = attachmentSources(tier, live).uploads.kinds;
  if (uploads.length) add("attachmentUploads", uploads.join(", "));
  // Derived from the running agent's own handshake rather than from the
  // transport, because one generic transport carries agents that differ: the
  // same `acp` tier sits behind an agent that reopens conversations and one
  // that cannot, and only the agent can say which it is. Omitted when absent,
  // on the same rule as every value above - a listing is a promise.
  if (live?.loadSession) add("history", "session/load");
  if (live?.listSessions) add("sessions", "listed by the agent");
  return out;
}

/** One affordance this agent does not have, and why. */
export type MissingCapability = {
  key: PublishedCapability["key"];
  why: string;
};

/**
 * What this agent cannot do, in the order the published list would have shown
 * them.
 *
 * The counterpart to `publishedCapabilities`, and separate from it on purpose:
 * one is a promise and the other is an explanation, and folding them into one
 * list is what produces an entry like `rewind: none` that reads as a feature.
 *
 * Empty for a agent with no chat surface at all, whose absences are one fact
 * rather than five.
 */
export function unavailableCapabilities(tier: ChatTier): MissingCapability[] {
  const out: MissingCapability[] = [];
  const add = (key: PublishedCapability["key"], missing: boolean) => {
    const why = tier.gaps[key];
    if (missing && why) out.push({ key, why });
  };
  add("rewind", tier.rewind === "none");
  add("steer", tier.steer === "none");
  add("approvals", tier.approvals === "none");
  add("diffs", tier.diffs === "none");
  add("budgets", !tier.spendCeilings);
  add("subagents", tier.subagents === "none");
  add("attachmentMentions", tier.attachmentMentions.length === 0);
  add("attachmentUploads", tier.attachmentUploads.length === 0);
  return out;
}

/**
 * What a steer costs, in the words a person reads.
 *
 * Derived from `steerCost` rather than written out, so the figure on screen and
 * the figure recorded by the measurement cannot drift apart. Null when there is
 * nothing to quote.
 *
 * The figure only, never how it was arrived at. `trials` and `measuredAgainst`
 * are why the number is trusted here, not something the person waiting on a
 * steer has any use for; Settings used to print them and it read like lab notes
 * left in the product.
 */
export function steerCostLabel(tier: ChatTier): string | null {
  const cost = tier.steerCost;
  if (!cost) return null;
  return `${(cost.minMs / 1000).toFixed(1)}-${(cost.maxMs / 1000).toFixed(1)}s`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The string entries of an `extra` key, in order, ignoring anything that is not
 * a string.
 *
 * Tolerant on purpose. A future CLI that promotes these to objects (as it
 * already did for `plugins`) would otherwise put a `[object Object]` in front
 * of the user; dropping what we cannot read shows a shorter honest list
 * instead, and `chatPlugins` is the pattern for reading the richer shape.
 */
export function stringList(extra: Extra | undefined, key: string): string[] {
  const raw = extra?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.map(str).filter((s): s is string => s !== null);
}

/** Plugins from `extra.plugins`, keeping only entries that at least have a
 *  name: a plugin we cannot name is not something the UI can usefully list. */
export function chatPlugins(extra: Extra | undefined): ChatPlugin[] {
  const raw = extra?.plugins;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p): ChatPlugin | null => {
      if (typeof p === "string") return { name: p, version: null, source: null, path: null };
      if (!p || typeof p !== "object") return null;
      const o = p as Record<string, unknown>;
      const name = str(o.name);
      return name ? { name, version: str(o.version), source: str(o.source), path: str(o.path) } : null;
    })
    .filter((p): p is ChatPlugin => p !== null);
}

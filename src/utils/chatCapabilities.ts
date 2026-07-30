// Two kinds of capability, kept in one file because both answer "what can this
// chat actually do".
//
//   * **What a session loaded** - its skills, subagents and plugins, read off
//     `system/init`. Per session, and it changes with the user's install.
//   * **What the harness behind it supports** - the chat tier below. Per
//     *transport*, fixed at build time, and the thing the UI gates on.
//
// The tier's rule is that **a value names what shipped, never what the feature
// is called**. A declaration reading `rewind: yes` or `steer: yes` would promise
// a second adapter's user something Sway only measured against one CLI version,
// so every value here is the measured outcome, and a surface reads the value
// rather than the presence of the key. Keyed on `ChatTransport` rather than on
// the agent id, because the transport is what the behaviour belongs to: a user
// adapter pointing at `claude_stream_json` gets the same tier for the same
// reason it gets the same wire protocol.
import type { ChatTransport } from "./agents";
import type { Extra } from "./chatTypes";

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
 * What a harness does with a message written mid-turn.
 *
 * `consumed-before-next-tool` is the measured outcome, not a promise. A harness
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

export type ChatTier = {
  rewind: RewindTier;
  steer: SteerTier;
  /** Null exactly when `steer` is `"none"`: there is no cost to quote for
   *  something that does not happen. */
  steerCost: SteerCost | null;
  /**
   * The `PreToolUse` bridge is available, which is what per-tool approval,
   * Sway-owned rules, spend ceilings and before-state diffs all ride. One flag
   * rather than four, because they share one mechanism: a harness without it
   * has none of them, and listing them separately would invite a declaration
   * claiming three of the four.
   */
  hooks: boolean;
};

/**
 * Per transport, from what each phase actually shipped.
 *
 * `Record<ChatTransport, ChatTier>` on purpose: a new transport fails to
 * compile until someone states its tier, which is the only thing that stops a
 * second harness inheriting Claude's measurements by silence.
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
    hooks: true,
  },
};

/** A PTY-only adapter, and the honest answer before `list_agents` resolves. Not
 *  a degraded tier: a PTY-only adapter ships no chat transport at all, so every
 *  value is `none` rather than unknown. */
export const NO_CHAT_TIER: ChatTier = { rewind: "none", steer: "none", steerCost: null, hooks: false };

/** What the harness behind this chat config supports. */
export function chatTier(transport: ChatTransport | null | undefined): ChatTier {
  return transport ? TIERS[transport] : NO_CHAT_TIER;
}

/** One published capability, split so a caller can look up its explanation by
 *  `key` without parsing `label` back apart. */
export type PublishedCapability = { key: "rewind" | "steer" | "hooks"; value: string; label: string };

/**
 * The tier as published: one entry per feature that actually shipped.
 *
 * `label` is always `feature: value` with the **qualified** value, never the
 * bare feature name. A feature that did not ship is **omitted** rather than
 * published as `rewind: none` - a listing is a promise, and an entry for
 * something absent invites reading the key and skipping the value.
 */
export function publishedCapabilities(tier: ChatTier): PublishedCapability[] {
  const out: PublishedCapability[] = [];
  const add = (key: PublishedCapability["key"], value: string) =>
    out.push({ key, value, label: `${key}: ${value}` });
  if (tier.rewind !== "none") add("rewind", tier.rewind);
  if (tier.steer !== "none") add("steer", tier.steer);
  if (tier.hooks) add("hooks", "pretooluse");
  return out;
}

/**
 * What a steer costs, in the words a person reads.
 *
 * Derived from `steerCost` rather than written out, so the figure on screen and
 * the figure recorded by the measurement cannot drift apart. Null when there is
 * nothing to quote.
 */
export function steerCostLabel(tier: ChatTier): string | null {
  const cost = tier.steerCost;
  if (!cost) return null;
  return `${(cost.minMs / 1000).toFixed(1)}-${(cost.maxMs / 1000).toFixed(1)}s`;
}

/** The same figure with its provenance, for a surface that has room to say how
 *  much the number is worth. */
export function steerCostDetail(tier: ChatTier): string | null {
  const cost = tier.steerCost;
  const label = steerCostLabel(tier);
  if (!cost || !label) return null;
  return `Measured at ${label} over ${cost.trials} trials against ${cost.measuredAgainst}, so treat it as typical rather than guaranteed.`;
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

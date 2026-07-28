// What a session loaded: its skills, subagents and plugins.
//
// These ride in `extra` rather than as typed event fields because they are
// Claude-specific, so the values arrive as `unknown` and have to be narrowed
// before the UI touches them. Doing that here, once, keeps the panel free of
// defensive casts and gives the shapes a place to be tested.
//
// The shapes are measurements against claude 2.1.220's `system/init`, not
// guesses: `skills` is an array of 29 plain strings, `agents` an array of 5
// plain strings, and `plugins` an array of objects carrying `name`, `path`,
// `source` and `version`.
import type { Extra } from "./chatTypes";

export type ChatPlugin = {
  name: string;
  version: string | null;
  source: string | null;
  path: string | null;
};

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

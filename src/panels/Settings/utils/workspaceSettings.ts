// The three-layer answer to "what is this setting, here?".
//
//   built-in default  <  ~/.config/tori/settings.json  <  <workspace>/.tori/settings.json
//
// Each layer is a complete answer on its own, so a missing or broken overlay is
// never an error: it costs the user their per-workspace picks and nothing else.
// The overlay file itself is read and written by `workspace_settings.rs`, which
// treats its keys as opaque; validating them is this module's job, so a feature
// adding a setting registers it here (in `EditorDefaults`) and nowhere else.
//
// Pure, and separate from the store for the usual reason: which layer wins is a
// rule with cases in it, and a rule tests without a mounted panel.

import type { EditorDefaults } from "../settingsStore";

/** A workspace's answers. Absent means "no answer here", which is distinct from
 *  an explicit `false` - that is this workspace saying no. */
export type EditorOverlay = Partial<EditorDefaults>;

/** Which layer supplied the value in force. */
export type Layer = "default" | "user" | "workspace";

/**
 * Pull a validated overlay out of whatever the file held.
 *
 * Validated against the *shape of the defaults* rather than a hand-written list:
 * a key the current build does not know, or one whose value is the wrong type,
 * is dropped. That is what lets a hand-edited file, or one written by a newer
 * version, be read without a crash and without a setting silently taking a
 * value nothing can interpret.
 */
export function parseOverlay(raw: unknown, defaults: EditorDefaults): EditorOverlay {
  const editor = (raw as { editor?: unknown } | null)?.editor;
  if (!editor || typeof editor !== "object" || Array.isArray(editor)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(editor as Record<string, unknown>)) {
    if (!(key in defaults)) continue;
    if (typeof value !== typeof defaults[key as keyof EditorDefaults]) continue;
    out[key] = value;
  }
  return out as EditorOverlay;
}

/** What the file should hold for this overlay. */
export function overlayFile(overlay: EditorOverlay): { editor: EditorOverlay } {
  return { editor: overlay };
}

/** The values in force: the workspace's answer where it has one, the user's
 *  otherwise, the built-in default under both. */
export function resolveEditorDefaults(
  defaults: EditorDefaults,
  user: EditorDefaults,
  overlay: EditorOverlay,
): EditorDefaults {
  return { ...defaults, ...user, ...overlay };
}

/**
 * Which layer each value came from, for the panel's badge.
 *
 * The workspace layer is decided by **presence**, which is exact: the overlay
 * either names the key or it does not. The user-versus-default split is decided
 * by **value**, which is a heuristic, because the loaded settings have already
 * had their defaults filled in by the backend and no longer say which keys the
 * file actually contained. The consequence is small and worth naming: someone
 * who sets a value to what it already was reads as "default". The badge's one
 * hard promise - that "workspace" means the overlay supplied it - is unaffected.
 */
export function editorOrigins(
  defaults: EditorDefaults,
  user: EditorDefaults,
  overlay: EditorOverlay,
): Record<keyof EditorDefaults, Layer> {
  const out = {} as Record<keyof EditorDefaults, Layer>;
  for (const key of Object.keys(defaults) as (keyof EditorDefaults)[]) {
    out[key] = key in overlay ? "workspace" : user[key] !== defaults[key] ? "user" : "default";
  }
  return out;
}

/** Set or clear one workspace answer. `undefined` clears it, which is how a
 *  setting is handed back to the layer below rather than pinned to a value that
 *  happens to match it today. Generic in the key, so the value has to be that
 *  setting's own type rather than any setting's. */
export function withOverride<K extends keyof EditorDefaults>(
  overlay: EditorOverlay,
  key: K,
  value: EditorDefaults[K] | undefined,
): EditorOverlay {
  const next = { ...overlay };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

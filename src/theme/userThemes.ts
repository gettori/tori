// Themes the user dropped into ~/.config/tori/packs/themes/.
//
// Rust (themes.rs) reads the directory and hands over whatever is structurally
// valid; this module runs the same `admit()` a bundled theme runs, so the two
// sources differ only in where the JSON came from. A theme that fails the gate
// is KEPT here rather than dropped: the picker will not offer it, but
// `getTheme` can still find it, which is what lets `setTheme` refuse it by name
// instead of reporting the far less useful "no such theme".
//
// The list is a signal because the whole point of the watcher is that a file
// dropped into the folder shows up in Settings without a restart.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { admit } from "./admit";
import { listThemes } from "./bundled";
import type { Appearance, Palette } from "./schema";
import type { Provenance } from "../utils/packs";

/** One file in the themes directory that parsed and validated in Rust. */
export type LoadedTheme = { palette: Palette; source: string; provenance?: Provenance };

/** What Rust's `list_user_themes` returns: the files that validated, plus a
 *  named error for each that did not. */
export type UserThemesPayload = { themes: LoadedTheme[]; errors: string[] };

export type UserTheme = {
  id: string;
  label: string;
  appearance: Appearance;
  palette: Palette;
  /** Absolute path of the file that defined it. */
  source: string;
  /** Empty when the theme passed `admit()`; otherwise why it did not. */
  problems: string[];
  provenance?: Provenance;
};

const [userThemes, setUserThemes] = createSignal<UserTheme[]>([]);

/** Every user theme, including the ones the gate refused. */
export function listUserThemes(): UserTheme[] {
  return userThemes();
}

/** Pure core: turn a loader payload into the registry entries plus everything
 *  worth telling the user about. Explicit input, no Tauri, so the admission
 *  rules are testable off-disk (the repo's pure-core convention). */
export function admitLoaded(payload: UserThemesPayload): {
  themes: UserTheme[];
  problems: string[];
} {
  const bundledIds = new Set(listThemes().map((t) => t.id));
  const themes: UserTheme[] = [];
  const problems: string[] = [...payload.errors];

  for (const { palette, source, provenance } of payload.themes) {
    // A user file may not shadow a bundled theme. Allowing it would make
    // "Tori Dark" mean different things on two machines, and the picker groups
    // by source precisely so a user can tell them apart.
    if (bundledIds.has(palette.id)) {
      problems.push(`${source}: id "${palette.id}" is a bundled theme; rename it`);
      continue;
    }
    const admission = admit(palette, source);
    const entry: UserTheme = {
      id: palette.id,
      label: palette.label,
      appearance: palette.appearance,
      palette,
      source,
      problems: admission.ok ? [] : admission.problems,
      provenance,
    };
    themes.push(entry);
    problems.push(...entry.problems);
  }

  return { themes, problems };
}

/** Admit a loader payload and publish the result. Split from the fetch so the
 *  registry can be driven without Tauri: vitest runs in node, and "a refused
 *  theme is never painted" is only provable by putting one in the registry and
 *  watching `setTheme` decline it. */
export function publishUserThemes(payload: UserThemesPayload): string[] {
  const { themes, problems } = admitLoaded(payload);
  setUserThemes(themes);
  return problems;
}

/** Re-read the themes directory and republish the list. Returns everything the
 *  caller should surface: unreadable files, id collisions, and gate refusals. */
export async function reloadUserThemes(): Promise<string[]> {
  let payload: UserThemesPayload;
  try {
    payload = await invoke<UserThemesPayload>("list_user_themes");
  } catch (e) {
    // A backend that cannot list themes is not a reason to drop the ones
    // already loaded, nor to block whatever the caller is doing.
    return [`could not read the themes folder: ${String(e)}`];
  }
  return publishUserThemes(payload);
}

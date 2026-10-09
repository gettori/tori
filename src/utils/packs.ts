// Mirrors `packs::Meta`, `packs::LoadError`, `packs::provenance::Provenance`
// and `packs::migrate::Report` in src-tauri/src/packs/.
import { createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Contributor = { name: string; github: string };

export type PackMeta = {
  description: string | null;
  contributor: Contributor | null;
  license: string | null;
};

export type PackKind = "lsp" | "dap" | "formatters" | "themes" | "agents";

/** A file Tori would not load. `kind` is null for `installed.json`;
 *  `removable` is the id `packs_remove` takes, for a recorded file edited since. */
export type LoadError = {
  kind: PackKind | null;
  file: string;
  message: string;
  fix: string | null;
  removable: string | null;
};

export type PackSource = "bundled" | "catalog" | "override" | "custom";

export type Provenance = { source: PackSource; updateAvailable: boolean; catalogConflict: boolean };

/** The word a card shows for where its pack came from. */
export function provenanceLabel(p: Provenance, contributor: Contributor | null | undefined): string {
  switch (p.source) {
    case "bundled":
      return "Bundled";
    case "catalog":
      return contributor ? `Catalog, by ${contributor.name}` : "Catalog";
    case "override":
      return "Override";
    case "custom":
      return "Custom";
  }
}

export type MigrationReport = {
  moved: { kind: PackKind; from: string; to: string; renamedFrom: string | null; isOverride: boolean }[];
  skipped: { path: string; reason: string }[];
};

const [loadErrors, setLoadErrors] = createSignal<LoadError[]>([]);
export { loadErrors };

/** Ask again. A failed ask, or an answer that is not a list, keeps the last
 *  answer rather than clearing it. */
export async function refreshLoadErrors(): Promise<LoadError[]> {
  const errors = await invoke<unknown>("packs_load_errors").catch(() => null);
  if (Array.isArray(errors)) setLoadErrors(errors as LoadError[]);
  return loadErrors();
}

/** `packs::CHANGED`: one kind was reloaded from its folder. */
export const PACKS_CHANGED = "packs:changed";

/** Call `fn` each time `kind` is reloaded, for as long as the calling
 *  component is mounted. */
export function onPacksChanged(kind: PackKind, fn: () => void) {
  const off = listen<PackKind>(PACKS_CHANGED, (e) => {
    if (e.payload === kind) fn();
  }).catch(() => null);
  onCleanup(() => void off.then((unlisten) => unlisten?.()));
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** What the start of a run says about packs, or null when there is nothing. */
export function packsNotice(report: MigrationReport | null, errors: LoadError[]): string | null {
  const parts: string[] = [];
  if (report && report.moved.length > 0) {
    parts.push(`Tori moved ${files(report.moved.length)} into ~/.config/tori/packs.`);
    const renamed = report.moved.filter((m) => m.renamedFrom);
    if (renamed.length > 0) {
      const ids = renamed.map((m) => m.renamedFrom).join(", ");
      const verb = renamed.length === 1 ? "now loads as a -custom copy" : "now load as -custom copies";
      parts.push(`${ids} ${verb}, with the bundled one switched off.`);
    }
    const kept = report.moved.filter((m) => m.isOverride).length;
    if (kept > 0) parts.push(`${files(kept)} kept a bundled id as an override.`);
  }
  if (report && report.skipped.length > 0) {
    const first = report.skipped[0];
    parts.push(`${files(report.skipped.length)} stayed where they were, first ${first.path}: ${first.reason}.`);
  }
  // A broken theme already has a toast of its own, naming the file.
  const broken = errors.filter((e) => e.kind !== "themes").length;
  if (broken > 0) {
    parts.push(`${files(broken)} did not load; Settings lists each under Needs fixing.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

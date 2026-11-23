// Each repo's default branch (origin/HEAD's target), asked once per repo for the
// life of the window: it moves only when someone changes the remote's HEAD.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

const [known, setKnown] = createSignal<Record<string, string | null>>({});
const asked = new Set<string>();

export function defaultBranchOf(repo: string): string | null {
  if (!asked.has(repo)) {
    asked.add(repo);
    void invoke<string | null>("repo_default_branch", { repo })
      .catch(() => null)
      .then((name) => setKnown((prev) => ({ ...prev, [repo]: name ?? null })));
  }
  return known()[repo] ?? null;
}

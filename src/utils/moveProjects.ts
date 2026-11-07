import { invoke } from "@tauri-apps/api/core";
import { moveWorkspaces } from "./moveWorkspace";
import { unsavedUnder } from "./unsavedPaths";

export type MoveRequest = { space: string; name: string; path: string };
export type PlannedMove = { from: string; to: string; done: boolean };
export type MoveResult = { moves: PlannedMove[]; warning?: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The backend cannot see unsaved buffers, so this is the only check for them.
export function moveBlockers(running: number, paths: readonly string[]): string[] {
  const unsaved = paths.reduce((n, p) => n + unsavedUnder(p).length, 0);
  return [
    ...(running
      ? [
          `${running} terminal or agent ${plural(running, "tab is", "tabs are")} running in ${plural(paths.length, "this folder", "these folders")}. Close ${plural(running, "it", "them")} first.`,
        ]
      : []),
    ...(unsaved
      ? [
          `${unsaved} ${plural(unsaved, "file has", "files have")} unsaved changes. Save or discard ${plural(unsaved, "it", "them")} first.`,
        ]
      : []),
  ];
}

function follow(done: MoveResult): MoveResult {
  moveWorkspaces(done.moves.map(({ from, to }) => ({ from, to })));
  return done;
}

export async function moveProjects(base: string, moves: MoveRequest[]): Promise<MoveResult> {
  return follow(await invoke<MoveResult>("move_into_space", { base, moves }));
}

export async function unfinishedMoves(): Promise<PlannedMove[] | null> {
  const journal = await invoke<{ moves: PlannedMove[] } | null>("move_journal");
  return journal?.moves.length ? journal.moves : null;
}

export async function resumeMoves(): Promise<MoveResult> {
  return follow(await invoke<MoveResult>("resume_moves"));
}

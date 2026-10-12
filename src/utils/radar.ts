// The radar's overlaps, as the webview reads them: files a live session here
// and a live session in another worktree of the same repo both wrote.
//
// Rust computes and announces them; this only keeps the last list. Every
// overlap arrives twice, once from each side, so a surface filters by its own
// session or folder and never has to look at the other half.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sameCwd } from "./pathScope";

export type Overlap = {
  session: string;
  path: string;
  /** Relative to the worktree root, the same in both worktrees. */
  file: string;
  other_session: string;
  other_path: string;
  /** What the other worktree has checked out now, null when detached. */
  other_branch: string | null;
};

export type RadarChanged = { units: { path: string; branch: string }[]; overlaps?: Overlap[] };

const [overlaps, setOverlaps] = createSignal<Overlap[]>([]);

let started = false;

/** Load the list once and follow every change after it. Safe to call from each
 *  surface that reads overlaps: only the first call does anything. */
export function watchRadar(): void {
  if (started) return;
  started = true;
  void listen<RadarChanged>("radar://changed", (e) => applyRadarChange(e.payload));
  void invoke<{ overlaps: Overlap[] }>("radar_list")
    .then((listing) => setOverlaps(listing.overlaps))
    .catch(() => {});
}

/** A change event's overlaps, when it carries any. Absent means unchanged. */
export function applyRadarChange(change: RadarChanged): void {
  if (change.overlaps) setOverlaps(change.overlaps);
}

/** What the session at this id shares with other worktrees. */
export const overlapsOf = (sessionId: string): Overlap[] => overlaps().filter((o) => o.session === sessionId);

/** What any session working in this folder shares with other worktrees. */
export const overlapsAt = (folderPath: string): Overlap[] => overlaps().filter((o) => sameCwd(o.path, folderPath));

/** The other side's branch, or how to name a worktree that has none. */
export const otherBranch = (o: Overlap): string => o.other_branch ?? "a detached worktree";

export function resetRadarForTests(): void {
  started = false;
  setOverlaps([]);
}

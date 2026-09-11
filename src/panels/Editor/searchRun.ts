// The grep fan-out the Search panel and the Search Editor both run.

import { invoke } from "@tauri-apps/api/core";
import { grepArgs, type GrepOptions, type RootOutcome, type SearchResult } from "../../utils/searchOptions";
import type { ResultMatch } from "./searchResultsDoc";

/** Per root, not shared across them: truncation is reported per section, and one
 *  budget split across members would let a noisy repo starve the rest. */
export const MAX_RESULTS = 500;

/** One root's leg of the fan-out. It never throws: a member whose grep fails
 *  reports in its own section, so one unreadable repo cannot blank the rest. */
export async function grepRoot(root: string, q: string, options: GrepOptions, max = MAX_RESULTS): Promise<RootOutcome> {
  try {
    return { root, result: await invoke<SearchResult>("grep_project", grepArgs(root, q, options, max)) };
  } catch (e) {
    return { root, error: String(e) };
  }
}

/** Each hit file's lines, read once per file, for the Search Editor's context
 *  rows. A file that cannot be read shows its hits without context. */
export async function readHitFiles(
  matches: readonly ResultMatch[],
): Promise<(root: string, file: string) => readonly string[] | null> {
  const key = (root: string, file: string) => `${root}\u0000${file}`;
  const files = new Map<string, { root: string; file: string }>();
  for (const m of matches) files.set(key(m.root, m.path), { root: m.root, file: m.path });
  const read = new Map<string, string[]>();
  await Promise.all(
    [...files].map(async ([k, f]) => {
      const text = await invoke<string>("fs_read_file", { path: `${f.root}/${f.file}` }).catch(() => null);
      if (text !== null) read.set(k, text.split(/\r?\n/));
    }),
  );
  return (root, file) => read.get(key(root, file)) ?? null;
}

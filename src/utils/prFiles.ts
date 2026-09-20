// What to do with a pull-request file the API sent no patch for.
//
// The API omits `patch` in three unrelated situations, and they need three
// different sentences on screen:
//
//   * **A binary file or a mode-only change.** There is no text diff to show
//     and there never will be; nothing is missing.
//   * **A pure rename.** The file moved and its contents did not, so an empty
//     diff is the complete and correct answer.
//   * **A patch past the size GitHub will send.** Something *is* missing, the
//     reader has to go elsewhere for it, and this is the only one of the three
//     where saying "no changes to show" would be a lie.
//
// The line counts beside the patch are what tell them apart, which is why
// `PrFile` carries them even though a present patch already contains them: a
// too-large file reports its additions and deletions and withholds the text, a
// binary file reports zero of both.

import type { PrFile } from "./forgeTypes";

export type FileSkip = "tooLarge" | "moved" | "noText";

/** Why this file renders a placeholder instead of a diff, or null to render the
 *  diff. */
export function fileSkip(f: PrFile): FileSkip | null {
  // An all-whitespace patch is treated as no patch. It is not a shape GitHub
  // sends, but the alternative is a file row that opens onto nothing at all
  // with no sentence saying why.
  if (f.patch !== null && f.patch.trim() !== "") return null;
  if (f.additions + f.deletions > 0) return "tooLarge";
  if (f.previousPath !== null) return "moved";
  return "noText";
}

/** How the file's row reads. A rename says both halves, because "src/to.ts"
 *  alone is indistinguishable from a new file. */
export function fileLabel(f: PrFile): string {
  return f.previousPath ? `${f.previousPath} → ${f.path}` : f.path;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a file's row says out loud: everything it encodes in colour or a glyph,
 *  which a screen reader would otherwise get as a letter and two numbers. */
export function fileRowName(file: PrFile, unresolved: number, viewed: boolean): string {
  const parts = [
    `${file.status[0].toUpperCase()}${file.status.slice(1)}`,
    // Both halves of a rename. The row itself shows the new path, which is what
    // a reader scans for; without the old one said here, a rename is a new file
    // beside a deleted one, which is two changes where there was one.
    file.previousPath ? `${file.previousPath} to ${file.path}` : file.path,
    `${file.additions} added`,
    `${file.deletions} removed`,
  ];
  if (unresolved) parts.push(plural(unresolved, "unresolved comment"));
  if (viewed) parts.push("viewed");
  return parts.join(", ");
}

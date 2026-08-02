// "Ask the agent to resolve this conflict" (plan phase 13, #17d).
//
// Two surfaces offer it, the banner over a conflicted buffer and the row in the
// Changes panel's Conflicts section, and they must hand the agent the *same*
// sentence: it is the same question about the same file, and two wordings drifting
// apart would read as two different requests. One composer and one send path here
// is what makes that true by construction rather than by two lists of words kept
// in step by hand.
//
// What the message carries is what the three-way view carries: the path, the
// stages, and the regions actually in dispute. It points the agent at the index
// rather than at the working copy, because git's markers are a rendering of
// stages 2 and 3 only - the base, which is the thing that says what each side
// *changed*, is not in the file at all.
import { invoke } from "@tauri-apps/api/core";
import {
  conflictRegions,
  conflictsOnly,
  deletedSides,
  sideLabels,
  type ConflictOp,
  type ConflictStages,
  type LineRange,
  type Side,
} from "./conflict";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { mentionPath } from "./pathScope";
import { requestSend, type SessionTarget } from "./safeSend";

/** How many disputed regions the message names by line before it stops listing
 *  them. A file with fifty would otherwise paste a paragraph of numbers into the
 *  prompt; the total is stated either way, so nothing is silently dropped. */
const REGION_CAP = 8;

/** One region in its own side's line numbers. `LineRange` is half-open, so the
 *  last line is `to - 1`; a zero-width range is text this side does not have
 *  (the other side inserted, or this side deleted what the other one changed),
 *  which has no lines to name and so is named by where it belongs. */
function span(r: LineRange): string {
  if (r.from >= r.to) return `before ${r.from}`;
  if (r.to - r.from === 1) return `${r.from}`;
  return `${r.from}-${r.to - 1}`;
}

/**
 * The wire format for "resolve this conflict", from the same three stages the
 * view is built from.
 *
 * Sides are named by index stage (`:2:`/`:3:`) and *then* translated, because
 * mid-rebase stage 2 is the upstream and stage 3 is your own replayed commit:
 * an agent told "keep ours" would keep the wrong one, and would sound right
 * doing it. The stage numbers are the part that never lies.
 */
export function composeConflictAsk(
  target: SessionTarget,
  root: string,
  file: string,
  op: ConflictOp,
  stages: ConflictStages,
): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(`${root.replace(/\/+$/, "")}/${file}`, cwd);
  const names = sideLabels(op);
  const head = `Resolve the conflict in @${mention}`;

  // A missing stage is a conflict about whether the file exists at all, not
  // about its lines, and it is finished with `git rm` rather than a merge (the
  // `-f` is required while the path is unmerged, same as phase 12's backend).
  const gone = deletedSides(stages);
  if (gone.length === 2) {
    return `${head}: both sides deleted the file, so \`git rm -f -- ${file}\` is what finishes it.`;
  }
  if (gone.length === 1) {
    const kept: Side = gone[0] === "ours" ? "theirs" : "ours";
    return (
      `${head}: ${names[gone[0]]} deleted the file and ${names[kept]} changed it, so the question is whether it survives, not which lines win. ` +
      `The surviving version is the one in the working copy: \`git add -- ${file}\` keeps it, \`git rm -f -- ${file}\` accepts the deletion.`
    );
  }

  const sides = `\`:2:\` is ${names.ours}, \`:3:\` is ${names.theirs}`;
  if (stages.binary) {
    return (
      `${head}: the file is binary, so there is no line-by-line merge to make. ${sides}. ` +
      `Take one side with \`git checkout --ours -- ${file}\` or \`git checkout --theirs -- ${file}\`, then \`git add -- ${file}\`.`
    );
  }

  const regions = conflictsOnly(conflictRegions(stages.base ?? "", stages.ours ?? "", stages.theirs ?? ""));
  const listed = regions.slice(0, REGION_CAP).map((r) => span(r.ours));
  const rest = regions.length - listed.length;
  const word = listed.length === 1 && /^\d+$/.test(listed[0]) ? "line" : "lines";
  const where = listed.length ? `, at \`:2:\` ${word} ${listed.join(", ")}${rest ? ` and ${rest} more` : ""}` : "";
  const disputed = regions.length
    ? `${regions.length} region${regions.length === 1 ? "" : "s"} in dispute${where}`
    : "the two sides changed it without disagreeing on any line";
  return (
    `${head}: ${disputed}. ${sides}. ` +
    `Read all three stages (\`git show :1:${file}\` for the base, then \`:2:\` and \`:3:\`) rather than the markers in the working copy, which carry the two sides but not the base. ` +
    `Then write the merged file and \`git add -- ${file}\`.`
  );
}

/**
 * Load the conflict, compose the ask, and route it through safe-send.
 *
 * The stages are read here rather than passed in, so a caller holding nothing
 * but a path (the Conflicts row) composes exactly what a caller looking at the
 * three-way view would. `git_conflict_op` failing is not fatal: an unknown
 * operation still has two sides, and `none` is a real answer (a conflicted
 * `git stash apply` records no state), so it degrades to the merge orientation
 * the same way the view does.
 *
 * Only the timeout is reported here. Terminal.tsx already toasts a blocked
 * target with the shared wording; this one is the case where no Terminal
 * answered at all, which nothing else would mention.
 */
export async function askAgentToResolve(target: SessionTarget, root: string, file: string): Promise<void> {
  let stages: ConflictStages;
  let op: ConflictOp;
  try {
    [stages, op] = await Promise.all([
      invoke<ConflictStages>("git_conflict_stages", { projectPath: root, file }),
      invoke<ConflictOp>("git_conflict_op", { projectPath: root }).catch(() => "none" as ConflictOp),
    ]);
  } catch (e) {
    // `String(e)` rather than an Error's message: a `Result<_, String>` command
    // rejects with the bare string git's own refusal was wrapped in, which is
    // the same thing every other panel toasts.
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
    return;
  }
  const result = await requestSend({ ...target, text: composeConflictAsk(target, root, file, op, stages) });
  if (result.kind === "timeout") {
    emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
  }
}

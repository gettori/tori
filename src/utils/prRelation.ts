// Whether a merged or closed pull request the poll found for a branch name is
// still that branch's, asked of local git once per change and shared by every
// surface that reads the poll, so a row and the Pull Requests panel cannot
// disagree about a reused branch name.

import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { BranchSync } from "./gitActions";
import type { PullRequest } from "./forgeTypes";
import type { FinishedPr } from "./branchSync";
import { forgePause, unitStatus } from "./forgeStatus";
import { projectPathFor } from "./sessionActivity";

/** `PrRelation` in src-tauri/src/git.rs. */
export type PrRelation =
  | { kind: "at" }
  | { kind: "ahead"; count: number }
  | { kind: "behind" }
  | { kind: "unrelated" }
  | { kind: "unknown" };

const [answers, setAnswers] = createStore<Record<string, { stamp: string; relation: PrRelation }>>({});
const asking = new Set<string>();
/** The newest stamp asked per branch, so a slower older reply cannot land last. */
const latest = new Map<string, string>();

// Content rather than object identity: the row and the Pull Requests panel read
// sync from two different stores and must land on one stamp. The tip's time
// moves on a commit or checkout, the base on a fetch.
const localStamp = (sync: BranchSync | null | undefined) =>
  sync ? `${sync.head_committed_at}:${sync.base?.behind ?? ""}:${sync.upstream.gone}` : "";

/**
 * The branch's relation to its finished pull request, or null for an open one,
 * for no pull request, and while local git has not answered yet.
 *
 * Asks on a miss, once per stamp: the read is what knows a new question exists,
 * and every caller asking the same question shares the one reply.
 */
export function prRelation(
  folderPath: string | null | undefined,
  branch: string | null | undefined,
  pr: PullRequest | null | undefined,
  sync: BranchSync | null | undefined,
): PrRelation | null {
  if (!folderPath || !branch || !pr || pr.state === "open") return null;
  // The branch standing on its base: a finished pull request out of `main`
  // into a release branch is not `main`'s own.
  if (sync && !sync.detached && sync.base === null) return { kind: "unrelated" };
  const endedAt = Math.floor(Date.parse(pr.closedAt ?? pr.mergedAt ?? "") / 1000);
  if (Number.isNaN(endedAt)) return { kind: "unknown" };
  const key = `${folderPath}\u0000${branch}`;
  const stamp = `${pr.number}:${pr.headSha}:${endedAt}:${localStamp(sync)}`;
  const held = answers[key];
  if (held?.stamp !== stamp && !asking.has(`${key}\u0000${stamp}`))
    void ask(key, stamp, folderPath, branch, pr.headSha, endedAt);
  return held?.relation ?? null;
}

/** A checkout's merged or closed pull request as the sync surfaces weigh it,
 *  for the ones that know a folder and a branch but not the poll. Null while
 *  the poller is stopped, since its answer would be aging unseen. */
export function finishedPr(
  folderPath: string | null | undefined,
  branch: string | null | undefined,
  sync: BranchSync | null | undefined,
): FinishedPr | null {
  if (!folderPath || !branch) return null;
  const project = projectPathFor(folderPath) ?? folderPath;
  if (forgePause(project) !== null) return null;
  const pr = unitStatus(project, branch)?.pullRequest;
  if (!pr || pr.state === "open") return null;
  const relation = prRelation(folderPath, branch, pr, sync);
  return relation?.kind === "unrelated" ? null : { state: pr.state, relation };
}

async function ask(key: string, stamp: string, projectPath: string, branch: string, sha: string, endedAt: number) {
  const token = `${key}\u0000${stamp}`;
  asking.add(token);
  latest.set(key, stamp);
  const relation = await invoke<PrRelation>("git_pr_relation", { projectPath, branch, sha, endedAt }).catch(
    (): PrRelation => ({ kind: "unknown" }),
  );
  asking.delete(token);
  if (latest.get(key) === stamp) setAnswers(key, { stamp, relation });
}

export function resetPrRelationsForTests() {
  setAnswers(reconcile({}));
  asking.clear();
  latest.clear();
}

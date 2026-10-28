// A repo's `.tori/project.json` for a worktree, and the user's answer to it.
// Rust owns the answer; this asks for it, raises one toast per proposal, and
// holds the proposal the Review dialog is showing.
import { createResource, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { emitWith, TOAST, type ToastEvent } from "./events";
import type { SpaceProject } from "./topicMembers";

export type ProposalValues = {
  setupCommand?: string;
  runCommand?: string;
  teardownCommand?: string;
  ports?: number;
  checks?: string[];
};

export type Proposal =
  | { state: "none" | "untrusted" | "fork" }
  | { state: "unaccepted"; digest: string; content: string; values: ProposalValues; previous: string | null }
  | { state: "declined"; digest: string; content: string; values: ProposalValues }
  | { state: "accepted"; digest: string; values: ProposalValues };

export type Reviewing = {
  worktree: string;
  proposal: Extract<Proposal, { state: "unaccepted" | "declined" }>;
};

const [reviewing, setReviewing] = createSignal<Reviewing | null>(null);
export { reviewing };

const askedThisLaunch = new Set<string>();
const toastedDigests = new Set<string>();

function toastError(e: unknown) {
  emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
}

export function proposalFor(worktree: string): Promise<Proposal> {
  return invoke<Proposal>("proposal_for", { worktree });
}

export type Answered = { worktree: string; proposal: Proposal };

export const projectFolders = (project: SpaceProject) => [
  ...new Set([project.path, ...(project.branchUnits ?? []).map((u) => u.folderPath)]),
];

export function createProposals(project: () => SpaceProject) {
  const [answered, { refetch }] = createResource(
    () => projectFolders(project()),
    async (paths) => {
      const answers = await Promise.all(
        paths.map((worktree) =>
          proposalFor(worktree).then(
            (proposal): Answered => ({ worktree, proposal }),
            (e) => {
              console.warn("proposal_for failed", worktree, e);
              return null;
            },
          ),
        ),
      );
      return answers.filter((a): a is Answered => a !== null);
    },
  );
  onMount(() => {
    const off = listen("proposals://changed", () => void refetch());
    onCleanup(() => void off.then((stop) => stop()));
  });
  return answered;
}

export type RepoValue<T> = { value: T; worktrees: string[] };

export function repoValues<K extends keyof ProposalValues>(
  answered: readonly Answered[] | undefined,
  key: K,
): RepoValue<NonNullable<ProposalValues[K]>>[] {
  const byValue = new Map<string, RepoValue<NonNullable<ProposalValues[K]>>>();
  for (const { worktree, proposal } of answered ?? []) {
    if (proposal.state !== "accepted") continue;
    const value = proposal.values[key];
    if (value === undefined || (Array.isArray(value) && !value.length)) continue;
    const id = JSON.stringify(value);
    const seen = byValue.get(id);
    if (seen) seen.worktrees.push(worktree);
    else byValue.set(id, { value: value as NonNullable<ProposalValues[K]>, worktrees: [worktree] });
  }
  return [...byValue.values()];
}

export async function openReview(worktree: string): Promise<void> {
  const proposal = await proposalFor(worktree);
  if (proposal.state === "unaccepted" || proposal.state === "declined") setReviewing({ worktree, proposal });
}

export const closeReview = () => setReviewing(null);

// Asked once per worktree per launch, so a warm switch adds no call to its budget.
// A declined proposal never toasts; it waits in the project's Tooling section.
export async function noticeProposal(worktree: string): Promise<void> {
  if (askedThisLaunch.has(worktree)) return;
  askedThisLaunch.add(worktree);
  let proposal: Proposal;
  try {
    proposal = await proposalFor(worktree);
  } catch (e) {
    askedThisLaunch.delete(worktree);
    console.warn("proposal_for failed", worktree, e);
    return;
  }
  if (proposal?.state !== "unaccepted" || toastedDigests.has(proposal.digest)) return;
  toastedDigests.add(proposal.digest);
  emitWith<ToastEvent>(TOAST, {
    message: "This repo proposes commands for its worktrees. Nothing from it runs until you accept it.",
    kind: "info",
    action: { label: "Review", run: () => void openReview(worktree).catch(toastError) },
  });
}

export async function acceptProposal(worktree: string, digest: string): Promise<void> {
  let setup: "user" | "repo" | null;
  try {
    setup = await invoke<"user" | "repo" | null>("accept_proposal", { worktree, digest });
  } catch (e) {
    toastError(e);
    return;
  }
  if (setup !== "repo") return;
  emitWith<ToastEvent>(TOAST, {
    message: "Accepted. Run its setup in this worktree now?",
    kind: "info",
    action: { label: "Run setup now", run: () => void rerunSetup(worktree) },
  });
}

export async function declineProposal(worktree: string, digest: string): Promise<void> {
  try {
    await invoke("decline_proposal", { worktree, digest });
  } catch (e) {
    toastError(e);
  }
}

export async function rerunSetup(worktree: string): Promise<void> {
  try {
    await invoke("setup_rerun", { worktreePath: worktree });
  } catch (e) {
    toastError(e);
  }
}

import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";

import Button from "../../components/Button/Button";
import { acceptProposal, openReview, proposalFor, type Proposal } from "../../utils/proposals";
import type { SpaceProject } from "../../utils/topicMembers";
import { Row, Section } from "./Section";

type Waiting = { worktree: string; proposal: Extract<Proposal, { state: "unaccepted" | "declined" }> };

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The worktrees whose `.tori/project.json` is not accepted. A declined one
 *  never toasts again, so this is where it can still be accepted. */
export default function ProposalsSection(props: { project: SpaceProject }) {
  const folders = () => [
    ...new Set([props.project.path, ...(props.project.branchUnits ?? []).map((u) => u.folderPath)]),
  ];
  const [waiting, { refetch }] = createResource(folders, async (paths) => {
    const answers = await Promise.all(
      paths.map((worktree) =>
        proposalFor(worktree).then(
          (proposal) => ({ worktree, proposal }),
          (e) => {
            console.warn("proposal_for failed", worktree, e);
            return null;
          },
        ),
      ),
    );
    return answers.filter((a): a is Waiting => a?.proposal.state === "unaccepted" || a?.proposal.state === "declined");
  });
  onMount(() => {
    const off = listen("proposals://changed", () => void refetch());
    onCleanup(() => void off.then((stop) => stop()));
  });

  return (
    <Show when={waiting()?.length}>
      <Section heading="Repo proposals">
        <For each={waiting()}>
          {(w) => (
            <Row
              label={nameOf(w.worktree)}
              hint={
                w.proposal.state === "declined"
                  ? "You declined this .tori/project.json. Nothing from it runs."
                  : "This .tori/project.json is waiting for an answer. Nothing from it runs yet."
              }
            >
              <Button onClick={() => void openReview(w.worktree)}>Review</Button>
              <Show when={w.proposal.state === "declined"}>
                <Button variant="primary" onClick={() => void acceptProposal(w.worktree, w.proposal.digest)}>
                  Accept
                </Button>
              </Show>
            </Row>
          )}
        </For>
      </Section>
    </Show>
  );
}

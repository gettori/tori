import { For, Show } from "solid-js";

import Button from "../../components/Button/Button";
import { acceptProposal, openReview, type Answered, type Proposal } from "../../utils/proposals";
import { Row, Section } from "./Section";

type Waiting = { worktree: string; proposal: Extract<Proposal, { state: "unaccepted" | "declined" }> };

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The worktrees whose `.tori/project.json` is not accepted. A declined one
 *  never toasts again, so this is where it can still be accepted. */
export default function ProposalsSection(props: { answered: Answered[] | undefined }) {
  const waiting = () =>
    (props.answered ?? []).filter(
      (a): a is Waiting => a.proposal.state === "unaccepted" || a.proposal.state === "declined",
    );

  return (
    <Show when={waiting().length}>
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

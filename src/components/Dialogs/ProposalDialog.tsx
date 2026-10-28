import { For, Show } from "solid-js";
import styles from "./ProposalDialog.module.css";
import dialogs from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import { lineDiff } from "../../panels/Chat/toolDiff";
import {
  acceptProposal,
  closeReview,
  declineProposal,
  reviewing,
  type ProposalValues,
  type Reviewing,
} from "../../utils/proposals";

const FIELDS: [keyof ProposalValues, string][] = [
  ["setupCommand", "Setup"],
  ["runCommand", "Run"],
  ["teardownCommand", "Teardown"],
  ["ports", "Ports"],
  ["checks", "Checks"],
];

const shown = (value: ProposalValues[keyof ProposalValues]) =>
  Array.isArray(value) ? value.join(", ") : String(value);

const MARK = { add: "+ ", del: "- ", ctx: "  " } as const;

function Body(props: { review: Reviewing }) {
  const proposal = () => props.review.proposal;
  const previous = () =>
    proposal().state === "unaccepted" ? (proposal() as { previous: string | null }).previous : null;
  return (
    <>
      <div class={dialogs.msg}>
        <Show
          when={previous()}
          fallback="This worktree's .tori/project.json proposes these. Nothing from it runs until you accept."
        >
          The repo changed what it proposes since you last accepted. Nothing from the new version runs until you accept
          it.
        </Show>
      </div>
      <dl class={styles.fields}>
        <For each={FIELDS.filter(([key]) => proposal().values[key] !== undefined)}>
          {([key, name]) => (
            <>
              <dt class={styles.name}>{name}</dt>
              <dd class={styles.value}>{shown(proposal().values[key])}</dd>
            </>
          )}
        </For>
      </dl>
      <pre class={styles.diff} data-proposal-diff>
        <For each={lineDiff(previous() ?? "", proposal().content)}>
          {(row) => (
            <div class={`${styles.line} ${row.kind === "ctx" ? "" : styles[row.kind]}`} data-kind={row.kind}>
              {MARK[row.kind]}
              {row.text}
            </div>
          )}
        </For>
      </pre>
    </>
  );
}

// Keyed, so a second Review replaces the first with its own focus restore.
export default function ProposalDialog() {
  return (
    <Show when={reviewing()} keyed>
      {(review) => {
        let decline: HTMLButtonElement | undefined;
        const answer = (accept: boolean) => {
          const { worktree, proposal } = review;
          closeReview();
          if (accept) void acceptProposal(worktree, proposal.digest);
          else void declineProposal(worktree, proposal.digest);
        };
        return (
          <Dialog
            open
            size="wide"
            title="Repo proposal"
            onClose={closeReview}
            initialFocus={() => decline}
            actions={
              <>
                <Show when={review.proposal.state === "unaccepted"}>
                  <Button ref={decline} onClick={() => answer(false)}>
                    Decline
                  </Button>
                </Show>
                <Button variant="primary" onClick={() => answer(true)}>
                  Accept
                </Button>
              </>
            }
          >
            <Body review={review} />
          </Dialog>
        );
      }}
    </Show>
  );
}

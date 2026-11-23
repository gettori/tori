import { createSignal, For, Show, untrack } from "solid-js";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Select from "../Select/Select";
import { forgeAccountName, type ForgeAccount } from "../../utils/forgeTypes";
import styles from "./Dialogs.module.css";

export type RemovalChoice = { accountId: string | null; author: string | null; unread: boolean; preselected: boolean };
export type Removal = { remote: string; projects: string[]; choices: RemovalChoice[] };

const NONE = "";
const folderName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

export default function RemoveAccountDialog(props: {
  account: ForgeAccount;
  host: string;
  others: ForgeAccount[];
  removals: Removal[];
  busy: boolean;
  onConfirm: (moves: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const initial = untrack(() =>
    Object.fromEntries(props.removals.map((r) => [r.remote, r.choices.find((c) => c.preselected)?.accountId ?? NONE])),
  );
  const [chosen, setChosen] = createSignal<Record<string, string>>(initial);

  const name = (id: string | null) => {
    const account = props.others.find((a) => a.id === id);
    return account ? forgeAccountName(account) : "No account";
  };
  const choiceOf = (r: Removal) => r.choices.find((c) => (c.accountId ?? NONE) === chosen()[r.remote]) ?? null;
  const ready = () => props.removals.every((r) => choiceOf(r) !== null);
  const confirm = () => {
    const moves = Object.fromEntries(Object.entries(chosen()).filter(([, id]) => id !== NONE));
    props.onConfirm(moves);
  };

  return (
    <Dialog
      open
      title={`Remove ${forgeAccountName(props.account)} from ${props.host}?`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="danger" disabled={props.busy || !ready()} onClick={confirm}>
            {props.busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.spaceHelp}>
          Tori deletes the token it stored for this account. These projects use it, so choose where each goes.
        </div>
        <For each={props.removals}>
          {(r) => (
            <div class={styles.spaceField}>
              <span class={styles.spaceLabel}>{r.projects.map(folderName).join(", ")}</span>
              <Select
                aria-label={`Account for ${r.projects.map(folderName).join(", ")} after removal`}
                placeholder="Pick an account"
                options={r.choices.map((c) => ({ value: c.accountId ?? NONE, label: name(c.accountId) }))}
                value={chosen()[r.remote] ?? NONE}
                onChange={(id) => setChosen({ ...chosen(), [r.remote]: id })}
              />
              <Show when={choiceOf(r)}>
                {(c) => (
                  <div class={styles.spaceHelp}>
                    {c().unread
                      ? "Could not read this repo's own author."
                      : c().author
                        ? `Commits as ${c().author}.`
                        : "No author is set, so git will refuse to commit."}
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}

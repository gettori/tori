import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { Check, Cloud, GitCommitHorizontal, Plus, RefreshCw, Trash2 } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Combobox, { type ComboboxOption } from "../Combobox/Combobox";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";

/** Where the chosen branch is, which is what says how to add it: a local one is
 *  attached, a remote-only one is tracked, and a name that is neither is made. */
export type BranchKind = "local" | "remote" | "new";
export type BranchPick = { name: string; kind: BranchKind };

/** The folder a worktree for `branch` would get, matching `pick_worktree_folder`
 *  on the Rust side: the branch's last segment. That name can already be taken,
 *  in which case the backend falls back to a slug of the whole branch and this
 *  preview is one folder off - a case it reports rather than guesses at. */
export function worktreeFolder(branch: string): string {
  const parts = branch.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : branch;
}

/**
 * Pick or create a branch, for both the menu rows that do it: a plain repo
 * attaches one, a bare container opens a worktree for it.
 *
 * **A name that matches nothing gets a row of its own.** It used to be a silent
 * property of Ok, so the same keystroke either attached an existing branch or
 * created a new one and nothing on screen said which. The create row is what
 * makes that visible, and it is the only entry here that writes a new ref.
 *
 * **Local and remote are one list, told apart by their glyph.** Two lists would
 * put the same name in two places whenever a remote had been fetched, and the
 * question ("which branch") has one answer either way. A remote a local already
 * covers is simply the local one.
 *
 * **The list is what is on disk, and the network is a button.** Remote branches
 * are read out of `refs/remotes` when the dialog opens, which is a ref read and
 * costs milliseconds; they used to arrive only with a fetch this dialog fired
 * on every open, so the picker waited on the network for refs it already had,
 * and showed none at all when that fetch failed. The header's Fetch is for the
 * branch that is genuinely newer than the last sweep.
 *
 * **A branch nothing is standing on can be deleted from its own row.** The
 * trash is a pointer affordance: a row is an `option`, and a focusable control
 * inside one is both an ARIA violation and unreachable anyway, since the caret
 * never leaves the filter. It shows on the row under the pointer and on the
 * parked row, and on nothing else - the active row is seeded on the first entry
 * before anybody has pressed a key, so keying it to that put a trash on a row
 * nobody had touched. Rows the tree already has open carry their tag instead,
 * because git refuses to delete a branch that is checked out and an affordance
 * that always fails is worse than none.
 *
 * **The fetch is reported in the list header, not in the title.** Appended to
 * the title (`Branch Name · fetching…`) it reflowed the dialog's own heading the
 * moment the fetch landed. It is a fact about the list, so it sits on the list.
 *
 * **Picking is a state, confirming is a button.** A row press parks the choice
 * and the action bar shows where it would land; a second press on the same row,
 * or the primary, commits it. The shared `Combobox` draws the parked row, which
 * is what `picked` is for there.
 *
 * The shell is `Dialog`. Escape is Kobalte's, reported as `onClose`.
 */
export default function AddBranchDialog(props: {
  /** "branch" attaches to a plain repo, "worktree" opens a folder off a bare
   *  container. Only the nouns and the path preview differ. */
  mode: "branch" | "worktree";
  projectName: string;
  /** The container a worktree would land in, already folded to `~` by the
   *  caller, which is the half of this that knows the home directory. */
  projectPath: string;
  locals: string[];
  /** Remote-only short names, with no `origin/` prefix. */
  remotes: string[];
  /** Branches the tree already has open, listed but not an answer to this
   *  question. */
  taken: string[];
  /** A fetch this dialog asked for is still running. */
  fetching: boolean;
  /** Go and look at the remote now. Withheld when the container has no origin,
   *  which is what hides the button: there is nowhere for it to look. */
  onFetch?: () => void;
  /** The branch whose delete is waiting to be confirmed. `unpushed` is null
   *  until the backend answers, and the strip says so rather than guessing. */
  deleting?: { branch: string; unpushed: boolean | null; busy: boolean } | null;
  /** Ask about deleting `branch`. Withheld by a caller that cannot delete,
   *  which is what hides every trash on the list. */
  onDeleteAsk?: (branch: string) => void;
  onDeleteConfirm?: () => void;
  onDeleteCancel?: () => void;
  busy: boolean;
  /** The branch the dialog opens on: in the filter, and picked where the list
   *  has it. A caller outside the tree knows where the user is standing, and
   *  that is the row the answer is usually next to. */
  prefill?: string;
  onConfirm: (pick: BranchPick) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal(props.prefill ?? "");
  const [picked, setPicked] = createSignal<BranchPick | null>(
    props.prefill && props.locals.includes(props.prefill)
      ? { name: props.prefill, kind: "local" }
      : null,
  );
  let input: HTMLInputElement | undefined;
  let primary: HTMLButtonElement | undefined;
  let deleteButton: HTMLButtonElement | undefined;

  const taken = createMemo(() => new Set(props.taken));
  const entries = createMemo<BranchPick[]>(() => {
    const locals = new Set(props.locals);
    return [
      ...props.locals.map((name) => ({ name, kind: "local" as const })),
      ...props.remotes.filter((n) => !locals.has(n)).map((name) => ({ name, kind: "remote" as const })),
    ];
  });

  // Substring and case-insensitive, which is what a branch filter is: fuzzy
  // ranking over `feat/x` and `fix/x` puts the one you did not mean first as
  // often as not, and the names here are short enough to type through.
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? entries().filter((e) => e.name.toLowerCase().includes(q)) : entries();
  });
  const options = createMemo<ComboboxOption[]>(() =>
    matches().map((e) => ({ value: e.name, label: e.name, disabled: taken().has(e.name) })),
  );
  const kinds = createMemo(() => new Map(entries().map((e) => [e.name, e.kind])));

  // Local, and nothing standing on it. A remote-only row has no local ref to
  // delete, and git refuses a branch that is checked out anywhere.
  const deletable = (name: string) =>
    !!props.onDeleteAsk && kinds().get(name) === "local" && !taken().has(name);

  // A parked row the list no longer has - its branch was just deleted - is not
  // an answer to anything.
  createEffect(() => {
    const parked = picked();
    if (parked && !entries().some((e) => e.name === parked.name)) setPicked(null);
  });

  const heading = () => {
    if (query().trim()) return `${matches().length} matching`;
    const remote = entries().filter((e) => e.kind === "remote").length;
    return `${props.locals.length} local, ${remote} remote`;
  };

  // A name nothing matches exactly. Exactly, not "nothing matched at all":
  // typing `main` while `maintenance` is listed is still a request for `main`,
  // and a create row is the only thing that would say so.
  const newName = () => {
    const q = query().trim();
    return q && !entries().some((e) => e.name === q) ? q : null;
  };

  // The parked row, or the typed name when there is no row to park on. Typing
  // clears the park, so the two can never both be live.
  const choice = (): BranchPick | null => {
    const parked = picked();
    if (parked) return parked;
    const fresh = newName();
    return fresh ? { name: fresh, kind: "new" } : null;
  };

  /** The row drawn as chosen, which is a row and never a typed new name. A
   *  memo, so the effect below fires on the choice changing rather than on
   *  every keystroke and every list that lands. */
  const parked = createMemo(() => (choice()?.kind === "new" ? null : (choice()?.name ?? null)));

  // Picking answers the list's question, so the next thing to press is the one
  // that commits it. Kobalte hands the filter its focus back as part of
  // selecting, which is right for a palette that commits on the press and wrong
  // for a dialog whose confirm is a button. Solid flushes this effect inside
  // the `setPicked` that triggered it, which is still before that, so the move
  // waits for the press to finish being handled - otherwise the two take turns
  // and the primitive has the last one. Deferred, because a row the dialog
  // *opened* on is not a pick: a `prefill` parks one before anybody has pressed
  // anything, and someone about to type a new name wants the filter.
  createEffect(
    on(
      parked,
      (name) => {
        if (!name) return;
        queueMicrotask(() => {
          if (parked()) primary?.focus();
        });
      },
      { defer: true },
    ),
  );

  // Where the branch is, until it is the one you picked: then the glyph's job
  // is to say so, and where it came from is already settled.
  const glyphFor = (name: string) => {
    if (parked() === name) return Check;
    return kinds().get(name) === "remote" ? Cloud : GitCommitHorizontal;
  };

  const landing = () => {
    const pick = choice();
    return pick ? `${props.projectPath}/${worktreeFolder(pick.name)}` : "";
  };

  // A pick the tree already has open. Reachable only through `prefill`: every
  // other route is a row press, and `Combobox` refuses a disabled row.
  const already = () => {
    const pick = choice();
    return !!pick && pick.kind !== "new" && taken().has(pick.name);
  };

  const confirm = () => {
    const pick = choice();
    if (props.busy || !pick || already()) return;
    props.onConfirm(pick);
  };

  // A confirmation nobody can answer is worse than none: the press that armed
  // this was a mouse on a row, so the answer has to come to the keyboard.
  createEffect(() => {
    if (props.deleting) deleteButton?.focus();
  });

  // A row press parks the choice; pressing the row that is already parked is
  // the second half of a double-click, and means "this one, go".
  const press = (name: string) => {
    if (picked()?.name === name) return confirm();
    setPicked({ name, kind: kinds().get(name) ?? "local" });
  };

  // Enter with nothing listed, the one key the surface cannot answer: there is
  // no row to commit, so the typed name is the answer. Every other Enter is
  // Kobalte's, and arrives through `onSelect`.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || matches().length) return;
    if (!newName()) return;
    e.preventDefault();
    confirm();
  }

  const noun = () => (props.mode === "worktree" ? "worktree" : "branch");

  return (
    <Dialog
      open
      size="sheet"
      title={`Add ${noun()} in “${props.projectName}”`}
      onClose={() => props.onCancel()}
      initialFocus={() => input}
      actions={
        <>
          {/* Worktree mode only: attaching a branch to a plain repo makes no
              folder, so there would be no path to promise. */}
          <Show when={props.mode === "worktree" && landing()}>
            {(path) => <span class={styles.pathHint}>{path()}</span>}
          </Show>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            ref={(el) => (primary = el)}
            variant="primary"
            disabled={props.busy || !choice() || already()}
            onClick={() => confirm()}
          >
            {props.busy ? "Working…" : `Add ${noun()}`}
          </Button>
        </>
      }
    >
      <Combobox
        class={styles.pickerField}
        listClass={styles.branchList}
        options={options()}
        query={query()}
        onQueryChange={(q) => {
          // Kobalte echoes a value written into the field back as an input
          // change, so without this a prefill would clear the pick it opened on
          // before anybody touched the keyboard.
          if (q === query()) return;
          setQuery(q);
          setPicked(null);
        }}
        onSelect={press}
        onKeyDown={onKeyDown}
        picked={parked()}
        inputRef={(el) => (input = el)}
        placeholder="Filter branches, or type a new name"
        aria-label="Filter branches, or type a new name"
        listLabel="Branches"
        emptyLabel="No branch matches"
        itemComponent={(option) => (
          <>
            <Icon
              icon={glyphFor(option.value)}
              class={styles.branchGlyph}
              classList={{ [styles.branchGlyphPicked]: parked() === option.value }}
              aria-hidden="true"
            />
            <span class={styles.branchName}>{option.label}</span>
            <Show when={taken().has(option.value)}>
              <span class={styles.branchTag}>
                {props.mode === "worktree" ? "in a worktree" : "checked out"}
              </span>
            </Show>
            <Show when={deletable(option.value)}>
              {/* Not a button: see the note about `option` above. Hidden from
                  the accessibility tree because the header carries the same
                  action for everyone who is not holding a mouse. */}
              <span
                class={styles.branchDelete}
                aria-hidden="true"
                onClick={(e) => {
                  // The row's own click commits a pick, and this is not one.
                  e.stopPropagation();
                  props.onDeleteAsk?.(option.value);
                }}
              >
                <Icon icon={Trash2} />
              </span>
            </Show>
          </>
        )}
        aboveList={
          <>
            {/* Not while a row is parked: the row is the choice then, and two
                things painted as chosen is one too many. */}
            <Show when={!picked() && newName()}>
              {(name) => (
                <div class={styles.createRow}>
                  <Icon icon={Plus} aria-hidden="true" />
                  <span class={styles.createLead}>Create branch</span>
                  <span class={styles.createName}>{name()}</span>
                </div>
              )}
            </Show>
            {/* One at a time, and in front of the create row: a delete waiting
                for an answer is the only thing on this surface that can lose
                work. */}
            <Show when={props.deleting}>
              {(del) => (
                <div class={styles.deleteRow} role="group" aria-label={`Delete ${del().branch}`}>
                  <Icon icon={Trash2} aria-hidden="true" />
                  <span class={styles.createLead}>Delete branch</span>
                  <span class={styles.createName}>{del().branch}</span>
                  <span class={styles.deleteState}>
                    {del().unpushed === null
                      ? "checking…"
                      : del().unpushed
                        ? "has commits the remote does not"
                        : "pushed"}
                  </span>
                  <Button size="xs" onClick={() => props.onDeleteCancel?.()}>
                    Cancel
                  </Button>
                  <Button
                    ref={(el) => (deleteButton = el)}
                    size="xs"
                    variant="danger"
                    disabled={del().busy}
                    onClick={() => props.onDeleteConfirm?.()}
                  >
                    {del().busy ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              )}
            </Show>
            <div class={styles.listHead}>
              <span>{heading()}</span>
              <Show when={props.fetching}>
                <span class={styles.fetching}>
                  <span class={styles.fetchDot} aria-hidden="true" />
                  fetching remote…
                </span>
              </Show>
              <Show when={props.onFetch}>
                <IconButton
                  class={styles.listHeadAction}
                  size="sm"
                  icon={<Icon icon={RefreshCw} />}
                  tooltip="Fetch branches from the remote"
                  disabled={props.fetching}
                  onClick={() => props.onFetch?.()}
                />
              </Show>
            </div>
          </>
        }
      />
    </Dialog>
  );
}

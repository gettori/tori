import { createMemo, createSignal, Show } from "solid-js";
import { Cloud, GitCommitHorizontal, Plus } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Combobox, { type ComboboxOption } from "../Combobox/Combobox";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";

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
  /** Remote refs are still arriving. */
  fetching: boolean;
  busy: boolean;
  onConfirm: (pick: BranchPick) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [picked, setPicked] = createSignal<BranchPick | null>(null);
  let input: HTMLInputElement | undefined;

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

  const landing = () => {
    const pick = choice();
    return pick ? `${props.projectPath}/${worktreeFolder(pick.name)}` : "";
  };

  const confirm = () => {
    const pick = choice();
    if (props.busy || !pick) return;
    props.onConfirm(pick);
  };

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
            variant="primary"
            disabled={props.busy || !choice()}
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
          setQuery(q);
          setPicked(null);
        }}
        onSelect={press}
        onKeyDown={onKeyDown}
        picked={choice()?.kind === "new" ? null : (choice()?.name ?? null)}
        inputRef={(el) => (input = el)}
        placeholder="Filter branches, or type a new name"
        aria-label="Filter branches, or type a new name"
        listLabel="Branches"
        emptyLabel="No branch matches"
        itemComponent={(option) => (
          <>
            <Icon
              icon={kinds().get(option.value) === "remote" ? Cloud : GitCommitHorizontal}
              class={styles.branchGlyph}
              aria-hidden="true"
            />
            <span class={styles.branchName}>{option.label}</span>
            <Show when={taken().has(option.value)}>
              <span class={styles.branchTag}>
                {props.mode === "worktree" ? "in a worktree" : "checked out"}
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
            <div class={styles.listHead}>
              <span>{heading()}</span>
              <Show when={props.fetching}>
                <span class={styles.fetching}>
                  <span class={styles.fetchDot} aria-hidden="true" />
                  fetching remote…
                </span>
              </Show>
            </div>
          </>
        }
      />
    </Dialog>
  );
}

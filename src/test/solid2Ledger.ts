export type IdiomClass =
  | "batch"
  | "boolean-attr"
  | "camelcase-attr"
  | "cleanup-in-ref"
  | "destructured-props"
  | "effect-in-handler"
  | "effect-writes"
  | "function-signal"
  | "handler-ternary"
  | "lowercase-on"
  | "nested-root"
  | "on-namespace"
  | "onmount-primitive"
  | "read-after-write"
  | "timing"
  | "top-prop-read"
  | "use-directive";

export interface LedgerEntry {
  file: string;
  count: number;
  reason: string;
}

export const ENFORCED: readonly IdiomClass[] = [
  "boolean-attr",
  "destructured-props",
  "lowercase-on",
  "on-namespace",
  "use-directive",
];

export const LEDGER: Partial<Record<IdiomClass, readonly LedgerEntry[]>> = {
  "boolean-attr": [
    {
      file: "src/components/IconButton/IconButton.tsx",
      count: 1,
      reason:
        "merges an explicit aria-pressed with active in an accessor that returns strings; written inline, the compiler wraps the nested ternary in memos and the tab switch row gains 4 runs",
    },
  ],
  "effect-writes": [
    {
      file: "src/panels/Editor/CheckpointDiffView.tsx",
      count: 1,
      reason: "fetches a diff behind a supersede token; 2.0: async createMemo keyed on workspace and target",
    },
    {
      file: "src/panels/Editor/CheckpointTimeline.tsx",
      count: 4,
      reason:
        "open is user picked and closes on a scope change or a pruned checkpoint, and a reveal request is consumed once; a memo would reopen a target that comes back; 2.0: createSignal(fn) for open and expanded, createEffect(compute, apply) for the reveal",
    },
    {
      file: "src/panels/Editor/CommitDetail.tsx",
      count: 1,
      reason: "fetches commit detail behind a supersede token; 2.0: async createMemo keyed on workspace and sha",
    },
    {
      file: "src/panels/Editor/CommitDiffView.tsx",
      count: 1,
      reason: "two step fetch behind a supersede token; 2.0: async createMemo keyed on workspace and target",
    },
    {
      file: "src/panels/Editor/ConflictView.tsx",
      count: 3,
      reason:
        "the current conflict is user picked and is null during a reload, so a memo would act on a stale region; the Result pane is a CodeMirror instance; syntax loads async; 2.0: createSignal(fn) for the pick, createEffect(compute, apply) for the pane, async createMemo for syntax",
    },
    {
      file: "src/panels/Editor/DiffView.tsx",
      count: 4,
      reason:
        "picked is a user selection reset on a new diff, the others run reloads and a blame fetch; 2.0: createSignal(fn) for picked, createEffect(compute, apply) for the reloads, async createMemo for blame",
    },
    {
      file: "src/panels/Editor/Editor.tsx",
      count: 5,
      reason:
        "a ResizeObserver, a right mode the user also sets, a pending open consumed once, the workspace switch work and a session reset with refetches; a memo on right mode would restore the old tab on leaving a chat; 2.0: createSignal(fn) for right mode, createEffect(compute, apply) for the rest",
    },
    {
      file: "src/panels/Editor/FileTree/FileTree.tsx",
      count: 3,
      reason:
        "row open state the user toggles, a reveal walk that scrolls and reports back, and a filter and selection reset on a new root; 2.0: createSignal(fn) for the resets, createEffect(compute, apply) for the reveal",
    },
    {
      file: "src/panels/Editor/FilesPanel/FilesPanel.tsx",
      count: 2,
      reason: "resets a user pick and a typed filter on a new root; 2.0: createSignal(fn) keyed on the root",
    },
    {
      file: "src/panels/Editor/GraphSection.tsx",
      count: 1,
      reason: "fetches the log and resets the open rows; 2.0: async createMemo for entries, createSignal(fn) for open",
    },
    {
      file: "src/panels/Editor/GraphView.tsx",
      count: 2,
      reason:
        "fetches the base branch, and resets open rows then pages the log; 2.0: async createMemo for the base, createSignal(fn) for open, createEffect(compute, apply) for the load",
    },
    {
      file: "src/panels/Editor/LocalHistory.tsx",
      count: 1,
      reason:
        "resets a user pick and reloads on a new file; 2.0: createSignal(fn) for picked, async createMemo for the list",
    },
    {
      file: "src/panels/Editor/MarkdownDocument.tsx",
      count: 1,
      reason:
        "renders in frame sliced steps and cancels on change; 2.0: createEffect(compute, apply) owning the frame job",
    },
    {
      file: "src/panels/Editor/PdfView.tsx",
      count: 3,
      reason:
        "a debounced repaint scale and two writes to the per path view store; 2.0: createEffect(compute, apply) for all three",
    },
    {
      file: "src/panels/Editor/PullRequests/PrFileBody.tsx",
      count: 2,
      reason: "resets a user pick and fetches blob sizes; 2.0: createSignal(fn) for picked, async createMemo for sizes",
    },
    {
      file: "src/panels/Editor/PullRequests/PullsPanel.tsx",
      count: 3,
      reason:
        "forge reads behind a supersede token, a viewing pointer in a shared store, and a merge state reset; 2.0: async createMemo for the reads, createEffect(compute, apply) for the store, createSignal(fn) for the merge state",
    },
    {
      file: "src/panels/Editor/PullRequests/ReviewForm.tsx",
      count: 1,
      reason:
        "drops a late submit and clears its error on a new PR; 2.0: createSignal(fn) for the error, keyed on the PR",
    },
    {
      file: "src/panels/Editor/ReviewPanel.tsx",
      count: 3,
      reason:
        "a member pick the user also sets, a conflict op fetch, and a commit target reset with a refresh; 2.0: createSignal(fn) for the picks, async createMemo for the op, createEffect(compute, apply) for the refresh",
    },
    {
      file: "src/panels/Editor/SearchPanel.tsx",
      count: 4,
      reason:
        "resets typed search state on a workspace change, debounces the replace preview, retires an outcome, and applies a scope request once; 2.0: createSignal(fn) for the resets, createEffect(compute, apply) for the preview and the scope",
    },
    {
      file: "src/panels/Editor/SessionPanel.tsx",
      count: 1,
      reason:
        "resets expanded rows and refetches on a new session; 2.0: createSignal(fn) for the rows, createEffect(compute, apply) for the refetch",
    },
    {
      file: "src/panels/Editor/TodoPanel.tsx",
      count: 1,
      reason:
        "clears user picked tags and rescans on new roots or patterns; 2.0: createSignal(fn) for the tags, createEffect(compute, apply) for the scan",
    },
  ],
};

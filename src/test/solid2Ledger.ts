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
    {
      file: "src/components/Autopilot/Horizon.tsx",
      count: 1,
      reason: "cross fades scene layers on a timer; 2.0: createEffect(compute, apply) returning the timer cleanup",
    },
    {
      file: "src/components/Diagram/Diagram.tsx",
      count: 1,
      reason: "an IntersectionObserver writes visibility; 2.0: createEffect(compute, apply) returning the disconnect",
    },
    {
      file: "src/components/Dialogs/AddBranchDialog.tsx",
      count: 2,
      reason:
        "an async ahead check, and a user pick dropped when its branch leaves the list; a memo would restore the pick if the branch came back; 2.0: async createMemo for ahead, createSignal(fn) for the pick",
    },
    {
      file: "src/components/Dialogs/AskpassDialog.tsx",
      count: 1,
      reason:
        "clears a typed secret and focuses for each prompt; 2.0: createSignal(fn) for the value, createEffect(compute, apply) for focus",
    },
    {
      file: "src/components/Dialogs/AttachFolderDialog.tsx",
      count: 1,
      reason:
        "inspects a folder, seeds an editable name and delays a reading hint; 2.0: createEffect(compute, apply) with the timer cleanup",
    },
    {
      file: "src/components/Dialogs/CloneAccount.tsx",
      count: 1,
      reason: "debounced forge lookups keyed on the URL; 2.0: createEffect(compute, apply) with the timer cleanup",
    },
    {
      file: "src/components/Dialogs/MoveIntoSpace.tsx",
      count: 2,
      reason:
        "inspects a folder and seeds editable fields, and runs a move check; 2.0: createEffect(compute, apply) for the inspect, async createMemo for the check",
    },
    {
      file: "src/components/Dialogs/NewTopicDialog.tsx",
      count: 1,
      reason: "debounces a stale branch probe; 2.0: createEffect(compute, apply) with the timer cleanup",
    },
    {
      file: "src/components/Menu/menuCore.tsx",
      count: 1,
      reason: "opens a native layer once and links the parent menu; 2.0: onSettled returning the release",
    },
    {
      file: "src/components/Omnibox/Omnibox.tsx",
      count: 6,
      reason:
        "three one shot lazy loads, a workspace search, a theme preview, and an arrow flag reset on typing; 2.0: createEffect(compute, apply) for the loads, search and preview, createSignal(fn) for the flag",
    },
    {
      file: "src/components/OverflowTabBar.tsx",
      count: 1,
      reason:
        "closes a user opened menu when overflow empties; a memo would reopen it when tabs overflow again; 2.0: createSignal(fn)",
    },
    {
      file: "src/components/ProjectIconPicker/ProjectIconPicker.tsx",
      count: 1,
      reason: "resets an editable draft when the stored icon changes; 2.0: createSignal(fn) for each draft field",
    },
    {
      file: "src/components/Select/Select.tsx",
      count: 1,
      reason: "opens a native layer once and moves focus; 2.0: onSettled returning the release",
    },
    {
      file: "src/components/SyncChip/SyncChip.tsx",
      count: 1,
      reason: "fetches the conflict op; 2.0: async createMemo keyed on the stop state",
    },
    {
      file: "src/components/Tab/Tabs.tsx",
      count: 1,
      reason:
        "falls back when the selected tab goes, notifies the owner and moves focus; 2.0: createEffect(compute, apply)",
    },
    {
      file: "src/components/Toasts/Toasts.tsx",
      count: 2,
      reason: "removes a toast after its exit and runs its dismiss timer; 2.0: createEffect(compute, apply) for both",
    },
    {
      file: "src/components/UsageStrip/UsageCard.tsx",
      count: 1,
      reason: "resets a user pick on a new profile; 2.0: createSignal(fn) keyed on the profile",
    },
    {
      file: "src/panels/Chat/ChatDraft.tsx",
      count: 2,
      reason:
        "seeds and prunes the draft's pick in a store keyed by tab, which the user also edits; 2.0: createEffect(compute, apply) for both",
    },
    {
      file: "src/panels/Chat/ChatView.tsx",
      count: 6,
      reason:
        "connects once, applies the opening pick, sends a held message, scrolls to a pending card, publishes the live chat, and restores the composer when a queued edit goes; 2.0: createEffect(compute, apply) for all six",
    },
    {
      file: "src/panels/Chat/Composer.tsx",
      count: 2,
      reason:
        "clamps a stash cursor the keyboard and mouse also move, and resets history and focuses on an edit; a memo would jump back when rows return; 2.0: createSignal(fn) for the cursor, createEffect(compute, apply) for focus",
    },
    {
      file: "src/panels/Chat/LaneStrip.tsx",
      count: 1,
      reason:
        "runs a clock while anything is running; 2.0: createEffect(compute, apply) returning the interval cleanup",
    },
    {
      file: "src/panels/Chat/Markdown.tsx",
      count: 1,
      reason: "throttles streamed text to one write per frame; 2.0: createEffect(compute, apply) owning the frame",
    },
    {
      file: "src/panels/Chat/MessageList.tsx",
      count: 3,
      reason:
        "ends a history load, repins on a sent prompt, and opens a held group on a reveal the user can close again; 2.0: createEffect(compute, apply) for the first two, createSignal(fn) for open",
    },
    {
      file: "src/panels/Chat/StatusStrip.tsx",
      count: 2,
      reason:
        "runs an elapsed timer and a document listener that closes the menu; 2.0: createEffect(compute, apply) returning each cleanup",
    },
    {
      file: "src/panels/Chat/ToolCallCard.tsx",
      count: 1,
      reason: "opens on a reveal, and the user can close it again; 2.0: createSignal(fn) reading the previous value",
    },
  ],
};

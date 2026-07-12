import { createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

export type NewProjectMode = "folder" | "clone" | "bare";

// Create something under a group, in one dialog. Replaces the separate "New
// folder", "Clone repo…" and "Bare + worktree…" group-menu items: a segmented
// control picks the mode, a Name field is always shown, and a URL field appears
// only for clone/bare (auto-filling the name from the URL until it is edited by
// hand). Enter confirms, Escape or a backdrop click cancels.
export default function NewProjectDialog(props: {
  groupName: string;
  busy: boolean;
  onConfirm: (opts: { mode: NewProjectMode; name: string; url: string }) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = createSignal<NewProjectMode>("folder");
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  // Track manual name edits so URL auto-fill stops clobbering a hand-typed name.
  const [nameEdited, setNameEdited] = createSignal(false);
  let first: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => first?.focus()));

  const needsUrl = () => mode() !== "folder";
  const nameFromUrl = (u: string) =>
    u.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") ?? "";

  function onUrlInput(v: string) {
    setUrl(v);
    if (!nameEdited()) setName(nameFromUrl(v.trim()));
  }

  const helper = () => {
    switch (mode()) {
      case "folder":
        return "A plain, non-git folder.";
      case "clone":
        return "Clone a git repository into a new folder.";
      case "bare":
        return "A .bare repo with one initial worktree; add more branches as their own folders.";
    }
  };

  const canConfirm = () => !!name().trim() && (!needsUrl() || !!url().trim());
  const confirm = () => {
    if (!canConfirm()) return;
    props.onConfirm({ mode: mode(), name: name().trim(), url: url().trim() });
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!props.busy) confirm();
    }
  }

  const segs: { key: NewProjectMode; label: string }[] = [
    { key: "folder", label: "Folder" },
    { key: "clone", label: "Clone" },
    { key: "bare", label: "Bare + worktree" },
  ];

  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={() => props.onCancel()}>
        <div class="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class="modal-title">New in “{props.groupName}”</div>

          <div class="seg" role="group" aria-label="What to create">
            <For each={segs}>
              {(s) => (
                <button
                  type="button"
                  class="seg-btn"
                  classList={{ active: mode() === s.key }}
                  aria-pressed={mode() === s.key}
                  onClick={() => setMode(s.key)}
                >
                  {s.label}
                </button>
              )}
            </For>
          </div>
          <div class="modal-msg">{helper()}</div>

          <Show when={needsUrl()}>
            <div class="modal-label">Repository URL</div>
            <input
              class="modal-input"
              value={url()}
              placeholder="https://…"
              onInput={(e) => onUrlInput(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
          </Show>

          <div class="modal-label">{needsUrl() ? "Folder name" : "Name"}</div>
          <input
            ref={first}
            class="modal-input"
            value={name()}
            placeholder={needsUrl() ? "defaults from the URL" : "folder name"}
            onInput={(e) => {
              setNameEdited(true);
              setName(e.currentTarget.value);
            }}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />

          <div class="modal-actions">
            <button class="modal-btn" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button
              class="modal-btn primary"
              disabled={props.busy || !canConfirm()}
              onClick={() => confirm()}
            >
              {props.busy ? "Working…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

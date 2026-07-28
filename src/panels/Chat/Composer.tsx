import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { ArrowUp, Plus, Square } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import type { QueuedInput } from "./chatStore";
import { checkAttachment, chipLabel, readAsBase64, type PendingBlock } from "../../utils/chatCompose";
import { DRAG_ABS_PATH_MIME, DRAG_PATH_MIME } from "../../utils/events";
import {
  activeToken,
  dropToken,
  moveIndex,
  rank,
  replaceToken,
  type CompletionToken,
} from "../../utils/composerCompletion";
import type { SlashCommand } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/**
 * The input.
 *
 * Enter sends, Shift+Enter is a newline, Escape interrupts a running turn. The
 * send button becomes a stop button while a turn runs, so there is one control
 * in one place rather than two that disagree.
 *
 * Typing during a turn never drops input and never interleaves it into the
 * running turn: it queues, visibly. The strip below the input is the queue, and
 * every entry in it is removable. When the turn was *cancelled* the queue is
 * held rather than flushed (see `pendingFlush`), and the strip grows send-now
 * and discard actions, because a turn the user stopped must not fire the
 * messages they stopped it to prevent.
 *
 * Attachments (an editor selection, a hunk comment, a diagnostic) arrive as
 * chips above the input and wait there. They are removable and nothing about
 * their arrival sends anything: [[concept_safe_send]]'s insert-only contract is
 * the same on this surface as on a terminal.
 *
 * `@` completes a project file into an attachment chip and `/` completes a slash
 * command into text. Both run off one recognizer (`composerCompletion`), and
 * while either menu is open it owns Enter, Tab, the arrows and Escape, so a
 * completion is never one keystroke away from sending the half-typed line it
 * was completing.
 */
export default function Composer(props: {
  running: boolean;
  queue: readonly QueuedInput[];
  attachments: readonly PendingBlock[];
  held: boolean;
  disabled: boolean;
  /** This session's real command catalogue, from the `initialize` handshake. */
  commands: readonly SlashCommand[];
  /** The project's file list, fetched on the first `@` and cached here: a chat
   *  that never mentions a file should not pay for the walk. */
  loadFiles: () => Promise<string[]>;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onDropQueued: (id: string) => void;
  onDropAttachment: (id: string) => void;
  /** A completed `@` mention, as the path relative to the project root. The
   *  caller resolves it and makes the chip, so path policy stays in one place. */
  onAttachFile: (relPath: string) => void;
  /** Images dropped, pasted or picked. Already checked against the limits. */
  onAttachImages: (images: { mediaType: string; base64: string }[]) => void;
  /** An attachment that was refused, for whoever owns the toast. */
  onAttachRejected: (reason: string) => void;
  /** Absolute paths dragged in from the file tree or an editor tab. Mentions,
   *  not uploads: the agent reads them off disk. */
  onAttachPaths: (absPaths: string[]) => void;
  /** The unsent draft, owned per session outside this component so it survives
   *  the tab being switched away from. */
  draft: string;
  onDraftChange: (text: string) => void;
  /** What was sent on this session, newest first, for Up-arrow recall. */
  history: readonly string[];
  onSendQueued: () => void;
  onDiscardQueued: () => void;
  /** The session controls (mode, model, effort) rendered into the bar under
   *  the input. Slotted rather than owned: their state and wiring belong to
   *  `ChatView`, and this component only decides where they sit. */
  controls?: JSX.Element;
  /** A one-line notice above the input (a pending switch, the bypass guard). */
  notice?: JSX.Element;
}) {
  // The draft lives in the caller's store; this reads and writes it so there is
  // one answer to "what is in the composer" rather than a local copy that has to
  // be kept in step with it.
  const text = () => props.draft;
  const setText = (value: string) => props.onDraftChange(value);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [token, setToken] = createSignal<CompletionToken | null>(null);
  const [files, setFiles] = createSignal<string[]>([]);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let picker: HTMLInputElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  let filesRequested = false;

  // A turn of nothing but a file reference is a real thing to send ("look at
  // this"), so an attachment is enough on its own.
  const hasContent = () => !!text().trim() || props.attachments.length > 0;

  const fileHits = createMemo(() => {
    const t = token();
    return t?.kind === "file" ? rank(files(), t.query, (f) => f) : [];
  });
  const commandHits = createMemo(() => {
    const t = token();
    return t?.kind === "command" ? rank(props.commands, t.query, (c) => c.name) : [];
  });
  const menuLength = () => fileHits().length + commandHits().length;
  const menuOpen = () => menuLength() > 0;

  function closeMenu() {
    setToken(null);
    setMenuIndex(0);
  }

  // Recompute after every edit and every caret move, since a menu that stayed
  // open because the caret walked away from its trigger would complete into the
  // wrong span.
  function syncToken() {
    if (!input) return;
    const next = activeToken(input.value, input.selectionStart ?? input.value.length);
    setToken(next);
    setMenuIndex(0);
    if (next?.kind === "file" && !filesRequested) {
      filesRequested = true;
      void props.loadFiles().then(setFiles).catch(() => setFiles([]));
    }
  }

  function setInputText(next: string, caret: number) {
    setText(next);
    setHistoryIndex(-1);
    if (!input) return;
    input.value = next;
    input.setSelectionRange(caret, caret);
    input.focus();
  }

  function accept() {
    const t = token();
    if (!t) return;
    if (t.kind === "file") {
      const hit = fileHits()[menuIndex()];
      if (!hit) return;
      // The mention leaves the text and becomes a chip, so what is sent carries
      // the path as structure rather than as a string to be re-parsed.
      const { text: next, caret } = dropToken(text(), t);
      setInputText(next, caret);
      props.onAttachFile(hit);
    } else {
      const hit = commandHits()[menuIndex()];
      if (!hit) return;
      // The hint is shown, never inserted: it describes what to type next, and
      // inserting it would send the word "<message>" to the model.
      const { text: next, caret } = replaceToken(text(), t, `/${hit.name} `);
      setInputText(next, caret);
    }
    closeMenu();
  }

  // Drop, paste and the picker all land here, so the limits are applied once
  // however an image arrived. Checked against a count that grows as we go, or
  // dropping eleven at once would let all eleven past a per-file check.
  async function attachFiles(files: readonly File[]) {
    if (props.disabled) return;
    const accepted: { mediaType: string; base64: string }[] = [];
    let count = props.attachments.length;
    for (const file of files) {
      const verdict = checkAttachment({ name: file.name, mediaType: file.type, bytes: file.size }, count);
      if (!verdict.ok) {
        props.onAttachRejected(verdict.reason);
        continue;
      }
      try {
        accepted.push({ mediaType: file.type, base64: await readAsBase64(file) });
        count += 1;
      } catch {
        props.onAttachRejected(`${file.name} could not be read.`);
      }
    }
    if (accepted.length) props.onAttachImages(accepted);
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    // Only when the clipboard actually carries a file: a normal text paste must
    // keep working, and an image copied alongside text is still an image.
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files);
  }

  function onDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      setDragging(false);
      void attachFiles(files);
      return;
    }
    // Not a file: a path dragged from the tree or an editor tab, which is a
    // mention rather than an upload. Same MIMEs the terminal accepts.
    const dragged =
      e.dataTransfer?.getData(DRAG_ABS_PATH_MIME) ||
      e.dataTransfer?.getData(DRAG_PATH_MIME) ||
      e.dataTransfer?.getData("text/plain") ||
      "";
    const paths = dragged.split("\n").filter(Boolean);
    if (!paths.length) return;
    e.preventDefault();
    setDragging(false);
    props.onAttachPaths(paths);
  }

  function submit() {
    const value = text().trim();
    if (!hasContent() || props.disabled) return;
    props.onSend(value);
    setText("");
    setHistoryIndex(-1);
    closeMenu();
    // The textarea grows with its content, so it has to be shrunk back by hand.
    if (input) input.style.height = "";
  }

  // Up at the very start of the input walks back through what was sent, the
  // way a shell does. Gated on the caret being at 0 so Up still moves through a
  // multi-line draft; gated on the menu being shut so it never steals its keys.
  function recall(delta: number): boolean {
    const entries = props.history;
    if (!entries.length) return false;
    const next = historyIndex() + delta;
    if (next < -1 || next >= entries.length) return false;
    setHistoryIndex(next);
    const value = next === -1 ? "" : entries[next];
    setText(value);
    if (input) {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
    }
    return true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!menuOpen() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const atStart = (input?.selectionStart ?? 0) === 0 && (input?.selectionEnd ?? 0) === 0;
      // Once a walk has started it continues, because recall leaves the caret at
      // the end of what it just put there: requiring the caret at 0 every time
      // would make Up work exactly once.
      const walking = historyIndex() >= 0;
      const navigating = e.key === "ArrowDown" ? walking : atStart || walking;
      if (navigating && recall(e.key === "ArrowUp" ? 1 : -1)) {
        e.preventDefault();
        return;
      }
    }
    if (menuOpen()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, menuLength()));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept();
        return;
      }
      if (e.key === "Escape") {
        // Dismisses the menu only. A running turn is interrupted by the next
        // Escape, so one key never means two things at once.
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && props.running) {
      e.preventDefault();
      props.onInterrupt();
    }
  }

  return (
    <div
      class={styles.composer}
      classList={{ [styles.composerDragging]: dragging() }}
      onDragOver={(e) => {
        // Required for a drop to fire at all. Only shows the target state for an
        // actual payload, so dragging a pane splitter across does not light up.
        if (!e.dataTransfer?.types.length) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Leaving for a child element is not leaving the composer.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Show when={props.queue.length}>
        <div class={`${styles.queue} ${props.held ? styles.queueHeld : ""}`}>
          <span class={styles.queueLabel}>
            {props.held
              ? `${props.queue.length} message${props.queue.length > 1 ? "s" : ""} held: the turn was stopped`
              : `Queued for the next turn`}
          </span>
          <For each={props.queue}>
            {(q) => (
              <button
                type="button"
                class={styles.queueItem}
                title="Remove from the queue"
                onClick={() => props.onDropQueued(q.id)}
              >
                {q.text}
              </button>
            )}
          </For>
          <Show when={props.held}>
            <div class={styles.queueActions}>
              <Button size="sm" variant="primary" onClick={() => props.onSendQueued()}>
                Send now
              </Button>
              <Button size="sm" onClick={() => props.onDiscardQueued()}>
                Discard
              </Button>
            </div>
          </Show>
        </div>
      </Show>
      {/* One menu, two sources. Above the input rather than below it: the
          composer sits at the bottom of the pane, and a menu below would open
          off-screen. */}
      <Show when={menuOpen()}>
        <div class={styles.completions} role="listbox">
          <For each={fileHits()}>
            {(path, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === menuIndex() }}
                role="option"
                aria-selected={i() === menuIndex()}
                onMouseEnter={() => setMenuIndex(i())}
                // Blur fires before click, and closing on blur would leave
                // `accept` with no token to complete. Keeping focus on the
                // textarea makes the click land on a menu that is still open.
                onMouseDown={(e) => e.preventDefault()}
                onClick={accept}
              >
                <span class={styles.completionName}>{path}</span>
              </button>
            )}
          </For>
          <For each={commandHits()}>
            {(cmd, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === menuIndex() }}
                role="option"
                aria-selected={i() === menuIndex()}
                onMouseEnter={() => setMenuIndex(i())}
                // Blur fires before click, and closing on blur would leave
                // `accept` with no token to complete. Keeping focus on the
                // textarea makes the click land on a menu that is still open.
                onMouseDown={(e) => e.preventDefault()}
                onClick={accept}
              >
                <span class={styles.completionName}>/{cmd.name}</span>
                <Show when={cmd.argumentHint}>
                  {(hint) => <span class={styles.completionHint}>{hint()}</span>}
                </Show>
                <Show when={cmd.description}>
                  <span class={styles.completionDesc}>{cmd.description}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.attachments.length}>
        <div class={styles.attachments}>
          <For each={props.attachments}>
            {(a) => (
              <button
                type="button"
                class={styles.attachment}
                title="Remove this attachment"
                onClick={() => props.onDropAttachment(a.id)}
              >
                {/* An image says what it is by being shown; a label reading
                    "image" tells the user nothing about which one. */}
                <Show when={a.block.type === "image" && a.block} fallback={chipLabel(a.block)}>
                  {(img) => (
                    <img
                      class={styles.attachmentThumb}
                      src={`data:${img().mediaType};base64,${img().data}`}
                      alt="attached image"
                    />
                  )}
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      {props.notice}
      <div class={styles.composerBox}>
        <textarea
          ref={input}
          class={styles.input}
          rows="1"
          placeholder={props.running ? "Type to queue for the next turn" : "Reply, or @ a file · / for commands"}
          value={text()}
          disabled={props.disabled}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setHistoryIndex(-1);
            syncToken();
            // Auto-grow to the content, capped in CSS.
            e.currentTarget.style.height = "";
            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          // A click or an arrow can move the caret out of the token that opened
          // the menu without changing a character, so selection is watched too.
          onSelect={syncToken}
          onBlur={closeMenu}
        />
        <div class={styles.composerBar}>
          {/* A plain file input rather than a native dialog: the webview has one
              already, and it needs no extra Tauri permission to open. */}
          <input
            ref={picker}
            class={styles.hiddenPicker}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              void attachFiles([...(e.currentTarget.files ?? [])]);
              // Cleared so picking the same file twice in a row still fires.
              e.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            class={styles.attachButton}
            title="Attach an image"
            aria-label="Attach an image"
            disabled={props.disabled}
            onClick={() => picker?.click()}
          >
            <Icon icon={Plus} />
          </button>
          {props.controls}
          <div class={styles.composerSpacer} />
          <button
            type="button"
            class={styles.sendButton}
            title={props.running ? "Stop this turn (Esc)" : "Send (Enter)"}
            aria-label={props.running ? "Stop" : "Send"}
            disabled={props.disabled || (!props.running && !hasContent())}
            onClick={() => (props.running ? props.onInterrupt() : submit())}
          >
            <Icon icon={props.running ? Square : ArrowUp} />
          </button>
        </div>
      </div>
    </div>
  );
}

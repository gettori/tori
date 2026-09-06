import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { ArrowUp, Plus, Square, X } from "lucide-solid";
import { convertFileSrc } from "@tauri-apps/api/core";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import type { QueuedInput } from "./chatStore";
import {
  attachmentKind,
  checkAttachment,
  chipLabel,
  readAsBytes,
  type AttachmentSource,
  type PendingBlock,
} from "../../utils/chatCompose";
import type { UploadFile } from "./composerAttachments";
import { DRAG_ABS_PATH_MIME, DRAG_PATH_MIME } from "../../utils/events";
import {
  activeToken,
  dropToken,
  moveIndex,
  rank,
  replaceToken,
  type CompletionToken,
} from "../../utils/composerCompletion";
import { insideFence } from "../../utils/composerFence";
import type { ContentBlock, SlashCommand } from "../../utils/chatTypes";
import styles from "./Chat.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

const MAX_ROWS = 9;
// The floor is what the box returns to after every send, so it is the height
// the composer is looked at for most of a session: a prompt worth writing is a
// paragraph rather than a search box's line.
const MIN_ROWS = 3;

// A paste past either of these is a document, not a sentence: it becomes a
// file chip so the box stays readable and the agent reads it off disk.
const LONG_PASTE_LINES = 30;
const LONG_PASTE_CHARS = 3000;

function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split("\n").length > LONG_PASTE_LINES;
}

/**
 * A chip of this composer's own, on its way into the sentence.
 *
 * Private, and checked before the path MIMEs: the tree marks its drags with
 * `text/plain` as well, and a chip read as a path would attach the same file a
 * second time under a second number.
 */
export const ATTACHMENT_TOKEN_MIME = "application/x-sway-attachment-token";

/** What the prose names this attachment by, or null for a chip that is not one
 *  (a selection, a hunk comment: they have no token to insert). */
function tokenOf(block: ContentBlock): string | null {
  return block.type === "fileRef" ? (block.label ?? null) : null;
}

/** The picture on the chip, or null for a chip that is not an image. A path is
 *  drawn through the asset protocol; the bytes of a replayed `image` block are
 *  drawn as they arrived. */
function thumbSrc(block: ContentBlock): string | null {
  if (block.type === "image") return `data:${block.mediaType};base64,${block.data}`;
  if (block.type === "fileRef" && block.label && attachmentKind(block.path) === "image") {
    return convertFileSrc(block.path);
  }
  return null;
}

/** What is about to land, said before it is refused rather than after. */
function dropHint(uploads: AttachmentSource): string {
  if (!uploads.kinds.length) return uploads.gap ?? "This agent takes no dropped files.";
  return `Drop to attach: ${uploads.kinds.join(", ")}`;
}

/** What the attach control offers, named after what this agent actually takes.
 *  It said "an image" for as long as an image was all anything took. */
function attachLabel(uploads: AttachmentSource): string {
  if (!uploads.kinds.length) return "This agent takes no attachments";
  if (uploads.kinds.includes("file")) return "Attach a file";
  return `Attach ${uploads.kinds.map((k) => (k === "image" ? "an image" : "a PDF")).join(" or ")}`;
}

/** The picker's filter, from what this agent takes. A `file` kind is any
 *  file, so the filter goes away rather than listing every extension. */
function pickerAccept(uploads: AttachmentSource): string | undefined {
  if (uploads.kinds.includes("file")) return undefined;
  const accept: string[] = [];
  if (uploads.kinds.includes("image")) accept.push("image/png", "image/jpeg", "image/gif", "image/webp");
  if (uploads.kinds.includes("pdf")) accept.push("application/pdf");
  return accept.join(",") || undefined;
}

/**
 * The input.
 *
 * Enter sends, Shift+Enter is a newline, Escape interrupts a running turn. The
 * send button becomes a stop button while a turn runs, so there is one control
 * in one place rather than two that disagree. Inside an open code fence Enter
 * adds a line instead, since sending half a block is the one thing a fence
 * announces you do not want; Cmd+Enter sends from anywhere, menu open or not.
 *
 * Typing during a turn never drops input. Once the turn is acknowledged the
 * message *steers* it: sent straight away, picked up at the agent's next step.
 * Before that acknowledgement there is no turn to steer, so it queues, visibly.
 * The strip below the input is the queue, and every entry in it is removable.
 * When the turn was *cancelled* the queue is held rather than flushed (see
 * `pendingFlush`), and the strip grows send-now and discard actions, because a
 * turn the user stopped must not fire the messages they stopped it to prevent.
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
  /** The running turn can take input right now, so Enter steers it rather than
   *  queueing for the next one. False for the window between Enter and the
   *  child's acknowledgement, where there is no turn to steer yet, and false
   *  for a agent whose declared tier cannot take input mid-turn. */
  steering: boolean;
  /** How long a steer took when it was measured (`"1.5-5.4s"`), or null when
   *  there is nothing to quote. Shown rather than dropped, because the one
   *  thing this control must not imply is that a steer is instant. */
  steerCost: string | null;
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
   *  caller resolves it and makes the chip, so path policy stays in one place,
   *  and hands back the token the new chip is named by (null when it refused
   *  the file) so the mention can keep its place in the sentence. */
  onAttachFile: (relPath: string) => string | null;
  /** What this agent can open when handed bytes, and the words for refusing
   *  them. The check runs here, where a file arrives, so a paste that cannot
   *  become a chip never does. */
  uploads: AttachmentSource;
  /** Files dropped, pasted or picked, already checked against `uploads`. */
  onAttachUploads: (files: UploadFile[]) => void;
  /** An attachment that was refused, for whoever owns the toast. */
  onAttachRejected: (reason: string) => void;
  /** Whether a long text paste becomes a `pasted.txt` chip rather than text in
   *  the box. Absent means on; only the setting turns it off. */
  attachLongPastes?: boolean;
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
  /** One line about what the next turn will run under, above the input.
   *
   *  Above rather than in the bar, and one line rather than one per control:
   *  the three switches land at the same boundary and used to say so beside
   *  whichever pill was pending, which moved every control to its right the
   *  moment anything was picked. A row of buttons that shuffles under the
   *  cursor is a worse cost than a line that appears. */
  notice?: JSX.Element;
  /** The session controls (mode, model, effort) rendered into the bar under
   *  the input. Slotted rather than owned: their state and wiring belong to
   *  `ChatView`, and this component only decides where they sit. */
  controls?: JSX.Element;
  /** The subagent lane being read, by name, or null on the main transcript.
   *  Only the placeholder changes: Sway has no channel to a subagent, so what
   *  is typed goes to the main agent from every lane. */
  watching?: string | null;
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
  // Where the caret is, kept as a signal so the fence notice and the send
  // label can follow it; the keydown itself reads the textarea directly.
  const [caret, setCaret] = createSignal(0);
  const inFence = createMemo(() => insideFence(text(), caret()));
  let picker: HTMLInputElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  let filesRequested = false;

  // A turn of nothing but a file reference is a real thing to send ("look at
  // this"), so an attachment is enough on its own.
  const hasContent = () => !!text().trim() || props.attachments.length > 0;

  // Auto-grow: three lines at rest, nine at most, then it scrolls.
  //
  // The size is written as `rows`, not as a pixel height, because rows is
  // denominated in line boxes: change the chat font size (or zoom) with a draft
  // sitting in the composer and the box re-flows to suit on its own. A pixel
  // height measured at the old font is simply wrong at the new one, and nothing
  // would recompute it until the next keystroke.
  //
  // It still has to *measure*, because a prompt is mostly prose without hard
  // newlines and only layout knows how many lines it soft-wrapped to.
  //
  // **It measures without collapsing the box first**, which it used to do on
  // every keystroke: `rows = 1`, read, `rows = n`. Two forced layouts of the
  // whole pane per character, and the transcript above resized twice in the
  // same breath for a box that mostly was not changing size at all. The floor
  // is where a box is if it is not overflowing, so `scrollHeight` against
  // `clientHeight` answers "does it need to be taller" without moving
  // anything. Only shrinking still has to measure small, and only from a box
  // that is already taller than the floor - which is deleting, not typing.
  function fit() {
    if (!input) return;
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (!Number.isFinite(line) || line <= 0) return;
    const rowsForContent = () =>
      Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round((input!.scrollHeight - padding) / line)));
    // Overflowing its box: grow to the content, from where it already is.
    if (input.scrollHeight > input.clientHeight) {
      input.rows = rowsForContent();
      return;
    }
    // Not overflowing and at the floor: there is nothing smaller to be, so the
    // measurement is the one that can be skipped outright. Below the floor is
    // not a size the box is allowed to keep, so it comes back up rather than
    // being left there.
    if (input.rows <= MIN_ROWS) {
      if (input.rows < MIN_ROWS) input.rows = MIN_ROWS;
      return;
    }
    input.rows = MIN_ROWS;
    input.rows = rowsForContent();
  }

  // Always, not only for a restored draft. The resting height is one rule's
  // answer or it is two: the `rows` attribute decided the first paint and
  // `fit` decided every paint after it, so a box those two disagreed about
  // sat wrong until the first keystroke and then jumped.
  onMount(fit);

  // Re-wrap on a width change: how many lines a prompt takes is a property of
  // how wide the box is, so a dragged divider or a zoom step leaves the height
  // measured against a width that is gone. Width only - `fit` changes the
  // height, and reacting to that would be a loop.
  onMount(() => {
    if (!input || typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const ro = new ResizeObserver(() => {
      const next = input?.clientWidth ?? 0;
      if (next === width) return;
      width = next;
      fit();
    });
    ro.observe(input);
    onCleanup(() => ro.disconnect());
  });

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
    const at = input.selectionStart ?? input.value.length;
    setCaret(at);
    const next = activeToken(input.value, at);
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
    setCaret(caret);
    if (!input) return;
    input.value = next;
    input.setSelectionRange(caret, caret);
    input.focus();
    fit();
  }

  function accept() {
    const t = token();
    if (!t) return;
    if (t.kind === "file") {
      const hit = fileHits()[menuIndex()];
      if (!hit) return;
      // The mention becomes a chip and keeps its place: the token is what the
      // sentence names the attachment by, so taking the words out would leave
      // "look at" pointing at nothing. A refused file has no token, and then
      // the mention is dropped the way it always was.
      const label = props.onAttachFile(hit);
      const { text: next, caret } = label ? replaceToken(text(), t, label) : dropToken(text(), t);
      setInputText(next, caret);
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
  // however a file arrived. Checked against a count that grows as we go, or
  // dropping eleven at once would let all eleven past a per-file check.
  async function attachFiles(files: readonly File[]) {
    if (props.disabled) return;
    const accepted: UploadFile[] = [];
    let count = props.attachments.length;
    for (const file of files) {
      const verdict = checkAttachment({ name: file.name, mediaType: file.type, bytes: file.size }, count, props.uploads);
      if (!verdict.ok) {
        props.onAttachRejected(verdict.reason);
        continue;
      }
      try {
        accepted.push({ name: file.name, bytes: await readAsBytes(file) });
        count += 1;
      } catch {
        props.onAttachRejected(`${file.name} could not be read.`);
      }
    }
    if (accepted.length) props.onAttachUploads(accepted);
  }

  /** Put a chip's token in the sentence, spaced so it does not weld itself to
   *  the word beside it. `at` is where a drop landed; without one it goes to
   *  the caret, which is where a click means. */
  function insertToken(token: string, at?: number) {
    const caret = at ?? input?.selectionStart ?? text().length;
    const before = text().slice(0, caret);
    const after = text().slice(caret);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const insert = `${lead}${token}${trail}`;
    setInputText(`${before}${insert}${after}`, caret + insert.length - trail.length);
  }

  // Where in the text a drop landed. Undefined when the browser cannot say or
  // the point is outside the input, and then the caret is the answer: dropping
  // a chip must put its token *somewhere*, and the caret is where the user was.
  function caretAtPoint(e: DragEvent): number | undefined {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (pos && input && (pos.offsetNode === input || input.contains(pos.offsetNode))) return pos.offset;
    return undefined;
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    // A clipboard that carries a file attaches it; an image copied alongside
    // text is still an image.
    if (files.length) {
      e.preventDefault();
      void attachFiles(files);
      return;
    }
    // A long text paste becomes a file too, through the same checks a dropped
    // file gets, so the cap and the tier apply unchanged. A tier with no file
    // uploads, or a user who turned this off, gets the textarea's own paste.
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (props.attachLongPastes === false || !props.uploads.kinds.includes("file") || !isLongPaste(pasted)) return;
    e.preventDefault();
    void attachFiles([new File([pasted], "pasted.txt", { type: "text/plain" })]);
  }

  function onDrop(e: DragEvent) {
    // One of this composer's own chips, going into the sentence. First,
    // because it carries no file and no path: read as either it would attach
    // the same thing again.
    const token = e.dataTransfer?.getData(ATTACHMENT_TOKEN_MIME);
    if (token) {
      e.preventDefault();
      setDragging(false);
      insertToken(token, caretAtPoint(e));
      return;
    }
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
    setCaret(0);
    closeMenu();
    // The textarea grew with its content, so it has to be put back by hand -
    // back to the *floor*, which is where an empty composer belongs. It used to
    // go back to a single row, a height the box has at no other moment: every
    // send left it short of its resting size until the next keystroke measured
    // it and snapped it up again, which is the jump that reads as the composer
    // resizing itself while you type.
    if (input) input.rows = MIN_ROWS;
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
    setCaret(value.length);
    if (input) {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      fit();
    }
    return true;
  }

  function onKeyDown(e: KeyboardEvent) {
    // The one key that always sends: over an open menu, inside a fence, from
    // anywhere. So nobody is ever stuck behind a fence they did not mean to open.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      closeMenu();
      submit();
      return;
    }
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
      // Inside an open fence the newline is the point; the textarea inserts it.
      if (input && insideFence(input.value, input.selectionStart ?? input.value.length)) return;
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
        // A chip of its own moving into the sentence is not an attachment
        // arriving, so the composer does not announce itself as a drop target
        // for one - and does not offer to attach what it already holds.
        if (e.dataTransfer.types.includes(ATTACHMENT_TOKEN_MIME)) return;
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
              // The visible text is the queued message, so the name has to say
              // what the button *does* to it - and name each row apart.
              <Tooltip
                as="button"
                type="button"
                class={styles.queueItem}
                label="Remove from the queue"
                aria-label={`Remove from the queue: ${q.text}`}
                onClick={() => props.onDropQueued(q.id)}
              >
                {q.text}
              </Tooltip>
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
            {(a) => {
              // A picture is already its own name, so the tile captions itself
              // with the token alone and leaves the filename to the control's
              // accessible name. Everything else has only words to go on.
              const thumb = () => thumbSrc(a.block);
              const face = () => (
                <>
                  <Show when={thumb()}>{(src) => <img class={styles.attachmentThumb} src={src()} alt="" />}</Show>
                  <span class={styles.attachmentName}>
                    {thumb() ? (tokenOf(a.block) ?? chipLabel(a.block)) : chipLabel(a.block)}
                  </span>
                </>
              );
              return (
                <div class={styles.attachment} classList={{ [styles.attachmentTile]: !!thumb() }}>
                  {/* Two controls, because the chip now means two things: put
                      the token in the message, or take the attachment away.
                      A chip with no token (a selection, a hunk comment) has
                      nothing to insert, so its face is not a control at all
                      rather than a button that does nothing. */}
                  <Show when={tokenOf(a.block)} fallback={<span class={styles.attachmentBody}>{face()}</span>}>
                    {(token) => (
                      <Tooltip
                        as="button"
                        type="button"
                        class={styles.attachmentBody}
                        label="Click or drag to put this in the message"
                        aria-label={`Insert ${chipLabel(a.block)}`}
                        draggable={true}
                        onDragStart={(e: DragEvent) => {
                          e.dataTransfer?.setData(ATTACHMENT_TOKEN_MIME, token());
                          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => insertToken(token())}
                        // The keyboard's way to the remove button's job, on the
                        // control the focus is already on.
                        onKeyDown={(e: KeyboardEvent) => {
                          if (e.key !== "Delete" && e.key !== "Backspace") return;
                          e.preventDefault();
                          props.onDropAttachment(a.id);
                        }}
                      >
                        {face()}
                      </Tooltip>
                    )}
                  </Show>
                  <button
                    type="button"
                    class={styles.attachmentRemove}
                    // Named after the action and after which attachment: an
                    // image chip's own content is a picture, so without this
                    // the button answers to nothing.
                    aria-label={`Remove ${chipLabel(a.block)}`}
                    onClick={() => props.onDropAttachment(a.id)}
                  >
                    <Icon icon={X} size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={dragging()}>
        <div class={styles.dropHint}>{dropHint(props.uploads)}</div>
      </Show>
      <Show when={props.notice}>
        {(notice) => <div class={styles.composerNotice}>{notice()}</div>}
      </Show>
      <div class={styles.composerBox}>
        <textarea
          ref={input}
          class={styles.input}
          rows={MIN_ROWS}
          // Says what Enter will actually do, and quotes the measured delivery
          // rather than letting a steer read as instant. The figure comes from
          // the declared tier, so it cannot drift from what was measured; the
          // fallback wording still refuses to promise immediacy.
          placeholder={
            props.watching
              ? // Never the steer wording outside main. A steer reaches the
                // turn it names, and this box cannot reach the lane on screen.
                `Watching ${props.watching}. What you type goes to the main agent`
              : props.running
                ? props.steering
                  ? props.steerCost
                    ? `Steer this turn, picked up in ${props.steerCost}`
                    : "Steer this turn, picked up at its next step"
                  : "Type to queue for the next turn"
                : "Reply, or @ a file · / for commands"
          }
          value={text()}
          disabled={props.disabled}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setHistoryIndex(-1);
            syncToken();
            fit();
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
            // Named as well as hidden: the button that opens it is a different
            // element, so this one is a form control with no label of its own.
            aria-label={attachLabel(props.uploads)}
            accept={pickerAccept(props.uploads)}
            multiple
            onChange={(e) => {
              void attachFiles([...(e.currentTarget.files ?? [])]);
              // Cleared so picking the same file twice in a row still fires.
              e.currentTarget.value = "";
            }}
          />
          <Tooltip
            as="button"
            type="button"
            class={styles.attachButton}
            label={attachLabel(props.uploads)}
            aria-label={attachLabel(props.uploads)}
            // Offered only where something can be attached: a picker that
            // refuses whatever it is given is the silent nothing the tier
            // exists to prevent.
            disabled={props.disabled || !props.uploads.kinds.length}
            onClick={() => picker?.click()}
          >
            <Icon icon={Plus} />
          </Tooltip>
          {props.controls}
          <div class={styles.composerSpacer} />
          <Tooltip
            as="button"
            type="button"
            class={styles.sendButton}
            label={props.running ? "Stop this turn (Esc)" : inFence() ? "Send (Cmd+Enter)" : "Send (Enter)"}
            aria-label={props.running ? "Stop" : "Send"}
            disabled={props.disabled || (!props.running && !hasContent())}
            onClick={() => (props.running ? props.onInterrupt() : submit())}
          >
            <Icon icon={props.running ? Square : ArrowUp} />
          </Tooltip>
        </div>
      </div>
      <Show when={inFence()}>
        <div class={styles.composerHint}>Enter adds a line inside the code block. Cmd+Enter sends.</div>
      </Show>
    </div>
  );
}

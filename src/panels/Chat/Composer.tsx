import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { render } from "solid-js/web";
import {
  ArrowUp,
  AudioWaveform,
  Check,
  CornerDownRight,
  GripVertical,
  Pencil,
  Plus,
  Square,
  SquarePen,
  X,
} from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import { queuedText, type QueuedInput } from "./chatStore";
import {
  checkAttachment,
  chipLabel,
  readAsBytes,
  type AttachmentSource,
  type PendingBlock,
} from "../../utils/chatCompose";
import type { ComposerAttachments, UploadFile } from "./composerAttachments";
import type { StashEntry } from "./promptStash";
import { ago } from "../../utils/relativeTime";
import FileIcon from "../../seti/FileIcon";
import AttachmentPreview from "./AttachmentPreview";
import { createComposerField, type ComposerField } from "./composerField";
import Tip, { excerptOf } from "./Tip";
import { attachmentTip, isTile, thumbSrc, tileName, tileNote, tokenOf } from "./attachmentInfo";
import { DRAG_ABS_PATH_MIME, DRAG_PATH_MIME, OPEN_IN_EDITOR, emitWith, type OpenInEditor } from "../../utils/events";
import {
  activeToken,
  dropToken,
  mentionScope,
  moveIndex,
  rank,
  replaceToken,
  type CompletionToken,
} from "../../utils/composerCompletion";
import { insideFence } from "../../utils/composerFence";
import { createDragReorder, moveKey } from "../../utils/dragReorder";
import { fmtTokens } from "../../utils/chatUsage";
import type { ContentBlock, SlashCommand } from "../../utils/chatTypes";
import type { PullRequest } from "../../utils/forgeTypes";
import { prHits, prLabel } from "../../utils/prMention";
import type { SessionMeta } from "../../utils/sessionStore";
import { sessionTitle } from "../../utils/sessionMention";
import { navLevel, type NavProject, type NavSpace, type NavUnit } from "../../utils/mentionNavigator";
import styles from "./Chat.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";
import DictationWave from "../../components/DictationWave/DictationWave";
import {
  dropActive as dropDictation,
  levels as dictationLevels,
  state as dictation,
  toggle as toggleDictation,
} from "../../utils/dictation";

type NavRow =
  | { kind: "space"; key: string; space: NavSpace }
  | { kind: "project"; key: string; space: NavSpace; project: NavProject }
  | { kind: "unit"; key: string; unit: NavUnit }
  | { kind: "session"; session: SessionMeta; project: NavProject }
  | { kind: "file"; path: string; folder: string };

function navName(row: NavRow): string {
  switch (row.kind) {
    case "space":
      return row.space.name;
    case "project":
      return row.project.name;
    case "unit":
      return row.unit.label;
    case "session":
      return sessionTitle(row.session);
    case "file":
      return row.path;
  }
}

function navDesc(row: NavRow): string | null {
  switch (row.kind) {
    case "space":
      return `Space, ${row.space.projects.length} projects`;
    case "project":
      return "Project";
    case "unit":
      return row.unit.branch ? `Checkout, ${row.unit.branch}` : "Checkout";
    case "session":
      return `Session, ${row.session.agent ?? "claude"}`;
    case "file":
      return null;
  }
}

// Sessions above files in a bare `@`, few enough that files stay in view;
// `@session/` lists the rest.
const MIXED_SESSIONS = 5;

// A paste past either of these is a document, not a sentence: it becomes a
// file chip so the box stays readable and the agent reads it off disk.
const LONG_PASTE_LINES = 30;
const LONG_PASTE_CHARS = 3000;

function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split("\n").length > LONG_PASTE_LINES;
}

// Four characters a token is a rough average, so the readout says "about" and
// stays out of the way until a draft is big enough for the figure to matter.
const TOKEN_READOUT_FROM = 500;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** What a caller holds to put text into the composer, handed over on mount. */
export type ComposerHandle = {
  /** Insert at the caret, on a line of its own, and focus the input. */
  insertBlock: (text: string) => void;
};

/**
 * A chip of this composer's own, on its way into the sentence.
 *
 * Private, and checked before the path MIMEs: the tree marks its drags with
 * `text/plain` as well, and a chip read as a path would attach the same file a
 * second time under a second number.
 */
export const ATTACHMENT_TOKEN_MIME = "application/x-tori-attachment-token";

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
 * When the turn was *cancelled* the queue is parked rather than flushed (see
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
  parked: boolean;
  restored?: boolean;
  disabled: boolean;
  /** This session's real command catalogue, from the `initialize` handshake. */
  commands: readonly SlashCommand[];
  /** Which of those commands are skills, the only ones a `/` mid-sentence
   *  offers. Absent or empty for an agent that does not say, and then a
   *  mid-sentence `/` offers nothing rather than guessing. */
  skills?: readonly string[];
  /** The project's file list, fetched on the first `@` and cached here: a chat
   *  that never mentions a file should not pay for the walk. */
  loadFiles: () => Promise<string[]>;
  /** The project's open pull requests, for `#`, read on the first `#`.
   *  Absent, `#` offers nothing. */
  prs?: readonly PullRequest[];
  loadPrs?: () => void;
  /** A picked pull request. Answers the token its chip is named by. */
  onAttachPr?: (pr: PullRequest) => string | null;
  /** One pull request by number, for one the open list does not hold. */
  resolvePr?: (number: number) => Promise<PullRequest | null>;
  /** The repo's sessions, newest first, read on the first `@`. Absent, `@`
   *  offers files only. */
  sessions?: readonly SessionMeta[];
  loadSessions?: () => void;
  /** A picked session. Answers the token its chip is named by. */
  onAttachSession?: (s: SessionMeta, project?: string) => string | null;
  /** The `@spaces/` and `@projects/` navigator, which offers nothing while
   *  its `spaces` is undefined. */
  navigator?: Pick<
    ComposerAttachments,
    | "spaces"
    | "here"
    | "sessionsOf"
    | "filesOf"
    | "loadSessionsOf"
    | "loadFilesOf"
    | "onAttachProject"
    | "onAttachSpace"
    | "onAttachSession"
  >;
  onSend: (text: string) => void;
  onQueue?: (text: string) => void;
  onInterrupt: () => void;
  onDropQueued: (id: string) => void;
  onReorderQueued?: (ids: string[]) => void;
  onSteerQueued?: (idOrOldest?: string) => void;
  editing?: string | null;
  onEditQueued?: (id: string) => void;
  onSaveEdit?: (text: string) => void;
  onCancelEdit?: () => void;
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
  /** Files dropped, pasted or picked, already checked against `uploads`.
   *  Answers the tokens the new chips are named by. */
  onAttachUploads: (files: UploadFile[]) => Promise<readonly string[]>;
  /** An attachment that was refused, for whoever owns the toast. */
  onAttachRejected: (reason: string) => void;
  /** Whether a long text paste becomes a `pasted.txt` chip rather than text in
   *  the box. Absent means on; only the setting turns it off. */
  attachLongPastes?: boolean;
  /** Whether a mentioned file is still there. Asked per chip on mount and each
   *  time the input regains focus; absent means no chip is ever marked. */
  fileExists?: (path: string) => Promise<boolean>;
  /** Receives the imperative handle on mount, for the transcript's Quote. */
  handle?: (handle: ComposerHandle) => void;
  /** The scratch file's name while the draft is being edited in the editor.
   *  The input is read only then; the editor writes, the composer sends. */
  linked?: string | null;
  /** Lift the draft into a scratch tab. Absent, no control is offered. */
  onOpenInEditor?: () => void;
  /** End the link: the tab closes and the input is the writer again. */
  onUnlink?: () => void;
  /** Absolute paths dragged in from the file tree or an editor tab. Mentions,
   *  not uploads: the agent reads them off disk. Answers their tokens. */
  onAttachPaths: (absPaths: string[]) => readonly string[];
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
  /** The prompt stash, oldest first. Without `onStash` Cmd+S is not bound
   *  here at all. */
  stash?: readonly StashEntry[];
  onStash?: () => void;
  onRestoreStash?: (id: string) => void;
  onDiscardStash?: (id: string) => void;
  /** A first message is held for a session still opening. The draft on show
   *  is that message, so it cannot be stashed out from under the send. */
  holding?: boolean;
  /** The subagent lane being read, by name, or null on the main transcript.
   *  Only the placeholder changes: Tori has no channel to a subagent, so what
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
  // Bumped when the input regains focus, so every chip re-asks whether its
  // file is still there: coming back from the tree is when one gets deleted.
  const [focusTick, setFocusTick] = createSignal(0);
  let picker: HTMLInputElement | undefined;
  let field: ComposerField | undefined;
  let fieldHost: HTMLDivElement | undefined;
  let filesRequested = false;
  let prsRequested = false;
  // The `@` the session list was last read for, so each new mention reads it
  // fresh and typing inside one does not.
  let sessionsAt = -1;

  // A turn of nothing but a file reference is a real thing to send ("look at
  // this"), so an attachment is enough on its own.
  const hasContent = () => !!text().trim() || props.attachments.length > 0;

  const scoped = createMemo(() => {
    const t = token();
    return t?.kind === "file" ? mentionScope(t.query) : null;
  });
  const sessionHits = createMemo(() => {
    const m = scoped();
    if (!m || (m.scope !== "all" && m.scope !== "session") || !props.sessions || !props.onAttachSession) return [];
    const hits = rank(props.sessions, m.query, (s) => sessionTitle(s));
    return m.scope === "all" ? hits.slice(0, MIXED_SESSIONS) : hits;
  });
  const fileHits = createMemo(() => {
    const m = scoped();
    return m && (m.scope === "all" || m.scope === "file") ? rank(files(), m.query, (f) => f) : [];
  });
  const navAt = createMemo(() => {
    const m = scoped();
    const spaces = props.navigator?.spaces();
    if (!m || (m.scope !== "spaces" && m.scope !== "projects") || !spaces) return null;
    return navLevel(m.scope, m.query, spaces, props.navigator!.here());
  });
  createEffect(() => {
    const at = navAt();
    const nav = props.navigator;
    if (!nav) return;
    untrack(() => {
      if (at?.level === "project") nav.loadSessionsOf(at.project.path);
      else if (at?.level === "files") nav.loadFilesOf(at.unit.folderPath);
    });
  });
  const navHits = createMemo((): NavRow[] => {
    const at = navAt();
    const nav = props.navigator;
    if (!at || !nav) return [];
    switch (at.level) {
      case "spaces":
        return rank(at.spaces, at.query, (k) => k.key).map((k) => ({ kind: "space", key: k.key, space: k.item }));
      case "projects":
        return rank(at.projects, at.query, (k) => k.key).map((k) => ({
          kind: "project",
          key: k.key,
          space: at.space,
          project: k.item,
        }));
      case "project":
        return [
          ...rank(at.units, at.query, (k) => k.key).map((k): NavRow => ({ kind: "unit", key: k.key, unit: k.item })),
          ...rank(nav.sessionsOf(at.project.path), at.query, (s) => sessionTitle(s)).map((s): NavRow => ({
            kind: "session",
            session: s,
            project: at.project,
          })),
        ];
      case "files":
        return rank(nav.filesOf(at.unit.folderPath), at.query, (f) => f).map((f) => ({
          kind: "file",
          path: f,
          folder: at.unit.folderPath,
        }));
    }
  });
  // A skill the catalogue also lists keeps its description and hint; one it
  // does not is still offered, by name alone.
  const skillCommands = createMemo((): SlashCommand[] =>
    (props.skills ?? []).map(
      (name) =>
        props.commands.find((c) => c.name === name) ?? { name, description: "", argumentHint: null, aliases: [] },
    ),
  );
  const commandHits = createMemo(() => {
    const t = token();
    if (t?.kind === "command") return rank(props.commands, t.query, (c) => c.name);
    if (t?.kind === "skill") return rank(skillCommands(), t.query, (c) => c.name);
    return [];
  });
  const prMenu = createMemo(() => {
    const t = token();
    return t?.kind === "pr" && props.onAttachPr ? prHits(props.prs ?? [], t.query) : [];
  });
  const menuLength = () =>
    sessionHits().length + fileHits().length + navHits().length + commandHits().length + prMenu().length;
  const resolveActive = () => prMenu()[menuIndex()]?.kind === "resolve";
  const [stashOpen, setStashOpen] = createSignal(false);
  const [stashIndex, setStashIndex] = createSignal(0);
  const stashRows = createMemo(() => [...(props.stash ?? [])].reverse());
  createEffect(() => {
    const n = stashRows().length;
    if (!n) setStashOpen(false);
    else if (stashIndex() >= n) setStashIndex(n - 1);
  });
  const menuOpen = () => menuLength() > 0;

  function closeMenu() {
    setToken(null);
    setMenuIndex(0);
  }

  // Recompute after every edit and every caret move, since a menu that stayed
  // open because the caret walked away from its trigger would complete into the
  // wrong span.
  function syncToken() {
    if (!field) return;
    const at = field.caret();
    setCaret(at);
    const next = activeToken(field.value(), at);
    setToken(next);
    setMenuIndex(0);
    if (next?.kind === "file" && !filesRequested) {
      filesRequested = true;
      void props
        .loadFiles()
        .then(setFiles)
        .catch(() => setFiles([]));
    }
    if (next?.kind !== "file") sessionsAt = -1;
    else if (next.start !== sessionsAt && props.loadSessions) {
      sessionsAt = next.start;
      props.loadSessions();
    }
    if (next?.kind === "pr" && !prsRequested) {
      prsRequested = true;
      props.loadPrs?.();
    }
  }

  function setInputText(next: string, caret: number) {
    setText(next);
    setHistoryIndex(-1);
    setCaret(caret);
    if (!field) return;
    field.set(next, caret);
    field.focus();
  }

  function drill(t: CompletionToken, key: string) {
    const seg = t.query.slice(t.query.lastIndexOf("/") + 1);
    const { text: next, caret } = replaceToken(text(), { ...t, start: t.end - seg.length }, `${key}/`);
    setInputText(next, caret);
    syncToken();
  }

  function acceptNav(t: CompletionToken, row: NavRow) {
    const nav = props.navigator!;
    if (row.kind === "unit") {
      drill(t, row.key);
      return;
    }
    let label: string | null;
    if (row.kind === "space") label = nav.onAttachSpace(row.space);
    else if (row.kind === "project") label = nav.onAttachProject(row.space, row.project);
    else if (row.kind === "session") label = nav.onAttachSession(row.session, row.project.path);
    else label = props.onAttachPaths([`${row.folder}/${row.path}`])[0] ?? null;
    const { text: next, caret } = label ? replaceToken(text(), t, label) : dropToken(text(), t);
    setInputText(next, caret);
    closeMenu();
  }

  function accept() {
    const t = token();
    if (!t) return;
    const row = navHits()[menuIndex()];
    if (t.kind === "file" && row) {
      acceptNav(t, row);
      return;
    }
    if (t.kind === "file" && menuIndex() < sessionHits().length) {
      const label = props.onAttachSession?.(sessionHits()[menuIndex()]);
      if (label) {
        const { text: next, caret } = replaceToken(text(), t, label);
        setInputText(next, caret);
      }
    } else if (t.kind === "file") {
      const hit = fileHits()[menuIndex() - sessionHits().length];
      if (!hit) return;
      // The mention becomes a chip and keeps its place: the token is what the
      // sentence names the attachment by, so taking the words out would leave
      // "look at" pointing at nothing. A refused file has no token, and then
      // the mention is dropped the way it always was.
      const label = props.onAttachFile(hit);
      const { text: next, caret } = label ? replaceToken(text(), t, label) : dropToken(text(), t);
      setInputText(next, caret);
    } else if (t.kind === "pr") {
      const hit = prMenu()[menuIndex()];
      if (!hit) return;
      if (hit.kind === "resolve") {
        void resolveInto(t, hit.number);
        return;
      }
      const label = props.onAttachPr?.(hit.pr);
      if (label) {
        const { text: next, caret } = replaceToken(text(), t, label);
        setInputText(next, caret);
      }
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

  async function resolveInto(t: CompletionToken, number: number) {
    closeMenu();
    const typed = text().slice(t.start, t.end);
    const pr = await (props.resolvePr?.(number) ?? Promise.resolve(null)).catch(() => null);
    if (!pr) {
      props.onAttachRejected(`No pull request ${number} in this repository.`);
      return;
    }
    const label = props.onAttachPr?.(pr);
    // Only where the number still stands: the user may have typed on meanwhile.
    if (label && text().slice(t.start, t.end) === typed) {
      const { text: next, caret } = replaceToken(text(), t, label);
      setInputText(next, caret);
    }
  }

  // Drop, paste and the picker all land here, so the limits are applied once
  // however a file arrived. Checked against a count that grows as we go, or
  // dropping eleven at once would let all eleven past a per-file check.
  //
  // `at` is where a drop landed. The tokens go in as soon as they are minted:
  // an attachment the sentence does not name is one the agent has to guess the
  // place of, and waiting to be clicked made that the common case.
  async function attachFiles(files: readonly File[], at?: number) {
    if (props.disabled) return;
    const accepted: UploadFile[] = [];
    let count = props.attachments.length;
    for (const file of files) {
      const verdict = checkAttachment(
        { name: file.name, mediaType: file.type, bytes: file.size },
        count,
        props.uploads,
      );
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
    if (!accepted.length) return;
    const labels = await props.onAttachUploads(accepted);
    if (labels?.length) insertToken(labels.join(" "), at);
  }

  /** Put a chip's token in the sentence, spaced so it does not weld itself to
   *  the word beside it. `at` is where a drop landed; without one it goes to
   *  the caret, which is where a click means. */
  function insertToken(token: string, at?: number) {
    const caret = at ?? field?.caret() ?? text().length;
    const before = text().slice(0, caret);
    const after = text().slice(caret);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const insert = `${lead}${token}${trail}`;
    setInputText(`${before}${insert}${after}`, caret + insert.length - trail.length);
  }

  /** Take a token out from where it sat and put it where it was dropped. */
  function moveToken(token: string, from: number, at: number | undefined) {
    if (at !== undefined && at >= from && at <= from + token.length) return;
    // The gap it leaves closes up: one of the two spaces it sat between goes
    // with it, or the one before it when it ended a sentence.
    let start = from;
    let end = from + token.length;
    const before = text()[start - 1];
    const after = text()[end];
    if (before === " " && (after === " " || after === undefined || /[.,;:!?)]/.test(after))) start -= 1;
    else if (start === 0 && after === " ") end += 1;
    const without = text().slice(0, start) + text().slice(end);
    const gone = end - start;
    const target = at === undefined ? undefined : at > start ? at - gone : at;
    setText(without);
    field?.set(without, Math.min(target ?? without.length, without.length));
    insertToken(token, target);
  }

  function insertSpoken(spoken: string) {
    const caret = field?.caret() ?? text().length;
    const before = text().slice(0, caret);
    const lead = before && !/\s$/.test(before) ? " " : "";
    setInputText(`${before}${lead}${spoken}${text().slice(caret)}`, caret + lead.length + spoken.length);
  }

  /** Put a block (a quote) in at the caret, starting on its own line. */
  function insertBlock(block: string) {
    const caret = field?.caret() ?? text().length;
    const before = text().slice(0, caret);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    setInputText(`${before}${lead}${block}${text().slice(caret)}`, caret + lead.length + block.length);
  }
  onMount(() => props.handle?.({ insertBlock }));

  // Where in the text a drop landed. Undefined when the point is outside the
  // text, and then the caret is the answer: dropping a chip must put its token
  // *somewhere*, and the caret is where the user was.
  function caretAtPoint(e: DragEvent): number | undefined {
    return field?.posAt(e.clientX, e.clientY);
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

  // A drop beside the text (on the tiles, the queue, the bar). One on the text
  // itself is taken by the field, which marks it handled on the way out.
  function onDrop(e: DragEvent) {
    if (e.defaultPrevented) {
      setDragging(false);
      return;
    }
    takeDrop(e);
  }

  function takeDrop(e: DragEvent) {
    // One of this composer's own chips, going into the sentence. First,
    // because it carries no file and no path: read as either it would attach
    // the same thing again.
    const token = e.dataTransfer?.getData(ATTACHMENT_TOKEN_MIME);
    if (token) {
      e.preventDefault();
      setDragging(false);
      const at = caretAtPoint(e);
      const from = movingFrom;
      movingFrom = null;
      if (from !== null && text().startsWith(token, from)) moveToken(token, from, at);
      else insertToken(token, at);
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      setDragging(false);
      void attachFiles(files, caretAtPoint(e));
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
    const at = caretAtPoint(e);
    const labels = props.onAttachPaths(paths);
    if (labels?.length) insertToken(labels.join(" "), at);
  }

  // Empty the box and put it back the way an empty composer sits. Shared by the
  // send and by Ctrl+C, which are the two ways a draft stops being one.
  function clearDraft() {
    setText("");
    setHistoryIndex(-1);
    setCaret(0);
    closeMenu();
  }

  function submit(queue = false) {
    const value = text().trim();
    if (!hasContent() || props.disabled) return;
    if (props.editing) {
      props.onSaveEdit?.(value);
      return;
    }
    if (queue && props.onQueue) props.onQueue(value);
    else props.onSend(value);
    clearDraft();
  }

  // Entering or leaving an edit replaces the whole draft from outside, which no
  // keystroke measured, so the box is refitted and the caret put at the end.
  createEffect(
    on(
      () => props.editing,
      () => {
        setHistoryIndex(-1);
        queueMicrotask(() => {
          if (!field) return;
          const end = field.value().length;
          field.select(end);
          setCaret(end);
          field.focus();
        });
      },
      { defer: true },
    ),
  );

  let queueStrip: HTMLDivElement | undefined;
  const drag = createDragReorder({
    keys: () => props.queue.map((q) => q.id),
    onCommit: (ids) => props.onReorderQueued?.(ids),
  });

  function moveQueued(id: string, delta: number) {
    const keys = props.queue.map((q) => q.id);
    const target = keys[keys.indexOf(id) + delta];
    if (!target) return;
    props.onReorderQueued?.(moveKey(keys, id, target));
    // Moving a row re-inserts its node, which drops focus off the handle and
    // would end a keyboard move after one step.
    queueMicrotask(() => queueStrip?.querySelector<HTMLElement>(`[data-queue-handle="${id}"]`)?.focus());
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
    field?.set(value, value.length);
    return true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (stashOpen()) {
      const row = stashRows()[stashIndex()];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setStashIndex((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, stashRows().length));
        return;
      }
      if (e.key === "Enter" || e.key === "Backspace") {
        e.preventDefault();
        if (row && e.key === "Enter") {
          setStashOpen(false);
          props.onRestoreStash?.(row.id);
        } else if (row) {
          props.onDiscardStash?.(row.id);
        }
        return;
      }
      setStashOpen(false);
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "s" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && props.onStash) {
      e.preventDefault();
      if (props.editing || props.linked || props.holding) return;
      if (hasContent()) {
        closeMenu();
        props.onStash();
      } else if (stashRows().length === 1) {
        props.onRestoreStash?.(stashRows()[0].id);
      } else if (stashRows().length) {
        setStashIndex(0);
        setStashOpen(true);
      }
      return;
    }
    if (props.editing && e.key === "Enter" && (e.altKey || (e.shiftKey && (e.metaKey || e.ctrlKey)))) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      closeMenu();
      if (!props.queue.length) submit();
      else if (props.steering) props.onSteerQueued?.();
      return;
    }
    // The one key that always sends: over an open menu, inside a fence, from
    // anywhere. So nobody is ever stuck behind a fence they did not mean to open.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      closeMenu();
      submit();
      return;
    }
    // Ctrl+C abandons the draft, the way it does at a shell prompt. Guarded on
    // there being prose to drop, so an empty box leaves the key alone, and on the
    // draft being the input's to clear rather than the scratch tab's. The chips
    // stay: each one is a file that was picked, and each already has its own x.
    if (e.key === "c" && e.ctrlKey && !e.metaKey && !e.altKey && !props.linked && text()) {
      e.preventDefault();
      clearDraft();
      return;
    }
    if (!menuOpen() && e.key === "ArrowUp" && e.altKey && !e.metaKey && !e.ctrlKey) {
      const last = [...props.queue].reverse().find((q) => !q.steering);
      const atStart = (field?.selection().to ?? 0) === 0;
      if (props.editing || !last || !atStart || !props.onEditQueued) return;
      e.preventDefault();
      props.onEditQueued(last.id);
      return;
    }
    if (!menuOpen() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const atStart = (field?.selection().to ?? 0) === 0;
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
      // `/` on a navigator node opens it; on a session, which has nothing
      // under it, it does nothing. In a file list it is part of the path.
      const row = navHits()[menuIndex()];
      if (e.key === "/" && row && row.kind !== "file") {
        e.preventDefault();
        if (row.kind !== "session") drill(token()!, row.key);
        return;
      }
      if (e.key === "Enter" && resolveActive()) {
        closeMenu();
      } else if (e.key === "Enter" || e.key === "Tab") {
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
      if (field && insideFence(field.value(), field.caret())) return;
      e.preventDefault();
      submit(e.altKey && props.running);
      return;
    }
    if (e.key === "Escape" && dropDictation()) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && props.editing) {
      e.preventDefault();
      props.onCancelEdit?.();
      return;
    }
    if (e.key === "Escape" && props.running) {
      e.preventDefault();
      props.onInterrupt();
    }
  }

  // Says what Enter will actually do, and quotes the measured delivery rather
  // than letting a steer read as instant. The figure comes from the declared
  // tier, so it cannot drift from what was measured; the fallback wording still
  // refuses to promise immediacy.
  const placeholderText = () =>
    props.watching
      ? // Never the steer wording outside main. A steer reaches the turn it
        // names, and this box cannot reach the lane on screen.
        `Watching ${props.watching}. What you type goes to the main agent`
      : props.running
        ? props.steering
          ? (props.steerCost
              ? `Steer this turn, picked up in ${props.steerCost}`
              : "Steer this turn, picked up at its next step") + (props.onQueue ? ". Option+Enter queues" : "")
          : "Type to queue for the next turn"
        : "Reply, or @ a file · / for commands";

  // The attachments a token in the text can be drawn as: every chip with a
  // label the prose names it by.
  const held = createMemo(() => {
    const by = new Map<string, PendingBlock>();
    for (const a of props.attachments) {
      const label = a.block.type === "fileRef" ? a.block.label : a.block.type === "ref" ? a.block.label : null;
      if (label) by.set(label, a);
    }
    return by;
  });
  // Where an inline chip being dragged sat, so dropping it moves it rather than
  // naming the attachment a second time.
  let movingFrom: number | null = null;

  onMount(() => {
    field = createComposerField({
      parent: fieldHost!,
      doc: text(),
      placeholder: placeholderText(),
      // One writer at a time: while a scratch tab holds the draft, typing here
      // would be overwritten by the next save.
      readOnly: !!props.linked || dictation() !== "idle",
      disabled: props.disabled,
      skills: props.skills ?? [],
      chipFor: (label) => {
        const a = untrack(held).get(label);
        if (!a) return null;
        return { key: a.id, mount: (dom) => render(() => <InlineChip a={a} label={label} />, dom) };
      },
      onInput: (value) => {
        setText(value);
        setHistoryIndex(-1);
        syncToken();
      },
      // A click or an arrow can move the caret out of the token that opened the
      // menu without changing a character, so selection is watched too.
      onSelect: syncToken,
      onKeyDown: (e) => {
        onKeyDown(e);
        return e.defaultPrevented;
      },
      onPaste: (e) => {
        onPaste(e);
        return e.defaultPrevented;
      },
      onDrop: (e) => {
        const types = e.dataTransfer?.types ?? [];
        const ours = [ATTACHMENT_TOKEN_MIME, DRAG_ABS_PATH_MIME, DRAG_PATH_MIME, "Files", "text/plain"];
        if (!ours.some((t) => types.includes(t))) return false;
        takeDrop(e);
        return true;
      },
      onFocus: () => setFocusTick((t) => t + 1),
      onBlur: closeMenu,
    });
    onCleanup(() => field?.destroy());
    // The draft is owned outside (per session, surviving a tab switch), so a
    // change made there - a restored stash, a queued message taken back to edit -
    // is written into the field. Typing round-trips to the same text and is
    // left alone.
    createEffect(() => {
      const t = text();
      if (field && field.value() !== t) field.set(t, t.length);
    });
    createEffect(() => field?.setPlaceholder(placeholderText()));
    createEffect(
      on(
        () => props.skills,
        (names) => field?.setSkills(names ?? []),
        { defer: true },
      ),
    );
    createEffect(() => field?.setReadOnly(!!props.linked || dictation() !== "idle", props.disabled));
    createEffect(on(held, () => field?.refreshChips(), { defer: true }));
  });

  /** A token in the sentence that is one of the held attachments. It reads as
   *  the text it is; hovering shows it is one piece that can be picked up. */
  const InlineChip = (p: { a: PendingBlock; label: string }) => {
    const block = p.a.block;
    const path = block.type === "fileRef" ? block.path : null;
    const missing = () => !!path && missingPaths().has(path);
    return (
      <button
        type="button"
        class={styles.inlineChip}
        classList={{ [styles.inlineChipMissing]: missing() }}
        aria-label={`Preview ${chipLabel(block)}`}
        // No tooltip of its own: hovering lights the attachment it names above,
        // which already says everything a tooltip would.
        onMouseEnter={() => setPointing(p.a.id)}
        onMouseLeave={() => setPointing(null)}
        // Out of the tab order: the field is one stop, and the chip's file is
        // reachable from its tile above.
        tabIndex={-1}
        draggable={true}
        onDragStart={(e: DragEvent) => {
          movingFrom = field?.view.posAtDOM(e.currentTarget as HTMLElement) ?? null;
          e.dataTransfer?.setData(ATTACHMENT_TOKEN_MIME, p.label);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => (movingFrom = null)}
        onClick={() => setPreviewing({ block, missing: missing() })}
      >
        {p.label}
      </button>
    );
  };

  const tiles = createMemo(() => props.attachments.filter((a) => isTile(a.block)));
  const pills = createMemo(() => props.attachments.filter((a) => !isTile(a.block)));
  const [previewing, setPreviewing] = createSignal<{ block: ContentBlock; missing: boolean } | null>(null);
  // The attachment a token in the text is being hovered for.
  const [pointing, setPointing] = createSignal<string | null>(null);
  // Files gone from disk since they were attached, shared by a chip's tile and
  // its token in the text so the two never disagree.
  const [missingPaths, setMissingPaths] = createSignal<ReadonlySet<string>>(new Set());
  function markMissing(path: string, gone: boolean) {
    if (untrack(missingPaths).has(path) === gone) return;
    setMissingPaths((prev) => {
      const next = new Set(prev);
      if (gone) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  // A component rather than a factory, so each chip owns its own `missing`
  // signal and the effect that keeps asking the disk about it.
  const Chip = (p: { a: PendingBlock }) => {
    const block = p.a.block;
    // A tile is its picture, or its Seti icon in the same box, above its name.
    // A pill is prose (a hunk comment, a diagnostic) or a link with no file.
    const src = thumbSrc(block);
    const path = block.type === "fileRef" ? block.path : null;
    const token = tokenOf(block);
    const name = tileName(block);
    const note = tileNote(block);
    const tile = isTile(block);
    // Gone from disk since it was attached. The chip stays, because the
    // sentence still names it; both controls say why it is red.
    const missing = () => !!path && missingPaths().has(path);
    if (path && props.fileExists) {
      const ask = props.fileExists;
      createEffect(
        on(
          focusTick,
          () =>
            void ask(path)
              .then((ok) => markMissing(path, !ok))
              .catch(() => {}),
        ),
      );
    }
    const reason = () => (missing() && path ? `. No file at ${path}` : "");
    return (
      <div
        class={styles.attachment}
        classList={{
          [styles.attachmentTile]: tile,
          [styles.attachmentMissing]: missing(),
          [styles.attachmentPointed]: pointing() === p.a.id,
        }}
      >
        {/* Two controls, because the chip means two things: look at it, or take
            it away. Cmd+click keeps the tile's other job of naming it in the
            sentence, for one that has a token to name it by. */}
        <Tooltip
          as="button"
          type="button"
          class={styles.attachmentBody}
          label={<Tip {...attachmentTip(block, { missing: missing() })} />}
          aria-label={`Preview ${chipLabel(block)}${reason()}`}
          draggable={token !== null}
          onDragStart={(e: DragEvent) => {
            if (!token) return;
            e.dataTransfer?.setData(ATTACHMENT_TOKEN_MIME, token);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={(e: MouseEvent) => {
            if (e.metaKey && token) insertToken(token);
            else setPreviewing({ block, missing: missing() });
          }}
          // The keyboard's way to the remove button's job, on the control the
          // focus is already on.
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "Delete" && e.key !== "Backspace") return;
            e.preventDefault();
            props.onDropAttachment(p.a.id);
          }}
        >
          <Show when={tile} fallback={<span class={styles.attachmentName}>{name}</span>}>
            <span class={styles.attachmentPreview}>
              {src ? <img class={styles.attachmentThumb} src={src} alt="" /> : <FileIcon name={name} />}
            </span>
            <span class={styles.attachmentName}>{name}</span>
            <Show when={note}>
              <span class={styles.attachmentNote}>{note}</span>
            </Show>
          </Show>
        </Tooltip>
        <button
          type="button"
          class={styles.attachmentRemove}
          // Named after the action and after which attachment: an image chip's
          // own content is a picture, so without this the button answers to
          // nothing.
          aria-label={`Remove ${chipLabel(block)}${reason()}`}
          onClick={() => props.onDropAttachment(p.a.id)}
        >
          <Icon icon={X} size={12} aria-hidden="true" />
        </button>
      </div>
    );
  };

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
        <div ref={queueStrip} class={`${styles.queue} ${props.parked ? styles.queueParked : ""}`}>
          {/* Its own line, with the held queue's decision at the end of it: the
              messages are a grid of equal cells, and a label or two buttons in
              among them would be cells of another width. */}
          <div class={styles.queueHead}>
            <span class={styles.queueLabel}>
              {props.parked
                ? `${props.queue.length} message${props.queue.length > 1 ? "s" : ""} held: ${props.restored ? "saved from last time" : "the turn was stopped"}`
                : `Queued for the next turn`}
            </span>
            <Show when={props.parked}>
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
          <div class={styles.queueItems}>
            <For each={props.queue}>
              {(q) => {
                const text = () => queuedText(q);
                const attached = () => q.blocks.filter((b) => b.type !== "text");
                const named = () =>
                  text() ||
                  attached()
                    .map((b) => tokenOf(b) ?? tileName(b))
                    .join(" ");
                const row = drag.rowProps(q.id);
                return (
                  <div
                    class={styles.queueItem}
                    classList={{
                      [styles.queueItemEditing]: props.editing === q.id,
                      [styles.queueItemDragging]: drag.dragging() === q.id,
                      [styles.queueItemOver]: drag.over() === q.id,
                    }}
                    onDragOver={row.onDragOver}
                    onDrop={row.onDrop}
                  >
                    <Show when={props.onReorderQueued && props.queue.length > 1}>
                      <button
                        type="button"
                        class={styles.queueHandle}
                        draggable={true}
                        data-queue-handle={q.id}
                        aria-label={`Move in the queue: ${named()}`}
                        onDragStart={row.onDragStart}
                        onDragEnd={row.onDragEnd}
                        onKeyDown={(e) => {
                          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                          e.preventDefault();
                          moveQueued(q.id, e.key === "ArrowUp" ? -1 : 1);
                        }}
                      >
                        <Icon icon={GripVertical} size={12} aria-hidden="true" />
                      </button>
                    </Show>
                    <Tooltip<HTMLSpanElement>
                      as="span"
                      class={styles.queueText}
                      label={
                        <Tip
                          heading={
                            q.steering
                              ? "Steering the running turn"
                              : props.parked
                                ? "Held after the turn was stopped"
                                : "Queued for the next turn"
                          }
                          lines={attached().map((b) => tokenOf(b) ?? tileName(b))}
                          excerpt={excerptOf(text(), 12)}
                          hint={props.parked ? "Send now or discard the queue below" : "Drag the handle to reorder"}
                        />
                      }
                    >
                      <For each={attached()}>
                        {(b) => {
                          const src = thumbSrc(b);
                          return src ? (
                            <img class={styles.queueThumb} src={src} alt="" />
                          ) : (
                            <span class={styles.queueRef}>{tokenOf(b) ?? tileName(b)}</span>
                          );
                        }}
                      </For>
                      {text()}
                    </Tooltip>
                    <Show when={props.onEditQueued && !q.steering && props.editing !== q.id}>
                      <Tooltip
                        as="button"
                        type="button"
                        class={styles.queueAction}
                        label="Edit in the composer"
                        aria-label={`Edit: ${named()}`}
                        onClick={() => props.onEditQueued?.(q.id)}
                      >
                        <Icon icon={Pencil} size={12} aria-hidden="true" />
                      </Tooltip>
                    </Show>
                    <Show when={props.steering && props.onSteerQueued && props.editing !== q.id}>
                      <Tooltip
                        as="button"
                        type="button"
                        class={styles.queueAction}
                        label="Steer this turn with it now"
                        aria-label={`Steer now: ${named()}`}
                        disabled={!!q.steering}
                        onClick={() => props.onSteerQueued?.(q.id)}
                      >
                        <Icon icon={CornerDownRight} size={12} aria-hidden="true" />
                      </Tooltip>
                    </Show>
                    <Tooltip
                      as="button"
                      type="button"
                      class={`${styles.queueAction} ${styles.queueRemove}`}
                      label="Remove from the queue"
                      aria-label={`Remove from the queue: ${named()}`}
                      onClick={() => props.onDropQueued(q.id)}
                    >
                      <Icon icon={X} size={12} aria-hidden="true" />
                    </Tooltip>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
      <Show when={props.editing}>
        <div class={`${styles.queue} ${styles.queueEditBar}`}>
          <span class={styles.queueLabel}>Editing a queued message</span>
          <div class={styles.queueActions}>
            <Button size="sm" variant="primary" disabled={!hasContent()} onClick={() => submit()}>
              <Icon icon={Check} size={12} aria-hidden="true" /> Save
            </Button>
            <Button size="sm" onClick={() => props.onCancelEdit?.()}>
              Cancel
            </Button>
          </div>
        </div>
      </Show>
      <Show when={stashOpen()}>
        <div class={styles.completions} role="listbox" aria-label="Stashed drafts">
          <For each={stashRows()}>
            {(entry, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === stashIndex() }}
                role="option"
                aria-selected={i() === stashIndex()}
                onMouseEnter={() => setStashIndex(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setStashOpen(false);
                  props.onRestoreStash?.(entry.id);
                }}
              >
                <span class={styles.completionDesc}>{entry.text.split("\n")[0].trim() || "(attachments only)"}</span>
                <Show when={entry.chips.length}>
                  {(n) => (
                    <span class={styles.completionHint}>{n() === 1 ? "1 attachment" : `${n()} attachments`}</span>
                  )}
                </Show>
                <span class={styles.completionHint}>{ago(Math.floor(entry.at / 1000))}</span>
                {/* Pointer only: an option may hold no control of its own, and
                    Backspace is the keyboard's discard. */}
                <span
                  class={`${styles.queueAction} ${styles.queueRemove} ${styles.stashDiscard}`}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDiscardStash?.(entry.id);
                  }}
                >
                  <Icon icon={X} size={12} aria-hidden="true" />
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      {/* One menu, two sources. Above the input rather than below it: the
          composer sits at the bottom of the pane, and a menu below would open
          off-screen. */}
      <Show when={menuOpen()}>
        <div class={styles.completions} role="listbox">
          <For each={sessionHits()}>
            {(s, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === menuIndex() }}
                role="option"
                aria-selected={i() === menuIndex()}
                onMouseEnter={() => setMenuIndex(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={accept}
              >
                <span class={styles.completionName}>{sessionTitle(s)}</span>
                <span class={styles.completionDesc}>{`Session, ${s.agent ?? "claude"}`}</span>
              </button>
            )}
          </For>
          <For each={fileHits()}>
            {(path, at) => {
              const i = () => at() + sessionHits().length;
              return (
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
              );
            }}
          </For>
          <For each={navHits()}>
            {(row, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === menuIndex() }}
                role="option"
                aria-selected={i() === menuIndex()}
                onMouseEnter={() => setMenuIndex(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={accept}
              >
                <span class={styles.completionName}>{navName(row)}</span>
                <Show when={"key" in row && row.key}>
                  {(key) => <span class={styles.completionHint}>{key()}/</span>}
                </Show>
                <Show when={navDesc(row)}>{(desc) => <span class={styles.completionDesc}>{desc()}</span>}</Show>
              </button>
            )}
          </For>
          <For each={prMenu()}>
            {(hit, i) => (
              <button
                type="button"
                class={styles.completion}
                classList={{ [styles.completionActive]: i() === menuIndex() }}
                role="option"
                aria-selected={i() === menuIndex()}
                onMouseEnter={() => setMenuIndex(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={accept}
              >
                {hit.kind === "pr" ? (
                  <>
                    <span class={styles.completionName}>{prLabel(hit.pr.number)}</span>
                    <span class={styles.completionDesc}>{hit.pr.title}</span>
                  </>
                ) : (
                  <>
                    <span class={styles.completionName}>{prLabel(hit.number)}</span>
                    <span class={styles.completionDesc}>Tab to look it up, Enter sends as typed</span>
                  </>
                )}
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
                <Show when={cmd.argumentHint}>{(hint) => <span class={styles.completionHint}>{hint()}</span>}</Show>
                <Show when={cmd.description}>
                  <span class={styles.completionDesc}>{cmd.description}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.attachments.length}>
        {/* Tiles and pills in grids of their own, so the two shapes never share
            a row and every cell in a row is the same width. */}
        <div class={styles.attachments}>
          <Show when={tiles().length}>
            <div class={styles.attachmentTiles}>
              <For each={tiles()}>{(a) => <Chip a={a} />}</For>
            </div>
          </Show>
          <Show when={pills().length}>
            <div class={styles.attachmentPills}>
              <For each={pills()}>{(a) => <Chip a={a} />}</For>
            </div>
          </Show>
        </div>
      </Show>
      <AttachmentPreview
        block={previewing()?.block ?? null}
        missing={previewing()?.missing ?? false}
        onClose={() => setPreviewing(null)}
        onOpenInEditor={(path, line) =>
          emitWith<OpenInEditor>(OPEN_IN_EDITOR, line === null ? { path } : { path, line })
        }
      />
      <Show when={dragging()}>
        <div class={styles.dropHint}>{dropHint(props.uploads)}</div>
      </Show>
      <Show when={props.notice}>{(notice) => <div class={styles.composerNotice}>{notice()}</div>}</Show>
      <div class={styles.composerBox}>
        <div class={styles.inputArea}>
          <div ref={fieldHost} class={styles.inputField} />
          <Show when={dictation() !== "idle"}>
            <DictationWave levels={dictationLevels()} busy={dictation() === "transcribing"} />
          </Show>
        </div>
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
          <Show when={props.onOpenInEditor}>
            <Tooltip
              as="button"
              type="button"
              class={styles.attachButton}
              label="Open the draft in the editor"
              aria-label="Open in editor"
              disabled={props.disabled || !!props.linked}
              onClick={() => props.onOpenInEditor?.()}
            >
              <Icon icon={SquarePen} />
            </Tooltip>
          </Show>
          <Tooltip
            as="button"
            type="button"
            class={styles.attachButton}
            classList={{ [styles.micRecording]: dictation() === "recording" }}
            label={
              dictation() === "idle"
                ? "Dictate a message"
                : dictation() === "recording"
                  ? "Stop and put the words in the message"
                  : "Turning what you said into text"
            }
            aria-label={
              dictation() === "idle" ? "Dictate" : dictation() === "recording" ? "Stop dictating" : "Transcribing"
            }
            aria-busy={dictation() === "transcribing"}
            disabled={props.disabled || !!props.linked}
            onClick={() => {
              // Back to the box, so Escape reaches it while the wave covers it.
              field?.focus();
              void toggleDictation(insertSpoken);
            }}
          >
            <Icon icon={AudioWaveform} />
          </Tooltip>
          {props.controls}
          <div class={styles.composerSpacer} />
          <Show when={approxTokens(text()) >= TOKEN_READOUT_FROM}>
            <span class={styles.barNote}>about {fmtTokens(approxTokens(text()))} tokens</span>
          </Show>
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
      <Show
        when={props.linked}
        fallback={
          <Show when={inFence()}>
            <div class={styles.composerHint}>Enter adds a line inside the code block. Cmd+Enter sends.</div>
          </Show>
        }
      >
        {(name) => (
          <div class={styles.composerHint}>
            Editing in {name()}. Save there to update this draft, or{" "}
            <button type="button" class={styles.inlineAction} onClick={() => props.onUnlink?.()}>
              edit here
            </button>
            .
          </div>
        )}
      </Show>
    </div>
  );
}

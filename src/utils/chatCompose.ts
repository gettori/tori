// The chat surface's half of the insert-only write path.
//
// [[concept_safe_send]] carries composed messages (hunk comments, selection
// mentions, "ask agent to draft", diagnostics) to a PTY-backed session as one
// sanitised line of bracketed paste, because a terminal can hold nothing else.
// A chat session can: it takes content *blocks*, so a file reference keeps its
// path and line range instead of being flattened into a string the receiving end
// has to parse back.
//
// So the same request carries both readings. Every caller keeps composing its
// one-line `text` for the PTY route, and additionally offers `blocks` for a
// chat-backed target. `Terminal.tsx` picks the route, since it already owns
// which session is hosted where, and nothing else has to know.
//
// The trust boundary is unchanged and is the whole point: blocks land in the
// composer as removable chips and wait there. Nothing here sends anything.
import { createSignal } from "solid-js";
import type { ContentBlock } from "./chatTypes";

/** Where a composed message for `sessionId` should go. */
export function routeFor(sessionId: string, chatIds: ReadonlySet<string>): "chat" | "pty" {
  return chatIds.has(sessionId) ? "chat" : "pty";
}

/** An editor selection: the region, plus the text itself so the agent does not
 *  have to read the file back to see what the user meant. */
export function selectionBlocks(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
): ContentBlock[] {
  return [{ type: "fileRef", path, startLine, endLine, text: text || null }];
}

/** A whole-file `@` mention: no range, because the user named the file rather
 *  than a region of it, and inventing one would tell the agent to read less
 *  than they meant. */
export function fileMentionBlocks(path: string): ContentBlock[] {
  return [{ type: "fileRef", path, startLine: null, endLine: null, text: null }];
}

/** A Changes-panel hunk comment: the region as structure, the comment as prose.
 *  Two blocks rather than one interpolated string, so the reference survives as
 *  a reference. */
export function hunkCommentBlocks(
  path: string,
  startLine: number,
  endLine: number,
  comment: string,
): ContentBlock[] {
  return [
    { type: "fileRef", path, startLine, endLine, text: null },
    { type: "text", text: comment },
  ];
}

/** A diagnostic: same shape as a hunk comment, with the severity kept in front
 *  of the message the way the PTY wire format has it. */
export function diagnosticBlocks(
  path: string,
  startLine: number,
  endLine: number,
  severity: string,
  message: string,
): ContentBlock[] {
  return [
    { type: "fileRef", path, startLine, endLine, text: null },
    { type: "text", text: `${severity}: ${message.replace(/\s*\n\s*/g, " ").trim()}` },
  ];
}

/** A TODO: the line it sits on, then the request. One line rather than a range,
 *  because a tag marks a point and a made-up end line would claim the note
 *  covers code it says nothing about. */
export function todoBlocks(path: string, line: number, tag: string, text: string): ContentBlock[] {
  return [
    { type: "fileRef", path, startLine: line, endLine: line, text: null },
    { type: "text", text: `Fix this ${tag}: ${text.replace(/\s*\n\s*/g, " ").trim()}` },
  ];
}

// Attachment limits, enforced where a thing is *offered* rather than where it is
// sent. A file that cannot be sent must never become a chip: a chip is a promise
// that the next turn will carry it, and discovering at send time that it cannot
// costs the user the turn rather than the file.
//
// The image types are the ones the Anthropic API accepts; anything else would be
// refused at the far end, so refusing it here is the same answer sooner and with
// a readable reason.
export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type AttachCheck = { ok: true } | { ok: false; reason: string };

/** Whether one more attachment may be offered, and if not, what to tell the
 *  user. Pure, so the rule is the same wherever an attachment comes from. */
export function checkAttachment(
  file: { name: string; mediaType: string; bytes: number },
  pendingCount: number,
): AttachCheck {
  if (pendingCount >= MAX_ATTACHMENTS) {
    return { ok: false, reason: `That is more than ${MAX_ATTACHMENTS} attachments. Send some first.` };
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mediaType)) {
    return {
      ok: false,
      reason: `${file.name} is ${file.mediaType || "an unknown type"}. Images only: PNG, JPEG, GIF or WebP.`,
    };
  }
  if (file.bytes > MAX_IMAGE_BYTES) {
    const mb = (file.bytes / 1024 / 1024).toFixed(1);
    return { ok: false, reason: `${file.name} is ${mb}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit.` };
  }
  return { ok: true };
}

/** An image attachment, as the base64 content block the transport already
 *  knows how to put on the wire (measured working in Phase 1). */
export function imageBlocks(mediaType: string, base64: string): ContentBlock[] {
  return [{ type: "image", mediaType, data: base64 }];
}

/** A dropped or pasted file's bytes as base64, without the data-URI prefix the
 *  reader puts on the front. */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** One block waiting in a composer, with an id so a chip can be removed without
 *  ambiguity when two references to the same file are pending. */
export type PendingBlock = { id: string; block: ContentBlock };

const [pending, setPending] = createSignal<Record<string, PendingBlock[]>>({});

let seq = 0;

/** Offer blocks to a chat's composer. They are *not* sent: they become chips the
 *  user can remove, and they ride along with whatever is typed next. */
export function offerToComposer(sessionId: string, blocks: readonly ContentBlock[]) {
  if (!blocks.length) return;
  const added = blocks.map((block) => ({ id: `att-${++seq}`, block }));
  setPending((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), ...added] }));
}

export function pendingFor(sessionId: string): PendingBlock[] {
  return pending()[sessionId] ?? [];
}

export function dropPending(sessionId: string, id: string) {
  setPending((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? []).filter((p) => p.id !== id) }));
}

/** Take everything pending for a session, clearing it. Called when the turn that
 *  carries them is sent, and on the tab closing so a reopened chat does not
 *  inherit chips from a session that is gone. */
export function takePending(sessionId: string): ContentBlock[] {
  const held = pendingFor(sessionId);
  if (held.length) clearPending(sessionId);
  return held.map((p) => p.block);
}

export function clearPending(sessionId: string) {
  setPending((prev) => {
    if (!(sessionId in prev)) return prev;
    const next = { ...prev };
    delete next[sessionId];
    return next;
  });
}

// Per-session history of what was actually sent, for Up-arrow recall. Bounded,
// because a long session's composer should not be a transcript of its own.
const HISTORY_CAP = 50;
const [histories, setHistories] = createSignal<Record<string, string[]>>({});

// The typed half of a composer's state, kept beside the attachment half so the
// two are one thing: cleared together, moved together by send-to-new-session,
// and addressable per session by anything that is not the composer.
//
// It does *not* by itself make the draft outlive the panel - `clearComposer`
// runs on unmount, deliberately, so a closed tab leaves nothing behind. A draft
// survives a tab switch because chat tabs stay mounted while hidden (Phase 5's
// no-remount guarantee), which is a property of the tab bar.
const [drafts, setDrafts] = createSignal<Record<string, string>>({});

export function draftFor(sessionId: string): string {
  return drafts()[sessionId] ?? "";
}

export function setDraft(sessionId: string, text: string) {
  setDrafts((prev) => (prev[sessionId] === text ? prev : { ...prev, [sessionId]: text }));
}

/**
 * Put back text whose send did not land, so the user can retry without
 * retyping. [[concept_safe_send]]'s rule ("keep the typed text on anything but
 * sent"), applied to a composer that has already been cleared.
 *
 * A composer clears itself the moment a send is *handed off*, which is right
 * for a path that cannot fail from there and wrong for one that can: a chat
 * steer is refused while the session waits on a permission prompt, and that
 * answer arrives long after the input emptied.
 *
 * **Only into an empty composer.** The user may have started typing something
 * else during the round trip, and restoring over that would lose the newer text
 * to save the older one. In that case the recall history is the fallback, which
 * is why the send is recorded there whichever path it took.
 */
export function restoreDraft(sessionId: string, text: string) {
  if (!text || draftFor(sessionId)) return;
  setDraft(sessionId, text);
}

/** Everything a composer was holding, cleared together: chips, draft and recall
 *  history. A sent turn must not leave chips behind, and a closed tab must not
 *  leave any of the three for a session whose transcript is no longer on screen.
 *  One call, so a new piece of composer state cannot be forgotten in one of
 *  three teardowns. */
export function clearComposer(sessionId: string) {
  clearPending(sessionId);
  setDrafts((prev) => dropKey(prev, sessionId));
  setHistories((prev) => dropKey(prev, sessionId));
}

function dropKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function historyFor(sessionId: string): readonly string[] {
  return histories()[sessionId] ?? [];
}

/** Record a sent message. Newest first, so index 0 is the last thing sent.
 *  A repeat of the last entry is not recorded twice: pressing Up twice to
 *  resend something should not need two presses to walk back past it. */
export function pushHistory(sessionId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  setHistories((prev) => {
    const current = prev[sessionId] ?? [];
    if (current[0] === trimmed) return prev;
    return { ...prev, [sessionId]: [trimmed, ...current].slice(0, HISTORY_CAP) };
  });
}

// A session seeded to send its first turn as soon as its transport is up.
//
// The only thing in this module that leads to a send, and only because the user
// asked for one: "send this to a new chat" is a send, just at a session that
// does not exist yet. The flag is consumed rather than read, so a remount of the
// seeded tab cannot fire the turn a second time.
const [autoSend, setAutoSend] = createSignal<Record<string, boolean>>({});

/** Whether a composer holds anything worth sending. Asked *before* a session is
 *  opened for it, so an empty composer never costs a stray chat tab and the
 *  child process behind it. */
export function hasSomethingToSend(sessionId: string): boolean {
  return pendingFor(sessionId).length > 0 || draftFor(sessionId).trim().length > 0;
}

/** Move a composer's contents to another session and mark it to send on open.
 *  Reads the source's draft and chips out of this store rather than taking them
 *  as arguments, so what gets sent is exactly what was on screen. */
export function seedForSend(fromSessionId: string, toSessionId: string) {
  const blocks = takePending(fromSessionId);
  const text = draftFor(fromSessionId).trim();
  if (!blocks.length && !text) {
    // Put back what was taken: a caller that asked at the wrong moment must not
    // cost the user their chips.
    offerToComposer(fromSessionId, blocks);
    return false;
  }
  offerToComposer(toSessionId, blocks);
  setDraft(toSessionId, text);
  setAutoSend((prev) => ({ ...prev, [toSessionId]: true }));
  setDraft(fromSessionId, "");
  return true;
}

/** Whether this session was seeded to send on open. Consuming: asking twice
 *  answers false the second time. */
export function takeAutoSend(sessionId: string): boolean {
  if (!autoSend()[sessionId]) return false;
  setAutoSend((prev) => dropKey(prev, sessionId));
  return true;
}

/** How a pending block reads as a chip. */
export function chipLabel(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return "image";
  const name = block.path.split("/").pop() || block.path;
  if (block.startLine === null) return `@${name}`;
  return block.endLine !== null && block.endLine !== block.startLine
    ? `@${name}#L${block.startLine}-L${block.endLine}`
    : `@${name}#L${block.startLine}`;
}

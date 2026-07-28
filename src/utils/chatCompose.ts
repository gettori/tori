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

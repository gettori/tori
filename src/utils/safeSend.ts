// Safe-send (plan: review-to-prompt + commit flow, phase 1). The single
// routed write path for every composed message (hunk comments, editor
// selection mentions, "ask agent to draft" - phase 2): insert-only, never
// auto-submits. `sendWithProbeGate`/`sanitizeForSend`/`bracketedPaste` are
// pure and unit-tested; `requestSend` is the cross-panel entry point other
// panels call, routed to Terminal.tsx (the only owner of `pty_write` and
// tab/session state) via the SEND_TO_SESSION event pair.
import { emitWith, onWith, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, type SendToSession, type SendToSessionResult } from "./events";
import { mentionPath } from "./pathScope";

// The routing/resume fields every safe-send caller needs to name a target
// session, split out of SendToSession (which also carries the per-request
// `text`/`requestId`). Built once per panel from the app's selected session
// (or a session panel's own props) and reused across every send from it.
export type SessionTarget = Omit<SendToSession, "requestId" | "text">;

// `In @<file> lines <X>-<Y>: <comment>`, the hunk-comment wire format (plan
// phase 1, task 2). Path relativity follows the drag-mention convention
// (mentionPath): inside the target's cwd, relative; outside it, absolute.
export function composeHunkComment(target: SessionTarget, filePath: string, startLine: number, endLine: number, comment: string): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(filePath, cwd);
  return `In @${mention} lines ${startLine}-${endLine}: ${comment}`;
}

// `@<file>#L<start>-L<end>`, the editor-selection mention wire format (plan
// phase 1, task 4). Same relativity rule as composeHunkComment: inside the
// target's cwd, relative; outside it (a Shared-tree buffer), absolute.
export function composeSelectionMention(target: SessionTarget, filePath: string, startLine: number, endLine: number): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(filePath, cwd);
  return `@${mention}#L${startLine}-L${endLine}`;
}

// `@<file>#L<start>-L<end> <severity>: <message>`, the diagnostic wire format
// (plan phase 3, task 3). Same relativity rule as the composers above. The
// mention comes first so the agent reads the location before the complaint,
// matching composeSelectionMention's shape rather than inventing a third one.
// Multi-line server messages (TypeScript loves these) are flattened: a raw
// newline would submit the prompt on some agents, which would break the
// insert-only contract this whole module exists to keep.
export function composeDiagnostic(
  target: SessionTarget,
  filePath: string,
  startLine: number,
  endLine: number,
  severity: string,
  message: string,
): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(filePath, cwd);
  const flat = message.replace(/\s*\n\s*/g, " ").trim();
  return `@${mention}#L${startLine}-L${endLine} ${severity}: ${flat}`;
}

// The diagnostic wire format with the server's own fixes named after it (wave
// 7): `<the line above>. Fixes the language server offers: "A", "B".`
//
// The titles are what makes this worth sending rather than just the complaint.
// An agent reading `Cannot find name 'foo'` has to work out what to do; one
// reading that the server already offers "Add import from './bar'" has been
// handed the answer, and can apply it or say why not.
//
// Quoted, because a title is a phrase with spaces in it and an unquoted list
// reads as one long sentence. Flattened for `composeDiagnostic`'s reason: a raw
// newline in a title would submit the prompt on some agents, which would break
// the insert-only contract this module exists to keep. With no fixes it is
// exactly `composeDiagnostic`, since a trailing "Fixes: none" is noise.
export function composeDiagnosticWithFixes(
  target: SessionTarget,
  filePath: string,
  startLine: number,
  endLine: number,
  severity: string,
  message: string,
  fixes: string[],
): string {
  const base = composeDiagnostic(target, filePath, startLine, endLine, severity, message);
  const titles = fixes.map((f) => f.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  if (!titles.length) return base;
  // Server messages usually end in a full stop and occasionally do not, so the
  // separator is added only where the sentence lacks one. TypeScript's end in
  // one; rust-analyzer's often do not.
  const stop = /[.!?]$/.test(base) ? "" : ".";
  return `${base}${stop} Fixes the language server offers: ${titles.map((t) => `"${t}"`).join(", ")}.`;
}

// `@<file>#L<line> Fix this <tag>: <text>`, the TODO wire format (wave 6). Same
// relativity rule and same mention-first shape as the composers above. The
// instruction is spelled out because, unlike a diagnostic, the line itself does
// not say what is wrong: a TODO is a note to a human, so what turns it into a
// request is the sentence around it. Flattened for `composeDiagnostic`'s reason
// - a raw newline submits the prompt on some agents, which would break the
// insert-only contract this module exists to keep.
export function composeTodo(
  target: SessionTarget,
  filePath: string,
  line: number,
  tag: string,
  text: string,
): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(filePath, cwd);
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return `@${mention}#L${line} Fix this ${tag}: ${flat}`;
}

// A resumed-but-not-yet-interactive session (mid-boot) probes "not-ready" and
// gets queued; a session waiting on a permission prompt probes "blocked" and
// is refused outright (the user must answer that prompt first, not queue
// behind it); anything else probing clean is "ready" to write.
export type ProbeState = "ready" | "blocked" | "not-ready";

export type SendResult = { kind: "sent" } | { kind: "blocked" } | { kind: "timeout" };

// What a caller tells the user when the gate refuses a blocked target. One
// string rather than one per surface: the PTY route and the chat steer are
// refused by the same rule, and two wordings would read as two different rules.
export const BLOCKED_REASON = "Session is waiting for permission, answer it first.";

export type SendDeps = {
  probe: () => Promise<ProbeState>;
  write: (text: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

// Insert-only: collapses the composed text to one line (a PTY write of raw
// newlines would submit intermediate lines at the shell/agent's prompt), and
// trims incidental whitespace from multi-line paste sources (a hunk comment,
// a selection mention).
//
// **And removes every other control byte**, which matters as soon as any of
// this text comes from outside the machine. `bracketedPaste` wraps the payload
// in `ESC[200~ … ESC[201~`, so a body carrying that terminator ends the paste
// early and hands the terminal everything after it as typing; a bare escape
// sequence repaints or repositions the display instead. A review comment (phase
// 12) is written by whoever reviews the pull request, so this is the first
// composer whose input nobody here controls, and the guard belongs at the one
// point every composer passes through rather than in each of them.
//
// A tab becomes a space, because it is genuine whitespace in quoted code and
// deleting it would run two words together. Nothing else in the C0/C1 range
// carries text.
export function sanitizeForSend(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\t/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

// Bracketed paste (no trailing Enter): the payload lands in the agent's
// input buffer for the user to review and submit themselves.
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export const QUEUE_POLL_MS = 400;
export const QUEUE_TIMEOUT_MS = 15_000;

// Probe-gate + queue: re-probes immediately before every write (direct or
// queued, satisfying the flush-time re-check), refuses immediately on a
// blocked target (including one that blocks mid-wait), and gives up once the
// deadline passes without ever reaching "ready".
export async function sendWithProbeGate(text: string, deps: SendDeps): Promise<SendResult> {
  const deadline = deps.now() + QUEUE_TIMEOUT_MS;
  for (;;) {
    const state = await deps.probe();
    if (state === "blocked") return { kind: "blocked" };
    if (state === "ready") {
      await deps.write(text);
      return { kind: "sent" };
    }
    if (deps.now() >= deadline) return { kind: "timeout" };
    await deps.sleep(QUEUE_POLL_MS);
  }
}

// Guards a caller's await against a Terminal panel that never answers (not
// mounted, or torn down mid-flight) - always resolves, worst case "timeout".
const REQUEST_TIMEOUT_MS = QUEUE_TIMEOUT_MS * 2;

function requestId(): string {
  return `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

// Cross-panel entry point: fire a SEND_TO_SESSION request and resolve once
// Terminal.tsx answers with the matching SEND_TO_SESSION_RESULT. Callers
// (the hunk-comment box, the selection-mention binding) use the result to
// decide whether to clear their own input - keep the typed text on anything
// but "sent" so the user can retry without retyping.
export function requestSend(payload: Omit<SendToSession, "requestId">): Promise<SendResult> {
  const id = requestId();
  return new Promise((resolve) => {
    let settled = false;
    const off = onWith<SendToSessionResult>(SEND_TO_SESSION_RESULT, (r) => {
      if (settled || r.requestId !== id) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve({ kind: r.result });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({ kind: "timeout" });
    }, REQUEST_TIMEOUT_MS);
    emitWith<SendToSession>(SEND_TO_SESSION, { ...payload, requestId: id });
  });
}

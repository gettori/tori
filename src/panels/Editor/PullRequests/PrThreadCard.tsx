// One review conversation, with the three things you can do to it: reply,
// resolve, and hand it to the agent that wrote the branch.
//
// Its own component because two surfaces draw the same card. The panel lists a
// pull request's outdated conversations at the bottom; a diff tab draws each
// one between the rows it is anchored to. A card copied into both would be two
// places for an optimistic reply to roll back differently.
//
// The thread list itself lives in `prReviewStore`, so a reply posted from the
// tab is on the panel's card too, with no event between them.

import { createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { pendingComment, withComment, withoutComment, withResolved } from "../../../utils/reviewThreads";
import { composeThreadAsk } from "../../../utils/threadAsk";
import { BLOCKED_REASON, requestSend, type SessionTarget } from "../../../utils/safeSend";
import { branchOwner, sessionStatus } from "../../../utils/sessionActivity";
import { STATUS_LABEL } from "../../../utils/sessionStatus";
import { findAdapter } from "../../../utils/agents";
import { agentOffReason } from "../../../utils/agentEnabled";
import { setThreadsError, updateThreads } from "../../../utils/prReviewStore";
import { forgeErrorMessage, type PullRequest, type ReviewComment, type ReviewThread } from "../../../utils/forgeTypes";
import ReviewThreadView from "./ReviewThreadView";

/// Distinguishes two replies in flight at once, so each reconciles onto its own
/// optimistic comment rather than onto whichever was appended last. Module-wide
/// because the cards are per thread and the collision is across them.
let replySeq = 0;

export default function PrThreadCard(props: {
  root: string;
  pr: PullRequest;
  thread: ReviewThread;
  /** Quote the hunk it was written against. What makes a conversation with no
   *  line to sit beside readable at all. */
  quoteHunk?: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [note, setNote] = createSignal<{ text: string; ok: boolean } | null>(null);

  /** Post a reply, showing it at once and then correcting it with what the
   *  server stored. The rollback is the half that matters: a reply left on
   *  screen after a refusal is a comment only its author can see. */
  async function reply(body: string) {
    const optimistic = pendingComment(body, ++replySeq);
    const id = props.thread.id;
    updateThreads(props.root, props.pr.number, (list) => withComment(list, id, optimistic));
    try {
      const stored = await invoke<ReviewComment>("forge_reply_to_thread", {
        projectPath: props.root,
        threadId: id,
        body,
      });
      updateThreads(props.root, props.pr.number, (list) => withComment(list, id, stored, optimistic.id));
    } catch (e) {
      updateThreads(props.root, props.pr.number, (list) => withoutComment(list, id, optimistic.id));
      setThreadsError(props.root, props.pr.number, forgeErrorMessage(e));
    }
  }

  /** Resolve or unresolve. Not optimistic: unlike a reply there is nothing to
   *  read while it lands, and a card that flips back on refusal reads as a
   *  click that did the opposite of what it said. */
  async function setResolved(resolved: boolean) {
    const id = props.thread.id;
    setBusy(true);
    try {
      await invoke<void>("forge_set_thread_resolved", {
        projectPath: props.root,
        threadId: id,
        resolved,
      });
      updateThreads(props.root, props.pr.number, (list) => withResolved(list, id, resolved));
      setThreadsError(props.root, props.pr.number, null);
    } catch (e) {
      setThreadsError(props.root, props.pr.number, forgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /// The session a remark about this pull request should reach.
  ///
  /// The branch, not the selection. Every other safe-send surface in the app
  /// composes for whatever session is selected, because it is looking at that
  /// session's own working tree; this one is looking at a branch, and the
  /// session that wrote it may not be the one on screen, may be in a different
  /// worktree, and may have no tab open at all.
  const owner = createMemo(() => branchOwner(props.root, props.pr.headRef));

  const ownerTarget = createMemo<SessionTarget | null>(() => {
    const o = owner();
    if (!o) return null;
    return {
      sessionId: o.session.id,
      agent: o.session.agent ?? "claude",
      profile: o.session.profile ?? null,
      folderPath: o.folderPath,
      sessionCwd: o.session.cwd,
      sessionPath: o.session.path,
      sessionTitle: o.session.title,
      sessionFile: o.session.path,
    };
  });

  /// Who would get the thread and how they are doing, or why nobody would.
  ///
  /// One memo rather than a label beside a separate refusal, because they are
  /// the same question asked twice and a pair that could disagree is how a
  /// reason ends up printed next to a button that still works.
  ///
  /// Both refusals are about the target, never about the thread: an outdated or
  /// resolved conversation is still worth an agent's attention, and withholding
  /// it would be this card deciding what the reader meant. The readiness is the
  /// composed session status, the same one the sidebar row shows, so the two
  /// cannot disagree about a session mid-turn. `none` is not a refusal: a
  /// session with nothing running is resumed by safe-send before it writes.
  const sendTo = createMemo<{ label: string; name: string; ready: boolean }>(() => {
    const o = owner();
    if (!o) {
      const label = `Nothing has run on ${props.pr.headRef} in this project.`;
      return { label, name: "", ready: false };
    }
    const name = o.session.name || o.session.title || o.session.id;
    // An agent the user turned off first, since that is the refusal they can
    // act on without leaving the question of what this agent can do.
    const off = agentOffReason(o.session.agent ?? "claude");
    if (off) return { label: off, name, ready: false };
    if (findAdapter(o.session.agent ?? "claude").resume_args.length === 0) {
      return { label: "This agent's sessions can't be resumed", name, ready: false };
    }
    const status = sessionStatus(o.session.id);
    const how = status === "none" ? "Not running" : STATUS_LABEL[status];
    return { label: `${name} · ${how}`, name, ready: true };
  });

  async function send() {
    const target = ownerTarget();
    const home = owner();
    if (!target || !home || !sendTo().ready) return;
    // Read before the send, not after: the owner can change while a message is
    // in flight (a newer session appears, the branch moves), and a confirmation
    // naming whoever owns it *now* would name a session that received nothing.
    const to = sendTo().name;
    setSending(true);
    try {
      // The unit's own folder, not `props.root`: a worktree project's units each
      // have a checkout, and a path resolved against the panel's one would
      // mention a real file in the wrong copy of the repo.
      const text = composeThreadAsk(target, home.folderPath, props.pr.number, props.thread);
      const result = await requestSend({ ...target, text });
      if (result.kind === "sent") setNote({ text: `Sent to ${to}.`, ok: true });
      else if (result.kind === "blocked") setNote({ text: BLOCKED_REASON, ok: false });
      else setNote({ text: "Couldn't reach the session, try again.", ok: false });
    } finally {
      setSending(false);
    }
  }

  return (
    <ReviewThreadView
      thread={props.thread}
      quoteHunk={props.quoteHunk}
      busy={busy()}
      onReply={(body) => void reply(body)}
      onResolve={(resolved) => void setResolved(resolved)}
      send={{
        label: sendTo().label,
        ready: sendTo().ready,
        busy: sending(),
        note: note(),
        onSend: () => void send(),
      }}
    />
  );
}

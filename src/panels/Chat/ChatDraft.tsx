// A chat tab before it has a session: the composer, and nothing behind it.
//
// This is the whole of the draft state. No child process is spawned, no session
// id is minted, no claim is taken and nothing is registered as live, so a tab
// opened and never used costs a tab record and this component. The first send is
// what turns it into a chat: the message is held, the tab record is replaced
// with the session id it minted, and `ChatView` mounts in its place and sends
// the held message once the transport can take a turn.
//
// Kept apart from `ChatView` rather than folded in as a null-session mode: forty
// of that component's call sites are only meaningful with a session id, and
// making them all narrow a nullable one would trade a small duplicate shell for
// a large permanent lie. What the two genuinely share - what an `@` mention
// means - is shared as code (`composerAttachments`), not by living together.
import { createSignal } from "solid-js";
import { Show } from "solid-js";
import Composer from "./Composer";
import { composerAttachments } from "./composerAttachments";
import { dropPending, draftFor, historyFor, markAutoSend, pendingFor, setDraft } from "../../utils/chatCompose";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import styles from "./Chat.module.css";

export default function ChatDraft(props: {
  /** This tab, which is also the composer's key: a draft has no session id to
   *  file what was typed under, and minting one per send attempt is what keeps a
   *  reverted attempt's id from ever being reused. */
  tabId: string;
  cwd: string;
  active: boolean;
  /** Why the last first-send attempt did not reach a session. Rendered above the
   *  composer, because it is the thing that decides what the user does next. */
  error?: string;
  /** Mint a session and spawn it. The held message rides along on the other
   *  side, so this takes nothing and returns nothing. */
  onStart: () => void;
}) {
  // Set the moment a send is accepted and never cleared: this surface is on its
  // way out, and the only thing left to stop is a second Enter landing in the
  // window before the swap has drawn.
  const [starting, setStarting] = createSignal(false);
  const attachments = composerAttachments(
    () => props.tabId,
    () => props.cwd,
  );

  function onSend(text: string) {
    if (starting()) return;
    const trimmed = text.trim();
    // Attachment-only is a valid thing to send, so the chips count too. Nothing
    // at all is not: an empty send would cost a process and a session id.
    if (!trimmed && !pendingFor(props.tabId).length) return;
    setStarting(true);
    markAutoSend(props.tabId, trimmed);
    // After the composer has finished its own submit - it clears the input right
    // after this returns - so replacing the tab record cannot race a write to a
    // surface that is already gone.
    queueMicrotask(() => props.onStart());
  }

  return (
    <div class={`${styles.chat} ${props.active ? styles.active : ""}`}>
      <Show when={props.error}>
        {(message) => (
          <div class={styles.banner}>
            <span class={styles.bannerText}>{message()}</span>
          </div>
        )}
      </Show>

      {/* Where the transcript will be. Empty rather than explained: a chat that
          has not started has nothing to say about itself, and a placeholder
          would be chrome the user reads once and then reads past forever. */}
      <div class={styles.draftFill} />

      <Composer
        running={false}
        steering={false}
        steerCost={null}
        queue={[]}
        attachments={pendingFor(props.tabId)}
        draft={draftFor(props.tabId)}
        onDraftChange={(t) => setDraft(props.tabId, t)}
        history={historyFor(props.tabId)}
        // Empty on purpose: an agent's commands come from its handshake, and no
        // agent has been asked anything yet. Offering a stale set from the last
        // one would promise commands this chat may not have.
        commands={[]}
        held={false}
        disabled={starting()}
        loadFiles={attachments.loadProjectFiles}
        onSend={onSend}
        onAttachFile={attachments.onAttachFile}
        onAttachPaths={attachments.onAttachPaths}
        onAttachImages={attachments.onAttachImages}
        onAttachRejected={(reason) => emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" })}
        onDropAttachment={(id) => dropPending(props.tabId, id)}
        // A draft has no turn to interrupt and no queue to hold one: all three
        // are reachable only once something is running.
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onSendQueued={() => {}}
        onDiscardQueued={() => {}}
      />
    </div>
  );
}

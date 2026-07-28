import { Show, createSignal } from "solid-js";
import Button from "../../components/Button/Button";
import type { PermissionDecision, PermissionScope } from "../../utils/chatTypes";
import type { ToolItem } from "./chatStore";
import { toolDigest, toolRenderer } from "./toolRenderers";
import styles from "./Chat.module.css";

export type Answer = {
  decision: PermissionDecision;
  scope: PermissionScope;
  reason: string | null;
};

/** The tool input, in full, as the thing being approved.
 *
 *  Deliberately the raw arguments rather than a summary: a one-line gloss is
 *  what the transcript row already shows, and approving a call on the strength
 *  of a gloss is approving something you have not read. Pretty-printed because
 *  a `MultiEdit` payload on one line is unreadable. */
function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * The approval gate, attached to its tool card by `tool_use_id`.
 *
 * The question reads as a sentence ("Run `cmd` in this workspace?") because
 * that is the decision actually being made; the raw arguments stay one
 * disclosure away for anything the digest cannot carry, so the sentence is a
 * headline over the evidence rather than a replacement for it.
 *
 * Five answers, which are three decisions crossed with how far they reach:
 * allow this call, allow it for this session, allow it for this project (a
 * Sway-owned rule, never `~/.claude/settings.json`), deny, or deny with a
 * typed reason. The reason is not cosmetic - it reaches the model as the tool
 * result, so "not that file, use the fixture" redirects the turn instead of
 * just stopping it.
 */
export default function PermissionPrompt(props: { card: ToolItem; onAnswer: (answer: Answer) => void }) {
  const [feedback, setFeedback] = createSignal<string | null>(null);
  const [showInput, setShowInput] = createSignal(false);

  const allow = (scope: PermissionScope) => props.onAnswer({ decision: "allow", scope, reason: null });

  function sendDenial() {
    const reason = (feedback() ?? "").trim();
    props.onAnswer({ decision: "deny", scope: "once", reason: reason || null });
  }

  const digest = () => toolDigest(props.card);

  return (
    <div class={styles.prompt}>
      <div class={styles.promptQuestion}>
        <Show
          when={toolRenderer(props.card.name) === "bash"}
          fallback={
            <>
              Allow <code>{props.card.name ?? "this tool"}</code>
              <Show when={digest()}>
                {(d) => (
                  <>
                    {" on "}
                    <code>{d()}</code>
                  </>
                )}
              </Show>
              ?
            </>
          }
        >
          Run <code>{digest()}</code> in this workspace?
        </Show>
      </div>

      <button
        type="button"
        class={styles.promptDisclose}
        aria-expanded={showInput()}
        onClick={() => setShowInput(!showInput())}
      >
        {showInput() ? "Hide the full arguments" : "Show the full arguments"}
      </button>
      <Show when={showInput()}>
        <pre class={styles.promptInput}>{inputText(props.card.input)}</pre>
      </Show>

      <Show
        when={feedback() === null}
        fallback={
          <div class={styles.promptFeedback}>
            <textarea
              class={styles.promptReason}
              rows="2"
              autofocus
              placeholder="Why not, and what to do instead. This reaches the model as the tool result."
              value={feedback() ?? ""}
              onInput={(e) => setFeedback(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendDenial();
                }
              }}
            />
            <div class={styles.promptActions}>
              <Button size="sm" variant="primary" onClick={sendDenial}>
                Send denial
              </Button>
              <Button size="sm" onClick={() => setFeedback(null)}>
                Back
              </Button>
            </div>
          </div>
        }
      >
        <div class={styles.promptActions}>
          <Button size="sm" variant="primary" onClick={() => allow("once")}>
            Allow once
          </Button>
          <Button size="sm" onClick={() => allow("session")}>
            Allow for this session
          </Button>
          <Button size="sm" onClick={() => allow("project")}>
            Always in this project
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onAnswer({ decision: "deny", scope: "once", reason: null })}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFeedback("")}>
            Deny with feedback
          </Button>
        </div>
      </Show>
    </div>
  );
}

import { For, Show, Switch, Match, createSignal, createResource } from "solid-js";
import { ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../utils/diffHunks";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { isUnderPath } from "../../utils/pathScope";
import PermissionPrompt, { type Answer } from "./PermissionPrompt";
import { formatDuration, isEditTool, toolDigest, toolPaths, toolRenderer } from "./toolRenderers";
import type { ToolItem } from "./chatStore";
import type { PermissionMode } from "../../utils/chatTypes";
import styles from "./Chat.module.css";
import Tooltip from "../../components/Tooltip/Tooltip";

/** `ToolDiff` from `chat/commands.rs`. */
type ToolDiff = { path: string; diff: string | null; created: boolean };

/** One rendered hunk, identified the way the backend re-checks it: by the hash
 *  of what was on screen, not by its position in a diff that may have moved. */
export type HunkRef = {
  toolUseId: string;
  path: string;
  hunkIndex: number;
  fingerprint: string;
};

const STATE_LABEL: Record<ToolItem["state"], string> = {
  awaitingApproval: "Waiting for approval",
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
};

function prettyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) return styles.diffAdd;
  if (line.startsWith("-")) return styles.diffDel;
  return styles.diffCtx;
}

/**
 * One tool call.
 *
 * Collapsed it is a row: name, the argument that distinguishes this call,
 * duration, status. Expanded it is the full input, the output, and - for a
 * writing tool - the real diff of what it changed, computed against the
 * before-state the approval hook captured on the way past rather than against
 * whatever the working tree looks like now. That distinction is the point when
 * several chats share one tree.
 *
 * Every path is clickable, because a transcript that names a file and cannot
 * open it is making the user do the lookup.
 */
export default function ToolCallCard(props: {
  card: ToolItem;
  sessionId: string;
  cwd: string;
  onAnswer: (card: ToolItem, answer: Answer) => void;
  onSetMode: (mode: PermissionMode) => void;
  /** Undo one hunk. Resolves true when the file was actually rewritten, which is
   *  when the card's diff has to be re-read. */
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
}) {
  const [open, setOpen] = createSignal(false);
  const [reverting, setReverting] = createSignal<string | null>(null);
  // Whether the user asked for the whole output. Reset when the card closes, so
  // a reopened card fetches again rather than showing a body the backend may
  // have evicted since.
  const [wantFull, setWantFull] = createSignal(false);
  const renderer = () => toolRenderer(props.card.name);
  const settled = () => props.card.state === "ok" || props.card.state === "error";

  // Fetched when the card is opened and the call has finished, never on every
  // card: a diff is a `git diff` per file, and a turn can make dozens of calls.
  const [diffs, { refetch }] = createResource(
    () => (open() && settled() && isEditTool(props.card.name) ? props.card.toolUseId : null),
    async (toolUseId) =>
      await invoke<ToolDiff[]>("chat_tool_diff", {
        sessionId: props.sessionId,
        toolUseId,
        cwd: props.cwd,
      }).catch(() => [] as ToolDiff[]),
  );

  // Only once the user asks, and only while the card is open: an output over
  // the cap is large by definition, and a turn can make dozens of calls.
  const [fullOutput] = createResource(
    () => (open() && wantFull() ? props.card.toolUseId : null),
    async (toolUseId) =>
      await invoke<string | null>("chat_tool_output", {
        sessionId: props.sessionId,
        toolUseId,
      }).catch(() => null),
  );

  function toggleOpen() {
    if (open()) setWantFull(false);
    setOpen(!open());
  }

  function openPath(path: string, line?: number) {
    // A path outside the workspace is a real case, not a bug: a tool can read a
    // system header or a file in another project. Saying so beats opening an
    // editor tab on something the user did not expect.
    if (!isUnderPath(path, props.cwd)) {
      emitWith<ToastEvent>(TOAST, { message: `${path} is outside this workspace.`, kind: "info" });
      return;
    }
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, line });
  }

  // Re-read after a successful revert rather than patched locally: the diff the
  // next click is checked against is the one the backend recomputes, so a card
  // still showing the reverted hunk would be an invitation to a refusal.
  async function revertHunk(path: string, index: number, header: string, lines: string[]) {
    const key = `${path}:${index}`;
    if (reverting()) return;
    setReverting(key);
    try {
      const done = await props.onRevertHunk({
        toolUseId: props.card.toolUseId,
        path,
        hunkIndex: index,
        fingerprint: hunkFingerprint(header, lines),
      });
      if (done) void refetch();
    } finally {
      setReverting(null);
    }
  }

  return (
    <div class={`${styles.tool} ${props.card.state === "awaitingApproval" ? styles.toolBlocked : ""}`}>
      <button type="button" class={styles.toolRow} onClick={toggleOpen} aria-expanded={open()}>
        <span class={styles.toolCaret} classList={{ [styles.toolCaretOpen]: open() }} aria-hidden="true">
          <Icon icon={ChevronRight} size={12} />
        </span>
        <span
          class={styles.toolName}
          classList={{
            [styles.toolNameEdit]: isEditTool(props.card.name),
            [styles.toolNameError]: props.card.state === "error" || props.card.state === "denied",
          }}
        >
          {/* The agent's prose wins where there is any, which is what keeps an
              ACP row reading "Read the file README.md" rather than "read".
              Phase 5 gives the token and the prose separate places to sit; this
              is the one-slot version until then. */}
          {props.card.title ?? props.card.name ?? "tool"}
        </span>
        <span class={styles.toolArg}>{toolDigest(props.card)}</span>
        <Show when={formatDuration(props.card.durationMs)}>
          {(d) => <span class={styles.toolDuration}>{d()}</span>}
        </Show>
        {/* "Done" earns no label: a settled call's row already reads as done,
            and captioning every one would caption the whole transcript. */}
        <Show when={props.card.state !== "ok"}>
          <span class={styles.toolState}>{STATE_LABEL[props.card.state]}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div class={styles.toolBody}>
          {/* The paths this call touched, as the way into the editor. */}
          <Show when={toolPaths(props.card).length}>
            <div class={styles.toolPaths}>
              <For each={toolPaths(props.card)}>
                {(path) => (
                  <Tooltip
                    as="button"
                    type="button"
                    class={styles.toolPath}
                    label={`Open ${path}`}
                    aria-label={`Open ${path}`}
                    onClick={() => openPath(path)}
                  >
                    {path}
                  </Tooltip>
                )}
              </For>
            </div>
          </Show>

          <Switch>
            {/* A shell command is read as a command, not as JSON with a
                "command" key in it. */}
            <Match when={renderer() === "bash"}>
              <pre class={`${styles.toolPre} ${styles.toolCommand}`}>{toolDigest(props.card)}</pre>
            </Match>
            <Match when={renderer() !== "bash"}>
              <pre class={styles.toolPre}>{prettyInput(props.card.input)}</pre>
            </Match>
          </Switch>

          {/* The diff, for a call that wrote something. */}
          <Show when={isEditTool(props.card.name) && settled()}>
            <Show
              when={!diffs.loading}
              fallback={<div class={styles.toolNote}>Reading what changed...</div>}
            >
              <For each={diffs()}>
                {(d) => (
                  <div class={styles.toolDiff}>
                    <button type="button" class={styles.toolPath} onClick={() => openPath(d.path)}>
                      {d.path}
                      <Show when={d.created}>
                        <span class={styles.toolBadge}>new</span>
                      </Show>
                    </button>
                    <Show
                      when={d.diff}
                      fallback={
                        <div class={styles.toolNote}>
                          No before-state was captured for this call, so there is nothing to diff against. Open the file
                          to see it as it is now.
                        </div>
                      }
                    >
                      {(text) => (
                        <For
                          each={parseDiffHunks(text())}
                          fallback={<div class={styles.toolNote}>The file is unchanged.</div>}
                        >
                          {(hunk, index) => (
                            <div class={styles.hunk}>
                              <div class={styles.hunkHeaderRow}>
                                {/* The visible text is the hunk header, so the
                                    name says what opening it does, and which
                                    line it lands on. */}
                                <Tooltip
                                  as="button"
                                  type="button"
                                  class={`${styles.diffLine} ${styles.hunkHeader}`}
                                  label="Open at this line"
                                  aria-label={`Open at line ${hunk.startLine}`}
                                  onClick={() => openPath(d.path, hunk.startLine)}
                                >
                                  {hunk.header}
                                </Tooltip>
                                <Tooltip
                                  as="button"
                                  type="button"
                                  class={styles.hunkRevert}
                                  label="Undo this hunk in the working tree"
                                  disabled={reverting() !== null}
                                  onClick={() => void revertHunk(d.path, index(), hunk.header, hunk.lines)}
                                >
                                  {reverting() === `${d.path}:${index()}` ? "Reverting..." : "Revert"}
                                </Tooltip>
                              </div>
                              <For each={hunk.lines}>
                                {(line) => <div class={`${styles.diffLine} ${diffLineClass(line)}`}>{line || " "}</div>}
                              </For>
                            </div>
                          )}
                        </For>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>

          <Show when={props.card.output}>
            {(output) => (
              <>
                <pre class={`${styles.toolPre} ${styles.toolOutput}`}>{fullOutput() ?? output()}</pre>
                {/* Absent unless there is more to show, so a card whose output
                    fitted looks exactly as it did before. */}
                <Show when={props.card.outputTruncated}>
                  <Switch>
                    <Match when={!wantFull()}>
                      <button type="button" class={styles.toolMore} onClick={() => setWantFull(true)}>
                        Show full output
                      </button>
                    </Match>
                    <Match when={fullOutput.loading}>
                      <span class={styles.toolNote}>Loading...</span>
                    </Match>
                    {/* The backend keeps a bounded number of these, so an old
                        card can outlive its own output. Saying so beats a
                        button that does nothing. */}
                    <Match when={fullOutput() === null}>
                      <span class={styles.toolNote}>The rest of this output is no longer held.</span>
                    </Match>
                  </Switch>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>

      {/* The prompt lives on the card rather than in a dialog: what is being
          approved is this call, and a modal would hide the transcript that
          explains why it was made. */}
      <Show when={props.card.approval}>
        <PermissionPrompt
          card={props.card}
          onAnswer={(answer) => props.onAnswer(props.card, answer)}
          onSetMode={props.onSetMode}
        />
      </Show>
    </div>
  );
}

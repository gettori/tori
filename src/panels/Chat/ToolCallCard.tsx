import { For, Show, Switch, Match, createEffect, createMemo, createSignal, createResource } from "solid-js";
import { ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../utils/diffHunks";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { isUnderPath, mentionPath } from "../../utils/pathScope";
import PermissionPrompt, { type Answer } from "./PermissionPrompt";
import { DiffView, ToolDiff, ToolInput, ToolOutput } from "./ToolBody";
import { toolDiffBody, unifiedHunks } from "./toolDiff";
import { langOfPath } from "./highlight";
import { formatDuration, isEditCall, toolDigest, toolPaths, toolRenderer, toolSummaryText } from "./toolRenderers";
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
  /** Later writes to the same file that folded onto this card. Each keeps its
   *  own identity: this card draws their diffs, and nothing else about them
   *  moves. */
  also?: ToolItem[];
  sessionId: string;
  cwd: string;
  onAnswer: (card: ToolItem, answer: Answer) => void;
  onSetMode: (mode: PermissionMode) => void;
  /** Undo one hunk. Resolves true when the file was actually rewritten, which is
   *  when the card's diff has to be re-read. */
  onRevertHunk: (ref: HunkRef) => Promise<boolean>;
  /** The subagent this call launched, when it launched one. A finished lane
   *  leaves the strip above the composer, so this card is the way back to what
   *  it did. */
  lane?: string | null;
  onOpenLane?: (agentId: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  // Whether the user asked to see what is different on disk *now*, which is the
  // question the revert control answers and the only one worth a `git diff` per
  // file. The card's own diff is drawn from the call itself and costs nothing.
  const [showTree, setShowTree] = createSignal(false);
  const [reverting, setReverting] = createSignal<string | null>(null);
  // Whether the user asked for the whole output. Reset when the card closes, so
  // a reopened card fetches again rather than showing a body the backend may
  // have evicted since.
  const [wantFull, setWantFull] = createSignal(false);
  const renderer = () => toolRenderer(props.card);
  const group = () => [props.card, ...(props.also ?? [])];
  // The argument that names this call, with the workspace prefix taken off. A
  // row is 80 characters wide and `/Users/me/Projects/...` is 40 of them before
  // the part anyone is reading.
  const arg = () => mentionPath(toolDigest(props.card), props.cwd);
  // Every other path the call touched. The one already in the row is not
  // repeated underneath it.
  const chips = () => toolPaths(props.card).filter((p) => p !== toolDigest(props.card));
  const written = () => {
    const s = summary();
    return s?.type === "edit" ? { added: s.added, removed: s.removed } : null;
  };
  // One row for the group, so the numbers have to be the group's. Summed rather
  // than taken from the first, which would report a third of the change.
  const summary = createMemo(() => {
    const parts = group()
      .map((c) => c.summary)
      .filter((s): s is NonNullable<typeof s> => s?.type === "edit");
    if (parts.length < 2) return props.card.summary;
    return {
      type: "edit" as const,
      added: parts.reduce((n, s) => n + (s.type === "edit" ? s.added : 0), 0),
      removed: parts.reduce((n, s) => n + (s.type === "edit" ? s.removed : 0), 0),
    };
  });
  const settled = () => props.card.state === "ok" || props.card.state === "error";

  // Show the plumbing when it breaks, and only when *this tab watched it
  // break*. The card mounts already failed for a failure read off a transcript
  // or replayed by an ACP agent on reconnect, and those were dealt with long
  // ago: opening them would open ten cards every time the app restarts. A live
  // failure mounts running and changes under us, which is the whole signal.
  let lastState = props.card.state;
  createEffect(() => {
    const state = props.card.state;
    const changed = state !== lastState;
    lastState = state;
    if (changed && (state === "error" || state === "denied")) setOpen(true);
  });

  // Fetched only once the user opens the revert surface, never on every card: a
  // diff is a `git diff` per file, and a turn can make dozens of calls.
  const [diffs, { refetch }] = createResource(
    () => (showTree() && settled() && isEditCall(props.card) ? props.card.toolUseId : null),
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
    const next = !open();
    if (!next) {
      setWantFull(false);
      setShowTree(false);
    }
    setOpen(next);
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
            [styles.toolNameEdit]: isEditCall(props.card),
            [styles.toolNameError]: props.card.state === "error" || props.card.state === "denied",
          }}
        >
          {/* The agent's prose wins where there is any, which is what keeps an
              ACP row reading "Read the file README.md" rather than "read". The
              kind it would otherwise show now picks the body instead. */}
          {props.card.title ?? props.card.name ?? "tool"}
        </span>
        <span class={styles.toolArg}>{arg()}</span>
        {/* What the call did, once it has said. A row with no summary is the
            row exactly as it was before this existed. A write says it in two
            numbers that carry their own verdict, so those get the diff's own
            colours rather than one grey string. */}
        <Switch>
          <Match when={written()}>
            {(counts) => (
              <span class={styles.toolSummary}>
                <span class={styles.diffAddCount}>+{counts().added}</span>{" "}
                <span class={styles.diffDelCount}>-{counts().removed}</span>
              </span>
            )}
          </Match>
          <Match when={toolSummaryText(summary())}>
            {(text) => <span class={styles.toolSummary}>{text()}</span>}
          </Match>
        </Switch>
        <Show when={formatDuration(props.card.durationMs)}>
          {(d) => <span class={styles.toolDuration}>{d()}</span>}
        </Show>
        {/* "Done" earns no label: a settled call's row already reads as done,
            and captioning every one would caption the whole transcript. */}
        <Show when={props.card.state !== "ok"}>
          <span class={styles.toolState}>{STATE_LABEL[props.card.state]}</span>
        </Show>
      </button>

      {/* Its own row rather than a control inside the one above, which is a
          button: a button inside a button is invalid, and the disclosure and
          the lane are two different destinations. */}
      <Show when={props.lane && props.onOpenLane}>
        <button
          type="button"
          class={styles.toolLane}
          onClick={() => props.onOpenLane?.(props.lane!)}
        >
          Read what this subagent did
        </button>
      </Show>

      <Show when={open()}>
        <div class={styles.toolBody}>
          {/* The paths this call touched, as the way into the editor. */}
          <Show when={chips().length}>
            <div class={styles.toolPaths}>
              <For each={chips()}>
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

          {/* One diff for the whole group. Rendering each folded call's own
              body would put them back in the separate blocks folding removed. */}
          <Show
            when={renderer() === "edit" && group().some((c) => toolDiffBody(c.patch, c.input))}
            fallback={<For each={group()}>{(c) => <ToolInput card={c} renderer={renderer()} onOpen={openPath} />}</For>}
          >
            <ToolDiff cards={group()} onOpen={openPath} />
          </Show>

          {/* What is different **on disk now**, which is a different question
              from what this call changed, and the only one revert can act on.
              Behind a control because it is a `git diff` per file and because
              the card's own diff already answered "what did this call do". */}
          <Show when={isEditCall(props.card) && settled()}>
            <Show when={showTree()} fallback={
              <button type="button" class={styles.toolMore} onClick={() => setShowTree(true)}>
                Compare with the file on disk
              </button>
            }>
              <Show when={!diffs.loading} fallback={<div class={styles.toolNote}>Reading what changed...</div>}>
                <For
                  each={diffs()}
                  fallback={
                    <div class={styles.toolNote}>
                      No before-state was captured for this call, so there is nothing to compare against. That is
                      normal for a conversation reopened from history.
                    </div>
                  }
                >
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
                            No before-state was captured for this call, so there is nothing to diff against. Open the
                            file to see it as it is now.
                          </div>
                        }
                      >
                        {(text) => (
                          <Show
                            when={parseDiffHunks(text()).length}
                            fallback={<div class={styles.toolNote}>The file is unchanged.</div>}
                          >
                            <DiffView
                              hunks={unifiedHunks(text())}
                              lang={langOfPath(d.path)}
                              path={d.path}
                              onOpen={openPath}
                              action={(_, index) => (
                                <Tooltip
                                  as="button"
                                  type="button"
                                  class={styles.hunkRevert}
                                  label="Undo this hunk in the working tree"
                                  disabled={reverting() !== null}
                                  onClick={() => {
                                    const hunk = parseDiffHunks(text())[index];
                                    void revertHunk(d.path, index, hunk.header, hunk.lines);
                                  }}
                                >
                                  {reverting() === `${d.path}:${index}` ? "Reverting..." : "Revert"}
                                </Tooltip>
                              )}
                            />
                          </Show>
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </Show>

          {/* An edit's own answer is a sentence saying the write worked, which
              the diff above already says and says better. A failure's answer is
              the only place the reason is, so it always shows. */}
          <Show when={renderer() === "edit" && props.card.state === "ok" ? null : props.card.output}>
            {(output) => (
              <>
                <ToolOutput
                  card={props.card}
                  renderer={renderer()}
                  text={fullOutput() ?? output()}
                  onOpen={openPath}
                />
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

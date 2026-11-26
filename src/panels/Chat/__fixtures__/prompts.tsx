import { For, onCleanup, createSignal, createStore, runWithOwner } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import ToolCallCard from "../ToolCallCard";
import AskCard from "../AskCard";
import type { Answer } from "../PermissionPrompt";
import type { ToolItem } from "../chatStore";
import { asksFor, closeAsk, showAsk, type SocketAsk } from "../../../utils/socketAsks";
import type { HostHandler } from "../../../dev/stubHost";
import styles from "../Chat.module.css";

const SESSION = "kitchen-prompts";
const CWD = "/Users/dev/tori";
const ANSWER_MS = 1200;

function waiting(over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id: "tool",
    turnId: "turn-1",
    toolUseId: "toolu",
    agentId: null,
    name: "Bash",
    title: null,
    toolKind: "execute",
    locations: [],
    input: null,
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    state: "awaitingApproval",
    durationMs: null,
    approval: { requestId: "req", autoDenyAtMs: null, agentId: null, suggestions: [] },
    edits: [],
    secret: null,
    blindEdits: [],
    submodules: [],
    files: [],
    ...over,
  };
}

const PROMPTS = (): ToolItem[] => [
  waiting({
    id: "tool-edit",
    toolUseId: "toolu_edit",
    name: "Edit",
    toolKind: "edit",
    input: {
      file_path: `${CWD}/src/panels/Chat/Composer.tsx`,
      old_string: "const drawn = new Set<string>();",
      new_string: "const drawn = new Set<string>(); // keyed by id",
    },
    approval: {
      requestId: "req-edit",
      autoDenyAtMs: null,
      agentId: null,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
  }),
  waiting({
    id: "tool-bash",
    toolUseId: "toolu_bash",
    input: {
      command:
        "pnpm exec vp test run src/panels/Chat/MessageList.test.tsx src/panels/Chat/LaneStrip.test.tsx src/panels/Chat/ToolCallCard.test.tsx src/panels/Chat/Markdown.test.tsx --reporter=verbose",
    },
    approval: { requestId: "req-bash", autoDenyAtMs: null, agentId: null, suggestions: [] },
  }),
];

const PR_BODY = [
  "## Summary",
  "",
  "Rows that arrive while you watch rise in once; history, lane switches and regroups draw without moving.",
  "",
  "## What changed",
  "",
  "- MessageList checks that the rows it already drew stay in front and at most three follow.",
  "- The status and lane dots breathe on the Thinking label's tempo while a turn runs.",
  "- The work card rotates one chevron like a tool card.",
  "- Code block buttons fade in, and a copy shows a check while it holds.",
  "- Tool, hook and notice rows toggle their state classes with classList.",
  "",
  "## How to test",
  "",
  "1. Open Design/Kitchen sink and find the Transcript section.",
  "2. Send a prompt, steer while it runs, then run an agent turn.",
  "3. Deliver history, switch to the subagent lane and back, collapse work.",
  "4. Only the rows from steps 2 rise; nothing in step 3 moves.",
].join("\n");

const ASKS = (): SocketAsk[] => [
  {
    id: "ask-pr",
    session: SESSION,
    question: "Open this pull request?",
    options: ["Approve", "Reject"],
    approval: {
      project: "tori",
      action: "pr.create",
      head: "ui-rework",
      base: "main",
      title: "Rise new transcript rows in once, and pulse the busy dots",
      body: PR_BODY,
      draft: false,
      head_sha: "0a201512",
    },
  },
  {
    id: "ask-merge",
    session: SESSION,
    question: "Merge pull request 412?",
    options: ["Approve", "Reject"],
    approval: { project: "tori", action: "pr.merge", number: 412, method: "squash", head_sha: "0a201512" },
  },
];

const [heard, setHeard] = createSignal<string[]>([]);
const [failNext, setFailNext] = createSignal(false);

export const promptsHost: HostHandler = (cmd, args) => {
  if (cmd === "chat_respond_permission") {
    setHeard((h) => [...h, `${String(args.toolUseId)}: ${String(args.decision)} ${String(args.scope)}`]);
    return null;
  }
  if (cmd === "rpc_ask_answer") {
    let fail = false;
    setFailNext((was) => {
      fail = was;
      return false;
    });
    setHeard((h) => [...h, `${String(args.id)}: ${String(args.answer)}${fail ? ", failed" : ""}`]);
    return new Promise((resolve, reject) =>
      setTimeout(() => (fail ? reject(new Error("the asker went away")) : resolve(true)), ANSWER_MS),
    );
  }
  return undefined;
};

export function createPrompts() {
  const [store, setStore] = createStore({ cards: PROMPTS() });
  const askAgain = () => {
    setStore((s) => {
      s.cards = PROMPTS();
    });
    ASKS().forEach(showAsk);
  };
  runWithOwner(null, askAgain);
  onCleanup(() => ASKS().forEach((a) => closeAsk(a.id)));
  return {
    cards: () => store.cards,
    askAgain,
    failNext,
    setFailNext,
    heard,
    answer(card: ToolItem, answer: Answer) {
      setStore((s) => {
        for (const c of s.cards) {
          if (c.toolUseId === card.toolUseId) {
            c.state = "running";
            c.approval = null;
          }
        }
      });
      void invoke("chat_respond_permission", {
        sessionId: SESSION,
        requestId: card.approval?.requestId,
        toolUseId: card.toolUseId,
        decision: answer.decision,
        scope: answer.scope,
        reason: answer.reason,
      });
    },
  };
}

export type Prompts = ReturnType<typeof createPrompts>;

export function PromptsPane(props: { prompts: Prompts }) {
  return (
    <div
      class={`${styles.chat} ${styles.active}`}
      style={{ position: "static", "min-width": "0", gap: "var(--tori-space-5)" }}
    >
      <div class={styles.list} style={{ overflow: "visible" }}>
        <For each={props.prompts.cards()}>
          {(card) => (
            <ToolCallCard
              card={card}
              sessionId={SESSION}
              cwd={CWD}
              onAnswer={(c, a) => props.prompts.answer(c, a)}
              onSetMode={() => {}}
              onRevertHunk={() => Promise.resolve(false)}
            />
          )}
        </For>
      </div>
      <For each={asksFor(SESSION)}>{(ask) => <AskCard ask={ask} here={SESSION} />}</For>
    </div>
  );
}

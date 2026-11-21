import { createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import MessageList from "../MessageList";
import StatusStrip from "../StatusStrip";
import LaneStrip from "../LaneStrip";
import {
  applyEvent,
  backgroundTasks,
  blockedLanes,
  connectionHealth,
  initialChat,
  isRunning,
  laneStrip,
  outstandingBackground,
  prependHistory,
  pushSteer,
  pushUserTurn,
  selectLane,
  visibleItems,
  type ChatState,
} from "../chatStore";
import type { ChatEvent, Usage } from "../../../utils/chatTypes";
import styles from "../Chat.module.css";

const SESSION = "kitchen-transcript";
const CWD = "/Users/dev/tori";
const HISTORY_PAGES = 3;
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 };

type Frame = ChatEvent extends infer E ? (E extends { sessionId: string } ? Omit<E, "sessionId"> : never) : never;
const frame = (f: Frame) => ({ ...f, sessionId: SESSION }) as ChatEvent;

const THOUGHT =
  "The pane stays mounted while it is hidden, so an entrance that replays on display would fire on every tab switch.";

const REPLY = [
  "The class comes off once the animation ends, so showing the pane again has nothing left to play:",
  "",
  "```ts",
  'el.addEventListener("animationend", finish);',
  "el.classList.add(className);",
  "```",
  "",
  "Three callers use it today, all on rows that arrive while the reader watches.",
].join("\n");

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function turnScript(n: number, agentInitiated: boolean): [number, ChatEvent][] {
  const turnId = `turn-${n}`;
  const lane = `lane-${n}`;
  const read = `${turnId}-read`;
  const agent = `${turnId}-agent`;
  const grep = `${turnId}-grep`;
  const steps: [number, Frame][] = [
    [0, { type: "turnStarted", turnId, model: "claude-opus", permissionMode: "default", agentInitiated }],
  ];
  chunks(THOUGHT, 18).forEach((text, i) =>
    steps.push([100 + i * 60, { type: "thinkingDelta", turnId, text, agentId: null }]),
  );
  steps.push(
    [
      900,
      {
        type: "toolCallStarted",
        turnId,
        toolUseId: read,
        name: "Read",
        input: { file_path: `${CWD}/src/utils/enterOnce.ts` },
        kind: "read",
        locations: [],
        title: null,
      },
    ],
    [
      1200,
      {
        type: "toolCallCompleted",
        turnId,
        toolUseId: read,
        status: "ok",
        output: "export function enterOnce(...)",
        files: [],
        durationMs: 40,
        summary: null,
        outputTruncated: false,
        patch: [],
      },
    ],
    [
      1400,
      {
        type: "toolCallStarted",
        turnId,
        toolUseId: agent,
        name: "Agent",
        input: { description: "Find the callers", prompt: "List every caller of enterOnce", subagent_type: "Explore" },
        kind: "other",
        locations: [],
        title: null,
      },
    ],
    [
      1450,
      {
        type: "subagentStarted",
        agentId: lane,
        toolUseId: agent,
        taskType: "local_agent",
        agentType: "Explore",
        description: "Find the callers",
        prompt: "List every caller of enterOnce",
      },
    ],
    [1700, { type: "subagentCall", agentId: lane, toolUseId: grep }],
    [
      1700,
      {
        type: "toolCallStarted",
        turnId,
        toolUseId: grep,
        name: "Grep",
        input: { pattern: "enterOnce" },
        kind: "search",
        locations: [],
        title: null,
      },
    ],
    [
      2200,
      {
        type: "toolCallCompleted",
        turnId,
        toolUseId: grep,
        status: "ok",
        output: "3 files",
        files: [],
        durationMs: 90,
        summary: null,
        outputTruncated: false,
        patch: [],
      },
    ],
    [
      2500,
      { type: "textDelta", turnId, text: "Three callers: Composer, the kitchen sink and MessageList.", agentId: lane },
    ],
    [
      2800,
      {
        type: "subagentUpdate",
        agentId: lane,
        status: "completed",
        activity: null,
        lastToolName: "Grep",
        usage: { totalTokens: 1800, toolUses: 1, durationMs: 1350 },
        summary: "Three callers",
      },
    ],
    [
      2850,
      {
        type: "toolCallCompleted",
        turnId,
        toolUseId: agent,
        status: "ok",
        output: "Three callers",
        files: [],
        durationMs: 1400,
        summary: null,
        outputTruncated: false,
        patch: [],
      },
    ],
  );
  chunks(REPLY, 14).forEach((text, i) =>
    steps.push([3000 + i * 40, { type: "textDelta", turnId, text, agentId: null }]),
  );
  const end = 3000 + Math.ceil(REPLY.length / 14) * 40 + 200;
  steps.push([
    end,
    {
      type: "turnCompleted",
      turnId,
      outcome: "completed",
      stopReason: "end_turn",
      usage: NO_USAGE,
      costUsd: null,
      permissionDenials: [],
    },
  ]);
  return steps.map(([at, f]) => [at, frame(f)]);
}

function historyPage(page: number): ChatEvent[] {
  const turn = (t: number) => `hist-${page}-turn-${t}`;
  return [
    frame({ type: "userMessage", turnId: turn(1), blocks: [{ type: "text", text: `Earlier question ${page}.1` }] }),
    frame({
      type: "textDelta",
      turnId: turn(1),
      text: "An answer read back from the transcript on disk.",
      agentId: null,
    }),
    frame({ type: "userMessage", turnId: turn(2), blocks: [{ type: "text", text: `Earlier question ${page}.2` }] }),
    frame({
      type: "toolCallStarted",
      turnId: turn(2),
      toolUseId: `${turn(2)}-ls`,
      name: "Bash",
      input: { command: "ls src" },
      kind: "execute",
      locations: [],
      title: null,
    }),
    frame({
      type: "toolCallCompleted",
      turnId: turn(2),
      toolUseId: `${turn(2)}-ls`,
      status: "ok",
      output: "panels\nutils",
      files: [],
      durationMs: 12,
      summary: null,
      outputTruncated: false,
      patch: [],
    }),
    frame({ type: "textDelta", turnId: turn(2), text: "Two folders.", agentId: null }),
  ];
}

function freshChat(): ChatState {
  const s = initialChat(SESSION);
  s.ready = true;
  return s;
}

export function createTranscript() {
  const [state, setState] = createStore(freshChat());
  const edit = (fn: (s: ChatState) => void) => setState(produce(fn));
  let timers: ReturnType<typeof setTimeout>[] = [];
  let turns = 0;
  let prompts = 0;
  const [pages, setPages] = createSignal(0);
  const stop = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  onCleanup(stop);

  const play = (agentInitiated: boolean) => {
    for (const [at, ev] of turnScript(++turns, agentInitiated)) {
      timers.push(setTimeout(() => edit((s) => applyEvent(s, ev)), at));
    }
  };
  const running = () => isRunning(state);

  return {
    state,
    running,
    sendOrSteer() {
      const blocks = [{ type: "text" as const, text: `Prompt ${++prompts}: where is the entrance cleared?` }];
      if (running()) {
        edit((s) => pushSteer(s, blocks));
      } else {
        edit((s) => pushUserTurn(s, blocks));
        play(false);
      }
    },
    runAgentTurn: () => play(true),
    moreHistory: () => pages() < HISTORY_PAGES,
    deliverHistory() {
      if (pages() >= HISTORY_PAGES) return;
      const page = pages() + 1;
      setPages(page);
      edit((s) => prependHistory(s, historyPage(page)));
    },
    selectLane: (agentId: string | null) => edit((s) => selectLane(s, agentId)),
    reset() {
      stop();
      setPages(0);
      setState(freshChat());
    },
  };
}

export type Transcript = ReturnType<typeof createTranscript>;

export function TranscriptPane(props: { transcript: Transcript; collapseWork: boolean; height: string }) {
  const t = () => props.transcript;
  const items = createMemo(() => visibleItems(t().state.items, false, t().state.selectedLane));
  const laneOpenedBy = (toolUseId: string) =>
    Object.values(t().state.lanes).find((l) => l.toolUseId === toolUseId)?.agentId ?? null;
  return (
    <div style={{ position: "relative", height: props.height }}>
      <div class={`${styles.chat} ${styles.active}`}>
        <StatusStrip
          health={connectionHealth(t().state)}
          running={t().running()}
          background={outstandingBackground(t().state)}
          awaitingApproval={false}
          files={0}
          detail={null}
          contextWindow={null}
          onReconnect={() => {}}
          menu={<div style={{ padding: "var(--tori-space-4)" }}>Session menu</div>}
        />
        <MessageList
          items={items()}
          streaming={t().running()}
          sessionId={SESSION}
          cwd={CWD}
          modelLabelFor={() => null}
          onSetMode={() => {}}
          onRevertHunk={async () => false}
          collapseWork={props.collapseWork}
          laneOpenedBy={laneOpenedBy}
          onOpenLane={(agentId) => t().selectLane(agentId)}
          onFetchEarlier={t().state.items.length && t().moreHistory() ? () => t().deliverHistory() : undefined}
        />
        <LaneStrip
          lanes={laneStrip(t().state)}
          tasks={backgroundTasks(t().state)}
          blocked={blockedLanes(t().state)}
          selected={t().state.selectedLane}
          busy={t().running()}
          mark="claude"
          active={false}
          onSelect={(agentId) => t().selectLane(agentId)}
        />
      </div>
    </div>
  );
}

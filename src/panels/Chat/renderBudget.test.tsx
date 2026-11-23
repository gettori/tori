import { expect, it, vi } from "vite-plus/test";
import { createMemo, createSignal, createStore } from "solid-js";
import { render } from "../../test/harness";
import { renderCost, renderDrift, rerunBudget } from "../../test/perfCounters";
import type { ChatEvent } from "../../utils/chatTypes";
import MessageList from "./MessageList";
import { applyEvent, initialChat, pushUserTurn, visibleItems, type ChatState } from "./chatStore";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("../../test/perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const SESSION = "render-budget";
const TURNS = 200;
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 };
const frame = (event: Record<string, unknown>) => ({ ...event, sessionId: SESSION }) as ChatEvent;

function startTurn(state: ChatState, n: number) {
  pushUserTurn(state, [{ type: "text", text: `question ${n}` }]);
  applyEvent(
    state,
    frame({
      type: "turnStarted",
      turnId: `turn-${n}`,
      model: "claude-opus",
      permissionMode: "default",
      agentInitiated: false,
    }),
  );
}

function finishTurn(state: ChatState, n: number) {
  const turnId = `turn-${n}`;
  applyEvent(state, frame({ type: "textDelta", turnId, text: `answer ${n}`, agentId: null }));
  applyEvent(
    state,
    frame({
      type: "turnCompleted",
      turnId,
      outcome: "completed",
      stopReason: "end_turn",
      usage: NO_USAGE,
      costUsd: null,
      permissionDenials: [],
    }),
  );
}

function seededChat() {
  const seeded = initialChat(SESSION);
  seeded.ready = true;
  for (let n = 1; n <= TURNS; n++) {
    startTurn(seeded, n);
    finishTurn(seeded, n);
  }
  startTurn(seeded, TURNS + 1);
  return createStore(seeded);
}

function mountList(state: ChatState, readingFrom?: string) {
  const [reading, setReading] = createSignal(readingFrom);
  const mounted = render(() => {
    const items = createMemo(() => visibleItems(state.items, false, state.selectedLane));
    return (
      <MessageList
        items={items()}
        streaming
        sessionId={SESSION}
        cwd="/proj"
        modelLabelFor={() => null}
        onSetMode={() => {}}
        onRevertHunk={() => Promise.resolve(false)}
        collapseWork={false}
        laneOpenedBy={() => null}
        onOpenLane={() => {}}
        readingBlock={(id) => (id === reading() ? 0 : undefined)}
      />
    );
  });
  return { ...mounted, setReading };
}

it("holds the render budget for one tool frame into a long transcript", async () => {
  const [state, setState] = seededChat();
  const { container } = mountList(state);

  const { cost, artifact } = await renderCost(container, () =>
    setState((s) => {
      applyEvent(
        s,
        frame({
          type: "toolCallStarted",
          turnId: `turn-${TURNS + 1}`,
          toolUseId: "tool-1",
          name: "Read",
          input: { file_path: "/proj/a.ts" },
          kind: "read",
          locations: [],
          title: null,
        }),
      );
    }),
  );

  expect(cost.mutations).toBeGreaterThan(0);
  expect(artifact).toStayWithinRerunBudget(rerunBudget("chat.tool_frame"));
  expect(renderDrift("chat.tool_frame", cost), JSON.stringify(cost)).toEqual([]);
});

it("holds the render budget for moving the read aloud row", async () => {
  const [state] = seededChat();
  const replies = state.items.filter((item) => item.kind === "text");
  const [from, to] = replies.slice(-2).map((item) => item.id);
  const { container, setReading } = mountList(state, from);

  const { cost, artifact } = await renderCost(container, () => setReading(to));

  expect(cost.mutations).toBeGreaterThan(0);
  expect(artifact).toStayWithinRerunBudget(rerunBudget("chat.selection"));
  expect(renderDrift("chat.selection", cost), JSON.stringify(cost)).toEqual([]);
});

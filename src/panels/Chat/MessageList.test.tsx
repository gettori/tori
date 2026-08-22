import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show, createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import MessageList from "./MessageList";
import type { ChatItem, QuestionItem } from "./chatStore";
import type { QuestionAnswer } from "../../utils/chatTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// The transcript and the diff view are one session read two ways, so switching
// between them must not cost the reader their place. The list reports the turn
// it was showing as it goes away, and opens on that turn when it comes back.
//
// Exercised through a `<Show>` toggle rather than through the test agent's
// `unmount`, because that is the real mechanism: ChatView swaps the two views
// with a `<Show>`, and disposing that branch is what runs the cleanup. The
// agent's `unmount` clears the container without disposing, so a test built
// on it would prove nothing about the app.

// No cast: `as ChatItem` would let a fixture omit a field the store always
// sets, and the list would then throw on something that cannot happen in the
// app. Same reason the tool-card tests build theirs by hand.
function turn(n: number): ChatItem[] {
  return [
    { kind: "user", id: `u${n}`, blocks: [{ type: "text", text: `question ${n}` }], steer: false },
    { kind: "text", id: `t${n}`, turnId: `turn-${n}`, text: `answer ${n}` },
  ];
}

const ITEMS: ChatItem[] = [1, 2, 3].flatMap(turn);

function list(
  over: {
    items?: ChatItem[];
    anchorTurnId?: string | null;
    onAnchor?: (id: string | null) => void;
  } = {},
) {
  return (
    <MessageList
      items={ITEMS}
      streaming={false}
      sessionId="s1"
      cwd="/tmp"
      modelLabelFor={() => null}
      onAnswer={() => {}}
      onSetMode={() => {}}
      onRevertHunk={async () => true}
      {...over}
    />
  );
}

// A steer is delivered *into* a running turn, so the transcript has to show it
// as an aside within that turn rather than as the next thing asked - otherwise
// the reply below it reads as an answer to the steer alone.
describe("a steer renders as an interjection", () => {
  const STEERED: ChatItem[] = [
    { kind: "user", id: "u1", blocks: [{ type: "text", text: "read every file" }], steer: false },
    { kind: "text", id: "t1", turnId: "turn-1", text: "reading" },
    { kind: "user", id: "s1", blocks: [{ type: "text", text: "stop, just summarise" }], steer: true },
    { kind: "text", id: "t2", turnId: "turn-1", text: "summarising" },
  ];

  it("labels it and does not open a turn group of its own", () => {
    const { container } = render(() => list({ items: STEERED }));
    expect(container.textContent).toContain("Steer");
    expect(container.textContent).toContain("stop, just summarise");
    // One header for one turn: the steer interrupted `turn-1` and did not start
    // a second one, so the transcript must not grow a second byline.
    const ids = [...container.querySelectorAll("[data-turn-id]")].map((e) => (e as HTMLElement).dataset.turnId);
    expect(ids).toEqual(["turn-1"]);
  });

  it("leaves an ordinary message unlabelled", () => {
    const { container } = render(() => list());
    expect(container.textContent).not.toContain("Steer");
  });
});

describe("MessageList turn anchoring", () => {
  it("marks each turn so a reader's position can be named by turn, not by pixel", () => {
    const { container } = render(() => list());
    const ids = [...container.querySelectorAll("[data-turn-id]")].map((e) => (e as HTMLElement).dataset.turnId);
    expect(ids).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("reports the turn it was showing when the view switches away", () => {
    const onAnchor = vi.fn();
    const [showList, setShowList] = createSignal(true);
    render(() => <Show when={showList()}>{list({ onAnchor })}</Show>);

    expect(onAnchor).not.toHaveBeenCalled();
    setShowList(false);

    // jsdom gives every element a zero rect, so every header reads as at or
    // above the top and "the last one at or above" lands on the final turn.
    // Which turn wins is a layout question this environment cannot answer; what
    // is pinned here is that a turn id is handed back at all, since the switch
    // away must leave something to come back to.
    expect(onAnchor).toHaveBeenCalledTimes(1);
    expect(onAnchor.mock.calls[0][0]).toBe("turn-3");
  });

  it("scrolls to a turn named while it is already on screen", async () => {
    // Where the blame widget's click lands. The mount-time anchor restores a
    // reader's place; this one is somebody pointing at a specific turn, and the
    // list is already mounted when it arrives.
    const [anchor, setAnchor] = createSignal<string | null>(null);
    // Written out rather than through `list()`: that helper takes its overrides
    // as a plain object, so the anchor would be frozen at the value it had when
    // the object was built, and this test is about one arriving later.
    const { container } = render(() => (
      <MessageList
        items={ITEMS}
        streaming={false}
        sessionId="s1"
        cwd="/tmp"
        anchorTurnId={anchor()}
        modelLabelFor={() => null}
        onAnswer={() => {}}
        onSetMode={() => {}}
        onRevertHunk={async () => true}
      />
    ));

    // jsdom lays nothing out, so the rows are given the geometry the scroll
    // arithmetic reads: one turn every 100px down a viewport that starts at 0.
    // `scrollTop` is stubbed too - jsdom has no scrolling box, so its own
    // setter is a no-op and the assertion below would read 0 whatever happened.
    const scroller = container.firstElementChild as HTMLElement;
    expect(scroller.querySelectorAll("[data-turn-id]").length).toBe(3);
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    let scrolledTo = 0;
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrolledTo,
      set: (v: number) => {
        scrolledTo = v;
      },
      configurable: true,
    });
    const rows = [...container.querySelectorAll<HTMLElement>("[data-turn-id]")];
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: (i + 1) * 100 }) as DOMRect;
    });

    setAnchor("turn-2");

    // The second turn's row, not the first and not the tail.
    await waitFor(() => expect(scrolledTo).toBe(200));
  });

  it("round-trips the anchor through a view switch without losing it", () => {
    const [showList, setShowList] = createSignal(true);
    const [anchor, setAnchor] = createSignal<string | null>(null);
    render(() => <Show when={showList()}>{list({ anchorTurnId: anchor(), onAnchor: setAnchor })}</Show>);

    setShowList(false);
    const left = anchor();
    expect(left).not.toBeNull();

    // Coming back re-renders the same turns, and the remembered anchor is what
    // the list opens on rather than being discarded for the tail.
    setShowList(true);
    expect(anchor()).toBe(left);
  });
});

// A compaction summary is the agent's own text, several hundred words of it,
// and it used to sit inline in the middle of the conversation. The boundary is
// what the reader needs at a glance; the summary is what they go looking for
// afterwards, so only one of the two is open.
describe("a compaction shows its line and folds the summary", () => {
  const COMPACTED: ChatItem[] = [
    { kind: "user", id: "u1", blocks: [{ type: "text", text: "start the migration" }], steer: false },
    {
      kind: "notice",
      id: "n1",
      text: "Compacted manually (32k to 4k).",
      level: "info",
      details: "1. Primary Request and Intent: the user asked for the migration.",
    },
  ];

  it("puts the summary behind a closed disclosure", () => {
    const { container } = render(() => list({ items: COMPACTED }));
    expect(container.textContent).toContain("Compacted manually (32k to 4k).");

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // Closed on arrival: the summary must not push the conversation down the
    // page every time a session that has compacted is reopened.
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain("Primary Request and Intent");
  });

  it("renders no disclosure for a notice that is only its line", () => {
    const items: ChatItem[] = [{ kind: "notice", id: "n1", text: "Session ended.", level: "info" }];
    const { container } = render(() => list({ items }));
    expect(container.textContent).toContain("Session ended.");
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("a question in the transcript", () => {
  const QUESTION: QuestionItem = {
    kind: "question",
    id: "q1",
    toolUseId: "toolu_q",
    turnId: "turn-1",
    requestId: "req-q",
    agentId: null,
    questions: [
      {
        question: "Which colour do you want?",
        header: "Colour",
        multiSelect: false,
        options: [
          { label: "Red", description: "", preview: null },
          { label: "Blue", description: "", preview: null },
        ],
      },
    ],
    submitted: null,
    result: null,
  };

  function list(onAnswerQuestion?: (item: QuestionItem, answers: QuestionAnswer[]) => void) {
    return render(() => (
      <MessageList
        items={[...turn(1), QUESTION]}
        streaming={false}
        sessionId="s1"
        cwd="/tmp"
        modelLabelFor={() => null}
        onAnswer={() => {}}
        onSetMode={() => {}}
        onRevertHunk={async () => true}
        onAnswerQuestion={onAnswerQuestion}
      />
    ));
  }

  it("renders the form and hands the answers back with the item that asked", () => {
    const onAnswerQuestion = vi.fn();
    list(onAnswerQuestion);
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
    fireEvent.click(screen.getByRole("button", { name: /send answers/i }));
    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
    // The item travels with the answers: the caller needs its `toolUseId` and
    // `requestId` to address the request, and neither is on the answers.
    expect(onAnswerQuestion.mock.calls[0][0].toolUseId).toBe("toolu_q");
    expect(onAnswerQuestion.mock.calls[0][1]).toEqual([
      { question: "Which colour do you want?", picks: ["Red"], freeText: null },
    ]);
  });

  it("reads as read only in a list that cannot send an answer", () => {
    list();
    expect(screen.queryByRole("button", { name: /send answers/i })).toBeNull();
  });
});

// Everything that is not the reply used to be one undifferentiated grey line at
// `--fg-subtle`: a thought, a hook frame and an error all read the same, and all
// read a tier below the prose they sit among. The glyph says which kind a row is
// before the words are read; the tier change is what makes the words readable at
// all (see the notes on `.notice` and `.thinkingToggle` in Chat.module.css).
describe("the ambient rows say what kind they are", () => {
  const AMBIENT: ChatItem[] = [
    { kind: "thinking", id: "th1", turnId: "turn-1", text: "weighing the two channels" },
    {
      kind: "hook",
      id: "h1",
      hookId: "hook-1",
      name: "PreToolUse:Write",
      event: "PreToolUse",
      phase: "finished",
      swayOwned: false,
      outcome: "allow",
      exitCode: 0,
      output: null,
      stderr: null,
    },
    { kind: "notice", id: "n1", text: "Session ended.", level: "info" },
    { kind: "notice", id: "n2", text: "The agent exited.", level: "error" },
  ];

  /** The glyph a row draws, identified by the markup rather than by the icon's
   *  name: the point of the assertion is that the four rows differ. */
  const glyphs = (container: HTMLElement) =>
    [...container.querySelectorAll("svg")].map((svg) => svg.outerHTML);

  it("draws a different glyph for a thought, a hook and each level of notice", () => {
    const { container } = render(() => list({ items: AMBIENT }));
    const drawn = glyphs(container);
    expect(drawn).toHaveLength(4);
    expect(new Set(drawn).size, "two rows draw the same glyph").toBe(4);
  });

  it("hides every glyph from assistive tech, because the label beside it already says it", () => {
    const { container } = render(() => list({ items: AMBIENT }));
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  // The thinking row is a disclosure, so its glyph must not have joined its
  // accessible name: "Brain Thinking" is what a decorative icon inside a button
  // reads as when nobody hides it.
  it("leaves the thinking toggle named by its own word", () => {
    render(() => list({ items: AMBIENT }));
    expect(screen.getByRole("button", { name: "Thinking" })).toBeTruthy();
  });

  it("stays clean with all of them on screen", async () => {
    const { container } = render(() => list({ items: AMBIENT }));
    await expectNoAxeViolations(container);
  });
});

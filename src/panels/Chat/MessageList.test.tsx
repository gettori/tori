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
    { kind: "text", id: `t${n}`, turnId: `turn-${n}`, text: `answer ${n}`, agentId: null },
  ];
}

const ITEMS: ChatItem[] = [1, 2, 3].flatMap(turn);

function list(
  over: {
    items?: ChatItem[];
    streaming?: boolean;
    anchorTurnId?: string | null;
    onAnchor?: (id: string | null) => void;
    rewindTsFor?: (turnId: string) => number | null;
    agentTurn?: (turnId: string) => boolean;
    onRewind?: (promptTs: number) => void;
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
    { kind: "text", id: "t1", turnId: "turn-1", text: "reading", agentId: null },
    { kind: "user", id: "s1", blocks: [{ type: "text", text: "stop, just summarise" }], steer: true },
    { kind: "text", id: "t2", turnId: "turn-1", text: "summarising", agentId: null },
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

// The other way the bottom of the conversation leaves the screen: the viewport
// shrinks under it. The composer below grows as you type, and every pixel it
// takes comes off this list - so the reply you were reading slides under the
// input box, and a tall row (a question card) can go behind it whole. Scroll
// position is measured from the top, so nothing about the content changed and
// the content-driven pin never ran.
describe("staying at the bottom when the list is made shorter", () => {
  /** The stub the suite installs globally is a no-op; this one hands back its
   *  callback so a test can say "the box resized" without a layout engine. */
  function captureResizeObserver() {
    const callbacks: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    return { callbacks, restore: () => (globalThis.ResizeObserver = original) };
  }

  /** A scroller with the geometry jsdom does not have: a viewport that can be
   *  told to shrink, and a scrollTop that remembers what it was set to. */
  function stubScroll(el: HTMLElement, height: number) {
    let top = 0;
    let clientHeight = height;
    Object.defineProperty(el, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => (top = v),
      configurable: true,
    });
    return {
      top: () => top,
      setTop: (v: number) => (top = v),
      shrinkTo: (h: number) => (clientHeight = h),
    };
  }

  it("follows the bottom down when the composer takes the room", () => {
    const ro = captureResizeObserver();
    const { container } = render(() => list());
    const scroller = container.firstElementChild as HTMLElement;
    const geom = stubScroll(scroller, 400);
    // At the bottom: 1000 tall, 400 of it visible, scrolled to 600.
    geom.setTop(600);

    geom.shrinkTo(340);
    ro.callbacks.forEach((cb) => cb());

    expect(geom.top()).toBe(1000);
    ro.restore();
  });

  it("leaves a reader who has scrolled up where they are", () => {
    // A resize is not a reason to take a position away from someone holding it
    // on purpose.
    const ro = captureResizeObserver();
    const { container } = render(() => list());
    const scroller = container.firstElementChild as HTMLElement;
    const geom = stubScroll(scroller, 400);
    geom.setTop(100);
    fireEvent.scroll(scroller);

    geom.shrinkTo(340);
    ro.callbacks.forEach((cb) => cb());

    expect(geom.top()).toBe(100);
    ro.restore();
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
    {
      kind: "thinking",
      id: "th1",
      turnId: "turn-1",
      text: "weighing the two channels",
      startedAt: 1000,
      endedAt: 13000,
      agentId: null,
    },
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
  // accessible name: "Brain Thought" is what a decorative icon inside a button
  // reads as when nobody hides it.
  it("leaves the thinking toggle named by its own words", () => {
    render(() => list({ items: AMBIENT }));
    expect(screen.getByRole("button", { name: "Thought for 12s" })).toBeTruthy();
  });

  it("stays clean with all of them on screen", async () => {
    const { container } = render(() => list({ items: AMBIENT }));
    await expectNoAxeViolations(container);
  });
});

// The label tells the tense: a sheen-swept "Thinking" only while deltas can
// still land (the tail of a streaming turn), the measured span once settled,
// and plain "Thought" where nothing was measured (a replay folds in one tick).
describe("the thinking label follows the stream", () => {
  const THINKING: ChatItem = {
    kind: "thinking",
    id: "th1",
    turnId: "turn-1",
    text: "weighing the two channels",
    startedAt: 1000,
    endedAt: 13000,
    agentId: null,
  };

  it("says Thinking while it is the streaming tail", () => {
    render(() => list({ items: [THINKING], streaming: true }));
    expect(screen.getByRole("button", { name: "Thinking" })).toBeTruthy();
  });

  it("settles the moment something streams after it, mid-turn or not", () => {
    const text: ChatItem = { kind: "text", id: "t1", turnId: "turn-1", text: "so:", agentId: null };
    render(() => list({ items: [THINKING, text], streaming: true }));
    expect(screen.getByRole("button", { name: "Thought for 12s" })).toBeTruthy();
  });

  it("reads plain Thought where the span measured nothing", () => {
    render(() => list({ items: [{ ...THINKING, endedAt: 1000 }] }));
    expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
  });
});

// A background subagent finishing makes the CLI open a turn of its own, with no
// user message in front of it. The transcript must not read that turn as an
// answer to whatever the reader last asked.
describe("a turn the agent opened for itself", () => {
  const REPORT: ChatItem[] = [
    { kind: "user", id: "u1", blocks: [{ type: "text", text: "launch it in the background" }], steer: false },
    { kind: "text", id: "t2", turnId: "turn-2", text: "the background subagent finished", agentId: null },
  ];

  it("claims no prompt of its own", () => {
    // Without the guard the prompt hangs on `turn-2`, so "rewind to here" would
    // restore the tree as it stood *after* the turn the reader meant.
    const { container } = render(() =>
      list({
        items: REPORT,
        rewindTsFor: () => 1,
        onRewind: () => {},
        agentTurn: (id) => id === "turn-2",
      }),
    );
    expect(container.textContent).not.toContain("Rewind to here");

    // The control, so the assertion above cannot pass for the wrong reason.
    const same = render(() => list({ items: REPORT, rewindTsFor: () => 1, onRewind: () => {} }));
    expect(same.container.textContent).toContain("Rewind to here");
  });

  it("leaves the prompt on the turn the user actually opened", () => {
    const items: ChatItem[] = [
      REPORT[0]!,
      { kind: "text", id: "t1", turnId: "turn-1", text: "launched", agentId: null },
      REPORT[1]!,
    ];
    const asked: string[] = [];
    render(() =>
      list({
        items,
        rewindTsFor: (id) => {
          asked.push(id);
          return 1;
        },
        onRewind: () => {},
        agentTurn: (id) => id === "turn-2",
      }),
    );
    expect(asked).toEqual(["turn-1"]);
  });
});

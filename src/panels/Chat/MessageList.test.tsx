import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { expectNoAxeViolations } from "../../test/axe";
import MessageList from "./MessageList";
import { applyEvent, initialChat, prependHistory, pushUserTurn } from "./chatStore";
import type { ChatItem, QuestionItem, ToolItem } from "./chatStore";
import type { ContentBlock, QuestionAnswer } from "../../utils/chatTypes";
import { invoke } from "@tauri-apps/api/core";
import { NAVIGATE, onWith, SESSION_ACTION, type NavTarget, type SessionAction } from "../../utils/events";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  // An attached image is a path now, and the bubble draws it off disk.
  convertFileSrc: (p: string) => `asset://${p}`,
}));

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
    collapseWork?: boolean;
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

// A reopened chat used to show a question about a screenshot with no
// screenshot in it, and lose an image-only prompt entirely.
describe("a prompt shows what it attached", () => {
  const PNG = "iVBORw0KGgo=";

  it("draws an image the turn still holds", () => {
    const items: ChatItem[] = [
      {
        kind: "user",
        id: "u1",
        blocks: [
          { type: "image", mediaType: "image/png", data: PNG },
          { type: "text", text: "what colour is this?" },
        ],
        steer: false,
      },
    ];
    const { container } = render(() => list({ items }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    expect(container.textContent).toContain("what colour is this?");
    // Not "[image]", which is what the bubble used to print beside the text.
    expect(container.textContent).not.toContain("[image]");
  });

  it("numbers a replayed image it has no bytes for", () => {
    const items: ChatItem[] = [
      {
        kind: "user",
        id: "u1",
        blocks: [{ type: "imageRef" }, { type: "imageRef" }, { type: "text", text: "compare these" }],
        steer: false,
      },
    ];
    const { container } = render(() => list({ items }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[Image #1]");
    expect(container.textContent).toContain("[Image #2]");
    expect(container.textContent).toContain("compare these");
  });

  it("keeps an image-only prompt visible", () => {
    const items: ChatItem[] = [{ kind: "user", id: "u1", blocks: [{ type: "imageRef" }], steer: false }];
    const { container } = render(() => list({ items }));
    expect(container.textContent).toContain("[Image #1]");
  });
});

describe("a prompt that references a pull request", () => {
  const ref: ContentBlock = {
    type: "ref",
    label: "[PR 7]",
    target: {
      kind: "pr",
      number: 7,
      title: "Seven",
      url: "https://github.com/o/r/pull/7",
      state: "merged",
      draft: false,
      head: "h",
      base: "main",
    },
  };
  const blocks: ContentBlock[] = [ref, { type: "text", text: "why did [PR 7] land?" }];
  const event = { type: "userMessage" as const, sessionId: "s1", turnId: "t1", blocks };

  // Live (the panel draws its own bubble), the ACP echo, and a replay all land
  // as one user item holding the ref: Rust lifts the note off the wire.
  const paths: [string, () => ChatItem[]][] = [
    [
      "live",
      () => {
        const s = initialChat("s1");
        pushUserTurn(s, blocks);
        return s.items;
      },
    ],
    [
      "echoed",
      () => {
        const s = initialChat("s1");
        applyEvent(s, event);
        return s.items;
      },
    ],
    [
      "replayed",
      () => {
        const s = initialChat("s1");
        prependHistory(s, [event]);
        return s.items;
      },
    ],
  ];

  for (const [name, items] of paths) {
    it(`draws the ${name} token as one chip and no Tori row`, () => {
      const { container } = render(() => list({ items: items() }));
      const chips = container.querySelectorAll("button[title]");
      expect([...chips].map((c) => c.textContent)).toEqual(["[PR 7]"]);
      expect(chips[0].getAttribute("title")).toBe("Seven (merged)");
      expect(container.textContent).toContain("why did [PR 7] land?");
      expect(container.textContent).not.toContain("ref-pr");
    });
  }

  it("opens the pull request it names", async () => {
    const { container } = render(() => list({ items: paths[0][1]() }));
    fireEvent.click(container.querySelector("button[title]")!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("forge_get_pr", { projectPath: "/tmp", number: 7 }));
  });
});

describe("a prompt that references a session", () => {
  it("opens the session it names", () => {
    const blocks: ContentBlock[] = [
      {
        type: "ref",
        label: "[Session: Fix login]",
        target: { kind: "session", id: "abc", title: "Fix login", agent: "codex", project: "/p" },
      },
      { type: "text", text: "what did [Session: Fix login] decide?" },
    ];
    const opened: SessionAction[] = [];
    const off = onWith<SessionAction>(SESSION_ACTION, (d) => opened.push(d));
    const { container } = render(() => list({ items: [{ kind: "user", id: "u1", blocks, steer: false }] }));
    const chip = container.querySelector("button[title]")!;
    expect(chip.textContent).toBe("[Session: Fix login]");
    expect(chip.getAttribute("title")).toBe("Fix login (codex)");
    fireEvent.click(chip);
    expect(opened).toEqual([{ sessionId: "abc", action: "open" }]);
    off();
  });

  it("shows a project or a space chip's target in the sidebar", () => {
    const blocks: ContentBlock[] = [
      {
        type: "ref",
        label: "[Project: tori]",
        target: { kind: "project", name: "tori", folder: "/p/tori", space: "Work" },
      },
      {
        type: "ref",
        label: "[Space: Work]",
        target: { kind: "space", name: "Work", projects: [{ name: "tori", folder: "/p/tori" }] },
      },
      { type: "text", text: "compare [Project: tori] with [Space: Work]" },
    ];
    const shown: NavTarget[] = [];
    const off = onWith<NavTarget>(NAVIGATE, (t) => shown.push(t));
    const { container } = render(() => list({ items: [{ kind: "user", id: "u1", blocks, steer: false }] }));
    const [project, space] = container.querySelectorAll("button[title]");
    expect(project.getAttribute("title")).toBe("/p/tori (Work)");
    expect(space.getAttribute("title")).toBe("tori");
    fireEvent.click(project);
    fireEvent.click(space);
    expect(shown).toEqual([{ project: "/p/tori" }, { space: "Work" }]);
    off();
  });
});

describe("a prompt that names what it attached", () => {
  const shot = {
    type: "fileRef" as const,
    path: "/store/1a2b-0/shot.png",
    startLine: null,
    endLine: null,
    text: null,
    label: "[Image 1]",
  };

  it("draws the token as a chip and the image off its path", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", blocks: [shot, { type: "text", text: "what is in [Image 1]?" }], steer: false },
    ];
    const { container } = render(() => list({ items }));
    const chips = container.querySelectorAll('span[title="/store/1a2b-0/shot.png"]');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("[Image 1]");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset:///store/1a2b-0/shot.png");
    // The path itself is not printed beside the sentence any more: the token
    // names it and the picture shows it.
    expect(container.textContent).toContain("what is in [Image 1]?");
    expect(container.textContent).not.toContain("@/store");
  });

  // The user meant those characters. Dressing them up would claim the turn
  // carried something it never did.
  it("leaves a token the turn carries no attachment for as plain text", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", blocks: [{ type: "text", text: "what about [Image 9]?" }], steer: false },
    ];
    const { container } = render(() => list({ items }));
    expect(container.textContent).toContain("what about [Image 9]?");
    expect(container.querySelector("span[title]")).toBeNull();
  });

  // Attach a file, press Enter, type nothing: the turn still has to show what
  // it carried, which is the whole complaint this work started from.
  it("names an attachment the sentence never mentioned", () => {
    const pdf = { ...shot, path: "/store/1a2b-1/spec.pdf", label: "[PDF 1]" };
    const items: ChatItem[] = [{ kind: "user", id: "u1", blocks: [pdf], steer: false }];
    const { container } = render(() => list({ items }));
    expect(container.textContent).toContain("[PDF 1]");
    expect(container.querySelector('span[title="/store/1a2b-1/spec.pdf"]')).toBeTruthy();
  });

  it("still prints an unlabelled reference as the path it is", () => {
    const items: ChatItem[] = [
      {
        kind: "user",
        id: "u1",
        blocks: [{ type: "fileRef", path: "/repo/a.ts", startLine: 1, endLine: 4, text: null }],
        steer: false,
      },
    ];
    const { container } = render(() => list({ items }));
    expect(container.textContent).toContain("@/repo/a.ts");
  });
});

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

// The other way the bottom of the conversation leaves the screen: the viewport
// shrinks under it. The composer below grows as you type, and every pixel it
// takes comes off this list - so the reply you were reading slides under the
// input box, and a tall row (a question card) can go behind it whole. Scroll
// position is measured from the top, so nothing about the content changed and
// the content-driven pin never ran.
describe("staying at the bottom when the list is made shorter", () => {
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

// Scrolling up detaches the pin, and it should: the agent talking is not a
// reason to take the view off the turn somebody is reading. Pressing Enter is
// the exception - the prompt lands at the tail, and a transcript that stays
// where it was leaves it under the composer with nothing saying it went
// anywhere.
describe("a send takes the reader back to the bottom", () => {
  const SENT: ChatItem = {
    kind: "user",
    id: "sent",
    blocks: [{ type: "text", text: "the long prompt that was just typed" }],
    steer: false,
  };

  /** `items` written into the JSX, so it is a prop the list re-reads rather
   *  than a value read once: `list({ items: items() })` would tear the whole
   *  component down and build a new one on every change, and a fresh mount
   *  pins by itself - which is the thing these tests have to not prove. */
  const growing = (items: () => ChatItem[]) => (
    <MessageList
      items={items()}
      streaming={false}
      sessionId="s1"
      cwd="/tmp"
      modelLabelFor={() => null}
      onAnswer={() => {}}
      onSetMode={() => {}}
      onRevertHunk={async () => true}
    />
  );

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Mounted, then scrolled up: a reader holding a position on an earlier turn.
   *  Settled before it hands the scroller back, because mounting pins once by
   *  itself and a spy installed before that lands would record it. */
  async function detached() {
    const [items, setItems] = createSignal(ITEMS);
    const { container } = render(() => growing(items));
    const scroller = container.firstElementChild as HTMLElement;
    const geom = stubScroll(scroller, 400);
    geom.setTop(100);
    fireEvent.scroll(scroller);
    await tick();
    return { scroller, geom, setItems };
  }

  it("pins on the reader's own message even when they had scrolled up", async () => {
    const { scroller, setItems } = await detached();
    const scrollTo = vi.spyOn(scroller, "scrollTo");

    setItems([...ITEMS, SENT]);

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000 }));
  });

  it("still leaves a scrolled-up reader alone when the agent is the one talking", async () => {
    const { scroller, setItems } = await detached();
    const scrollTo = vi.spyOn(scroller, "scrollTo");

    setItems([...ITEMS, { kind: "text", id: "t9", turnId: "turn-9", text: "a reply", agentId: null }]);

    await tick();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // What the composer does *after* the send moves the bottom again: the
  // attachment chips clear, the lane strip opens when the turn spawns
  // subagents, the queue strip appears. Each of those comes off this list, and
  // only the resize observer sees it - which follows the bottom only while the
  // list counts as pinned, so the send has to have restored that too.
  it("follows the composer's height again once a send has re-pinned it", async () => {
    const ro = captureResizeObserver();
    const { geom, setItems } = await detached();

    setItems([...ITEMS, SENT]);
    await tick();

    geom.shrinkTo(340);
    ro.callbacks.forEach((cb) => cb());

    expect(geom.top()).toBe(1000);
    ro.restore();
  });

  // An image has no height until it has loaded, so the pin above lands against
  // a bubble that is still going to grow by up to the 180px the transcript caps
  // it at - which is enough to put the prompt back under the composer.
  it("re-pins when an image in a prompt finishes loading", async () => {
    const withImage: ChatItem[] = [
      ...ITEMS,
      { kind: "user", id: "shot", blocks: [{ type: "image", mediaType: "image/png", data: "AAAA" }], steer: false },
    ];
    const { container } = render(() => list({ items: withImage }));
    const scroller = container.firstElementChild as HTMLElement;
    stubScroll(scroller, 400).setTop(600);
    await tick();
    const scrollTo = vi.spyOn(scroller, "scrollTo");

    const img = scroller.querySelector("img");
    expect(img).not.toBeNull();
    // `load` does not bubble; the list listens for it in the capture phase.
    img!.dispatchEvent(new Event("load"));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000 }));
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
      toriOwned: false,
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
  const glyphs = (container: HTMLElement) => [...container.querySelectorAll("svg")].map((svg) => svg.outerHTML);

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

describe("agent work collapsed into a card", () => {
  const call = (id: string, over: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool",
    id,
    toolUseId: id,
    agentId: null,
    turnId: "turn-1",
    name: "Bash",
    title: null,
    toolKind: "execute",
    locations: [],
    input: { command: `echo ${id}` },
    state: "ok",
    outputTruncated: false,
    approval: null,
    output: null,
    summary: null,
    patch: [],
    files: [],
    durationMs: null,
    edits: [],
    ...over,
  });
  const waiting = (id: string) =>
    call(id, {
      state: "awaitingApproval",
      approval: { requestId: `req-${id}`, autoDenyAtMs: null, suggestions: [], agentId: null },
    });
  const PROMPT: ChatItem = { kind: "user", id: "u1", blocks: [{ type: "text", text: "do it" }], steer: false };
  const REPLY: ChatItem = { kind: "text", id: "t1", turnId: "turn-1", text: "done", agentId: null };
  const QUESTION: QuestionItem = {
    kind: "question",
    id: "q1",
    toolUseId: "toolu_q",
    turnId: "turn-1",
    requestId: "req-q",
    agentId: null,
    questions: [
      {
        question: "Which channel do you want?",
        header: "Channel",
        multiSelect: false,
        options: [
          { label: "Stable", description: "", preview: null },
          { label: "Beta", description: "", preview: null },
        ],
      },
    ],
    submitted: null,
    result: null,
  };

  // Off a store: a call settles by mutation in place, and a plain array would
  // never show whether the card follows it.
  function mount(initial: ChatItem[]) {
    const [state, setState] = createStore({ items: initial });
    const view = render(() => list({ items: state.items, collapseWork: true }));
    return { ...view, setState };
  }

  it("leaves the transcript alone while the setting is off", () => {
    render(() => list({ items: [PROMPT, call("a"), REPLY] }));
    expect(screen.queryByRole("button", { name: "1 tool call" })).toBeNull();
    expect(screen.getByText("echo a")).toBeTruthy();
  });

  it("shows the prompt and the reply, and the calls only once the card is opened", () => {
    mount([PROMPT, call("a"), call("b"), REPLY]);
    expect(screen.getByText("do it")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("echo a")).toBeNull();

    const card = screen.getByRole("button", { name: "2 tool calls" });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("echo a")).toBeTruthy();
    expect(screen.getByText("echo b")).toBeTruthy();
  });

  // A prompt behind a card is a session that looks hung.
  it("keeps a call waiting on approval outside the card, and takes it in once it is answered", () => {
    const { setState } = mount([PROMPT, call("a"), waiting("p")]);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();

    const card = screen.getByRole("button", { name: "1 tool call" });
    fireEvent.click(card);

    setState("items", 2, { state: "ok", approval: null });
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    const after = screen.getByRole("button", { name: "2 tool calls" });
    expect(after, "the card was rebuilt rather than kept").toBe(card);
    expect(after.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("echo p")).toBeTruthy();
  });

  it("keeps an open question outside the card, and takes it in once it is answered", () => {
    const { setState } = mount([PROMPT, call("a"), QUESTION]);
    expect(screen.getByText("Which channel do you want?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tool call" })).toBeTruthy();

    setState("items", 2, { result: "Stable" });
    expect(screen.queryByText("Which channel do you want?")).toBeNull();
    expect(screen.getByRole("button", { name: "1 tool call, 1 question" })).toBeTruthy();
  });

  it("starts a replayed question inside the card, since nothing can answer it", () => {
    mount([PROMPT, call("a"), { ...QUESTION, requestId: null, result: "Stable" }]);
    expect(screen.queryByText("Which channel do you want?")).toBeNull();
    expect(screen.getByRole("button", { name: "1 tool call, 1 question" })).toBeTruthy();
  });

  // Scroll restore and the model line hang off the turn's first row, which is
  // usually a call and so usually inside a card that is shut.
  it("still marks a turn that opens inside a card that is shut", () => {
    const { container } = mount([PROMPT, call("a"), REPLY]);
    const marks = [...container.querySelectorAll<HTMLElement>("[data-turn-id]")].map((e) => e.dataset.turnId);
    expect(marks).toEqual(["turn-1"]);
  });

  it("marks the turn once when the card is open", () => {
    const { container } = mount([PROMPT, call("a"), REPLY]);
    fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(1);
  });

  it("says a call failed the moment it does", () => {
    const { setState } = mount([PROMPT, call("a", { state: "running" }), REPLY]);
    expect(screen.getByRole("button", { name: "1 tool call" })).toBeTruthy();
    setState("items", 1, { state: "error" });
    expect(screen.getByRole("button", { name: "1 tool call, 1 failed" })).toBeTruthy();
  });

  it("names the call in flight while the run is the streaming tail", () => {
    const [state] = createStore({ items: [PROMPT, call("a", { state: "running" })] as ChatItem[] });
    render(() => list({ items: state.items, collapseWork: true, streaming: true }));
    expect(screen.getByRole("button", { name: "Bash echo a" })).toBeTruthy();
  });

  it("stays clean shut and open", async () => {
    const { container } = mount([PROMPT, call("a"), call("b", { state: "error" }), REPLY]);
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "2 tool calls, 1 failed" }));
    await expectNoAxeViolations(container);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { Show, createSignal } from "solid-js";
import MessageList from "./MessageList";
import type { ChatItem } from "./chatStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// The transcript and the diff view are one session read two ways, so switching
// between them must not cost the reader their place. The list reports the turn
// it was showing as it goes away, and opens on that turn when it comes back.
//
// Exercised through a `<Show>` toggle rather than through the test harness's
// `unmount`, because that is the real mechanism: ChatView swaps the two views
// with a `<Show>`, and disposing that branch is what runs the cleanup. The
// harness's `unmount` clears the container without disposing, so a test built
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

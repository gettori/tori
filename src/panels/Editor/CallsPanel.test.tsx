import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import CallsPanel from "./CallsPanel";
import {
  clearCallRoots,
  normalizeCallItems,
  publishCallRoots,
  setCallFetcher,
  type CallDirection,
  type CallItem,
} from "../../utils/callHierarchy";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

function item(name: string, path: string, line: number) {
  return {
    name,
    kind: 12,
    uri: `file://${path}`,
    range: { start: { line: line - 1, character: 0 }, end: { line, character: 0 } },
    selectionRange: { start: { line: line - 1, character: 4 }, end: { line: line - 1, character: 8 } },
  };
}

const A = normalizeCallItems([item("alpha", "/repo/a.ts", 10)])[0];
const B = normalizeCallItems([item("beta", "/repo/b.ts", 20)])[0];

/** What each symbol's level answers, by direction. Set per test. */
let levels: Record<string, Partial<Record<CallDirection, CallItem[]>>> = {};
let asked: string[] = [];
let off: () => void = () => {};

beforeEach(() => {
  clearCallRoots();
  levels = {};
  asked = [];
  off = setCallFetcher((it, direction) => {
    asked.push(`${it.name}:${direction}`);
    return Promise.resolve(levels[it.name]?.[direction] ?? []);
  });
});

afterEach(() => {
  off();
  cleanup();
});

// Rows carry an inline `padding-left` from their depth, which is what tells
// them apart from the scroll container around them - CSS modules hash `.row`
// and `.rows` to names that both contain "row". Same selector `OutlinePanel`'s
// tests use, for the same reason.
const rowEls = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("div[style]")];
const rows = (c: HTMLElement) => rowEls(c).map((r) => r.textContent ?? "");
const twisties = (c: HTMLElement) => [...c.querySelectorAll("button[aria-label]")] as HTMLButtonElement[];

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("the Calls panel", () => {
  it("says what to do rather than looking broken when nothing is rooted", () => {
    // The tab is only visible when the server *does* do call hierarchy, so an
    // empty panel here means the caret, not the language.
    publishCallRoots("/repo/a.ts", []);
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);
    expect(container.textContent).toContain("Put the caret on a function");
  });

  it("expands one level at a time, asking only when a row is opened", async () => {
    // The protocol has no "give me the tree" request, so every level is a round
    // trip; expanding eagerly would spend them on levels nobody looked at.
    publishCallRoots("/repo/a.ts", [A]);
    levels = { alpha: { incoming: [B] } };
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);

    expect(rows(container)).toHaveLength(1);
    expect(asked).toEqual([]);

    fireEvent.click(twisties(container)[0]);
    await settle();

    expect(asked).toEqual(["alpha:incoming"]);
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)[1]).toContain("beta");
  });

  it("asks once per row and reuses the answer when it is collapsed and reopened", async () => {
    publishCallRoots("/repo/a.ts", [A]);
    levels = { alpha: { incoming: [B] } };
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);

    fireEvent.click(twisties(container)[0]);
    await settle();
    fireEvent.click(twisties(container)[0]);
    await settle();
    fireEvent.click(twisties(container)[0]);
    await settle();

    expect(asked).toEqual(["alpha:incoming"]);
    expect(rows(container)).toHaveLength(2);
  });

  it("does not ask twice when a row is clicked again while its level is loading", async () => {
    // The `…` says a fetch is running; without something reading it, a second
    // click just issues the same request again.
    publishCallRoots("/repo/a.ts", [A]);
    let release!: (items: CallItem[]) => void;
    off();
    off = setCallFetcher((it, direction) => {
      asked.push(`${it.name}:${direction}`);
      return new Promise<CallItem[]>((resolve) => (release = resolve));
    });

    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);
    fireEvent.click(twisties(container)[0]);
    await settle();
    fireEvent.click(twisties(container)[0]);
    await settle();

    expect(asked).toEqual(["alpha:incoming"]);
    release([B]);
    await settle();
    expect(rows(container)).toHaveLength(2);
  });

  it("re-asks in the other direction, because it is a different question", async () => {
    // Switching direction is not a filter over the same tree: outgoing calls of
    // a symbol have nothing to do with its incoming ones, so keeping the
    // expansions would show one question's answers under the other's heading.
    publishCallRoots("/repo/a.ts", [A]);
    levels = { alpha: { incoming: [B], outgoing: [] } };
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);

    fireEvent.click(twisties(container)[0]);
    await settle();
    expect(rows(container)).toHaveLength(2);

    fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent === "Outgoing")!);
    await settle();

    // Collapsed back to the root: the level below it is now unknown again.
    expect(rows(container)).toHaveLength(1);
    fireEvent.click(twisties(container)[0]);
    await settle();
    expect(asked).toEqual(["alpha:incoming", "alpha:outgoing"]);
  });

  it("draws a mutually recursive pair once and does not expand through it", async () => {
    // The edge is real and worth seeing. What must not happen is following it
    // forever, so the repeat is marked and simply has no disclosure control.
    publishCallRoots("/repo/a.ts", [A]);
    levels = { alpha: { incoming: [B] }, beta: { incoming: [A] } };
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);

    fireEvent.click(twisties(container)[0]);
    await settle();
    fireEvent.click(twisties(container)[1]);
    await settle();

    expect(rows(container).map((r) => r.replace(/\s+/g, " "))).toHaveLength(3);
    expect(rows(container)[2]).toContain("alpha");
    expect(rows(container)[2]).toContain("cycle");

    // And the repeat offers no way to go deeper.
    fireEvent.click(twisties(container)[2]);
    await settle();
    expect(rows(container)).toHaveLength(3);
    expect(asked).toEqual(["alpha:incoming", "beta:incoming"]);
  });

  it("lets the same symbol be expanded separately at two places in the tree", async () => {
    // Expansion is keyed on the whole ancestor chain, not on the symbol. One
    // function reached two ways is two rows, and opening one must leave the
    // other shut - otherwise a wide tree unfolds in several places at once from
    // a single click, which reads as the panel losing track of what was opened.
    //
    // This needs `gamma` under *both* roots to say anything: an earlier version
    // put it under one, where symbol-keying and chain-keying behave identically
    // and the test passed against either.
    const C = normalizeCallItems([item("gamma", "/repo/c.ts", 30)])[0];
    const D = normalizeCallItems([item("delta", "/repo/d.ts", 40)])[0];
    publishCallRoots("/repo/a.ts", [A, B]);
    levels = { alpha: { incoming: [C] }, beta: { incoming: [C] }, gamma: { incoming: [D] } };
    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);

    fireEvent.click(twisties(container)[0]); // alpha
    await settle();
    fireEvent.click(twisties(container)[2]); // beta, now the third row
    await settle();
    expect(rows(container).map((r) => r.replace(/\s+/g, ""))).toHaveLength(4);

    // Open gamma under alpha only.
    fireEvent.click(twisties(container)[1]);
    await settle();

    const text = rows(container);
    // alpha, gamma, delta, beta, gamma - five rows, and the *second* gamma is
    // still closed. Symbol-keyed expansion would have opened it too, giving six.
    expect(text).toHaveLength(5);
    expect(text[2]).toContain("delta");
    expect(text[4]).toContain("gamma");
    expect(text[4]).not.toContain("delta");
  });

  it("jumps to a row's own file and line", () => {
    publishCallRoots("/repo/a.ts", [A]);
    const seen: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => seen.push(d));

    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);
    fireEvent.click(rowEls(container)[0]);

    off();
    // The name, not the body.
    expect(seen).toEqual([{ path: "/repo/a.ts", line: 10, col: 5 }]);
  });

  it("does not jump when the disclosure control is used", async () => {
    // The row navigates and the twisty expands; without stopping propagation,
    // opening a level would also jump away from the tree being opened.
    publishCallRoots("/repo/a.ts", [A]);
    levels = { alpha: { incoming: [B] } };
    const seen: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => seen.push(d));

    const { container } = render(() => <CallsPanel path="/repo/a.ts" />);
    fireEvent.click(twisties(container)[0]);
    await settle();

    off();
    expect(seen).toEqual([]);
    expect(rows(container)).toHaveLength(2);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen } from "@solidjs/testing-library";
import QuoteSelection, { quoteBlock, selectionWithin } from "./QuoteSelection";

// jsdom never fires selectionchange on its own, so every test sets the
// selection and dispatches the event by hand, the way the browser would.
function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function mount() {
  const onQuote = vi.fn();
  let root!: HTMLDivElement;
  const result = render(() => (
    <div>
      <div ref={root}>
        <p>hello world</p>
        <textarea aria-label="Other">typed</textarea>
      </div>
      <p>elsewhere</p>
      <QuoteSelection root={() => root} onQuote={onQuote} />
    </div>
  ));
  return { ...result, root, onQuote };
}

const quoteButtons = () => screen.queryAllByRole("button", { name: "Quote" });

afterEach(() => document.getSelection()?.removeAllRanges());

describe("QuoteSelection", () => {
  it("offers Quote for a selection inside the transcript, and not outside it", () => {
    const { getByText } = mount();
    expect(quoteButtons()).toHaveLength(0);
    select(getByText("hello world"));
    expect(quoteButtons()).toHaveLength(1);
    select(getByText("elsewhere"));
    expect(quoteButtons()).toHaveLength(0);
  });

  it("offers nothing for a selection inside a box the user is typing in", () => {
    const { getByLabelText } = mount();
    select(getByLabelText("Other"));
    expect(quoteButtons()).toHaveLength(0);
  });

  it("offers nothing for a collapsed selection", () => {
    const { getByText } = mount();
    const range = document.createRange();
    range.setStart(getByText("hello world").firstChild!, 2);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(quoteButtons()).toHaveLength(0);
  });

  // Every attached tab stays mounted, so two transcripts hear the same event.
  it("draws one button for one selection when two transcripts are mounted", () => {
    const first = mount();
    mount();
    select(first.getByText("hello world"));
    expect(quoteButtons()).toHaveLength(1);
  });

  it("hands the selected text over on click, and keeps the selection through mousedown", () => {
    const { getByText, onQuote } = mount();
    select(getByText("hello world"));
    const button = quoteButtons()[0];
    // The pair a real pointer sends; the mousedown is the one that would
    // move focus, so it is the one the button refuses.
    fireEvent.pointerDown(button);
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledWith("hello world");
    expect(quoteButtons()).toHaveLength(0);
  });

  it("checks both ends of the selection against the root", () => {
    const { root, getByText } = mount();
    const range = document.createRange();
    range.setStart(getByText("hello world").firstChild!, 0);
    range.setEnd(getByText("elsewhere").firstChild!, 3);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionWithin(root, sel)).toBeNull();
  });
});

describe("quoteBlock", () => {
  it("prefixes one line and leaves a blank line after", () => {
    expect(quoteBlock("hello world")).toBe("> hello world\n\n");
  });

  it("prefixes every line of many, dropping trailing whitespace", () => {
    expect(quoteBlock("first\nsecond\n\n")).toBe("> first\n> second\n\n");
  });
});

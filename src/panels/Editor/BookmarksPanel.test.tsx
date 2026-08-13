import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import BookmarksPanel, { type BookmarkRow } from "./BookmarksPanel";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

// The panel reads rows and emits an open, so what is asserted here is the
// rendering and the three things a row can do. Where the rows come from is the
// store's business and is tested there.

const ROOT = "/space/proj/main";
const ROWS: BookmarkRow[] = [
  { path: `${ROOT}/src/a.ts`, line: 12 },
  { path: `${ROOT}/src/deep/b.ts`, line: 40, label: "the retry" },
];

let opened: OpenInEditor[] = [];
let offOpen: (() => void) | undefined;

beforeEach(() => {
  opened = [];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
});
afterEach(() => offOpen?.());

const noop = () => {};

describe("the bookmarks panel", () => {
  it("opens the file at the marked line when a row is clicked", () => {
    render(() => <BookmarksPanel rows={ROWS} root={ROOT} onLabel={noop} onRemove={noop} />);
    fireEvent.click(screen.getByText("a.ts"));
    // Through OPEN_IN_EDITOR, so the arrival is recorded like any other and Back
    // can take you off the line the panel put you on.
    expect(opened).toEqual([{ path: `${ROOT}/src/a.ts`, line: 12 }]);
  });

  it("says which line each row is", () => {
    render(() => <BookmarksPanel rows={ROWS} root={ROOT} onLabel={noop} onRemove={noop} />);
    expect(screen.getByText(":12")).toBeTruthy();
    expect(screen.getByText(":40")).toBeTruthy();
  });

  it("shows a name where there is one and the folder where there is not", () => {
    // A row can spare one line of context, and a name someone chose says more
    // than a path they already know.
    render(() => <BookmarksPanel rows={ROWS} root={ROOT} onLabel={noop} onRemove={noop} />);
    expect(screen.getByText("the retry")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
  });

  it("names the folder relative to the workspace", () => {
    render(() => <BookmarksPanel rows={ROWS} root={null} onLabel={noop} onRemove={noop} />);
    // With no workspace to be relative to, the whole folder is the honest answer.
    expect(screen.getByText(`${ROOT}/src`)).toBeTruthy();
  });

  it("hands a row to the labeller and to the remover", () => {
    const labelled: BookmarkRow[] = [];
    const removed: BookmarkRow[] = [];
    render(() => (
      <BookmarksPanel
        rows={ROWS}
        root={ROOT}
        onLabel={(r) => labelled.push(r)}
        onRemove={(r) => removed.push(r)}
      />
    ));
    fireEvent.click(screen.getByLabelText("Name this bookmark"));
    fireEvent.click(screen.getByLabelText("Rename this bookmark"));
    fireEvent.click(screen.getAllByLabelText("Remove this bookmark")[1]);
    expect(labelled).toEqual([ROWS[0], ROWS[1]]);
    expect(removed).toEqual([ROWS[1]]);
    // Neither is an open: the buttons sit outside the jump target.
    expect(opened).toEqual([]);
  });

  it("says how to make one when there are none", () => {
    // The tab is offered whether or not anything is marked, because this
    // sentence is the only place the gesture is explained.
    render(() => <BookmarksPanel rows={[]} root={ROOT} onLabel={noop} onRemove={noop} />);
    expect(screen.getByText(/Click the gutter beside a line to mark it/)).toBeTruthy();
  });
});

describe("the bookmarks panel, to axe", () => {
  it("has no accessibility violations", () => {
    const { container } = render(() => (
      <BookmarksPanel rows={ROWS} root={ROOT} onLabel={noop} onRemove={noop} />
    ));

    return expectNoAxeViolations(container);
  });
});

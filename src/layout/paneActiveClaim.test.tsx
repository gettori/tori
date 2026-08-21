// Why opening a file has to write the pane's **pick** and not only its kind's
// claim.
//
// A pane holds file tabs and terminal tabs at once, and each kind publishes one
// `stripActiveId` claim. `activeIdInPane` resolves the collision, and the rule
// is not "the kind that last changed wins": the stored pick wins when its kind
// still claims it, and otherwise the *first claim in display order* does.
//
// Two facts make that fatal for a file. `unifiedTabs` emits every terminal tab
// before every file tab, and `terminalTabStore.visibleId()` falls back to
// `tabs[0]`, so the terminal claim is never quiet once the workspace has one
// tab. A file that published only its claim therefore stayed behind whatever
// chat the pane was showing, however many times it was opened from the tree.
// A `.tsx` with no JSX in it: `tabPlacement` persists through localStorage, and
// the suite splits environments on the extension, so the DOM project is the one
// that can run this at all.
import { describe, it, expect, beforeEach } from "vitest";
import { activeIdInPane, resetTabPlacement, setPaneActive } from "./tabPlacement";

const WS = "/space/proj/main";
const PANE = "left";
// Display order, terminal tabs first, as `unifiedTabs` emits them.
const IN_PANE = ["chat:1", "chat:2", "file:/a.ts"];

beforeEach(() => {
  localStorage.clear();
  resetTabPlacement();
});

describe("a pane holding both a chat and a file", () => {
  it("gives the pane to the first claim in order when nothing is stored", () => {
    // Both kinds claim. This is the state `openFile` used to leave behind.
    expect(activeIdInPane(WS, PANE, IN_PANE, ["chat:1", "file:/a.ts"])).toBe("chat:1");
  });

  it("still gives it to the chat when only the file's claim changes", () => {
    // Opening a second file moves the file kind's claim and nothing else, so
    // the answer does not move at all. The tell is that it is not even the file
    // that was just opened.
    expect(activeIdInPane(WS, PANE, IN_PANE, ["chat:1", "file:/b.ts"])).toBe("chat:1");
  });

  it("gives it to the file once the file is the pane's stored pick", () => {
    // What clicking the tab has always done, through `PaneView`'s `onActivate`,
    // and what opening from the tree now does too.
    setPaneActive(WS, PANE, "file:/a.ts");

    expect(activeIdInPane(WS, PANE, IN_PANE, ["chat:1", "file:/a.ts"])).toBe("file:/a.ts");
  });

  it("falls back off a stored pick its kind no longer claims", () => {
    // The stored pick is not a veto: a file stored but not claimed (its kind
    // moved on to another tab) hands the pane back rather than pinning it to
    // something nothing is showing.
    setPaneActive(WS, PANE, "file:/a.ts");

    expect(activeIdInPane(WS, PANE, IN_PANE, ["chat:2", "file:/b.ts"])).toBe("chat:2");
  });
});

// The tree's highlight answers "which file is on screen", which is not the same
// question as "which file do commands mean". A pane showing a chat has no file
// on screen at all, and a row still lit as open points at something the user
// cannot see.
//
// `paneFileId` is the accessor behind it, and the case that matters is the one
// where the pane's answer is a tab of another kind entirely.
describe("what the pane is showing, for something that draws", () => {
  const FILES = ["file:/a.ts", "file:/b.ts"];

  it("answers with the chat when the chat is the pane's pick", () => {
    setPaneActive(WS, PANE, "chat:1");

    // Not a file id, so a file-filtered read of this resolves to nothing, and
    // the tree lights no row.
    expect(activeIdInPane(WS, PANE, [...IN_PANE, ...FILES], ["chat:1", "file:/a.ts"])).toBe("chat:1");
  });

  it("answers with the file again once the file is picked back", () => {
    setPaneActive(WS, PANE, "file:/a.ts");

    expect(activeIdInPane(WS, PANE, [...IN_PANE, ...FILES], ["chat:1", "file:/a.ts"])).toBe("file:/a.ts");
  });
});

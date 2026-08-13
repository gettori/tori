import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// The panel through its real seams: the tags come from the settings store's
// three-layer resolution, the search goes to `grep_project`, a click goes out
// as `OPEN_IN_EDITOR` (the one place arrivals are recorded as jumps), and Send
// goes out as `SEND_TO_SESSION`, which is the insert-only channel. None of the
// four is mocked away, because each is the thing the ticket actually promises.

type Options = { regex: boolean; case: boolean };
type GrepCall = { root: string; query: string; options: Options };

const bridge: {
  calls: GrepCall[];
  respond: (query: string) => unknown;
} = {
  calls: [],
  respond: () => ({ matches: [], truncated: false }),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "grep_project") {
      bridge.calls.push(args as unknown as GrepCall);
      return Promise.resolve(bridge.respond(args.query as string));
    }
    // `set_settings` echoes what it was handed, which is what the real backend
    // does once it has filled in any missing defaults.
    if (cmd === "set_settings") return Promise.resolve(args.settings);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import TodoPanel from "./TodoPanel";
import { saveSettings, settings, DEFAULT_SETTINGS } from "../Settings/settingsStore";
import { SEND_TO_SESSION, SEND_TO_SESSION_RESULT, OPEN_IN_EDITOR } from "../../utils/events";

const hit = (path: string, line: number, text: string, span: [number, number]) => ({
  path,
  line,
  text,
  submatches: [span],
});
const ok = (matches: ReturnType<typeof hit>[], truncated = false) => ({ matches, truncated });

const SESSION = { sessionId: "s1", agent: "claude", folderPath: "/proj" } as never;

/** What shipped, captured at import time. `createStore` proxies
 *  `DEFAULT_SETTINGS` itself (see the note above `BUILT_IN_EDITOR` in the
 *  store), so the first `saveSettings` rewrites that very object: cloning it in
 *  `beforeEach` would hand back whatever the previous test set. */
const PRISTINE = structuredClone(DEFAULT_SETTINGS);

function mount(extra: Partial<Parameters<typeof TodoPanel>[0]> = {}) {
  return render(() => <TodoPanel root="/proj" selected={null} {...extra} />);
}

/** Set the user-layer tag list and wait for the panel to search again. */
async function setTags(value: string) {
  const before = bridge.calls.length;
  await saveSettings({
    ...settings,
    editorDefaults: { ...settings.editorDefaults, todoPatterns: value },
  });
  await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(before));
}

beforeEach(async () => {
  bridge.calls = [];
  bridge.respond = () => ok([]);
  await saveSettings(structuredClone(PRISTINE));
  bridge.calls = [];
});

describe("what it searches for", () => {
  it("asks for every configured tag at once, case-sensitively", async () => {
    // Case-sensitive on purpose: a TODO marker and the word "todo" in a comment
    // are different things, and a panel listing every prose "hack" is one
    // nobody reads twice.
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    expect(bridge.calls[0].query).toBe("TODO|FIXME|HACK|XXX");
    expect(bridge.calls[0].options.regex).toBe(true);
    expect(bridge.calls[0].options.case).toBe(true);
  });

  it("lists what a custom tag finds, and stops listing the tag it replaced", async () => {
    // The ticket's first promise: the setting is what the panel searches for,
    // so changing it changes what is on screen without reopening anything.
    bridge.respond = (query) =>
      query.includes("REVIEW")
        ? ok([hit("src/a.ts", 4, "// REVIEW this", [3, 9])])
        : ok([hit("src/a.ts", 9, "// TODO that", [3, 7])]);
    mount();
    await waitFor(() => expect(screen.getByText("// TODO that")).toBeTruthy());

    await setTags("REVIEW");
    await waitFor(() => expect(screen.getByText("// REVIEW this")).toBeTruthy());
    expect(screen.queryByText("// TODO that")).toBeNull();
    expect(bridge.calls[bridge.calls.length - 1].query).toBe("REVIEW");
  });

  it("does not claim a project has nothing tagged when there is no project", async () => {
    // "Nothing tagged in this project" is a claim about a project, and with no
    // root there was no search to have made it.
    mount({ root: null });
    await waitFor(() => expect(screen.getByText("Open a project to see its TODOs.")).toBeTruthy());
    expect(screen.queryByText("Nothing tagged in this project.")).toBeNull();
    expect(bridge.calls).toHaveLength(0);
  });

  it("searches for nothing at all when the tag list is emptied", async () => {
    // An empty alternation would match at every position, so the panel would
    // list every line in the project rather than none.
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    const before = bridge.calls.length;
    await saveSettings({
      ...settings,
      editorDefaults: { ...settings.editorDefaults, todoPatterns: "  ,  " },
    });
    await waitFor(() => expect(screen.getByText(/No TODO tags configured/)).toBeTruthy());
    expect(bridge.calls.length).toBe(before);
  });
});

describe("the list", () => {
  beforeEach(() => {
    bridge.respond = () =>
      ok([
        hit("src/a.ts", 4, "  // TODO wire it", [5, 9]),
        hit("src/a.ts", 40, "  // FIXME leaks", [5, 10]),
        hit("src/b.ts", 7, "// HACK for now", [3, 7]),
      ]);
  });

  it("groups by file and counts each tag, zero included", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("3 items in 2 files")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^TODO/ }).textContent).toContain("1");
    // Configured but not found: the chip still appears, so it does not blink in
    // and out of the row as files are edited.
    expect(screen.getByRole("button", { name: /^XXX/ }).textContent).toContain("0");
  });

  it("narrows to the tags whose chips are on, and back again", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("// TODO wire it")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^FIXME/ }));
    await waitFor(() => expect(screen.queryByText("// TODO wire it")).toBeNull());
    expect(screen.getByText("// FIXME leaks")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^FIXME/ }));
    await waitFor(() => expect(screen.getByText("// TODO wire it")).toBeTruthy());
  });

  it("forgets a chip selection when the tags change under it", async () => {
    // Otherwise a tag nobody can see any more goes on filtering the list, and
    // the panel looks empty for no reason on screen.
    mount();
    await waitFor(() => expect(screen.getByText("// TODO wire it")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^FIXME/ }));
    await waitFor(() => expect(screen.queryByText("// TODO wire it")).toBeNull());

    bridge.respond = () => ok([hit("src/a.ts", 4, "// TODO wire it", [3, 7])]);
    await setTags("TODO");
    await waitFor(() => expect(screen.getByText("// TODO wire it")).toBeTruthy());
  });
});

describe("going to a TODO", () => {
  it("opens the file at that line, through the event jumps are recorded on", async () => {
    // `OPEN_IN_EDITOR` rather than a direct open: Editor.tsx's handler for it is
    // documented as the one place arrivals are recorded, so routing through it
    // is what makes this worth exactly one jump-list entry.
    bridge.respond = () => ok([hit("src/a.ts", 42, "  // TODO wire it", [5, 9])]);
    mount();
    await waitFor(() => expect(screen.getByText("// TODO wire it")).toBeTruthy());

    const opened: { path: string; line?: number }[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    try {
      fireEvent.click(screen.getByText("// TODO wire it"));
    } finally {
      window.removeEventListener(OPEN_IN_EDITOR, listener);
    }
    expect(opened).toEqual([{ path: "/proj/src/a.ts", line: 42 }]);
  });
});

describe("handing one to the agent", () => {
  beforeEach(() => {
    bridge.respond = () => ok([hit("src/a.ts", 42, "  // TODO wire it up", [5, 9])]);
  });

  it("lands the composed request at the prompt, unsubmitted", async () => {
    // Safe-send is insert-only by construction: the panel asks, the Terminal
    // answers, and nothing here submits. What is asserted is the request that
    // goes out and the text it carries.
    const sent: { text: string; requestId: string }[] = [];
    const onSend = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; requestId: string }>).detail;
      sent.push(detail);
      window.dispatchEvent(
        new CustomEvent(SEND_TO_SESSION_RESULT, {
          detail: { requestId: detail.requestId, result: "sent" },
        }),
      );
    };
    window.addEventListener(SEND_TO_SESSION, onSend);
    try {
      mount({ selected: SESSION });
      await waitFor(() => expect(screen.getByText("// TODO wire it up")).toBeTruthy());
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(sent).toHaveLength(1));
    } finally {
      window.removeEventListener(SEND_TO_SESSION, onSend);
    }

    // The mention comes first so the agent reads the location before the
    // request, matching the diagnostic and selection composers.
    expect(sent[0].text).toBe("@src/a.ts#L42 Fix this TODO: // TODO wire it up");
  });

  it("says why rather than sending when no session is selected", async () => {
    const sent: unknown[] = [];
    const onSend = () => sent.push(1);
    window.addEventListener(SEND_TO_SESSION, onSend);
    try {
      mount();
      await waitFor(() => expect(screen.getByText("// TODO wire it up")).toBeTruthy());
      // The reason is the Send button's tooltip now, not its `title`, so it
      // is asserted the way a keyboard user reaches it: focus opens it.
      const send = screen.getByRole("button", { name: "Send" });
      send.focus();
      fireEvent.focus(send);
      await waitFor(() =>
        expect(screen.getByRole("tooltip").textContent).toBe("Select a session first"),
      );
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(screen.queryByText("// TODO wire it up")).toBeTruthy());
    } finally {
      window.removeEventListener(SEND_TO_SESSION, onSend);
    }
    expect(sent).toHaveLength(0);
  });
});

describe("the todo panel, to axe", () => {
  it("has no accessibility violations", async () => {
    const { container } = mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    await expectNoAxeViolations(container);
  });
});

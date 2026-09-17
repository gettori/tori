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
  respond: (query: string, root: string) => unknown;
} = {
  calls: [],
  respond: () => ({ matches: [], truncated: false }),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "grep_project") {
      bridge.calls.push(args as unknown as GrepCall);
      return Promise.resolve(bridge.respond(args.query as string, args.root as string));
    }
    // `set_settings` echoes what it was handed, which is what the real backend
    // does once it has filled in any missing defaults.
    if (cmd === "set_settings") return Promise.resolve(args.settings);
    return Promise.resolve(null);
  },
}));

// The watcher's handlers are kept so a test can fire one burst at one root,
// which is the only way to assert that a neighbour's section survives it.
const fsHandlers = vi.hoisted(() => [] as ((e: { payload: { root?: string } }) => void)[]);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: { root?: string } }) => void) => {
    if (name === "fs://changed") fsHandlers.push(cb);
    return Promise.resolve(() => {
      const i = fsHandlers.indexOf(cb);
      if (i >= 0) fsHandlers.splice(i, 1);
    });
  },
  emit: () => Promise.resolve(),
}));

import TodoPanel from "./TodoPanel";
import type { MemberRoot } from "../../utils/topicMembers";
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
  fsHandlers.length = 0;
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


describe("a Feature's members", () => {
  const API = "/w/api";
  const WEB = "/w/web";
  const member = (label: string, path: string): MemberRoot => ({
    path,
    repoPath: path,
    label,
    state: { label: "Ready", usable: true, action: null, reason: null },
  });
  const ROOTS = [member("api", API), member("web", WEB)];

  const perRoot = (byRoot: Record<string, ReturnType<typeof hit>[]>, truncated: string[] = []) =>
    (_query: string, root: string) => ok(byRoot[root] ?? [], truncated.includes(root));

  const mountTopic = (roots = ROOTS) =>
    render(() => <TodoPanel root={API} selected={null} roots={roots} />);

  /** Past the panel's own fs debounce, which is deliberately longer than the
   *  tree's so a burst of writes is one rescan. */
  const settleWatcher = () => new Promise((r) => setTimeout(r, 500));

  it("greps every member once, and lists each member's hits under its own name", async () => {
    bridge.respond = perRoot({
      [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])],
      [WEB]: [hit("src/b.ts", 9, "// TODO in web", [3, 7])],
    });
    const { container } = mountTopic();
    await waitFor(() => expect(bridge.calls).toHaveLength(2));
    expect(bridge.calls.map((c) => c.root).sort()).toEqual([API, WEB]);

    await waitFor(() => expect(screen.getByText("// TODO in web")).toBeTruthy());
    const sections = [...container.querySelectorAll("[data-root]")];
    expect(sections.map((s) => s.getAttribute("data-root"))).toEqual([API, WEB]);
    expect(sections[0].textContent).toContain("// TODO in api");
    expect(sections[0].textContent).not.toContain("// TODO in web");
    expect(sections[1].textContent).toContain("// TODO in web");
  });

  it("opens a hit against the member it was found in", async () => {
    bridge.respond = perRoot({ [WEB]: [hit("src/b.ts", 9, "// TODO in web", [3, 7])] });
    mountTopic();
    await waitFor(() => expect(screen.getByText("// TODO in web")).toBeTruthy());

    const opened: { path: string; line?: number }[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    try {
      fireEvent.click(screen.getByText("// TODO in web"));
    } finally {
      window.removeEventListener(OPEN_IN_EDITOR, listener);
    }
    // Not `${API}/src/b.ts`: the active member is the api one, and the hit is
    // not in it.
    expect(opened).toEqual([{ path: `${WEB}/src/b.ts`, line: 9 }]);
  });

  it("leaves a member's rows alone when the other one changes underneath", async () => {
    bridge.respond = perRoot({
      [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])],
      [WEB]: [hit("src/b.ts", 9, "// TODO in web", [3, 7])],
    });
    mountTopic();
    await waitFor(() => expect(screen.getByText("// TODO in api")).toBeTruthy());
    await waitFor(() => expect(fsHandlers.length).toBeGreaterThan(0));

    bridge.calls = [];
    bridge.respond = perRoot({
      [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])],
      [WEB]: [hit("src/b.ts", 9, "// TODO moved", [3, 7])],
    });
    for (const cb of fsHandlers) cb({ payload: { root: WEB } });
    await settleWatcher();

    // Only the member that changed was re-grepped.
    await waitFor(() => expect(bridge.calls.map((c) => c.root)).toEqual([WEB]));
    await waitFor(() => expect(screen.getByText("// TODO moved")).toBeTruthy());
    // And the untouched member never blanked.
    expect(screen.getByText("// TODO in api")).toBeTruthy();
  });

  it("counts two members' same-named files as two files", async () => {
    // A hit's path is relative to the repo it was found in, so merging the
    // members' lists before counting would report one `src/a.ts`.
    bridge.respond = perRoot({
      [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])],
      [WEB]: [hit("src/a.ts", 9, "// TODO in web", [3, 7])],
    });
    mountTopic();
    await waitFor(() => expect(screen.getByText("// TODO in web")).toBeTruthy());
    expect(screen.getByText("2 items in 2 files")).toBeTruthy();
  });

  it("keeps the summary when one member's grep failed and the others answered", async () => {
    bridge.respond = (_q, root) => {
      if (root === WEB) throw new Error("ripgrep exploded");
      return ok([hit("src/a.ts", 4, "// TODO in api", [3, 7])]);
    };
    mountTopic();
    await waitFor(() => expect(screen.getByText(/ripgrep exploded/)).toBeTruthy());
    // One repo failing says nothing about the hits the other one returned.
    expect(screen.getByText("1 item in 1 file")).toBeTruthy();
  });

  it("reports a cap against the member that hit it", async () => {
    bridge.respond = perRoot(
      {
        [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])],
        [WEB]: [hit("src/b.ts", 9, "// TODO in web", [3, 7])],
      },
      [WEB],
    );
    const { container } = mountTopic();
    await waitFor(() => expect(screen.getByText("// TODO in web")).toBeTruthy());
    const sections = [...container.querySelectorAll("[data-root]")];
    expect(sections[1].textContent).toContain("Capped at");
    expect(sections[0].textContent).not.toContain("Capped at");
    // The Topic-wide summary makes no cap claim: it is not one repo's number.
    expect(screen.getByText("2 items in 2 files")).toBeTruthy();
  });

  it("keeps a member whose grep failed on screen, and the others with it", async () => {
    bridge.respond = (_q, root) => {
      if (root === WEB) throw new Error("ripgrep exploded");
      return ok([hit("src/a.ts", 4, "// TODO in api", [3, 7])]);
    };
    const { container } = mountTopic();
    await waitFor(() => expect(screen.getByText(/ripgrep exploded/)).toBeTruthy());
    const sections = [...container.querySelectorAll("[data-root]")];
    expect(sections[0].textContent).toContain("// TODO in api");
  });

  it("never greps a member with no worktree, but keeps its section", async () => {
    const gone: MemberRoot = {
      path: "/repos/web",
      repoPath: "/repos/web",
      label: "web",
      state: { label: "Worktree missing", usable: false, action: "recreate", reason: null },
    };
    bridge.respond = perRoot({ [API]: [hit("src/a.ts", 4, "// TODO in api", [3, 7])] });
    mountTopic([member("api", API), gone]);
    await waitFor(() => expect(screen.getByText("// TODO in api")).toBeTruthy());
    expect(bridge.calls.map((c) => c.root)).toEqual([API]);
    expect(screen.getByText("Worktree missing")).toBeTruthy();
  });
});

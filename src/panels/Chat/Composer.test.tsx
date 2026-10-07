import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import Composer, { ATTACHMENT_TOKEN_MIME, type ComposerHandle } from "./Composer";
import { expectNoAxeViolations } from "../../test/axe";
import type { AttachmentSource, PendingBlock } from "../../utils/chatCompose";
import type { PullRequest } from "../../utils/forgeTypes";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";

// The chip draws a stored file through the asset protocol, which needs the
// Tauri internals the webview injects and jsdom has not.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

// The first mounted tests in the repo. Three phases shipped composer behaviour
// that was reasoned rather than rendered; these are the things that reasoning
// cannot settle, because they are about what the DOM does with an event.

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const [draft, setDraftValue] = createSignal("");
  const onSend = vi.fn();
  const onInterrupt = vi.fn();
  const onDropAttachment = vi.fn();
  const onAttachFile = vi.fn((_relPath: string): string | null => "[File 1]");
  const onAttachUploads = vi.fn();
  const onAttachRejected = vi.fn();
  const onAttachPaths = vi.fn();
  const result = render(() => (
    <Composer
      running={false}
      steering={false}
      steerCost={null}
      queue={[]}
      attachments={[]}
      commands={[]}
      loadFiles={async () => []}
      prs={[]}
      loadPrs={() => {}}
      onAttachPr={() => null}
      resolvePr={async () => null}
      onAttachFile={onAttachFile}
      uploads={OPENS_EVERYTHING}
      onAttachUploads={onAttachUploads}
      onAttachRejected={onAttachRejected}
      onAttachPaths={onAttachPaths}
      draft={draft()}
      onDraftChange={setDraftValue}
      history={[]}
      parked={false}
      disabled={false}
      onSend={onSend}
      onInterrupt={onInterrupt}
      onDropQueued={() => {}}
      onDropAttachment={onDropAttachment}
      onSendQueued={() => {}}
      onDiscardQueued={() => {}}
      {...over}
    />
  ));
  const input = result.container.querySelector("textarea") as HTMLTextAreaElement;
  return {
    ...result,
    input,
    onSend,
    onInterrupt,
    onDropAttachment,
    onAttachFile,
    onAttachUploads,
    onAttachRejected,
    onAttachPaths,
  };
}

// Claude's upload source, which every test not about a refusal runs under.
const OPENS_EVERYTHING: AttachmentSource = { kinds: ["image", "pdf", "file"], gap: null };

// `stubMetrics` below spies on `getComputedStyle` with a plain object, and a
// spy left standing breaks every later accessible-name lookup and axe scan:
// they ask the returned style for `getPropertyValue`, which the stub has not.
afterEach(() => vi.restoreAllMocks());

// jsdom lays nothing out, so the box is handed the two numbers the arithmetic
// reads: `clientHeight` is what the rows attribute currently buys it, and
// `scrollHeight` is what the text needs. Everything else about the fit is
// decided from those two.
function stubMetrics(input: HTMLTextAreaElement, opts: { line: number; padding: number; needed: () => number }) {
  Object.defineProperty(input, "clientHeight", {
    get: () => input.rows * opts.line + opts.padding,
    configurable: true,
  });
  Object.defineProperty(input, "scrollHeight", { get: opts.needed, configurable: true });
  const style = {
    lineHeight: `${opts.line}px`,
    paddingTop: `${opts.padding / 2}px`,
    paddingBottom: `${opts.padding / 2}px`,
  };
  vi.spyOn(window, "getComputedStyle").mockReturnValue(style as unknown as CSSStyleDeclaration);
}

/** Every value `rows` is set to, in order. The collapse this used to do shows
 *  up here as a 1 between two sensible numbers. */
function watchRows(input: HTMLTextAreaElement) {
  const seen: number[] = [];
  let rows = input.rows;
  Object.defineProperty(input, "rows", {
    get: () => rows,
    set: (v: number) => {
      rows = v;
      seen.push(v);
    },
    configurable: true,
  });
  return seen;
}

describe("the input's own height", () => {
  it("grows without collapsing the box first", () => {
    // The old fit set `rows = 1` before every measurement, which laid out the
    // whole pane twice per keystroke and moved the transcript above with it.
    const { input } = setup();
    let needed = 200;
    stubMetrics(input, { line: 20, padding: 20, needed: () => needed });
    const seen = watchRows(input);

    needed = 140; // six lines of content in a three-line box
    fireEvent.input(input, { target: { value: "a\nb\nc\nd\ne\nf" } });

    expect(seen).not.toContain(1);
    expect(input.rows).toBe(6);
  });

  it("measures nothing at all while the text still fits", () => {
    // The common case by far: typing along inside a box that is already the
    // right size. Nothing is written, so nothing is laid out twice.
    const { input } = setup();
    stubMetrics(input, { line: 20, padding: 20, needed: () => 60 });
    const seen = watchRows(input);

    fireEvent.input(input, { target: { value: "hello" } });

    expect(seen).toEqual([]);
    expect(input.rows).toBe(3);
  });

  it("comes back to its resting height when a message goes, not below it", () => {
    // The bug the whole of this describe exists around: sending put the box at
    // one row, which is a height it has at no other moment. The next keystroke
    // measured it and snapped it back up, and that jump is what reads as the
    // composer resizing itself while you type.
    const { input } = setup();
    let needed = 140;
    stubMetrics(input, { line: 20, padding: 20, needed: () => needed });
    fireEvent.input(input, { target: { value: "a\nb\nc\nd\ne\nf" } });
    expect(input.rows).toBe(6);

    needed = 40;
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.rows).toBe(3);
  });

  it("puts a box that is somehow under the floor back on it", () => {
    // Belt for the same braces: whatever leaves it short - an older build's
    // send, a hand-set attribute - the next fit is not allowed to agree with
    // it. Nothing is measured at a size the box is not permitted to be.
    const { input } = setup();
    stubMetrics(input, { line: 20, padding: 20, needed: () => 40 });
    input.rows = 1;

    fireEvent.input(input, { target: { value: "a" } });

    expect(input.rows).toBe(3);
  });

  it("still shrinks when the text does", () => {
    const { input } = setup();
    let needed = 140;
    stubMetrics(input, { line: 20, padding: 20, needed: () => needed });
    fireEvent.input(input, { target: { value: "a\nb\nc\nd\ne\nf" } });
    expect(input.rows).toBe(6);

    needed = 40;
    fireEvent.input(input, { target: { value: "a" } });
    expect(input.rows).toBe(3);
  });
});

describe("Composer keys", () => {
  it("sends on Enter", () => {
    const { input, onSend } = setup();
    fireEvent.input(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("does not send on Shift+Enter, which is a newline", () => {
    const { input, onSend } = setup();
    fireEvent.input(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("interrupts on Escape only while a turn is running", () => {
    const idle = setup();
    fireEvent.keyDown(idle.input, { key: "Escape" });
    expect(idle.onInterrupt).not.toHaveBeenCalled();

    const busy = setup({ running: true });
    fireEvent.keyDown(busy.input, { key: "Escape" });
    expect(busy.onInterrupt).toHaveBeenCalled();
  });

  it("clears the draft on Ctrl+C, the way a shell prompt does", () => {
    const { input, onSend } = setup();
    fireEvent.input(input, { target: { value: "half a thought" } });

    expect(fireEvent.keyDown(input, { key: "c", ctrlKey: true })).toBe(false);
    expect(input.value).toBe("");
    // Dropped, not sent: the two ways a draft stops being one, and this is the
    // one that keeps no copy.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+C alone when the box is empty", () => {
    const { input } = setup();
    expect(fireEvent.keyDown(input, { key: "c", ctrlKey: true })).toBe(true);
  });

  it("keeps the chips when Ctrl+C drops the prose", () => {
    // A chip is a file that was picked rather than something typed, and it has
    // its own x. Clearing the sentence must not take the attachments with it.
    const chip: PendingBlock[] = [
      {
        id: "att-1",
        block: {
          type: "fileRef",
          path: "/store/1a2b-0/shot.png",
          startLine: null,
          endLine: null,
          text: null,
          label: "[Image 1]",
        },
      },
    ];
    const { input, onDropAttachment } = setup({ attachments: chip });
    fireEvent.input(input, { target: { value: "look at [Image 1]" } });

    fireEvent.keyDown(input, { key: "c", ctrlKey: true });

    expect(input.value).toBe("");
    expect(onDropAttachment).not.toHaveBeenCalled();
  });

  it("leaves the draft to the scratch tab that holds it", () => {
    // While a scratch tab is the writer, the input is read-only: clearing here
    // would be overwritten by the tab's next save anyway.
    const { input } = setup({ linked: "draft-1.md", draft: "held elsewhere" });
    expect(fireEvent.keyDown(input, { key: "c", ctrlKey: true })).toBe(true);
    expect(input.value).toBe("held elsewhere");
  });

  it("sends nothing when there is nothing to send", () => {
    const { input, onSend } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  // Half a code block is the one message a fence says you do not want sent.
  // Enter is left alone there (not prevented), so the textarea adds the line.
  it("adds a line rather than sending while the caret is inside an open code fence", () => {
    const { input, onSend } = setup();
    type(input, "look:\n```ts\nconst a = 1;");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();

    type(input, "look:\n```ts\nconst a = 1;\n```");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSend).toHaveBeenCalledWith("look:\n```ts\nconst a = 1;\n```");
  });

  it("sends on Cmd+Enter from inside a fence", () => {
    const { input, onSend } = setup();
    type(input, "```\ncode");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("```\ncode");
  });

  // Enter over an open menu completes; Cmd+Enter is the one key that still
  // sends, and it must not complete on the way out.
  it("sends on Cmd+Enter over an open completion menu, without completing", async () => {
    const { input, findByText, onSend, onAttachFile } = setup({ loadFiles: async () => FILES });
    type(input, "look at @compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("look at @compose");
    expect(onAttachFile).not.toHaveBeenCalled();
  });

  it("says what Enter does while inside a fence, and only then", () => {
    const { input, queryByText } = setup();
    const hint = () => queryByText(/Cmd\+Enter sends/);
    expect(hint()).toBeNull();
    type(input, "```\n");
    expect(hint()).not.toBeNull();
    type(input, "```\ncode\n```");
    expect(hint()).toBeNull();
  });

  // What Enter does mid-turn changed, so the placeholder has to say which of the
  // two it will do. It also must not present a steer as instant: Phase 2 measured
  // 1.5s to 5.4s from the write to the model acting on it.
  it("says whether typing steers this turn or queues for the next", () => {
    expect(setup({ running: true, steering: true, steerCost: "1.5-5.4s" }).input.placeholder).toBe(
      "Steer this turn, picked up in 1.5-5.4s",
    );
    expect(setup({ running: true, steering: false }).input.placeholder).toBe("Type to queue for the next turn");
    expect(setup({ running: true, steering: true, steerCost: null, onQueue: () => {} }).input.placeholder).toBe(
      "Steer this turn, picked up at its next step. Option+Enter queues",
    );
  });

  // The figure comes from the declared tier, so a agent measured differently
  // quotes its own; one with nothing measured still refuses to imply immediacy.
  it("quotes the measured delivery rather than implying a steer is instant", () => {
    const slower = setup({ running: true, steering: true, steerCost: "3.0-9.0s" }).input.placeholder;
    expect(slower).toBe("Steer this turn, picked up in 3.0-9.0s");

    const unmeasured = setup({ running: true, steering: true, steerCost: null }).input.placeholder;
    expect(unmeasured).toBe("Steer this turn, picked up at its next step");
    for (const text of [slower, unmeasured]) {
      expect(text).not.toMatch(/instant|immediate|now\b/i);
    }
  });
});

// Typing into a textarea in jsdom does not move the caret, and the menu keys off
// the caret. So the value and the selection are set together, the way a real
// keystroke leaves them.
function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.input(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
  fireEvent.select(input);
}

const FILES = ["src/utils/chatCompose.ts", "src/panels/Chat/Composer.tsx", "README.md"];

function pr(number: number, title: string): PullRequest {
  return {
    number,
    title,
    body: null,
    state: "open",
    isDraft: false,
    author: "a",
    createdAt: "2026-10-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    comments: 0,
    headRef: "h",
    baseRef: "main",
    headSha: "abc",
    headRepoIsOrigin: true,
    url: `https://github.com/o/r/pull/${number}`,
    mergeableState: "clean",
  };
}

describe("# pull request completion", () => {
  const PRS = [pr(12, "Fix login"), pr(9, "Docs")];
  const hash = (n: number | string) => `#${n}`;

  it("lists the open pull requests and Enter names the picked one", async () => {
    const onAttachPr = vi.fn((p: PullRequest) => `[PR ${p.number}]`);
    const loadPrs = vi.fn();
    const { input, findByText, onSend } = setup({ prs: PRS, loadPrs, onAttachPr });
    type(input, `see ${hash("login")}`);
    expect(await findByText("Fix login")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachPr).toHaveBeenCalledWith(PRS[0]);
    expect(input.value).toBe("see [PR 12]");
    expect(onSend).not.toHaveBeenCalled();
    expect(loadPrs).toHaveBeenCalledTimes(1);
  });

  // "fixes #4" is a sentence far more often than a pick.
  it("sends the sentence as typed on Enter over a number the list does not hold", async () => {
    const onAttachPr = vi.fn(() => "[PR 4]");
    const resolvePr = vi.fn(async () => pr(4, "Old"));
    const { input, findByText, onSend } = setup({ prs: PRS, onAttachPr, resolvePr });
    type(input, `fixes ${hash(4)}`);
    await findByText("Tab to look it up, Enter sends as typed");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(`fixes ${hash(4)}`);
    expect(resolvePr).not.toHaveBeenCalled();
    expect(onAttachPr).not.toHaveBeenCalled();
  });

  it("looks up a number the list does not hold on Tab", async () => {
    const old = pr(4, "Old");
    const onAttachPr = vi.fn(() => "[PR 4]");
    const resolvePr = vi.fn(async () => old);
    const { input, findByText, onSend } = setup({ prs: PRS, onAttachPr, resolvePr });
    type(input, `fixes ${hash(4)}`);
    await findByText("Tab to look it up, Enter sends as typed");
    fireEvent.keyDown(input, { key: "Tab" });
    await vi.waitFor(() => expect(onAttachPr).toHaveBeenCalledWith(old));
    expect(input.value).toBe("fixes [PR 4]");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("says so when the number is not a pull request here", async () => {
    const { input, findByText, onAttachRejected } = setup({
      prs: PRS,
      onAttachPr: () => "[PR 4]",
      resolvePr: async () => null,
    });
    type(input, hash(4));
    await findByText("Tab to look it up, Enter sends as typed");
    fireEvent.keyDown(input, { key: "Tab" });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(input.value).toBe(hash(4));
  });
});

describe("@ sessions beside files", () => {
  const meta = (id: string, title: string) => ({
    id,
    path: `/t/${id}.jsonl`,
    cwd: "/work/repo",
    branch: "main",
    title,
    last_active: 0,
    created_at: 0,
    name: null,
    agent: "codex",
  });
  const SESSIONS = [meta("a", "Fix login flow"), meta("b", "Write docs")];
  const withSessions = (over: Partial<Parameters<typeof Composer>[0]> = {}) =>
    setup({
      loadFiles: async () => FILES,
      sessions: SESSIONS,
      loadSessions: () => {},
      onAttachSession: (m) => `[Session: ${m.title}]`,
      ...over,
    });

  it("lists sessions above files on a bare @", async () => {
    const { input, findByText, container } = withSessions();
    type(input, "@");
    await findByText("README.md");
    const names = [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(names.slice(0, 2)).toEqual(["Fix login flowSession, codex", "Write docsSession, codex"]);
  });

  it("reads the session list again for each new @, not per keystroke", () => {
    const loadSessions = vi.fn();
    const { input } = withSessions({ loadSessions });
    type(input, "@a");
    type(input, "@ab");
    expect(loadSessions).toHaveBeenCalledTimes(1);
    type(input, "@ab @c");
    expect(loadSessions).toHaveBeenCalledTimes(2);
  });

  it("narrows to sessions with @session/ and to files with @file/", async () => {
    const { input, findByText, queryByText } = withSessions();
    type(input, "@session/docs");
    expect(await findByText("Write docs")).toBeTruthy();
    expect(queryByText("README.md")).toBeNull();
    type(input, "@file/read");
    expect(await findByText("README.md")).toBeTruthy();
    expect(queryByText("Write docs")).toBeNull();
  });

  it("still fuzzy matches a file path through a slash", async () => {
    const { input, findByText } = withSessions();
    type(input, "@utils/chat");
    expect(await findByText("src/utils/chatCompose.ts")).toBeTruthy();
  });

  it("names the picked session where the mention was", async () => {
    const { input, findByText } = withSessions();
    type(input, "ask @session/login");
    await findByText("Fix login flow");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("ask [Session: Fix login flow]");
  });

  it("offers files only when no sessions are passed, as for pi, and # still works", async () => {
    const { input, findByText, queryByText } = withSessions({
      sessions: undefined,
      prs: [pr(12, "Fix login")],
      onAttachPr: () => "[PR 12]",
    });
    type(input, "@");
    await findByText("README.md");
    expect(queryByText("Fix login flow")).toBeNull();
    type(input, "#login");
    expect(await findByText("Fix login")).toBeTruthy();
  });
});

describe("@ project and space navigator", () => {
  const meta = (id: string, title: string) => ({
    id,
    path: `/t/${id}.jsonl`,
    cwd: "/code/tori/main",
    branch: "main",
    title,
    last_active: 0,
    created_at: 0,
    name: null,
    agent: "claude",
  });
  const unit = (folderPath: string) => ({
    label: folderPath.split("/").pop()!,
    folderPath,
    branch: "main",
    kind: "worktree",
    isCurrent: false,
  });
  const TORI = { name: "tori", path: "/code/tori", branchUnits: [unit("/code/tori/main")] };
  const FORK = { name: "tori", path: "/forks/tori", branchUnits: [] };
  const WORK = { name: "Client Work", path: "/spaces/client-work", projects: [TORI, FORK] };
  const withNav = () => {
    const nav = {
      spaces: () => [WORK],
      here: () => WORK,
      sessionsOf: (path: string) => (path === TORI.path ? [meta("s1", "Fix login flow")] : []),
      filesOf: (folder: string) => (folder === "/code/tori/main" ? ["src/a.ts", "README.md"] : []),
      loadSessionsOf: vi.fn(),
      loadFilesOf: vi.fn(),
      onAttachProject: vi.fn((_g, p: { name: string }) => `[Project: ${p.name}]`),
      onAttachSpace: vi.fn((g: { name: string }) => `[Space: ${g.name}]`),
      onAttachSession: vi.fn((s: { title: string }) => `[Session: ${s.title}]`),
    };
    const onAttachPaths = vi.fn(() => ["[File 1]"]);
    return { ...setup({ navigator: nav, onAttachPaths }), nav, onAttachPaths };
  };

  it("drills @spaces/ by path keys down to a file, which attaches by its absolute path", async () => {
    const { input, findByText, onAttachPaths } = withNav();
    type(input, "see @spaces/");
    expect(await findByText("Client Work")).toBeTruthy();
    fireEvent.keyDown(input, { key: "/" });
    expect(input.value).toBe("see @spaces/client-work/");
    type(input, "see @spaces/client-work/tori/main/rea");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachPaths).toHaveBeenCalledWith(["/code/tori/main/README.md"]);
    expect(input.value).toBe("see [File 1]");
  });

  it("keys two projects of one name apart", async () => {
    const { input, findByText, container } = withNav();
    type(input, "@projects/");
    await findByText("tori-2/");
    const hints = [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(hints).toEqual(["toritori/Project", "toritori-2/Project"]);
  });

  it("lists a project's checkouts and its sessions, and Enter references a session", async () => {
    const { input, findByText, nav } = withNav();
    type(input, "ask @projects/tori/login");
    expect(nav.loadSessionsOf).toHaveBeenCalledWith("/code/tori");
    await findByText("Fix login flow");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(nav.onAttachSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "/code/tori");
    expect(input.value).toBe("ask [Session: Fix login flow]");
  });

  it("leaves the draft alone on / over a session, which has nothing under it", async () => {
    const { input, findByText } = withNav();
    type(input, "@projects/tori/login");
    await findByText("Fix login flow");
    expect(fireEvent.keyDown(input, { key: "/" })).toBe(false);
    expect(input.value).toBe("@projects/tori/login");
  });

  it("Enter references the highlighted space or project", async () => {
    const { input, findByText, nav } = withNav();
    type(input, "@spaces/cli");
    await findByText("Client Work");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(nav.onAttachSpace).toHaveBeenCalledWith(WORK);
    expect(input.value).toBe("[Space: Client Work]");
    type(input, "@projects/tori-2");
    await findByText("tori-2/");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(nav.onAttachProject).toHaveBeenCalledWith(WORK, FORK);
    expect(input.value).toBe("[Project: tori]");
  });
});

describe("@ file completion", () => {
  it("opens on @ and filters as you type", async () => {
    const { input, findByText, queryByText } = setup({ loadFiles: async () => FILES });
    type(input, "@");
    expect(await findByText("README.md")).toBeTruthy();

    type(input, "@compose");
    expect(await findByText("src/utils/chatCompose.ts")).toBeTruthy();
    expect(queryByText("README.md")).toBeNull();
  });

  it("loads the project index once, however many mentions are typed", async () => {
    const loadFiles = vi.fn(async () => FILES);
    const { input, findByText } = setup({ loadFiles });
    type(input, "@a");
    await findByText("src/panels/Chat/Composer.tsx");
    type(input, "@a @b");
    expect(loadFiles).toHaveBeenCalledTimes(1);
  });

  // The mention keeps its place, as the token the chip is named by: taking the
  // words out would leave "look at" pointing at nothing.
  it("accepting a mention leaves its token where the mention was", async () => {
    const { input, findByText, onAttachFile } = setup({ loadFiles: async () => FILES });
    type(input, "look at @compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachFile).toHaveBeenCalledWith("src/utils/chatCompose.ts");
    expect(input.value).toBe("look at [File 1]");
  });

  it("drops the mention when the file was refused, since there is no token to put there", async () => {
    const onAttachFile = vi.fn((): string | null => null);
    const { input, findByText } = setup({ loadFiles: async () => FILES, onAttachFile });
    type(input, "look at @compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("look at");
  });

  // The sharp one: Enter belongs to the menu while it is open, or completing a
  // mention would send the half-typed line it was completing.
  it("Enter completes rather than sends while the menu is open", async () => {
    const { input, findByText, onSend } = setup({ loadFiles: async () => FILES });
    type(input, "@compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Escape dismisses the menu without interrupting the turn", async () => {
    const { input, findByText, queryByText, onInterrupt } = setup({
      running: true,
      loadFiles: async () => FILES,
    });
    type(input, "@compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(queryByText("src/utils/chatCompose.ts")).toBeNull();
    expect(onInterrupt).not.toHaveBeenCalled();
    // The next Escape reaches the turn, so nothing is unreachable.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalled();
  });

  it("Tab accepts like Enter", async () => {
    const { input, findByText, onAttachFile } = setup({ loadFiles: async () => FILES });
    type(input, "@compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onAttachFile).toHaveBeenCalledWith("src/utils/chatCompose.ts");
  });

  it("arrows move the selection that Enter accepts", async () => {
    const { input, findByText, onAttachFile } = setup({ loadFiles: async () => FILES });
    type(input, "@compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachFile).toHaveBeenCalledWith("src/panels/Chat/Composer.tsx");
  });

  it("stays shut for an @ that is not a mention", async () => {
    const { input, queryByText } = setup({ loadFiles: async () => FILES });
    type(input, "mail me@example");
    expect(queryByText("README.md")).toBeNull();
  });
});

describe("/ slash-command completion", () => {
  // Shaped like the real `initialize` catalogue: a hint on some, an empty one on
  // most. See the fixture at dev/fixtures/claude/initialize.jsonl.
  const COMMANDS = [
    { name: "review", description: "Multi-lens code review", argumentHint: "[pr number]", aliases: [] },
    { name: "resume", description: "Resume a session", argumentHint: "", aliases: [] },
    { name: "compact", description: "Compact the context", argumentHint: "", aliases: ["c"] },
  ];

  it("lists commands with their descriptions and argument hints", () => {
    const { input, getByText } = setup({ commands: COMMANDS });
    type(input, "/re");
    expect(getByText("/review")).toBeTruthy();
    expect(getByText("Multi-lens code review")).toBeTruthy();
    expect(getByText("[pr number]")).toBeTruthy();
    expect(getByText("/resume")).toBeTruthy();
  });

  it("inserts the command and leaves the caret ready for its argument", () => {
    const { input, getByText } = setup({ commands: COMMANDS });
    type(input, "/rev");
    fireEvent.click(getByText("/review"));
    expect(input.value).toBe("/review ");
    // The hint is shown, never inserted: it says what to type, and inserting it
    // would send the literal words "[pr number]" to the model.
    expect(input.value).not.toContain("[pr number]");
  });

  // A slash mid-sentence is a path separator. Completing there would offer a
  // command menu over every path anyone ever types.
  it("does not open on a slash that is not the message's opening", () => {
    const { input, queryByText } = setup({ commands: COMMANDS });
    type(input, "look in src/re");
    expect(queryByText("/review")).toBeNull();
  });
});

// jsdom builds a real File from a Blob, so the size and type the limit check
// reads are the file's own rather than a stub's.
function imageFile(name: string, type = "image/png", bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Fire a chip's dragstart and answer what it put on the drag, so the drop that
 *  follows carries exactly what the drag set and nothing a test invented. */
function drag(el: Element): Record<string, string> {
  const data: Record<string, string> = {};
  fireEvent.dragStart(el, {
    dataTransfer: {
      types: [],
      setData: (mime: string, value: string) => {
        data[mime] = value;
      },
    },
  });
  return data;
}

function drop(el: Element, init: { files?: File[]; data?: Record<string, string> }) {
  const dataTransfer = {
    files: init.files ?? [],
    types: Object.keys(init.data ?? {}),
    getData: (mime: string) => init.data?.[mime] ?? "",
  };
  fireEvent.drop(el, { dataTransfer });
}

// Thirty-one lines: one past the threshold.
const LONG_PASTE = Array.from({ length: 31 }, (_, i) => `line ${i}`).join("\n");

/** A text paste, the way the clipboard hands one over: no files, text on ask. */
function pasteOf(text: string) {
  return { clipboardData: { files: [], getData: () => text } };
}

describe("file uploads", () => {
  // Bytes and a name, nothing decoded: they are written to disk as they are
  // and come back as a path, so no `image` block is ever offered.
  it("hands a dropped PNG over as its bytes and its name", async () => {
    const { container, onAttachUploads } = setup();
    drop(container.firstElementChild!, { files: [imageFile("shot.png")] });
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
    const [files] = onAttachUploads.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(files[0].bytes).toBeInstanceOf(Uint8Array);
    expect(files[0].bytes).toHaveLength(64);
  });

  it("takes a PDF and a source file the same way", async () => {
    const { container, onAttachUploads } = setup();
    drop(container.firstElementChild!, {
      files: [imageFile("notes.pdf", "application/pdf"), imageFile("main.ts", "video/mp2t")],
    });
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
    expect(onAttachUploads.mock.calls[0][0].map((f: { name: string }) => f.name)).toEqual(["notes.pdf", "main.ts"]);
  });

  it("attaches a pasted file without swallowing an ordinary text paste", async () => {
    const { input, onAttachUploads } = setup();
    expect(fireEvent.paste(input, pasteOf("hello"))).toBe(true);
    expect(onAttachUploads).not.toHaveBeenCalled();
    fireEvent.paste(input, { clipboardData: { files: [imageFile("clip.png")] } });
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
  });

  // A document pasted into a sentence box: it becomes a file the agent reads
  // off disk, and the box keeps whatever was already in it.
  it("turns a long text paste into a pasted.txt chip and leaves the box alone", async () => {
    const { input, onAttachUploads } = setup();
    expect(fireEvent.paste(input, pasteOf(LONG_PASTE))).toBe(false);
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
    const [files] = onAttachUploads.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("pasted.txt");
    expect(new TextDecoder().decode(files[0].bytes)).toBe(LONG_PASTE);
    expect(input.value).toBe("");
  });

  it("counts a paste as long by characters as well as by lines", async () => {
    const { input, onAttachUploads } = setup();
    expect(fireEvent.paste(input, pasteOf("x".repeat(3001)))).toBe(false);
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
    const short = setup();
    expect(fireEvent.paste(short.input, pasteOf("x".repeat(3000)))).toBe(true);
    expect(short.onAttachUploads).not.toHaveBeenCalled();
  });

  it("pastes long text as text under an agent that takes no file uploads, and when turned off", () => {
    const noFiles = setup({ uploads: { kinds: ["image", "pdf"], gap: null } });
    expect(fireEvent.paste(noFiles.input, pasteOf(LONG_PASTE))).toBe(true);
    expect(noFiles.onAttachUploads).not.toHaveBeenCalled();
    expect(noFiles.onAttachRejected).not.toHaveBeenCalled();

    const off = setup({ attachLongPastes: false });
    expect(fireEvent.paste(off.input, pasteOf(LONG_PASTE))).toBe(true);
    expect(off.onAttachUploads).not.toHaveBeenCalled();
  });

  // Through the same door as a dropped file, so the same cap applies.
  it("counts a long paste against the attachment cap", async () => {
    const pending: PendingBlock[] = Array.from({ length: 10 }, (_, i) => ({
      id: `att-${i}`,
      block: { type: "fileRef" as const, path: `/x/s${i}.png`, startLine: null, endLine: null, text: null },
    }));
    const { input, onAttachUploads, onAttachRejected } = setup({ attachments: pending });
    fireEvent.paste(input, pasteOf(LONG_PASTE));
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  it("filters the picker to what the agent opens, and not at all when that is any file", () => {
    const any = setup().container.querySelector('input[type="file"]');
    expect(any?.getAttribute("accept")).toBeNull();
    const imagesOnly = setup({ uploads: { kinds: ["image"], gap: null } }).container.querySelector(
      'input[type="file"]',
    );
    expect(imagesOnly?.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
  });

  it("renders an image chip as the image itself", () => {
    const chips: PendingBlock[] = [{ id: "att-1", block: { type: "image", mediaType: "image/png", data: "AAAA" } }];
    const { container } = setup({ attachments: chips });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });
});

// The token is what the sentence names an attachment by, and the chip used to
// be the only way to get one: a dropped file was attached and unnamed until it
// was clicked, which is a step nobody took.
describe("naming a new attachment in the message", () => {
  it("puts a dropped path's token in at the caret", () => {
    const { input, container } = setup({ onAttachPaths: () => ["[File 1]"] });
    type(input, "look here");
    input.setSelectionRange(4, 4);
    drop(container.firstElementChild!, { data: { "application/x-tori-path": "/repo/src/a.ts" } });
    expect(input.value).toBe("look [File 1] here");
  });

  it("puts an upload's token in once it has been stored", async () => {
    const { input } = setup({ onAttachUploads: async () => ["[Image 1]"] });
    type(input, "compare");
    fireEvent.paste(input, { clipboardData: { files: [imageFile("shot.png")] } });
    await vi.waitFor(() => expect(input.value).toBe("compare [Image 1]"));
  });

  // The document goes to disk and its name takes its place, so the sentence
  // still reads as one written around what was pasted into it.
  it("leaves a long paste's token where the text would have gone", async () => {
    const { input } = setup({ onAttachUploads: async () => ["[File 1]"] });
    type(input, "summarise this");
    fireEvent.paste(input, pasteOf(LONG_PASTE));
    await vi.waitFor(() => expect(input.value).toBe("summarise this [File 1]"));
  });

  // Two files, one drop: one run of tokens rather than two placed at a caret
  // the first one moved.
  it("names every file of a multi-file drop, in the order they arrived", async () => {
    const { input, container } = setup({ onAttachUploads: async () => ["[Image 1]", "[File 2]"] });
    type(input, "these");
    drop(container.firstElementChild!, { files: [imageFile("shot.png"), imageFile("main.ts", "video/mp2t")] });
    await vi.waitFor(() => expect(input.value).toBe("these [Image 1] [File 2]"));
  });
});

describe("attachment limits, applied where a thing is offered", () => {
  it("rejects a kind nothing opens and says what this agent does", async () => {
    const { container, onAttachUploads, onAttachRejected } = setup();
    drop(container.firstElementChild!, { files: [imageFile("clip.mp4", "video/mp4")] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachRejected.mock.calls[0][0]).toMatch(/clip\.mp4.*image, pdf, file/);
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  it("rejects an oversized image and says how big it was", async () => {
    const { container, onAttachUploads, onAttachRejected } = setup();
    drop(container.firstElementChild!, { files: [imageFile("huge.png", "image/png", 6 * 1024 * 1024)] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachRejected.mock.calls[0][0]).toMatch(/6\.0MB/);
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  // The one a per-file check gets wrong: eleven dropped at once must not all
  // pass a limit that was only ever read before the batch started.
  it("counts a batch against the cap as it goes", async () => {
    const { container, onAttachUploads, onAttachRejected } = setup();
    const many = Array.from({ length: 12 }, (_, i) => imageFile(`s${i}.png`));
    drop(container.firstElementChild!, { files: many });
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
    expect(onAttachUploads.mock.calls[0][0]).toHaveLength(10);
    expect(onAttachRejected).toHaveBeenCalledTimes(2);
  });

  it("counts what is already pending, not just this drop", async () => {
    const pending: PendingBlock[] = Array.from({ length: 10 }, (_, i) => ({
      id: `att-${i}`,
      block: { type: "fileRef" as const, path: `/x/s${i}.png`, startLine: null, endLine: null, text: null },
    }));
    const { container, onAttachUploads, onAttachRejected } = setup({ attachments: pending });
    drop(container.firstElementChild!, { files: [imageFile("one-more.png")] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachUploads).not.toHaveBeenCalled();
  });
});

describe("a queued message", () => {
  it("shows its image beside its text", () => {
    const { container, getByRole } = setup({
      running: true,
      queue: [
        {
          id: "q1",
          blocks: [
            { type: "fileRef", path: "/tmp/shot.png", startLine: null, endLine: null, text: null, label: "Image 1" },
            { type: "text", text: "compare [Image 1]" },
          ],
        },
      ],
    });
    getByRole("button", { name: "Remove from the queue: compare [Image 1]" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset:///tmp/shot.png");
    expect(container.textContent).toContain("compare [Image 1]");
  });

  const two = [
    { id: "q1", blocks: [{ type: "text" as const, text: "first" }] },
    { id: "q2", blocks: [{ type: "text" as const, text: "second" }] },
  ];

  it("moves down on ArrowDown on its handle", () => {
    const onReorderQueued = vi.fn();
    const { getByRole } = setup({ running: true, queue: two, onReorderQueued });
    fireEvent.keyDown(getByRole("button", { name: "Move in the queue: first" }), { key: "ArrowDown" });
    expect(onReorderQueued).toHaveBeenCalledWith(["q2", "q1"]);
  });

  it("removes nothing when its text is clicked", () => {
    const onDropQueued = vi.fn();
    const { getByText } = setup({ running: true, queue: two, onDropQueued });
    fireEvent.click(getByText("first"));
    expect(onDropQueued).not.toHaveBeenCalled();
  });
});

describe("queue keys", () => {
  const one = [{ id: "q1", blocks: [{ type: "text" as const, text: "queued" }] }];

  it("queues on Option+Enter while a turn runs, and steers on Enter", () => {
    const onQueue = vi.fn();
    const { input, onSend } = setup({ running: true, steering: true, onQueue });
    fireEvent.input(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(onQueue).toHaveBeenCalledWith("later");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "now" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("now");
  });

  it("steers the oldest on Cmd+Shift+Enter and leaves the draft", () => {
    const onSteerQueued = vi.fn();
    const { input, onSend } = setup({ running: true, steering: true, queue: one, onSteerQueued });
    fireEvent.input(input, { target: { value: "still typing" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSteerQueued).toHaveBeenCalledWith();
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("still typing");
  });

  it("sends on Cmd+Shift+Enter when nothing is queued", () => {
    const onSteerQueued = vi.fn();
    const { input, onSend } = setup({ running: true, steering: true, onSteerQueued });
    fireEvent.input(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(onSteerQueued).not.toHaveBeenCalled();
  });
});

describe("an attachment chip", () => {
  const shot: PendingBlock[] = [
    {
      id: "att-1",
      block: {
        type: "fileRef",
        path: "/store/1a2b-0/shot.png",
        startLine: null,
        endLine: null,
        text: null,
        label: "[Image 2]",
      },
    },
  ];
  const notes: PendingBlock[] = [
    {
      id: "att-2",
      block: {
        type: "fileRef",
        path: "/store/1a2b-1/notes.pdf",
        startLine: null,
        endLine: null,
        text: null,
        label: "[PDF 1]",
      },
    },
  ];

  it("shows the picture, the file's own name, and the token the message says", () => {
    const { container, getByText, getByLabelText } = setup({ attachments: shot });
    expect(getByText("shot.png")).toBeTruthy();
    expect(getByText("[Image 2]")).toBeTruthy();
    expect(getByLabelText("Open [Image 2] shot.png")).toBeTruthy();
    // Off disk through the asset protocol, not out of the message: the bytes
    // are on the wire nowhere now.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset:///store/1a2b-0/shot.png");
  });

  // One shape for every file: a picture where there is one, and the file's own
  // Seti icon where there is not, rather than a pill beside a tile.
  it("gives a file with no picture its type icon, and the same caption", () => {
    const { container, getByText } = setup({ attachments: notes });
    expect(getByText("notes.pdf")).toBeTruthy();
    expect(getByText("[PDF 1]")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".seti-icon")).not.toBeNull();
  });

  it("opens the file when the body is clicked, and does not remove it", () => {
    const opens: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const { input, getByLabelText, onDropAttachment } = setup({ attachments: shot });
    type(input, "compare this");
    fireEvent.click(getByLabelText("Open [Image 2] shot.png"));
    off();
    expect(opens).toEqual([{ path: "/store/1a2b-0/shot.png" }]);
    // The chip is a way into the file, not a way to edit the sentence: what
    // was typed is untouched.
    expect(input.value).toBe("compare this");
    expect(onDropAttachment).not.toHaveBeenCalled();
  });

  it("still puts its token in the message on Cmd+click, at the caret", () => {
    const opens: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const { input, getByLabelText } = setup({ attachments: notes });
    type(input, "read then answer");
    input.setSelectionRange(4, 4);
    fireEvent.click(getByLabelText("Open [PDF 1] notes.pdf"), { metaKey: true });
    off();
    expect(input.value).toBe("read [PDF 1] then answer");
    expect(opens).toEqual([]);
  });

  it("removes on Delete or Backspace, so the keyboard reaches what the button does", () => {
    const { getByLabelText, onDropAttachment } = setup({ attachments: shot });
    fireEvent.keyDown(getByLabelText("Open [Image 2] shot.png"), { key: "Delete" });
    expect(onDropAttachment).toHaveBeenCalledWith("att-1");
  });

  it("stays clean with both of its controls on screen", async () => {
    const { container } = setup({ attachments: [...shot, ...notes] });
    await expectNoAxeViolations(container);
  });
});

describe("a chip whose file has gone", () => {
  const notes: PendingBlock[] = [
    {
      id: "att-2",
      block: {
        type: "fileRef",
        path: "/store/1a2b-1/notes.pdf",
        startLine: null,
        endLine: null,
        text: null,
        label: "[PDF 1]",
      },
    },
  ];
  // Asked by role and a tolerant name: the chip's name is built from adjacent
  // nodes, which jsdom joins without a separator.
  const insert = (r: ReturnType<typeof setup>) => r.getByRole("button", { name: /^Open \[PDF 1\]/ });
  const remove = (r: ReturnType<typeof setup>) => r.getByRole("button", { name: /^Remove \[PDF 1\]/ });

  it("is marked missing and says where the file was, on both of its controls", async () => {
    const r = setup({ attachments: notes, fileExists: async () => false });
    await vi.waitFor(() =>
      expect(insert(r).getAttribute("aria-label")).toMatch(/No file at \/store\/1a2b-1\/notes\.pdf/),
    );
    expect(remove(r).getAttribute("aria-label")).toMatch(/No file at \/store\/1a2b-1\/notes\.pdf/);
    expect(r.container.querySelector("[class*='attachmentMissing']")).not.toBeNull();
  });

  it("stays plain while the file is there, and is never asked without a checker", async () => {
    const fileExists = vi.fn(async () => true);
    const r = setup({ attachments: notes, fileExists });
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalledWith("/store/1a2b-1/notes.pdf"));
    expect(insert(r).getAttribute("aria-label")).toBe("Open [PDF 1] notes.pdf");
    expect(r.container.querySelector("[class*='attachmentMissing']")).toBeNull();

    const unchecked = setup({ attachments: notes });
    expect(insert(unchecked).getAttribute("aria-label")).toBe("Open [PDF 1] notes.pdf");
  });

  // Coming back from the tree is when a mentioned file gets deleted.
  it("asks again each time the input regains focus", async () => {
    const fileExists = vi.fn(async () => true);
    const { input } = setup({ attachments: notes, fileExists });
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalledTimes(1));
    fireEvent.focus(input);
    await vi.waitFor(() => expect(fileExists).toHaveBeenCalledTimes(2));
  });

  it("is not opened when it is gone: the toast says where it was", async () => {
    const opens: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const r = setup({ attachments: notes, fileExists: async () => false });
    await vi.waitFor(() => expect(insert(r).getAttribute("aria-label")).toMatch(/No file/));
    fireEvent.click(insert(r));
    off();
    expect(opens).toEqual([]);
  });

  it("still lets the message send", async () => {
    const r = setup({ attachments: notes, fileExists: async () => false });
    await vi.waitFor(() => expect(insert(r).getAttribute("aria-label")).toMatch(/No file/));
    type(r.input, "look at [PDF 1]");
    fireEvent.keyDown(r.input, { key: "Enter" });
    expect(r.onSend).toHaveBeenCalledWith("look at [PDF 1]");
  });
});

describe("the size readout", () => {
  const readout = (r: ReturnType<typeof setup>) => r.queryByText(/^about .* tokens$/);

  it("stays out of the way under five hundred tokens, then says about how many", () => {
    const r = setup();
    // Four characters a token, rounded up: 1996 is 499, 1997 is already 500.
    type(r.input, "x".repeat(1996));
    expect(readout(r)).toBeNull();
    type(r.input, "x".repeat(1997));
    expect(readout(r)?.textContent).toBe("about 500 tokens");
    type(r.input, "x".repeat(6000));
    expect(readout(r)?.textContent).toBe("about 2k tokens");
    type(r.input, "short again");
    expect(readout(r)).toBeNull();
  });
});

describe("a draft being edited in the editor", () => {
  it("offers the editor only when a caller can open it, and not while linked", () => {
    expect(setup().queryByLabelText("Open in editor")).toBeNull();
    const onOpenInEditor = vi.fn();
    const r = setup({ onOpenInEditor });
    fireEvent.click(r.getByLabelText("Open in editor"));
    expect(onOpenInEditor).toHaveBeenCalledTimes(1);
    expect(
      (setup({ onOpenInEditor, linked: "Untitled-3" }).getByLabelText("Open in editor") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // One writer at a time. The browser refuses typing into a read-only box;
  // the send stays here, and sends what the last save mirrored in.
  it("goes read only, says which tab has the draft, and still sends it on Cmd+Enter", () => {
    const { input, onSend, getByText } = setup({ linked: "Untitled-3", draft: "saved from the editor" });
    expect(input.readOnly).toBe(true);
    expect(getByText(/Editing in Untitled-3/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("saved from the editor");
  });

  it("hands the writing back on edit here", () => {
    const onUnlink = vi.fn();
    const { getByRole } = setup({ linked: "Untitled-3", onUnlink });
    fireEvent.click(getByRole("button", { name: "edit here" }));
    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(setup().input.readOnly).toBe(false);
  });
});

describe("the insert handle", () => {
  it("puts a block in at the caret on a line of its own, and focuses the input", () => {
    let handle: ComposerHandle | undefined;
    const { input } = setup({ handle: (h) => (handle = h) });
    type(input, "before after");
    input.setSelectionRange(6, 6);
    handle!.insertBlock("> quoted\n\n");
    // What followed the caret follows the block, untouched.
    expect(input.value).toBe("before\n> quoted\n\n after");
    expect(document.activeElement).toBe(input);
  });

  it("adds no leading newline into an empty draft or after one", () => {
    let handle: ComposerHandle | undefined;
    const { input } = setup({ handle: (h) => (handle = h) });
    handle!.insertBlock("> a\n\n");
    expect(input.value).toBe("> a\n\n");
    handle!.insertBlock("> b\n\n");
    expect(input.value).toBe("> a\n\n> b\n\n");
  });
});

describe("dragging a chip into the sentence", () => {
  const shot: PendingBlock[] = [
    {
      id: "att-1",
      block: {
        type: "fileRef",
        path: "/store/1a2b-0/shot.png",
        startLine: null,
        endLine: null,
        text: null,
        label: "[Image 1]",
      },
    },
  ];

  it("lands where it was dropped, between the two words", () => {
    const { input, container, getByLabelText, onAttachPaths, onAttachUploads } = setup({ attachments: shot });
    type(input, "look here");
    // What the browser answers for the point under the pointer. jsdom lays
    // nothing out, so the offset is the thing being stubbed, not the geometry.
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
      offsetNode: input,
      offset: 5,
    });
    const dt = drag(getByLabelText("Open [Image 1] shot.png"));
    // Only the private type: `text/plain` would make a drop on the terminal,
    // or on this composer's own path branch, read the token as a file path.
    expect(Object.keys(dt)).toEqual([ATTACHMENT_TOKEN_MIME]);
    drop(container.firstElementChild!, { data: dt });

    expect(input.value).toBe("look [Image 1] here");
    // The chip moved, it did not arrive: nothing was attached a second time.
    expect(onAttachPaths).not.toHaveBeenCalled();
    expect(onAttachUploads).not.toHaveBeenCalled();
    delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  });

  it("falls back to the caret where the browser cannot say where the drop landed", () => {
    const { input, container, getByLabelText } = setup({ attachments: shot });
    type(input, "look here");
    input.setSelectionRange(4, 4);
    drop(container.firstElementChild!, { data: drag(getByLabelText("Open [Image 1] shot.png")) });
    expect(input.value).toBe("look [Image 1] here");
  });

  it("does not light the composer up as a drop target for its own chip", () => {
    const { container, getByLabelText } = setup({ attachments: shot });
    const composer = container.firstElementChild!;
    const before = composer.className;
    const dt = drag(getByLabelText("Open [Image 1] shot.png"));
    fireEvent.dragOver(composer, { dataTransfer: { types: Object.keys(dt), getData: (m: string) => dt[m] ?? "" } });
    expect(composer.className).toBe(before);
  });
});

describe("under an agent that takes no uploads", () => {
  const ACP_UPLOADS: AttachmentSource = {
    kinds: [],
    gap: "Nothing has measured whether this agent can read outside its project.",
  };

  it("still takes a tree-dragged source file, which is a mention", () => {
    const { container, onAttachPaths, onAttachRejected } = setup({ uploads: ACP_UPLOADS });
    drop(container.firstElementChild!, { data: { "application/x-tori-path": "/repo/src/main.rs" } });
    expect(onAttachPaths).toHaveBeenCalledWith(["/repo/src/main.rs"]);
    expect(onAttachRejected).not.toHaveBeenCalled();
  });

  it("refuses a pasted file in the tier's own words", async () => {
    const { input, onAttachUploads, onAttachRejected } = setup({ uploads: ACP_UPLOADS });
    fireEvent.paste(input, { clipboardData: { files: [imageFile("notes.md", "")] } });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachRejected).toHaveBeenCalledWith(ACP_UPLOADS.gap);
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  // A picker that refuses whatever it is handed is worse than no picker.
  it("offers no attach button at all", () => {
    const { getByRole } = setup({ uploads: ACP_UPLOADS });
    expect((getByRole("button", { name: "This agent takes no attachments" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("what the composer says it can take", () => {
  it("names the kinds where a file is about to land, not after it is refused", () => {
    const { container, getByText } = setup();
    fireEvent.dragOver(container.firstElementChild!, { dataTransfer: { types: ["Files"], getData: () => "" } });
    expect(getByText("Drop to attach: image, pdf, file")).toBeTruthy();
  });

  it("says what a refusing agent will not take, in the tier's own words", () => {
    const gap = "Nothing has measured whether this agent can read outside its project.";
    const { container, getByText } = setup({ uploads: { kinds: [], gap } });
    fireEvent.dragOver(container.firstElementChild!, { dataTransfer: { types: ["Files"], getData: () => "" } });
    expect(getByText(gap)).toBeTruthy();
  });

  // It said "an image" for as long as an image was all it took.
  it("names the attach button after what this agent opens", () => {
    expect(setup().getByRole("button", { name: "Attach a file" })).toBeTruthy();
    expect(
      setup({ uploads: { kinds: ["image", "pdf"], gap: null } }).getByRole("button", {
        name: "Attach an image or a PDF",
      }),
    ).toBeTruthy();
  });
});

describe("dragging a path in", () => {
  it("takes a dragged file path as a mention rather than an upload", () => {
    const { container, onAttachPaths, onAttachUploads } = setup();
    drop(container.firstElementChild!, { data: { "application/x-tori-path": "/repo/src/a.ts" } });
    expect(onAttachPaths).toHaveBeenCalledWith(["/repo/src/a.ts"]);
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  it("takes every path of a multi-row drag", () => {
    const { container, onAttachPaths } = setup();
    drop(container.firstElementChild!, {
      data: { "application/x-tori-abspath": "/repo/a.ts\n/repo/b.ts" },
    });
    expect(onAttachPaths).toHaveBeenCalledWith(["/repo/a.ts", "/repo/b.ts"]);
  });
});

describe("draft and history", () => {
  // The draft is owned outside the component, so a remount finds it again.
  // This is the property the tab-switch case actually rests on.
  it("renders the draft it is given and reports every edit back", () => {
    const [draft, setDraft] = createSignal("half a thought");
    const { container, unmount } = render(() => (
      <Composer
        running={false}
        steering={false}
        steerCost={null}
        queue={[]}
        attachments={[]}
        commands={[]}
        loadFiles={async () => []}
        draft={draft()}
        onDraftChange={setDraft}
        history={[]}
        parked={false}
        disabled={false}
        onSend={() => {}}
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onDropAttachment={() => {}}
        onAttachFile={() => null}
        uploads={OPENS_EVERYTHING}
        onAttachUploads={async () => []}
        onAttachRejected={() => {}}
        onAttachPaths={() => []}
        onSendQueued={() => {}}
        onDiscardQueued={() => {}}
      />
    ));
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value).toBe("half a thought");
    fireEvent.input(area, { target: { value: "half a thought, continued" } });
    expect(draft()).toBe("half a thought, continued");
    unmount();

    // Mounted again, as a tab switch would: the draft is still there verbatim.
    const second = render(() => (
      <Composer
        running={false}
        steering={false}
        steerCost={null}
        queue={[]}
        attachments={[]}
        commands={[]}
        loadFiles={async () => []}
        draft={draft()}
        onDraftChange={setDraft}
        history={[]}
        parked={false}
        disabled={false}
        onSend={() => {}}
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onDropAttachment={() => {}}
        onAttachFile={() => null}
        uploads={OPENS_EVERYTHING}
        onAttachUploads={async () => []}
        onAttachRejected={() => {}}
        onAttachPaths={() => []}
        onSendQueued={() => {}}
        onDiscardQueued={() => {}}
      />
    ));
    expect((second.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("half a thought, continued");
  });

  it("walks back through what was sent, and forward again to nothing", () => {
    const { input } = setup({ history: ["most recent", "older"] });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("most recent");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("older");
    // Past the end stays put rather than wrapping to the newest.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("older");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("most recent");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
  });

  // Up has to keep meaning "move the cursor" inside a draft the user is editing.
  it("does not recall when the caret is inside the draft", () => {
    const { input } = setup({ history: ["most recent"] });
    type(input, "line one\nline two");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("line one\nline two");
  });
});

describe("Composer attachments", () => {
  const chips: PendingBlock[] = [
    { id: "att-1", block: { type: "fileRef", path: "/repo/a.ts", startLine: 1, endLine: 4, text: null } },
    { id: "att-2", block: { type: "fileRef", path: "/repo/b.ts", startLine: 7, endLine: 7, text: null } },
  ];

  it("renders one chip per attachment, named by file with its range under it", () => {
    const { getByText } = setup({ attachments: chips });
    expect(getByText("a.ts")).toBeTruthy();
    expect(getByText("L1-L4")).toBeTruthy();
    expect(getByText("b.ts")).toBeTruthy();
    expect(getByText("L7")).toBeTruthy();
  });

  it("removes exactly the chip whose remove button was pressed", () => {
    const { getByLabelText, onDropAttachment } = setup({ attachments: chips });
    fireEvent.click(getByLabelText("Remove @b.ts#L7"));
    expect(onDropAttachment).toHaveBeenCalledTimes(1);
    expect(onDropAttachment).toHaveBeenCalledWith("att-2");
  });

  // A selection has no token, so there is nothing to put in the sentence. It
  // does have a file, and a line worth arriving at.
  it("opens a selection at the line it covers, and has no token to insert", () => {
    const opens: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opens.push(d));
    const { input, getByLabelText } = setup({ attachments: chips });
    type(input, "why");
    fireEvent.click(getByLabelText("Open @a.ts#L1-L4"), { metaKey: true });
    off();
    expect(opens).toEqual([{ path: "/repo/a.ts", line: 1 }]);
    expect(input.value).toBe("why");
  });

  // The rule the unit tests could only assert about `hasContent`: a turn of
  // nothing but a file reference is a real thing to send.
  it("sends an attachment-only turn with empty text", () => {
    const { input, onSend } = setup({ attachments: chips });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("");
  });
});

// The lane strip switches what you read, never what you type: Tori has no
// channel to a subagent, so the composer stays bound to the main agent in every
// lane. The placeholder is the only thing that changes, and it has to say so.
describe("reading a subagent's lane", () => {
  it("says where what you type is going, and never offers to steer", () => {
    const { input } = setup({ watching: "Create one.txt", running: true, steering: true, steerCost: "1.5-5.4s" });
    expect(input.placeholder).toBe("Watching Create one.txt. What you type goes to the main agent");
    // The load-bearing half. A steer reaches the turn it names, and this box
    // cannot reach the lane on screen, so the wording must not survive here.
    expect(input.placeholder).not.toContain("Steer");
  });

  it("still sends, and sends the same way main does", () => {
    const { input, onSend } = setup({ watching: "Create one.txt" });
    fireEvent.input(input, { target: { value: "stop agent one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("stop agent one");
  });

  it("reads as usual back on main", () => {
    const { input } = setup({ watching: null, running: true, steering: true, steerCost: "1.5-5.4s" });
    expect(input.placeholder).toBe("Steer this turn, picked up in 1.5-5.4s");
  });
});

describe("the prompt stash", () => {
  const entry = (id: string, text: string, at = 0) => ({ id, text, chips: [], at });

  it("stashes a non-empty draft on Cmd+S", () => {
    const onStash = vi.fn();
    const { input } = setup({ onStash, stash: [] });
    fireEvent.input(input, { target: { value: "half a thought" } });
    expect(fireEvent.keyDown(input, { key: "s", metaKey: true })).toBe(false);
    expect(onStash).toHaveBeenCalledOnce();
  });

  it("restores the only entry into an empty composer", () => {
    const onRestoreStash = vi.fn();
    const { input, container } = setup({ onStash: vi.fn(), onRestoreStash, stash: [entry("a", "parked")] });
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    expect(onRestoreStash).toHaveBeenCalledWith("a");
    expect(container.querySelector('[aria-label="Stashed drafts"]')).toBeNull();
  });

  it.each([
    ["editing a queued entry", { editing: "q1" }],
    ["linked to a scratch tab", { linked: "scratch.md" }],
    ["holding a first send", { holding: true }],
  ])("does nothing while %s", (_why, over) => {
    const onStash = vi.fn();
    const onRestoreStash = vi.fn();
    const { input } = setup({ onStash, onRestoreStash, stash: [entry("a", "parked")], ...over });
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    fireEvent.input(input, { target: { value: "typed" } });
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    expect(onStash).not.toHaveBeenCalled();
    expect(onRestoreStash).not.toHaveBeenCalled();
  });

  it("opens a menu over several entries, newest first, and restores the picked one", async () => {
    const onRestoreStash = vi.fn();
    const { input, container } = setup({
      onStash: vi.fn(),
      onRestoreStash,
      stash: [entry("old", "first parked"), entry("new", "second parked\nmore")],
    });
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    const rows = [...container.querySelectorAll('[aria-label="Stashed drafts"] [role="option"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("second parked"),
      expect.stringContaining("first parked"),
    ]);
    await expectNoAxeViolations(container);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRestoreStash).toHaveBeenCalledWith("old");
    expect(container.querySelector('[aria-label="Stashed drafts"]')).toBeNull();
  });

  it("discards the selected entry on Backspace and closes on Escape", () => {
    const onDiscardStash = vi.fn();
    const { input, container } = setup({
      onStash: vi.fn(),
      onDiscardStash,
      stash: [entry("old", "first"), entry("new", "second")],
    });
    fireEvent.keyDown(input, { key: "s", metaKey: true });
    expect(fireEvent.keyDown(input, { key: "Backspace" })).toBe(false);
    expect(onDiscardStash).toHaveBeenCalledWith("new");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector('[aria-label="Stashed drafts"]')).toBeNull();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import Composer, { ATTACHMENT_TOKEN_MIME } from "./Composer";
import { expectNoAxeViolations } from "../../test/axe";
import type { AttachmentSource, PendingBlock } from "../../utils/chatCompose";

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
      onAttachFile={onAttachFile}
      uploads={OPENS_EVERYTHING}
      onAttachUploads={onAttachUploads}
      onAttachRejected={onAttachRejected}
      onAttachPaths={onAttachPaths}
      draft={draft()}
      onDraftChange={setDraftValue}
      history={[]}
      held={false}
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
  return { ...result, input, onSend, onInterrupt, onDropAttachment, onAttachFile, onAttachUploads, onAttachRejected, onAttachPaths };
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
  const style = { lineHeight: `${opts.line}px`, paddingTop: `${opts.padding / 2}px`, paddingBottom: `${opts.padding / 2}px` };
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

    needed = 100; // four lines of content in a two-line box
    fireEvent.input(input, { target: { value: "a\nb\nc\nd" } });

    expect(seen).not.toContain(1);
    expect(input.rows).toBe(4);
  });

  it("measures nothing at all while the text still fits", () => {
    // The common case by far: typing along inside a box that is already the
    // right size. Nothing is written, so nothing is laid out twice.
    const { input } = setup();
    stubMetrics(input, { line: 20, padding: 20, needed: () => 60 });
    const seen = watchRows(input);

    fireEvent.input(input, { target: { value: "hello" } });

    expect(seen).toEqual([]);
    expect(input.rows).toBe(2);
  });

  it("comes back to its resting height when a message goes, not below it", () => {
    // The bug the whole of this describe exists around: sending put the box at
    // one row, which is a height it has at no other moment. The next keystroke
    // measured it and snapped it back up, and that jump is what reads as the
    // composer resizing itself while you type.
    const { input } = setup();
    let needed = 100;
    stubMetrics(input, { line: 20, padding: 20, needed: () => needed });
    fireEvent.input(input, { target: { value: "a\nb\nc\nd" } });
    expect(input.rows).toBe(4);

    needed = 40;
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.rows).toBe(2);
  });

  it("puts a box that is somehow under the floor back on it", () => {
    // Belt for the same braces: whatever leaves it short - an older build's
    // send, a hand-set attribute - the next fit is not allowed to agree with
    // it. Nothing is measured at a size the box is not permitted to be.
    const { input } = setup();
    stubMetrics(input, { line: 20, padding: 20, needed: () => 40 });
    input.rows = 1;

    fireEvent.input(input, { target: { value: "a" } });

    expect(input.rows).toBe(2);
  });

  it("still shrinks when the text does", () => {
    const { input } = setup();
    let needed = 100;
    stubMetrics(input, { line: 20, padding: 20, needed: () => needed });
    fireEvent.input(input, { target: { value: "a\nb\nc\nd" } });
    expect(input.rows).toBe(4);

    needed = 40;
    fireEvent.input(input, { target: { value: "a" } });
    expect(input.rows).toBe(2);
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

  it("sends nothing when there is nothing to send", () => {
    const { input, onSend } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  // What Enter does mid-turn changed, so the placeholder has to say which of the
  // two it will do. It also must not present a steer as instant: Phase 2 measured
  // 1.5s to 5.4s from the write to the model acting on it.
  it("says whether typing steers this turn or queues for the next", () => {
    expect(setup({ running: true, steering: true, steerCost: "1.5-5.4s" }).input.placeholder).toBe(
      "Steer this turn, picked up in 1.5-5.4s",
    );
    expect(setup({ running: true, steering: false }).input.placeholder).toBe("Type to queue for the next turn");
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
    fireEvent.paste(input, { clipboardData: { files: [] } });
    expect(onAttachUploads).not.toHaveBeenCalled();
    fireEvent.paste(input, { clipboardData: { files: [imageFile("clip.png")] } });
    await vi.waitFor(() => expect(onAttachUploads).toHaveBeenCalled());
  });

  it("filters the picker to what the agent opens, and not at all when that is any file", () => {
    const any = setup().container.querySelector('input[type="file"]');
    expect(any?.getAttribute("accept")).toBeNull();
    const imagesOnly = setup({ uploads: { kinds: ["image"], gap: null } }).container.querySelector('input[type="file"]');
    expect(imagesOnly?.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
  });

  it("renders an image chip as the image itself", () => {
    const chips: PendingBlock[] = [
      { id: "att-1", block: { type: "image", mediaType: "image/png", data: "AAAA" } },
    ];
    const { container } = setup({ attachments: chips });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
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

describe("an attachment chip", () => {
  const shot: PendingBlock[] = [
    {
      id: "att-1",
      block: { type: "fileRef", path: "/store/1a2b-0/shot.png", startLine: null, endLine: null, text: null, label: "[Image 2]" },
    },
  ];
  const notes: PendingBlock[] = [
    {
      id: "att-2",
      block: { type: "fileRef", path: "/store/1a2b-1/notes.pdf", startLine: null, endLine: null, text: null, label: "[PDF 1]" },
    },
  ];

  it("captions the picture with its token, and keeps the filename in its name", () => {
    const { container, getByText, getByLabelText } = setup({ attachments: shot });
    // The picture says which file it is, so the caption only has to say what
    // to type. The filename is still announced, on the control.
    expect(getByText("[Image 2]")).toBeTruthy();
    expect(getByLabelText("Insert [Image 2] shot.png")).toBeTruthy();
    // Off disk through the asset protocol, not out of the message: the bytes
    // are on the wire nowhere now.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("asset:///store/1a2b-0/shot.png");
  });

  it("still reads as token and filename where there is no picture to look at", () => {
    const { getByText } = setup({ attachments: notes });
    expect(getByText("[PDF 1] notes.pdf")).toBeTruthy();
  });

  it("puts its token in the message when the body is clicked, and does not remove it", () => {
    const { input, getByLabelText, onDropAttachment } = setup({ attachments: shot });
    type(input, "compare this");
    fireEvent.click(getByLabelText("Insert [Image 2] shot.png"));
    expect(input.value).toBe("compare this [Image 2]");
    expect(onDropAttachment).not.toHaveBeenCalled();
  });

  it("inserts at the caret rather than at the end", () => {
    const { input, getByLabelText } = setup({ attachments: notes });
    type(input, "read then answer");
    input.setSelectionRange(4, 4);
    fireEvent.click(getByLabelText("Insert [PDF 1] notes.pdf"));
    expect(input.value).toBe("read [PDF 1] then answer");
  });

  it("removes on Delete or Backspace, so the keyboard reaches what the button does", () => {
    const { getByLabelText, onDropAttachment } = setup({ attachments: shot });
    fireEvent.keyDown(getByLabelText("Insert [Image 2] shot.png"), { key: "Delete" });
    expect(onDropAttachment).toHaveBeenCalledWith("att-1");
  });

  it("stays clean with both of its controls on screen", async () => {
    const { container } = setup({ attachments: [...shot, ...notes] });
    await expectNoAxeViolations(container);
  });
});

describe("dragging a chip into the sentence", () => {
  const shot: PendingBlock[] = [
    {
      id: "att-1",
      block: { type: "fileRef", path: "/store/1a2b-0/shot.png", startLine: null, endLine: null, text: null, label: "[Image 1]" },
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
    const dt = drag(getByLabelText("Insert [Image 1] shot.png"));
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
    drop(container.firstElementChild!, { data: drag(getByLabelText("Insert [Image 1] shot.png")) });
    expect(input.value).toBe("look [Image 1] here");
  });

  it("does not light the composer up as a drop target for its own chip", () => {
    const { container, getByLabelText } = setup({ attachments: shot });
    const composer = container.firstElementChild!;
    const before = composer.className;
    const dt = drag(getByLabelText("Insert [Image 1] shot.png"));
    fireEvent.dragOver(composer, { dataTransfer: { types: Object.keys(dt), getData: (m: string) => dt[m] ?? "" } });
    expect(composer.className).toBe(before);
  });
});

describe("under an agent that takes no uploads", () => {
  const ACP_UPLOADS: AttachmentSource = { kinds: [], gap: "Nothing has measured whether this agent can read outside its project." };

  it("still takes a tree-dragged source file, which is a mention", () => {
    const { container, onAttachPaths, onAttachRejected } = setup({ uploads: ACP_UPLOADS });
    drop(container.firstElementChild!, { data: { "application/x-sway-path": "/repo/src/main.rs" } });
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
      setup({ uploads: { kinds: ["image", "pdf"], gap: null } }).getByRole("button", { name: "Attach an image or a PDF" }),
    ).toBeTruthy();
  });
});

describe("dragging a path in", () => {
  it("takes a dragged file path as a mention rather than an upload", () => {
    const { container, onAttachPaths, onAttachUploads } = setup();
    drop(container.firstElementChild!, { data: { "application/x-sway-path": "/repo/src/a.ts" } });
    expect(onAttachPaths).toHaveBeenCalledWith(["/repo/src/a.ts"]);
    expect(onAttachUploads).not.toHaveBeenCalled();
  });

  it("takes every path of a multi-row drag", () => {
    const { container, onAttachPaths } = setup();
    drop(container.firstElementChild!, {
      data: { "application/x-sway-abspath": "/repo/a.ts\n/repo/b.ts" },
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
        held={false}
        disabled={false}
        onSend={() => {}}
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onDropAttachment={() => {}}
        onAttachFile={() => null}
        uploads={OPENS_EVERYTHING}
        onAttachUploads={() => {}}
        onAttachRejected={() => {}}
        onAttachPaths={() => {}}
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
        held={false}
        disabled={false}
        onSend={() => {}}
        onInterrupt={() => {}}
        onDropQueued={() => {}}
        onDropAttachment={() => {}}
        onAttachFile={() => null}
        uploads={OPENS_EVERYTHING}
        onAttachUploads={() => {}}
        onAttachRejected={() => {}}
        onAttachPaths={() => {}}
        onSendQueued={() => {}}
        onDiscardQueued={() => {}}
      />
    ));
    expect((second.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "half a thought, continued",
    );
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

  it("renders one chip per attachment, labelled by file and range", () => {
    const { getByText } = setup({ attachments: chips });
    expect(getByText("@a.ts#L1-L4")).toBeTruthy();
    expect(getByText("@b.ts#L7")).toBeTruthy();
  });

  it("removes exactly the chip whose remove button was pressed", () => {
    const { getByLabelText, onDropAttachment } = setup({ attachments: chips });
    fireEvent.click(getByLabelText("Remove @b.ts#L7"));
    expect(onDropAttachment).toHaveBeenCalledTimes(1);
    expect(onDropAttachment).toHaveBeenCalledWith("att-2");
  });

  // A selection or a hunk comment has no token, so there is nothing to put in
  // the sentence and its face is not a control at all.
  it("offers no insert control for a chip that names no token", () => {
    const { queryByLabelText } = setup({ attachments: chips });
    expect(queryByLabelText("Insert @a.ts#L1-L4")).toBeNull();
  });

  // The rule the unit tests could only assert about `hasContent`: a turn of
  // nothing but a file reference is a real thing to send.
  it("sends an attachment-only turn with empty text", () => {
    const { input, onSend } = setup({ attachments: chips });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("");
  });
});

// The lane strip switches what you read, never what you type: Sway has no
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

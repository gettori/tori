import { describe, it, expect, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import Composer from "./Composer";
import type { PendingBlock } from "../../utils/chatCompose";

// The first mounted tests in the repo. Three phases shipped composer behaviour
// that was reasoned rather than rendered; these are the things that reasoning
// cannot settle, because they are about what the DOM does with an event.

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const [draft, setDraftValue] = createSignal("");
  const onSend = vi.fn();
  const onInterrupt = vi.fn();
  const onDropAttachment = vi.fn();
  const onAttachFile = vi.fn();
  const onAttachImages = vi.fn();
  const onAttachRejected = vi.fn();
  const onAttachPaths = vi.fn();
  const result = render(() => (
    <Composer
      running={false}
      queue={[]}
      attachments={[]}
      commands={[]}
      loadFiles={async () => []}
      onAttachFile={onAttachFile}
      onAttachImages={onAttachImages}
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
  return { ...result, input, onSend, onInterrupt, onDropAttachment, onAttachFile, onAttachImages, onAttachRejected, onAttachPaths };
}

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

  it("accepting a mention hands back the path and takes its text out of the input", async () => {
    const { input, findByText, onAttachFile } = setup({ loadFiles: async () => FILES });
    type(input, "look at @compose");
    await findByText("src/utils/chatCompose.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachFile).toHaveBeenCalledWith("src/utils/chatCompose.ts");
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

function drop(el: Element, init: { files?: File[]; data?: Record<string, string> }) {
  const dataTransfer = {
    files: init.files ?? [],
    types: Object.keys(init.data ?? {}),
    getData: (mime: string) => init.data?.[mime] ?? "",
  };
  fireEvent.drop(el, { dataTransfer });
}

describe("image attachments", () => {
  it("attaches a dropped PNG as a base64 image block", async () => {
    const { container, onAttachImages } = setup();
    drop(container.firstElementChild!, { files: [imageFile("shot.png")] });
    await vi.waitFor(() => expect(onAttachImages).toHaveBeenCalled());
    const [images] = onAttachImages.mock.calls[0];
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/png");
    expect(typeof images[0].base64).toBe("string");
    expect(images[0].base64).not.toContain("data:");
  });

  it("attaches a pasted image without swallowing an ordinary text paste", async () => {
    const { input, onAttachImages } = setup();
    fireEvent.paste(input, { clipboardData: { files: [] } });
    expect(onAttachImages).not.toHaveBeenCalled();
    fireEvent.paste(input, { clipboardData: { files: [imageFile("clip.png")] } });
    await vi.waitFor(() => expect(onAttachImages).toHaveBeenCalled());
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
  it("rejects a non-image before it can become a chip", async () => {
    const { container, onAttachImages, onAttachRejected } = setup();
    drop(container.firstElementChild!, { files: [imageFile("notes.pdf", "application/pdf")] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachRejected.mock.calls[0][0]).toContain("notes.pdf");
    expect(onAttachImages).not.toHaveBeenCalled();
  });

  it("rejects an oversized image and says how big it was", async () => {
    const { container, onAttachImages, onAttachRejected } = setup();
    drop(container.firstElementChild!, { files: [imageFile("huge.png", "image/png", 6 * 1024 * 1024)] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachRejected.mock.calls[0][0]).toMatch(/6\.0MB/);
    expect(onAttachImages).not.toHaveBeenCalled();
  });

  // The one a per-file check gets wrong: eleven dropped at once must not all
  // pass a limit that was only ever read before the batch started.
  it("counts a batch against the cap as it goes", async () => {
    const { container, onAttachImages, onAttachRejected } = setup();
    const many = Array.from({ length: 12 }, (_, i) => imageFile(`s${i}.png`));
    drop(container.firstElementChild!, { files: many });
    await vi.waitFor(() => expect(onAttachImages).toHaveBeenCalled());
    expect(onAttachImages.mock.calls[0][0]).toHaveLength(10);
    expect(onAttachRejected).toHaveBeenCalledTimes(2);
  });

  it("counts what is already pending, not just this drop", async () => {
    const pending: PendingBlock[] = Array.from({ length: 10 }, (_, i) => ({
      id: `att-${i}`,
      block: { type: "image" as const, mediaType: "image/png", data: "AAAA" },
    }));
    const { container, onAttachImages, onAttachRejected } = setup({ attachments: pending });
    drop(container.firstElementChild!, { files: [imageFile("one-more.png")] });
    await vi.waitFor(() => expect(onAttachRejected).toHaveBeenCalled());
    expect(onAttachImages).not.toHaveBeenCalled();
  });
});

describe("dragging a path in", () => {
  it("takes a dragged file path as a mention rather than an upload", () => {
    const { container, onAttachPaths, onAttachImages } = setup();
    drop(container.firstElementChild!, { data: { "application/x-sway-path": "/repo/src/a.ts" } });
    expect(onAttachPaths).toHaveBeenCalledWith(["/repo/src/a.ts"]);
    expect(onAttachImages).not.toHaveBeenCalled();
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
        onAttachFile={() => {}}
        onAttachImages={() => {}}
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
        onAttachFile={() => {}}
        onAttachImages={() => {}}
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

  it("removes exactly the chip that was clicked", () => {
    const { getByText, onDropAttachment } = setup({ attachments: chips });
    fireEvent.click(getByText("@b.ts#L7"));
    expect(onDropAttachment).toHaveBeenCalledTimes(1);
    expect(onDropAttachment).toHaveBeenCalledWith("att-2");
  });

  // The rule the unit tests could only assert about `hasContent`: a turn of
  // nothing but a file reference is a real thing to send.
  it("sends an attachment-only turn with empty text", () => {
    const { input, onSend } = setup({ attachments: chips });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("");
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor } from "../../test/harness";
import { invoke } from "@tauri-apps/api/core";
import AttachmentPreview from "./AttachmentPreview";
import type { ContentBlock } from "../../utils/chatTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("./highlight", () => ({
  createHighlight: () => ({ html: () => null, lines: () => null }),
  langOfPath: (p: string) => p.split(".").pop() ?? "",
}));
vi.mock("../Editor/PdfView", () => ({ default: () => null }));
const invoked = vi.mocked(invoke);

const fileRef = (over: Partial<Extract<ContentBlock, { type: "fileRef" }>> = {}): ContentBlock => ({
  type: "fileRef",
  path: "/repo/src/a.ts",
  startLine: null,
  endLine: null,
  text: null,
  ...over,
});

function preview(block: ContentBlock) {
  return render(() => <AttachmentPreview block={block} missing={false} onClose={() => {}} onOpenInEditor={() => {}} />);
}

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

describe("a file attachment's preview", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is reading, then shows the lines the attachment covers", async () => {
    const read = held<unknown>();
    invoked.mockImplementation(() => read.promise);
    preview(fileRef({ startLine: 2, endLine: 3 }));
    expect(await screen.findByText("Reading the file...")).toBeTruthy();
    expect(screen.getByText("Open in editor")).toBeTruthy();

    read.resolve("one\ntwo\nthree\nfour");
    await waitFor(() => expect(screen.queryByText("Reading the file...")).toBeNull());
    expect(document.body.textContent).toContain("two\nthree");
    expect(document.body.textContent).not.toContain("four");
  });

  it("shows an empty file as empty rather than as still reading", async () => {
    invoked.mockResolvedValue("");
    preview(fileRef());
    await waitFor(() => expect(screen.queryByText("Reading the file...")).toBeNull());
    expect(screen.queryByText("This file cannot be shown as text.")).toBeNull();
  });

  it("says the file cannot be shown when the read fails", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "fs_read_file") throw new Error("stream did not contain valid UTF-8");
    });
    preview(fileRef());
    expect(await screen.findByText("This file cannot be shown as text.")).toBeTruthy();
    expect(screen.getByText("Open in editor")).toBeTruthy();
  });

  it("reads nothing for a selection that carries its own text", () => {
    preview(fileRef({ startLine: 4, endLine: 4, text: "the selected line" }));
    expect(document.body.textContent).toContain("the selected line");
    expect(invoked).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ATTACHMENT_NAME_HEADER, attachmentsDir, composerAttachments } from "./composerAttachments";
import { chatTier } from "../../utils/chatCapabilities";
import { clearComposer, pendingFor } from "../../utils/chatCompose";

const KEY = "tab-1";
const claude = composerAttachments(
  () => KEY,
  () => "/work/repo",
  () => chatTier("claude_stream_json"),
  (reason) => rejected.push(reason),
);
const acp = composerAttachments(
  () => KEY,
  () => "/work/repo",
  () => chatTier("acp"),
  (reason) => rejected.push(reason),
);
let rejected: string[] = [];

afterEach(() => {
  clearComposer(KEY);
  rejected = [];
  invoke.mockReset();
});

const labels = () => pendingFor(KEY).map((p) => (p.block.type === "fileRef" ? [p.block.label, p.block.path] : null));

describe("a pasted file becomes a labelled path", () => {
  it("posts the bytes raw with the name in a header, and offers the path it got back", async () => {
    invoke.mockResolvedValueOnce("/home/me/.config/sway/attachments/abc-shot.png");
    const bytes = new Uint8Array([1, 2, 3]);
    await claude.onAttachUploads([{ name: "shot.png", bytes }]);

    expect(invoke).toHaveBeenCalledWith("store_attachment", bytes, {
      headers: { [ATTACHMENT_NAME_HEADER]: "shot.png" },
    });
    expect(labels()).toEqual([["[image 1]", "/home/me/.config/sway/attachments/abc-shot.png"]]);
    expect(pendingFor(KEY).some((p) => p.block.type === "image")).toBe(false);
  });

  it("percent-encodes a name the header cannot carry as it is", async () => {
    invoke.mockResolvedValueOnce("/x/a.pdf");
    await claude.onAttachUploads([{ name: "rapport été.pdf", bytes: new Uint8Array() }]);
    expect(invoke.mock.calls[0][2]).toEqual({ headers: { [ATTACHMENT_NAME_HEADER]: "rapport%20%C3%A9t%C3%A9.pdf" } });
    expect(labels()).toEqual([["[pdf 1]", "/x/a.pdf"]]);
  });

  it("numbers a batch in drop order, per kind", async () => {
    invoke.mockResolvedValueOnce("/x/a.png").mockResolvedValueOnce("/x/b.pdf").mockResolvedValueOnce("/x/c.png");
    await claude.onAttachUploads([
      { name: "a.png", bytes: new Uint8Array() },
      { name: "b.pdf", bytes: new Uint8Array() },
      { name: "c.png", bytes: new Uint8Array() },
    ]);
    expect(labels().map((l) => l?.[0])).toEqual(["[image 1]", "[pdf 1]", "[image 2]"]);
  });

  it("says so when the write fails, and offers no chip for it", async () => {
    invoke.mockRejectedValueOnce("disk full");
    await claude.onAttachUploads([{ name: "a.png", bytes: new Uint8Array() }]);
    expect(rejected).toEqual(["a.png could not be saved: disk full"]);
    expect(pendingFor(KEY)).toEqual([]);
  });
});

describe("a dragged path is a labelled mention", () => {
  it("labels by kind, and resolves an @ mention against the cwd", () => {
    claude.onAttachPaths(["/repo/shot.png", "/repo/src/main.rs"]);
    claude.onAttachFile("docs/spec.pdf");
    expect(labels()).toEqual([
      ["[image 1]", "/repo/shot.png"],
      ["[file 1]", "/repo/src/main.rs"],
      ["[pdf 1]", "/work/repo/docs/spec.pdf"],
    ]);
  });

  it("refuses a kind the agent cannot open, naming the ones it can", () => {
    claude.onAttachPaths(["/repo/clip.mp4"]);
    expect(pendingFor(KEY)).toEqual([]);
    expect(rejected[0]).toMatch(/clip\.mp4.*image, pdf, file/);
  });

  // ACP carries a path as text already, so a source file costs nothing new;
  // whether it would open an image off a path is unmeasured.
  it("keeps a source file for an ACP agent and refuses an image", () => {
    acp.onAttachPaths(["/repo/src/main.rs", "/repo/shot.png"]);
    expect(labels()).toEqual([["[file 1]", "/repo/src/main.rs"]]);
    expect(rejected[0]).toMatch(/shot\.png.*It opens: file\./);
  });
});

describe("where uploads go", () => {
  it("asks once and hands back null when the backend cannot say", async () => {
    invoke.mockRejectedValueOnce("no home");
    expect(await attachmentsDir()).toBeNull();
    invoke.mockResolvedValue("/home/me/.config/sway/attachments");
    expect(await attachmentsDir()).toBe("/home/me/.config/sway/attachments");
    expect(await attachmentsDir()).toBe("/home/me/.config/sway/attachments");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

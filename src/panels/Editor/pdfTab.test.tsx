import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createEffect } from "solid-js";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { closeOf } from "../../test/tabs";
import { pointerClick } from "../../test/menus";

// A PDF is a file the code editor must never read: it is bytes, and CodeEditor
// reads a file as UTF-8. That exclusion is the same shape as the `sway://` one
// next door - one-liners in `pdfOf` and `editablePathOf` that nothing else
// notices if they rot - so this suite mounts the real pane and asserts what
// CodeEditor is actually handed.
//
// It also covers the half that has no equivalent for an image: a parsed
// document outlives its view, so something has to say when it may go. That is
// one effect in `Editor.tsx` over the open-tab set, and it is checked here
// rather than in `pdfDocument.test.ts` because the store cannot see tabs.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorAgent";
import { installAnimationFrame } from "../../test/frames";

installResizeObserver();
installAnimationFrame();

const REPO = "/space/proj/main";

let existing = new Set<string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
      case "git_log":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(existing.has(String(args.path)));
      default:
        return Promise.resolve(null);
    }
  },
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));

// The real `PdfView` and the real store, over a stand-in pdf.js: the claim
// about releasing a document is only worth anything if a document was really
// held in the first place.
vi.mock("./pdfjsRuntime", () => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
  return {
    pdfjs: {
      GlobalWorkerOptions: {} as Record<string, string>,
      PDFWorker: class {
        promise = Promise.resolve();
        port = new (globalThis as unknown as { Worker: new () => unknown }).Worker();
      },
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 3, getPage: async () => page }),
        destroy: async () => {},
      }),
    },
    workerUrl: "/pdfjs/pdf.worker.min.mjs",
    runtimeUrls: {},
  };
});

const handed: { activePath: string | null; openPaths: string[] }[] = [];
vi.mock("./CodeEditor", () => ({
  default: (props: { activePath: string | null; openPaths: string[] }) => {
    createEffect(() => handed.push({ activePath: props.activePath, openPaths: [...props.openPaths] }));
    return null;
  },
}));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, PURGE_UNDER_PATH } = await import("../../utils/events");
const { retainedPdfPaths, pdfView, pdfLoadCount } = await import("./pdfDocument");

const PDF = `${REPO}/manual.pdf`;
const CODE = `${REPO}/src/a.ts`;

const selection = selectionFor(REPO);
const last = () => handed[handed.length - 1];

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => (
    <>
      <Editor selected={selection as never} />
      <PaneView pinKind="file" />
    </>
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

async function open(path: string, line?: number) {
  emitWith(OPEN_IN_EDITOR, { path, line });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

/** Mounted, loaded, and holding a document. The view is lazy, so nothing is on
 *  screen for a tick after the tab opens. */
async function pdfShown() {
  await waitFor(() => expect(retainedPdfPaths()).toContain(PDF));
  await waitFor(() => expect(document.querySelectorAll("canvas").length).toBeGreaterThan(0));
}

beforeEach(() => {
  localStorage.clear();
  handed.length = 0;
  existing = new Set([PDF, CODE]);
  listening.ready = false;
  vi.stubGlobal("Worker", class {});
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("a .pdf tab in the editor pane", () => {
  it("opens as its own view, named by the file", async () => {
    await mountEditor();
    await open(PDF);
    await pdfShown();

    expect(screen.getByRole("tab", { name: /manual\.pdf/ })).toBeTruthy();
  });

  it("is never handed to the code editor as a path to edit", async () => {
    await mountEditor();
    await open(CODE);
    await open(PDF);
    await pdfShown();

    // CodeEditor stays mounted, exactly as it does for an image tab: it is
    // mounted on the union of open paths so a background workspace keeps its
    // buffers. What it must not get is a path to read, and it does not.
    await waitFor(() => expect(last().activePath).toBeNull());
    expect(handed.every((h) => h.activePath !== PDF)).toBe(true);
    // `openPaths` is the eviction keep-set, not a set of buffers to build - an
    // image tab is in it too, and a file is only ever read for `activePath`. So
    // it naming the PDF is correct, and asserted so a later reader does not
    // "fix" it.
    expect(last().openPaths).toContain(PDF);
  });

  it("is persisted like any other file tab, so it comes back after a relaunch", async () => {
    await mountEditor();
    await open(PDF);
    await pdfShown();

    await waitFor(() => expect(localStorage.getItem("sway.editor.tabs.v1")).toContain(PDF));
  });

  it("releases the document when its tab is closed", async () => {
    await mountEditor();
    await open(PDF);
    await pdfShown();

    pointerClick(closeOf(/manual\.pdf/));

    await waitFor(() => expect(retainedPdfPaths()).not.toContain(PDF));
  });

  it("releases the document when the folder holding it is deleted", async () => {
    await mountEditor();
    await open(PDF);
    await pdfShown();

    emitWith(PURGE_UNDER_PATH, { path: REPO });

    await waitFor(() => expect(retainedPdfPaths()).not.toContain(PDF));
  });

  it("earns the bar its zoom controls, and loses it the blame toggle", async () => {
    await mountEditor();
    await open(CODE);
    // Blame is per line, so a code tab has it and the PDF beside it must not:
    // there are no lines to attribute, and the file is not even read as text.
    expect(screen.getByRole("button", { name: /Git blame/ })).toBeTruthy();
    expect(screen.queryByLabelText("Zoom percentage")).toBeNull();

    await open(PDF);
    await pdfShown();
    expect(screen.queryByRole("button", { name: /Git blame/ })).toBeNull();
    expect(screen.getByLabelText("Zoom percentage")).toBeTruthy();
    expect(screen.getByLabelText("Page")).toBeTruthy();
  });

  it("keeps the zoom across a switch to another tab and back", async () => {
    await mountEditor();
    await open(PDF);
    await pdfShown();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = pdfView(PDF).zoom;
    expect(zoomed).not.toBe("fitWidth");

    await open(CODE);
    await open(PDF);
    await pdfShown();
    expect(pdfView(PDF).zoom).toBe(zoomed);
  });

  it("keeps the page across a switch to another tab and back, without re-parsing", async () => {
    await mountEditor();
    await open(PDF, 3);
    await pdfShown();
    await waitFor(() => expect(pdfView(PDF).page).toBe(3));
    const parses = pdfLoadCount();

    await open(CODE);
    // The view is gone with the tab switch; the document and the page are not.
    expect(retainedPdfPaths()).toContain(PDF);
    expect(pdfView(PDF).page).toBe(3);

    await open(PDF);
    await pdfShown();
    expect(pdfView(PDF).page).toBe(3);
    expect(pdfLoadCount()).toBe(parses);
  });
});

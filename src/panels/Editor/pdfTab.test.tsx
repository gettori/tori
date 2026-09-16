import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createEffect } from "solid-js";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { closeOf } from "../../test/tabs";
import { pointerClick } from "../../test/menus";

// A PDF is a file the code editor must never read: it is bytes, and CodeEditor
// reads a file as UTF-8. That exclusion is the same shape as the `tori://` one
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
  const page = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    streamTextContent: () => [`page ${n} text`],
  });
  return {
    pdfjs: {
      GlobalWorkerOptions: {} as Record<string, string>,
      PDFWorker: class {
        promise = Promise.resolve();
        port = new (globalThis as unknown as { Worker: new () => unknown }).Worker();
      },
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 3, getPage: async (n: number) => page(n) }),
        destroy: async () => {},
      }),
      // Enough of pdf.js's `TextLayer` to select across; see `pdfView.test.tsx`.
      TextLayer: class {
        container: HTMLElement;
        source: string[];
        constructor({ textContentSource, container }: { textContentSource: string[]; container: HTMLElement }) {
          this.container = container;
          this.source = textContentSource;
        }
        render() {
          for (const str of this.source) {
            const span = document.createElement("span");
            // pdf.js's own: the span is scaffolding for a text run, not a thing
            // in its own right, so it keeps the text and sheds the generic role.
            span.setAttribute("role", "presentation");
            span.textContent = str;
            this.container.append(span);
          }
          return Promise.resolve();
        }
        update() {}
        cancel() {}
      },
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
const { emitWith, onWith, OPEN_IN_EDITOR, PURGE_UNDER_PATH, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, TOAST } =
  await import("../../utils/events");
const { retainedPdfPaths, pdfView, pdfLoadCount } = await import("./pdfDocument");

const PDF = `${REPO}/manual.pdf`;
const CODE = `${REPO}/src/a.ts`;

const selection = selectionFor(REPO);
// The same selection with a session attached: safe-send has nowhere to land a
// quote without one, which is a case of its own below.
const withSession = { ...selection, sessionId: "s1", agent: "claude", sessionCwd: REPO };
const last = () => handed[handed.length - 1];

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor(sel: Partial<typeof withSession> = selection) {
  mounted = render(() => (
    <>
      <Editor selected={sel as never} />
      <PaneView pinKind="file" />
    </>
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

type SentBlock = { path: string; startLine: number | null; endLine: number | null; text: string | null };
type Sent = { requestId: string; text: string; blocks?: SentBlock[] };

/** Stand in for Terminal.tsx: take the request off the bus and answer it, so
 *  `requestSend` resolves rather than sitting out its own timeout. */
function collectSends(): { sent: Sent[]; off: () => void } {
  const sent: Sent[] = [];
  const off = onWith<Sent>(SEND_TO_SESSION, (req) => {
    sent.push(req);
    emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
  });
  return { sent, off };
}

/** Select a page's words and offer them to the agent, the way a reader does. */
function quotePage(page: number) {
  const span = document.querySelector(`[data-pdf-page="${page}"] span`);
  if (!span) throw new Error(`no text on page ${page}`);
  const range = document.createRange();
  range.selectNodeContents(span);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  fireEvent.click(screen.getByRole("button", { name: "Quote" }));
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
  document.getSelection()?.removeAllRanges();
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

    await waitFor(() => expect(localStorage.getItem("tori.editor.tabs.v1")).toContain(PDF));
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

  it("sends a selection to the session as a page, never as a line", async () => {
    const { sent, off } = collectSends();
    await mountEditor(withSession);
    await open(PDF);
    await pdfShown();
    await waitFor(() => expect(document.querySelector('[data-pdf-page="1"] span')).toBeTruthy());

    quotePage(1);

    await waitFor(() => expect(sent).toHaveLength(1));
    // The agent opens a PDF by page; `#L1` would send it looking for a first
    // line of text in a file that has none.
    expect(sent[0].text).toBe("@manual.pdf (page 1)");
    expect(sent[0].text).not.toContain("#L");
    // And the words themselves ride along as a block, so the agent does not
    // have to parse the file back to see what was meant.
    expect(sent[0].blocks?.[0]).toMatchObject({ path: PDF, startLine: 1, endLine: 1, text: "page 1 text" });
    off();
  });

  it("says which session to pick rather than dropping the quote", async () => {
    const toasts: { message: string }[] = [];
    const off = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
    await mountEditor();
    await open(PDF);
    await pdfShown();
    await waitFor(() => expect(document.querySelector('[data-pdf-page="1"] span')).toBeTruthy());

    quotePage(1);

    await waitFor(() => expect(toasts.map((t) => t.message)).toContain("Select a session first"));
    off();
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

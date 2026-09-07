import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PdfView from "./PdfView";
import { pdfPlace, releasePdfsExcept, setPdfPlace } from "./pdfDocument";

// jsdom has no layout, so the viewport measures zero and every page keeps its
// intrinsic height. That is enough for what this file is about - which pages
// exist, which have a canvas, and where a `goto` lands - and the arithmetic
// that depends on a real width is covered in `pdfLayout.test.ts`.
//
// It also implements no ResizeObserver, which `PdfView` already guards for; and
// no IntersectionObserver, which it deliberately does not use: the render
// window is computed from the scroll offset and the measured heights, so an
// observer would only be a second way to ask a question already answered.

const spy = vi.hoisted(() => ({ pages: 12, failWith: null as unknown }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

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
        promise: spy.failWith
          ? Promise.reject(spy.failWith)
          : Promise.resolve({ numPages: spy.pages, getPage: async () => page }),
        destroy: async () => {},
      }),
    },
    workerUrl: "/assets/pdf.worker.min.mjs",
    runtimeUrls: {},
  };
});

const PATH = "/repo/manual.pdf";

beforeAll(() => vi.stubGlobal("Worker", class {}));

afterEach(() => {
  releasePdfsExcept([]);
  spy.pages = 12;
  spy.failWith = null;
});

describe("PdfView", () => {
  it("gives every page a placeholder and only the pages on screen a canvas", async () => {
    spy.pages = 300;
    const { container } = render(() => <PdfView path={PATH} />);
    await waitFor(() => expect(container.querySelectorAll("canvas").length).toBeGreaterThan(0));
    expect(container.querySelectorAll("canvas").length).toBeLessThanOrEqual(5);
  });

  it("says which file could not be opened rather than going blank", async () => {
    spy.failWith = Object.assign(new Error("bad header"), { name: "InvalidPDFException" });
    const { findByText } = render(() => <PdfView path={PATH} />);
    expect(await findByText("manual.pdf could not be opened as a PDF.")).toBeTruthy();
  });

  it("says a password-protected file is protected", async () => {
    spy.failWith = Object.assign(new Error("password"), { name: "PasswordException" });
    const { findByText } = render(() => <PdfView path={PATH} />);
    expect(await findByText(/password-protected/)).toBeTruthy();
  });

  describe("goto, whose line is a page", () => {
    it("holds a cold open's request until the document has loaded", async () => {
      // The request is handed over before the document exists, which is what a
      // cold `OPEN_IN_EDITOR` does: `openFile` then `setGotoTarget`, same tick.
      render(() => <PdfView path={PATH} goto={{ path: PATH, line: 7, nonce: 1 }} />);
      expect(pdfPlace(PATH).page).toBe(1);
      await waitFor(() => expect(pdfPlace(PATH).page).toBe(7));
    });

    it("clamps a page the document does not have", async () => {
      render(() => <PdfView path={PATH} goto={{ path: PATH, line: 999, nonce: 1 }} />);
      await waitFor(() => expect(pdfPlace(PATH).page).toBe(12));
    });

    it("goes back to the page on a second request with the same page", async () => {
      const [goto, setGoto] = createSignal({ path: PATH, line: 4, nonce: 1 });
      render(() => <PdfView path={PATH} goto={goto()} />);
      await waitFor(() => expect(pdfPlace(PATH).page).toBe(4));

      setPdfPlace(PATH, { page: 9, offset: 0 });
      setGoto({ path: PATH, line: 4, nonce: 2 });
      await waitFor(() => expect(pdfPlace(PATH).page).toBe(4));
    });

    it("ignores a request aimed at another file", async () => {
      render(() => <PdfView path={PATH} goto={{ path: "/repo/other.pdf", line: 5, nonce: 1 }} />);
      await waitFor(() => expect(document.querySelectorAll("canvas").length).toBeGreaterThan(0));
      expect(pdfPlace(PATH).page).toBe(1);
    });
  });
});

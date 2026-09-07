import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PdfRuntimeError,
  isPdfPath,
  jumpToPdfPage,
  loadPdf,
  pdfFailureMessage,
  pdfLoadCount,
  pdfView,
  releasePdf,
  releasePdfsExcept,
  retainedPdfPaths,
  setPdfView,
} from "./pdfDocument";

// What the store did to pdf.js, recorded rather than mocked away: the point of
// most of these tests is that a second open does *not* reach `getDocument`.
const spy = vi.hoisted(() => ({
  opened: [] as string[],
  destroyed: [] as string[],
  workerSrc: "",
  failWith: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("./pdfjsRuntime", () => {
  class FakePDFWorker {
    promise = Promise.resolve();
    // A real `Worker`, so the fallback warning stays where it belongs: on the
    // fallback. `globalThis.Worker` is stubbed below, node having none.
    port = new (globalThis as unknown as { Worker: new () => unknown }).Worker();
  }
  return {
    pdfjs: {
      GlobalWorkerOptions: {
        set workerSrc(v: string) {
          spy.workerSrc = v;
        },
      },
      PDFWorker: FakePDFWorker,
      getDocument: ({ url }: { url: string }) => {
        spy.opened.push(url);
        const fail = spy.failWith;
        return {
          promise: fail ? Promise.reject(fail) : Promise.resolve({ numPages: 3 }),
          destroy: async () => void spy.destroyed.push(url),
        };
      },
    },
    workerUrl: "/pdfjs/pdf.worker.min.mjs",
    runtimeUrls: { cMapUrl: "/pdfjs/cmaps/" },
  };
});

type NodeEvents = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
};

const A = "/repo/a.pdf";
const B = "/repo/b.pdf";

beforeAll(() => vi.stubGlobal("Worker", class {}));

afterEach(async () => {
  releasePdfsExcept([]);
  await vi.waitFor(() => expect(retainedPdfPaths()).toEqual([]));
  spy.opened.length = 0;
  spy.destroyed.length = 0;
  spy.failWith = null;
});

describe("isPdfPath", () => {
  it("is the extension, in any case", () => {
    expect(isPdfPath("/repo/manual.pdf")).toBe(true);
    expect(isPdfPath("/repo/MANUAL.PDF")).toBe(true);
  });

  it("is not a path that merely contains it", () => {
    expect(isPdfPath("/repo/notes.md")).toBe(false);
    expect(isPdfPath("/repo/pdf/readme.txt")).toBe(false);
    expect(isPdfPath("/repo/report.pdfx")).toBe(false);
  });
});

describe("the document store", () => {
  it("parses a path once, however many views ask for it", async () => {
    const before = pdfLoadCount();
    const [first, second] = await Promise.all([loadPdf(A), loadPdf(A)]);
    expect(first).toBe(second);
    expect(spy.opened).toEqual([`asset://localhost/${A}`]);
    expect(pdfLoadCount()).toBe(before + 1);
  });

  it("re-parses only after the path has been released", async () => {
    await loadPdf(A);
    releasePdf(A);
    await vi.waitFor(() => expect(spy.destroyed).toEqual([`asset://localhost/${A}`]));
    expect(retainedPdfPaths()).toEqual([]);
    await loadPdf(A);
    expect(spy.opened).toHaveLength(2);
  });

  it("points pdf.js at the bundled worker script", async () => {
    await loadPdf(A);
    expect(spy.workerSrc).toBe("/pdfjs/pdf.worker.min.mjs");
  });

  it("releases the documents no open tab names any more, and only those", async () => {
    await Promise.all([loadPdf(A), loadPdf(B)]);
    expect(retainedPdfPaths().sort()).toEqual([A, B]);

    releasePdfsExcept([B, "/repo/notes.md"]);
    await vi.waitFor(() => expect(spy.destroyed).toEqual([`asset://localhost/${A}`]));
    expect(retainedPdfPaths()).toEqual([B]);
  });

  it("destroys a document whose tab closed while it was still parsing", async () => {
    const load = loadPdf(A);
    releasePdf(A);
    expect(retainedPdfPaths()).toEqual([]);
    await load.catch(() => {});
    await vi.waitFor(() => expect(spy.destroyed).toEqual([`asset://localhost/${A}`]));
  });

  it("does not reject an open that failed with nobody listening", async () => {
    // A tab opened and closed inside one tick leaves the load promise with no
    // handler; an unobserved rejection is reported as an app-level error.
    spy.failWith = new Error("no");
    const unhandled = vi.fn();
    // Reached through globalThis: the frontend tsconfig carries no @types/node,
    // so a bare `process` does not typecheck even where it exists at runtime.
    const proc = (globalThis as unknown as { process: NodeEvents }).process;
    proc.on("unhandledRejection", unhandled);
    loadPdf(A);
    await new Promise((r) => setTimeout(r, 10));
    proc.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("the shared view state", () => {
  const place = (path: string) => ({ page: pdfView(path).page, offset: pdfView(path).offset });

  it("starts at the top, fitting the width, and survives as long as the document", async () => {
    await loadPdf(A);
    expect(place(A)).toEqual({ page: 1, offset: 0 });
    expect(pdfView(A).zoom).toBe("fitWidth");

    setPdfView(A, { page: 4, offset: 0.5 });
    expect(place(A)).toEqual({ page: 4, offset: 0.5 });
  });

  it("keeps a zoom the toolbar set, which is what survives a tab switch", async () => {
    await loadPdf(A);
    setPdfView(A, { zoom: 175 });
    expect(pdfView(A).zoom).toBe(175);
  });

  it("carries a page jump as a nonce, so asking twice for one page asks twice", async () => {
    await loadPdf(A);
    jumpToPdfPage(A, 7);
    const first = pdfView(A).jump;
    jumpToPdfPage(A, 7);
    const second = pdfView(A).jump;
    expect(first?.page).toBe(7);
    expect(second?.page).toBe(7);
    expect(second?.nonce).not.toBe(first?.nonce);
  });

  it("goes back to the defaults once the last tab on the path has closed", async () => {
    await loadPdf(A);
    setPdfView(A, { page: 4, offset: 0.5, zoom: 200 });
    releasePdf(A);
    expect(place(A)).toEqual({ page: 1, offset: 0 });
    expect(pdfView(A).zoom).toBe("fitWidth");
  });

  it("is ignored for a path with no document behind it", () => {
    setPdfView("/repo/never-opened.pdf", { page: 9, offset: 1 });
    expect(place("/repo/never-opened.pdf")).toEqual({ page: 1, offset: 0 });
  });

  it("keeps two open documents' state apart", async () => {
    await Promise.all([loadPdf(A), loadPdf(B)]);
    setPdfView(A, { zoom: 300, page: 2 });
    expect(pdfView(B).zoom).toBe("fitWidth");
    expect(pdfView(B).page).toBe(1);
  });
});

describe("pdfFailureMessage", () => {
  it("names the file and says the library, not the file, is the problem", () => {
    expect(pdfFailureMessage(A, new PdfRuntimeError("boom"))).toBe(
      "a.pdf needs a newer macOS: this version of WebKit cannot run the PDF viewer.",
    );
  });

  it("says so for a password-protected file", () => {
    const err = Object.assign(new Error("password"), { name: "PasswordException" });
    expect(pdfFailureMessage(A, err)).toBe(
      "a.pdf is password-protected, and Sway cannot open protected PDFs.",
    );
  });

  it("falls back to naming the file for anything else, including a text file renamed .pdf", () => {
    const err = Object.assign(new Error("bad header"), { name: "InvalidPDFException" });
    expect(pdfFailureMessage(A, err)).toBe("a.pdf could not be opened as a PDF.");
    expect(pdfFailureMessage(A, null)).toBe("a.pdf could not be opened as a PDF.");
  });
});

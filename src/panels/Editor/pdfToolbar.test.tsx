import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfToolbar from "./PdfToolbar";
import { loadPdf, pdfView, releasePdfsExcept, setPdfView } from "./pdfDocument";
import { CSS_PER_PT, MAX_PERCENT, MIN_PERCENT } from "./pdfLayout";
import { expectNoAxeViolations } from "../../test/axe";

// The toolbar reads and writes the shared view state and nothing else, so this
// mounts it alone over a store primed the way `PdfView` would prime it. What
// the two agree about is asserted where they meet, in `pdfTab.test.tsx`.

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("./pdfjsRuntime", () => ({
  pdfjs: {
    GlobalWorkerOptions: {} as Record<string, string>,
    PDFWorker: class {
      promise = Promise.resolve();
      port = new (globalThis as unknown as { Worker: new () => unknown }).Worker();
    },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 120 }),
      destroy: async () => {},
    }),
  },
  workerUrl: "/pdfjs/pdf.worker.min.mjs",
  runtimeUrls: {},
}));

const PATH = "/repo/manual.pdf";

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const percentField = () => screen.getByLabelText("Zoom percentage") as HTMLInputElement;
const pageField = () => screen.getByLabelText("Page") as HTMLInputElement;

/** What `PdfView` publishes once it has worked out what a zoom setting means at
 *  this pane's width. The toolbar cannot compute it, which is the whole reason
 *  the field exists, so a test standing in for the view has to supply it. */
function viewResolved(percent: number) {
  setPdfView(PATH, { scale: (percent / 100) * CSS_PER_PT });
}

/** Type into a field and press Enter, the way a reader commits one. */
function commit(field: HTMLInputElement, text: string) {
  fireEvent.input(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: "Enter" });
}

beforeEach(async () => {
  vi.stubGlobal("Worker", class {});
  await loadPdf(PATH);
  // What the view publishes once it has measured itself: 120 pages, fitting the
  // width of a pane where that lands on exactly 100%.
  setPdfView(PATH, { pages: 120 });
  viewResolved(100);
});
afterEach(() => releasePdfsExcept([]));

describe("the PDF toolbar", () => {
  it("shows the percentage the view resolved to, and the page out of the count", () => {
    render(() => <PdfToolbar path={PATH} />);
    expect(percentField().value).toBe("100");
    expect(pageField().value).toBe("1");
    expect(screen.getByText("/ 120")).toBeTruthy();
  });

  it("names every control it draws", async () => {
    // Two bare inputs with no visible label between them, so the names are the
    // whole of what a screen reader gets here.
    const { container } = render(() => <PdfToolbar path={PATH} />);
    await expectNoAxeViolations(container);
  });

  describe("the zoom buttons", () => {
    it("move between round stops", async () => {
      render(() => <PdfToolbar path={PATH} />);
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(pdfView(PATH).zoom).toBe(125);

      // The buttons step from the percentage the *view* resolved to, not from
      // the setting: from fit-width at 87% the next step up is 100, which is
      // only right if the resolved figure is what is being stepped from. So the
      // view's half of the exchange has to happen for the second click to mean
      // anything, and here that is by hand.
      viewResolved(125);
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      expect(pdfView(PATH).zoom).toBe(100);
    });

    it("steps to a round stop from a fit that landed between two", () => {
      viewResolved(87);
      render(() => <PdfToolbar path={PATH} />);
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(pdfView(PATH).zoom).toBe(100);
    });

    it("are disabled at the bounds rather than doing nothing", async () => {
      viewResolved(MAX_PERCENT);
      render(() => <PdfToolbar path={PATH} />);
      // The DOM property, not jest-dom's matcher: the package is in the tree to
      // pin vite-plugin-solid's peer resolution, not for its matchers, and its
      // types are not declared here (see `vitest.config.ts`).
      expect(button("Zoom in").disabled).toBe(true);
      expect(button("Zoom out").disabled).toBe(false);
    });
  });

  describe("the percent field", () => {
    it("takes a number and clamps it to the range", () => {
      render(() => <PdfToolbar path={PATH} />);
      commit(percentField(), "150");
      expect(pdfView(PATH).zoom).toBe(150);

      commit(percentField(), "9000");
      expect(pdfView(PATH).zoom).toBe(MAX_PERCENT);
      commit(percentField(), "1");
      expect(pdfView(PATH).zoom).toBe(MIN_PERCENT);
    });

    it("puts back what was taken, so the field never shows what was refused", () => {
      render(() => <PdfToolbar path={PATH} />);
      // 9000 clamps to 400 and 9001 clamps to 400 as well, so the second commit
      // changes nothing in the state: only the write-back keeps the field
      // honest here.
      commit(percentField(), "9000");
      commit(percentField(), "9001");
      expect(percentField().value).toBe(String(MAX_PERCENT));
    });

    it("rejects anything that is not a number and puts the old value back", () => {
      render(() => <PdfToolbar path={PATH} />);
      commit(percentField(), "abc");
      expect(pdfView(PATH).zoom).toBe("fitWidth");
      expect(percentField().value).toBe("100");
    });

    it("abandons on Escape", () => {
      render(() => <PdfToolbar path={PATH} />);
      fireEvent.input(percentField(), { target: { value: "300" } });
      fireEvent.keyDown(percentField(), { key: "Escape" });
      expect(pdfView(PATH).zoom).toBe("fitWidth");
      expect(percentField().value).toBe("100");
    });

    it("commits on blur too, so a value left showing is never unapplied", () => {
      render(() => <PdfToolbar path={PATH} />);
      fireEvent.input(percentField(), { target: { value: "175" } });
      fireEvent.blur(percentField());
      expect(pdfView(PATH).zoom).toBe(175);
    });
  });

  describe("the fit strip", () => {
    it("sets the mode it names", async () => {
      render(() => <PdfToolbar path={PATH} />);
      fireEvent.click(screen.getByRole("button", { name: "Page" }));
      await waitFor(() => expect(pdfView(PATH).zoom).toBe("fitPage"));
    });

    it("shows nothing pressed once a percentage is typed, since it is none of them", async () => {
      render(() => <PdfToolbar path={PATH} />);
      commit(percentField(), "150");
      await waitFor(() =>
        expect(
          ["Width", "Page", "100%"].map((n) =>
            screen.getByRole("button", { name: n }).getAttribute("aria-pressed"),
          ),
        ).toEqual(["false", "false", "false"]),
      );
    });
  });

  describe("the page field", () => {
    it("asks the view to go to the page, clamped to the document", () => {
      render(() => <PdfToolbar path={PATH} />);
      commit(pageField(), "42");
      expect(pdfView(PATH).jump?.page).toBe(42);

      commit(pageField(), "999");
      expect(pdfView(PATH).jump?.page).toBe(120);
      expect(pageField().value).toBe("120");
    });

    it("rejects a non-number and puts the current page back", () => {
      render(() => <PdfToolbar path={PATH} />);
      commit(pageField(), "later");
      expect(pdfView(PATH).jump).toBeNull();
      expect(pageField().value).toBe("1");
    });

    it("follows the page the view reports, without a click", async () => {
      render(() => <PdfToolbar path={PATH} />);
      setPdfView(PATH, { page: 4 });
      await waitFor(() => expect(pageField().value).toBe("4"));
    });
  });
});

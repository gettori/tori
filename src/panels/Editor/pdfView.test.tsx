import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import PdfView from "./PdfView";
import { pdfView, releasePdfsExcept, setPdfView } from "./pdfDocument";
import { expectNoAxeViolations } from "../../test/axe";

// jsdom has no layout, so a test that wants one has to lend it: `layOut` below
// gives the viewport a size and a scrollTop that behaves like a real one. Most
// of what is here does not need that - which pages exist, where a `goto` lands,
// what a failure says - and the arithmetic behind it all is `pdfLayout.test.ts`.
//
// jsdom implements no IntersectionObserver either, which `PdfView` deliberately
// does not use: the render window is computed from the scroll offset and the
// measured heights, so an observer would only be a second way to ask a question
// already answered.

const spy = vi.hoisted(() => ({ pages: 12, failWith: null as unknown }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("./pdfjsRuntime", () => {
  const page = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    // One line per page, naming the page: what a quote spanning pages says is
    // the whole question, so the text has to be traceable back to where it came
    // from. The real one answers a `ReadableStream` of positioned items.
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
        promise: spy.failWith
          ? Promise.reject(spy.failWith)
          : Promise.resolve({ numPages: spy.pages, getPage: async (n: number) => page(n) }),
        destroy: async () => {},
      }),
      // Enough of pdf.js's `TextLayer` to select across, which is all any of
      // this asks of it: the real one streams the page's items and positions a
      // span per run, and jsdom has no layout to position anything in.
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

const PATH = "/repo/manual.pdf";

/**
 * The element `PdfView` listens to for scrolls: `OverlayScroll`'s viewport,
 * reached through the one stable attribute in that component's markup. Its
 * scrollbar track carries `data-no-window-drag`, and the viewport is the
 * sibling before it.
 */
function scroller(container: HTMLElement): HTMLElement {
  const track = container.querySelector("[data-no-window-drag]");
  if (!track?.previousElementSibling) throw new Error("no OverlayScroll viewport in this tree");
  return track.previousElementSibling as HTMLElement;
}

/** Every live ResizeObserver callback, so a test can say "the pane was laid
 *  out" the way a browser does rather than reaching into the component. */
const observers: (() => void)[] = [];

/**
 * Lend the viewport the geometry jsdom has none of: a measured size, and a
 * `scrollTop` that stores what is written to it and fires `scroll` (jsdom's is a
 * no-op, because with no layout nothing is ever scrollable).
 *
 * `PdfView` measures on mount and then only when its ResizeObserver fires, so
 * the recorded observers are fired here. That is not a shortcut around the
 * component: it is exactly the callback a browser makes once the pane has a
 * size, and the sequence under test starts there.
 */
function layOut(container: HTMLElement, width: number, height: number) {
  const el = scroller(container);
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
      el.dispatchEvent(new Event("scroll"));
    },
  });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height });
  for (const fire of observers) fire();
  return {
    scrollTop: () => top,
    scrollTo: (value: number) => {
      el.scrollTop = value;
    },
  };
}

/**
 * The spans of one page's text layer. CSS Modules are stubbed to the empty
 * string under vitest, so the layer's own class is not a handle; a `span` under
 * a page is, because nothing else in a page draws one.
 */
const spansOn = (container: HTMLElement, page: number) =>
  [...container.querySelectorAll<HTMLElement>(`[data-pdf-page="${page}"] span`)];

/** Select from the first word of one page to the last of another, the way a
 *  drag (or a click then a shift-click) leaves the selection. jsdom fires no
 *  `selectionchange` of its own, so it is dispatched here as the browser would. */
function selectAcross(container: HTMLElement, from: number, to: number) {
  const [a] = spansOn(container, from);
  const [b] = spansOn(container, to);
  if (!a || !b) throw new Error(`no text on page ${from} or page ${to}`);
  const range = document.createRange();
  range.setStart(a.firstChild!, 0);
  range.setEnd(b.firstChild!, b.textContent!.length);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

/** A 12-page document in a laid-out pane, scrolled to the top. */
async function readyPage(onQuote?: (text: string, first: number, last: number) => void) {
  const { container } = render(() => <PdfView path={PATH} onQuote={onQuote} />);
  await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
  const pane = layOut(container, 612 + 32, 900);
  await waitFor(() => expect(spansOn(container, 1).length).toBeGreaterThan(0));
  return { container, pane };
}

/** Where the viewport has to sit for `page` to start at its top, for a 12-page
 *  Letter document at scale 1: 16px of column padding, then 792 + 12 per page. */
const topOf = (page: number) => 16 + (page - 1) * 804;

beforeAll(() => {
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  releasePdfsExcept([]);
  observers.length = 0;
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

  it("publishes the page count and the scale it resolved to, for the toolbar", async () => {
    const { container } = render(() => <PdfView path={PATH} />);
    await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
    // jsdom measures the pane as zero-wide, where fit-width has nothing to fit
    // to and answers 1. The point here is that *something* is published, not
    // what: the arithmetic is `pdfLayout`'s.
    expect(pdfView(PATH).scale).toBe(1);
    expect(container).toBeTruthy();
  });

  it("tracks the page from scroll, with no click anywhere", async () => {
    const { container } = render(() => <PdfView path={PATH} />);
    await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
    expect(pdfView(PATH).page).toBe(1);

    // Page 4 of a 12-page Letter document at scale 1: pages are 792 tall with a
    // 12px gap, so page 4 starts at 16 + 3 * 804 = 2428.
    const pane = layOut(container, 612 + 32, 900);
    pane.scrollTo(2428);
    await waitFor(() => expect(pdfView(PATH).page).toBe(4));
  });

  it("keeps the reader on the same page through a zoom in and back out", async () => {
    const { container } = render(() => <PdfView path={PATH} />);
    await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
    const pane = layOut(container, 612 + 32, 900);

    pane.scrollTo(3000);
    const page = pdfView(PATH).page;
    expect(page).toBeGreaterThan(1);

    // Three zooms and a reset. Each one rewrites every page's height, so the
    // scroll offset that named this page stops naming it; landing back on the
    // same page is the whole of what the re-anchor is for.
    for (const zoom of [200, 300, 50, "fitWidth" as const]) {
      setPdfView(PATH, { zoom });
      await waitFor(() => expect(pdfView(PATH).page).toBe(page));
    }
    expect(pane.scrollTop()).toBeGreaterThan(0);
  });

  it("answers a zoom by publishing what it resolved to", async () => {
    const { container } = render(() => <PdfView path={PATH} />);
    await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
    layOut(container, 612 + 32, 900);
    // Fit-width in a pane exactly as wide as a Letter page plus the column's
    // padding is scale 1, which reads as 75%.
    await waitFor(() => expect(pdfView(PATH).scale).toBe(1));

    setPdfView(PATH, { zoom: 200 });
    await waitFor(() => expect(pdfView(PATH).scale).toBeCloseTo((200 / 100) * (96 / 72), 6));
  });

  describe("a trackpad pinch", () => {
    /** WebKit's form, which is what the app actually gets: a cumulative `scale`
     *  over the gesture. jsdom knows nothing of these events, so they are built
     *  by hand the way WebKit sends them. */
    function gesture(el: HTMLElement, type: string, scale: number, clientY = 300) {
      const e = Object.assign(new Event(type, { cancelable: true }), { scale, clientY });
      el.dispatchEvent(e);
      return e;
    }

    async function readyPane() {
      const { container } = render(() => <PdfView path={PATH} />);
      await waitFor(() => expect(pdfView(PATH).pages).toBe(12));
      const pane = layOut(container, 612 + 32, 900);
      pane.scrollTo(3000);
      return { pane, el: scroller(container) };
    }

    it("zooms, and stops WebKit zooming the whole window instead", async () => {
      const { el } = await readyPane();
      // Without preventDefault on the start, WebKit takes the gesture as a page
      // zoom and the app's own chrome scales with the document.
      expect(gesture(el, "gesturestart", 1).defaultPrevented).toBe(true);

      gesture(el, "gesturechange", 2);
      await waitFor(() => expect(pdfView(PATH).zoom).toBe(150));
    });

    it("reads e.scale as cumulative, not as one step", async () => {
      const { el } = await readyPane();
      gesture(el, "gesturestart", 1);
      gesture(el, "gesturechange", 2);
      await waitFor(() => expect(pdfView(PATH).zoom).toBe(150));

      // 4 is twice 2, not four times the original, so this doubles again rather
      // than quadrupling from where it started.
      gesture(el, "gesturechange", 4);
      await waitFor(() => expect(pdfView(PATH).zoom).toBe(300));
    });

    it("accumulates a slow pinch instead of discarding every step of it", async () => {
      const { el } = await readyPane();
      gesture(el, "gesturestart", 1);
      const before = pdfView(PATH).zoom;

      // Each of these is far too small on its own to move the rounded
      // percentage. Measuring the next step from the last *applied* scale is
      // what lets them add up; measuring from the last event would throw each
      // one away and a gesture this gentle would never zoom at all.
      for (let i = 1; i <= 40; i++) gesture(el, "gesturechange", 1 + i * 0.005);
      await waitFor(() => expect(pdfView(PATH).zoom).not.toBe(before));
      expect(pdfView(PATH).zoom).toBeGreaterThan(80);
    });

    it("keeps what is under the pointer under the pointer", async () => {
      const { pane, el } = await readyPane();
      const before = pdfView(PATH).page;
      const topBefore = pane.scrollTop();

      gesture(el, "gesturestart", 1);
      gesture(el, "gesturechange", 2, 300);
      await waitFor(() => expect(pane.scrollTop()).not.toBe(topBefore));
      // The pointer sat on the probe line here, so the page under it is the page
      // the store reports; a pinch that moved the reader elsewhere would show up
      // as a different one.
      expect(pdfView(PATH).page).toBe(before);
    });

    it("takes Chromium's form too, and leaves an ordinary wheel alone", async () => {
      const { el } = await readyPane();
      const zoomed = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true });
      el.dispatchEvent(zoomed);
      await waitFor(() => expect(typeof pdfView(PATH).zoom).toBe("number"));
      expect(zoomed.defaultPrevented).toBe(true);

      const setting = pdfView(PATH).zoom;
      const scrolling = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
      el.dispatchEvent(scrolling);
      expect(scrolling.defaultPrevented).toBe(false);
      expect(pdfView(PATH).zoom).toBe(setting);
    });
  });

  describe("the text layer", () => {
    it("lays the page's words over the page it drew", async () => {
      const { container } = await readyPage();
      expect(spansOn(container, 1).map((n) => n.textContent)).toEqual(["page 1 text"]);
      expect(spansOn(container, 2).map((n) => n.textContent)).toEqual(["page 2 text"]);
    });

    it("re-places the words it has on a zoom rather than building them again", async () => {
      const { container } = await readyPage();
      const [before] = spansOn(container, 1);

      setPdfView(PATH, { zoom: 200 });
      await waitFor(() => expect(pdfView(PATH).scale).toBeCloseTo(2 * (96 / 72), 6));
      // The same node, still in the document. A layer rebuilt per zoom step
      // would delete the nodes a standing selection is anchored to, and a range
      // whose boundary is removed collapses: the selection would vanish on the
      // first zoom after it was made.
      expect(spansOn(container, 1)[0]).toBe(before);
      expect(before.isConnected).toBe(true);
    });

    it("names every control it draws over the page", async () => {
      const { container } = await readyPage();
      selectAcross(container, 1, 2);
      // With the Quote button showing, which is the only thing here a reader
      // operates: the spans themselves are pdf.js's transparent text runs,
      // marked presentational the way its own viewer marks them.
      await expectNoAxeViolations(container);
    });
  });

  describe("a selection that outlives the pages it started on", () => {
    it("keeps a page's words once its canvas has gone", async () => {
      const { container, pane } = await readyPage();
      await waitFor(() => expect(spansOn(container, 3).length).toBe(1));
      selectAcross(container, 3, 3);

      pane.scrollTo(topOf(9));
      await waitFor(() => expect(pdfView(PATH).page).toBe(9));
      // The picture is gone, which is the point of the window; the words are
      // not, because an end of the selection is anchored in them.
      expect(container.querySelector('[data-pdf-page="3"] canvas')).toBeNull();
      expect(spansOn(container, 3).length).toBe(1);
    });

    it("gives the pages between the ends their words before the quote is read", async () => {
      const { container, pane } = await readyPage();
      await waitFor(() => expect(spansOn(container, 3).length).toBe(1));
      selectAcross(container, 3, 3);

      pane.scrollTo(topOf(6));
      await waitFor(() => expect(spansOn(container, 6).length).toBe(1));
      // The shift-click at the far end. Pages 4 and 5 were dropped on the way
      // past, so without the selection widening the window the quote would jump
      // straight from page 3 to page 6.
      selectAcross(container, 3, 6);
      // Page 5 is in the render window from here, so page 4 is the one that has
      // to come back from the selection alone. Waiting on 5 would pass before
      // the layer that matters had been built.
      await waitFor(() => expect(spansOn(container, 4).length).toBe(1));

      const quoted = document.getSelection()!.toString();
      expect(quoted).toContain("page 4 text");
      expect(quoted).toContain("page 5 text");
    });
  });

  describe("quoting to the agent", () => {
    it("offers Quote for a selection and hands over the pages it spans", async () => {
      const onQuote = vi.fn();
      const { container } = await readyPage(onQuote);
      selectAcross(container, 1, 2);

      fireEvent.click(screen.getByRole("button", { name: "Quote" }));
      await waitFor(() =>
        expect(onQuote).toHaveBeenCalledWith(expect.stringContaining("page 1 text"), 1, 2),
      );
    });

    it("waits for a page the selection only just reached before reading the quote", async () => {
      const onQuote = vi.fn();
      const { container, pane } = await readyPage(onQuote);
      await waitFor(() => expect(spansOn(container, 3).length).toBe(1));
      selectAcross(container, 3, 3);
      pane.scrollTo(topOf(6));
      await waitFor(() => expect(spansOn(container, 6).length).toBe(1));

      // Page 4 is out of the render window and starts fetching its words only
      // now. Quoting in the same breath is exactly the race, so the click comes
      // with no wait in between.
      selectAcross(container, 3, 6);
      fireEvent.click(screen.getByRole("button", { name: "Quote" }));

      await waitFor(() => expect(onQuote).toHaveBeenCalled());
      expect(onQuote.mock.calls[0][0]).toContain("page 4 text");
      expect(onQuote.mock.calls[0].slice(1)).toEqual([3, 6]);
    });

    it("takes Cmd+Shift+M on the focused pane for the same send", async () => {
      const onQuote = vi.fn();
      const { container } = await readyPage(onQuote);
      selectAcross(container, 2, 2);

      const pane = scroller(container);
      // The chord belongs to the pane, not to the window: a selection left
      // standing in a PDF must not answer for a keystroke typed in the
      // composer, and being focusable is what lets the browser say which.
      expect(pane.tabIndex).toBe(0);
      const e = new KeyboardEvent("keydown", { key: "M", metaKey: true, shiftKey: true, cancelable: true });
      pane.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      await waitFor(() => expect(onQuote).toHaveBeenCalledWith("page 2 text", 2, 2));
    });

    it("ignores the chord typed anywhere but the pane", async () => {
      const onQuote = vi.fn();
      const { container } = await readyPage(onQuote);
      selectAcross(container, 2, 2);

      const e = new KeyboardEvent("keydown", { key: "M", metaKey: true, shiftKey: true, cancelable: true });
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(onQuote).not.toHaveBeenCalled();
    });

    it("leaves the chord alone when the selection is somewhere else", async () => {
      const onQuote = vi.fn();
      const { container } = await readyPage(onQuote);
      const outside = document.createElement("p");
      outside.textContent = "not the document";
      document.body.append(outside);
      const range = document.createRange();
      range.selectNodeContents(outside);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      const e = new KeyboardEvent("keydown", { key: "M", metaKey: true, shiftKey: true, cancelable: true });
      scroller(container).dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(onQuote).not.toHaveBeenCalled();
      outside.remove();
    });
  });

  describe("goto, whose line is a page", () => {
    it("holds a cold open's request until the document has loaded", async () => {
      // The request is handed over before the document exists, which is what a
      // cold `OPEN_IN_EDITOR` does: `openFile` then `setGotoTarget`, same tick.
      render(() => <PdfView path={PATH} goto={{ path: PATH, line: 7, nonce: 1 }} />);
      expect(pdfView(PATH).page).toBe(1);
      await waitFor(() => expect(pdfView(PATH).page).toBe(7));
    });

    it("clamps a page the document does not have", async () => {
      render(() => <PdfView path={PATH} goto={{ path: PATH, line: 999, nonce: 1 }} />);
      await waitFor(() => expect(pdfView(PATH).page).toBe(12));
    });

    it("goes back to the page on a second request with the same page", async () => {
      const [goto, setGoto] = createSignal({ path: PATH, line: 4, nonce: 1 });
      render(() => <PdfView path={PATH} goto={goto()} />);
      await waitFor(() => expect(pdfView(PATH).page).toBe(4));

      setPdfView(PATH, { page: 9, offset: 0 });
      setGoto({ path: PATH, line: 4, nonce: 2 });
      await waitFor(() => expect(pdfView(PATH).page).toBe(4));
    });

    it("ignores a request aimed at another file", async () => {
      render(() => <PdfView path={PATH} goto={{ path: "/repo/other.pdf", line: 5, nonce: 1 }} />);
      await waitFor(() => expect(document.querySelectorAll("canvas").length).toBeGreaterThan(0));
      expect(pdfView(PATH).page).toBe(1);
    });
  });
});

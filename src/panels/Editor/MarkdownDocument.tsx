import { For, createEffect, createSignal, on, onCleanup } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { traceNote, traceWork } from "../../utils/perfTrace";
import { lexInSteps, type PreviewBlock } from "./previewBlocks";
import { marked } from "marked";
import { emitWith, NAVIGATE, OPEN_IN_EDITOR, type NavTarget, type OpenInEditor } from "../../utils/events";
import { linkTarget } from "../Chat/links";
import PreviewCode from "./PreviewCode";
import styles from "./MarkdownPreview.module.css";

type Segment = { kind: "prose"; html: string } | { kind: "code"; lang: string; code: string };

// Per frame, for turning blocks into DOM: a megabyte document is thousands of
// blocks, and doing them all at once held the first paint for over 400ms. The
// slice is sized from what the last one cost, DOM included.
const SLICE_MS = 8;
const FIRST_SLICE = 16;

// Relative image src values (the common case for a plan/README's own
// screenshots) resolve against the document's base directory, then go
// through Tauri's asset protocol (convertFileSrc) so the webview - which
// otherwise has no access to arbitrary local paths - can actually load them.
// Absolute/http(s)/data URLs are left untouched.
function resolveImages(html: string, base: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (!src || /^(https?:|data:)/i.test(src)) continue;
    const abs = src.startsWith("/") ? src : `${base}/${src}`;
    img.setAttribute("src", convertFileSrc(abs));
  }
  return doc.body.innerHTML;
}

/** Markdown text rendered as a document, the body of a `.md` tab's preview and
 *  of a pull request's description. Locally rendered, no remote fetch:
 *  `marked` parses to HTML, `sanitizeHtml` strips script-execution vectors
 *  before it goes into innerHTML, then relative images and links resolve
 *  against `base`.
 *
 *  Rendered block by block rather than as one innerHTML blob, so a fence can be
 *  a real component with a copy button and a `mermaid` fence can be a drawn
 *  diagram instead of its own arrow syntax.
 *
 *  `source` names the document. A new one fills in from the top; a new text
 *  for the same one swaps in whole once rendered. `onRendered` fires with it
 *  each time a render completes. */
export default function MarkdownDocument(props: {
  text: string;
  base: string;
  source: string;
  ref?: (el: HTMLDivElement) => void;
  onRendered?: (source: string) => void;
}) {
  // Segments keyed by their source, carried across renders: typing into a big
  // document re-sanitizes only the blocks that changed, and `For` keeps the DOM
  // of every block whose object comes back the same.
  let made = new Map<string, Segment>();
  const [segments, setSegments] = createSignal<Segment[]>([]);
  let renderedFor: string | null = null;
  let job: number | undefined;
  onCleanup(() => job !== undefined && cancelAnimationFrame(job));

  createEffect(
    on([() => props.text, () => props.source], ([t, source]) => {
      if (job !== undefined) cancelAnimationFrame(job);
      job = undefined;
      const base = props.base;
      // A new document fills in from the top as it goes; an edit to the one on
      // screen swaps in whole, so typing never blanks the text below the caret.
      const fresh = renderedFor !== source;
      if (fresh) setSegments([]);
      // Lexed in steps first, inside the same slices: a megabyte in one pass
      // held a frame for 90ms.
      const lexing = lexInSteps(t);
      let all: PreviewBlock[] | null = null;
      const next = new Map<string, Segment>();
      const out: Segment[] = [];
      let i = 0;
      let count = FIRST_SLICE;
      let last: number | undefined;
      let slices = 0;
      const began = performance.now();
      const step = (now?: number) => {
        job = undefined;
        // A frame that came late was spent laying out the last slice, which
        // no timer in here can see, so the next slice shrinks to match.
        if (now !== undefined && last !== undefined && now - last > 2 * SLICE_MS + 17) {
          count = Math.max(1, Math.floor(count / 2));
        }
        slices++;
        last = now;
        if (!all) {
          const end = performance.now() + SLICE_MS;
          traceWork("md-preview-lex", () => {
            let r = lexing.next();
            while (!r.done && performance.now() < end) r = lexing.next();
            if (r.done) all = r.value;
          });
          if (!all) {
            job = requestAnimationFrame(step);
            return;
          }
        }
        const blocks = all;
        const t0 = performance.now();
        const stop = Math.min(blocks.length, i + count);
        traceWork("md-preview-slice", () => {
          for (; i < stop; i++) {
            const b = blocks[i];
            const seg =
              made.get(b.key) ??
              (b.kind === "prose"
                ? { kind: "prose" as const, html: resolveImages(sanitizeHtml(marked.parser(b.tokens)), base) }
                : { kind: "code" as const, lang: b.lang, code: b.code });
            next.set(b.key, seg);
            out.push(seg);
          }
          if (fresh && i < blocks.length) setSegments(out.slice());
        });
        const perBlock = (performance.now() - t0) / Math.max(1, count);
        count = Math.max(1, Math.min(count * 2, Math.floor(SLICE_MS / Math.max(perBlock, 0.01))));
        if (i < blocks.length) {
          job = requestAnimationFrame(step);
          return;
        }
        made = next;
        traceWork("md-preview-slice", () => setSegments(out));
        renderedFor = source;
        props.onRendered?.(source);
        traceNote("preview-render", { blocks: blocks.length, slices, ms: Math.round(performance.now() - began) });
      };
      step();
    }),
  );

  // An anchor the webview follows takes the whole app off the SPA. A link
  // out of the base directory still opens: a README links its siblings.
  function onLinkClick(e: MouseEvent) {
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    e.preventDefault();
    const target = linkTarget(anchor.getAttribute("href") ?? "", props.base);
    if (target.kind === "external") {
      void invoke("plugin:opener|open_url", { url: target.url }).catch(() => {});
    } else if (target.kind === "navigate") {
      emitWith<NavTarget>(NAVIGATE, target.target);
    } else if (target.kind === "file") {
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: target.path, line: target.line });
    } else if (target.kind === "outside") {
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: target.path });
    }
  }

  return (
    <div ref={(el) => props.ref?.(el)} class={styles.markdownBody} onClick={onLinkClick}>
      <For each={segments()}>
        {(seg) =>
          seg.kind === "prose" ? (
            // `display: contents` on the carrier: the document's own
            // margins have to keep collapsing across a fence, or every
            // block boundary gains a seam the source does not have.
            <div class={styles.prose} innerHTML={seg.html} />
          ) : (
            <PreviewCode lang={seg.lang} code={seg.code} />
          )
        }
      </For>
    </div>
  );
}

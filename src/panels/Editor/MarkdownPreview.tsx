import { For, createEffect, createMemo, createResource, Show } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { marked, type Token } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { bufferTextOf, handOff, takeHandOff, scrollFraction } from "../../utils/liveBuffer";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import PreviewCode from "./PreviewCode";
import styles from "./MarkdownPreview.module.css";

type Segment = { kind: "prose"; html: string } | { kind: "code"; lang: string; code: string };

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// Relative image src values (the common case for a plan/README's own
// screenshots) resolve against the markdown file's own directory, then go
// through Tauri's asset protocol (convertFileSrc) so the webview - which
// otherwise has no access to arbitrary local paths - can actually load them.
// Absolute/http(s)/data URLs are left untouched.
function resolveImages(html: string, fileDir: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (!src || /^(https?:|data:)/i.test(src)) continue;
    const abs = src.startsWith("/") ? src : `${fileDir}/${src}`;
    img.setAttribute("src", convertFileSrc(abs));
  }
  return doc.body.innerHTML;
}

/** Read-only rendered view of a `.md` tab (the preview side of its toggle,
 *  CodeEditor stays the source side). Locally rendered, no remote fetch:
 *  `marked` parses to HTML, `sanitizeHtml` strips script-execution vectors
 *  before it goes into innerHTML, then relative images are resolved to the
 *  file's own directory via the asset protocol.
 *
 *  Rendered block by block rather than as one innerHTML blob, the way the chat
 *  transcript is, so a fence can be a real component with a copy button and a
 *  `mermaid` fence can be a drawn diagram instead of its own arrow syntax.
 *
 *  Renders the open buffer rather than the file: the toggle sits next to the
 *  editor, so "preview" that ignored unsaved edits would be showing a
 *  different document from the one just typed into. Disk is the fallback for a
 *  tab with no buffer at all, which is every restored tab nobody has clicked. */
export default function MarkdownPreview(props: { path: string }) {
  const live = () => bufferTextOf(props.path);
  const [disk] = createResource(
    // Null while a buffer holds this file, which is `createResource`'s own way
    // of saying there is nothing to fetch: the read is skipped rather than
    // raced with the answer we already have.
    () => (live() === undefined ? props.path : null),
    (path: string) => invoke<string>("fs_read_file", { path }),
  );
  const text = () => live() ?? disk();

  const segments = createMemo<Segment[]>(() => {
    const t = text();
    if (t === undefined) return [];
    const dir = dirOf(props.path);
    const segs: Segment[] = [];
    let run: Token[] = [];
    const flush = () => {
      if (!run.length) return;
      segs.push({ kind: "prose", html: resolveImages(sanitizeHtml(marked.parser(run)), dir) });
      run = [];
    };
    for (const token of marked.lexer(t)) {
      if (token.type === "code") {
        flush();
        segs.push({ kind: "code", lang: (token.lang ?? "").trim().split(/\s+/)[0], code: token.text });
      } else {
        run.push(token);
      }
    }
    flush();
    return segs;
  });

  let box!: HTMLDivElement;
  // The path this view has already positioned itself for. Per path rather than
  // a plain flag, because the same component is reused when the active tab
  // moves from one previewed markdown file to another.
  let placedFor: string | null = null;

  createEffect(() => {
    if (text() === undefined || placedFor === props.path) return;
    placedFor = props.path;
    const fraction = takeHandOff(props.path, "preview");
    if (fraction === undefined) return;
    // After the browser has laid the rendered HTML out: until it has, the box
    // has no scrollable height for a fraction to point into.
    requestAnimationFrame(() => {
      const max = box.scrollHeight - box.clientHeight;
      if (max <= 0) return;
      box.scrollTop = fraction * max;
      // Handed straight back, so toggling to the source without scrolling
      // returns to the same place rather than to the cursor.
      handOff(props.path, "preview", fraction);
    });
  });

  return (
    <OverlayScroll
      class={styles.preview}
      // The hand-off needs the element that actually scrolls, which is the
      // component's viewport, not its frame.
      viewportRef={(el) => {
        box = el;
        el.addEventListener("scroll", () => {
          const fraction = scrollFraction(box.scrollTop, box.scrollHeight, box.clientHeight);
          if (fraction !== undefined) handOff(props.path, "preview", fraction);
        });
      }}
    >
      <Show when={text() === undefined && disk.loading}>
        <div class="tree-empty">Loading…</div>
      </Show>
      <Show when={text() !== undefined}>
        <div class={styles.markdownBody}>
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
      </Show>
    </OverlayScroll>
  );
}

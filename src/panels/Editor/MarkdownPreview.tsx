import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  bufferTextOf,
  handOff,
  takeHandOff,
  scrollFraction,
  notePreviewAnchor,
  previewAnchorOf,
  boxAt,
} from "../../utils/liveBuffer";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import MarkdownDocument from "./MarkdownDocument";
import styles from "./MarkdownPreview.module.css";

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Read-only rendered view of a `.md` tab (the preview side of its toggle,
 *  CodeEditor stays the source side). The rendering is `MarkdownDocument`'s,
 *  with relative images and links resolved against the file's own directory;
 *  this side owns where the text comes from and the scroll hand-off.
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

  const [renderedFor, setRenderedFor] = createSignal<string | null>(null);

  let box!: HTMLDivElement;
  let body: HTMLDivElement | undefined;
  // The path this view has already positioned itself for. Per path rather than
  // a plain flag, because the same component is reused when the active tab
  // moves from one previewed markdown file to another.
  let placedFor: string | null = null;

  function boxes(): Element[] {
    const out: Element[] = [];
    for (const child of Array.from(body?.children ?? [])) {
      if (child.classList.contains(styles.prose)) out.push(...Array.from(child.children));
      else out.push(child);
    }
    return out;
  }

  const topOf = (el: Element) => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;

  function noteAnchor(path: string) {
    const all = boxes();
    const i = boxAt(all.length, (n) => topOf(all[n]) + all[n].getBoundingClientRect().height, box.scrollTop);
    if (i >= 0) notePreviewAnchor(path, { box: i, offset: box.scrollTop - topOf(all[i]) });
  }

  createEffect(() => {
    if (renderedFor() !== props.path || placedFor === props.path) return;
    const path = props.path;
    placedFor = path;
    const fraction = takeHandOff(path, "preview");
    const anchor = fraction === undefined ? previewAnchorOf(path) : undefined;
    if (fraction === undefined && anchor === undefined) return;
    // After the last slice is in and laid out: until then, the box has no
    // scrollable height for a fraction to point into.
    requestAnimationFrame(() => {
      const max = box.scrollHeight - box.clientHeight;
      if (max <= 0) return;
      if (fraction !== undefined) {
        box.scrollTop = fraction * max;
        // Handed straight back, so toggling to the source without scrolling
        // returns to the same place rather than to the cursor.
        handOff(path, "preview", fraction);
        return;
      }
      const all = boxes();
      if (!all.length || !anchor) return;
      const target = all[Math.min(anchor.box, all.length - 1)];
      const place = () =>
        (box.scrollTop = Math.min(box.scrollHeight - box.clientHeight, topOf(target) + anchor.offset));
      place();
      // Once more a frame later: landing draws the blocks around the target,
      // which were estimated heights until then, and moves it.
      requestAnimationFrame(() => placedFor === path && props.path === path && place());
    });
  });

  return (
    <OverlayScroll
      class={styles.preview}
      // The hand-off needs the element that actually scrolls, which is the
      // component's viewport, not its frame.
      viewportRef={(el) => {
        box = el;
        let noting: number | undefined;
        el.addEventListener("scroll", () => {
          // Not until this path is placed: on a swap between two previews the
          // scroller clamps while still showing the last file, and that offset
          // would be written down under the new one.
          const path = props.path;
          if (placedFor !== path) return;
          const fraction = scrollFraction(box.scrollTop, box.scrollHeight, box.clientHeight);
          if (fraction !== undefined) handOff(path, "preview", fraction);
          if (noting !== undefined) return;
          noting = requestAnimationFrame(() => {
            noting = undefined;
            if (placedFor === path && props.path === path) noteAnchor(path);
          });
        });
        onCleanup(() => noting !== undefined && cancelAnimationFrame(noting));
      }}
    >
      <Show when={text() === undefined && disk.loading}>
        <div class="tree-empty">Loading…</div>
      </Show>
      <Show when={text() !== undefined}>
        <MarkdownDocument
          text={text()!}
          base={dirOf(props.path)}
          source={props.path}
          ref={(el) => (body = el)}
          onRendered={setRenderedFor}
        />
      </Show>
    </OverlayScroll>
  );
}

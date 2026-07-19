import { createResource, Show } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import styles from "./MarkdownPreview.module.css";

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
 *  file's own directory via the asset protocol. */
export default function MarkdownPreview(props: { path: string }) {
  const [text] = createResource(
    () => props.path,
    (path) => invoke<string>("fs_read_file", { path }),
  );
  const html = () => {
    const t = text();
    if (t === undefined) return "";
    return resolveImages(sanitizeHtml(marked.parse(t) as string), dirOf(props.path));
  };
  return (
    <div class={styles.preview}>
      <Show when={text.loading}>
        <div class="tree-empty">Loading…</div>
      </Show>
      <Show when={!text.loading}>
        <div class={styles.markdownBody} innerHTML={html()} />
      </Show>
    </div>
  );
}

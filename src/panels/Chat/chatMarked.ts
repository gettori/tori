import { Marked, type RendererObject } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// What a transcript refuses to turn into markup. A model's text can carry
// instructions somebody else planted in it, and an element that loads a URL
// sends that URL's query string out with no click at all.
const renderer: RendererObject = {
  html: ({ text }) => escapeHtml(text),
  image({ href, text }) {
    if (/^data:image\//i.test(href)) return false;
    return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
  },
};

/** The two newline rules, built once each rather than configured per call.
 *
 *  Instances because the static `marked.lexer`/`marked.parser` take an options
 *  object that *replaces* the defaults instead of merging into them, and
 *  `breaks` does nothing without the `gfm` it would have dropped. Measured on
 *  marked 18.0.6: passing `{breaks: true}` to both halves renders no `<br>` at
 *  all, which is a silent no-op and exactly the shape of bug that survives
 *  review. */
export const PROSE = new Marked({ renderer });
export const LINEWISE = new Marked({ breaks: true, renderer });

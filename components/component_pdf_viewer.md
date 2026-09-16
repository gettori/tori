---
summary: PdfView keys the parsed pdf by path not mount, so a reading position outlives a tab switch that would kill an img
status: current
updated: 2026-09-07
source: plan "PDF viewer tab" (personal/sway, branch `logo-update-260907`), phases 1 to 3 . commits `28df519`, `bfb58fd`, `2f19355`, `fafd814`, `dc57d79`
---

# PDF viewer tab

**Location:** `src/panels/Editor/` (key files: `pdfjsRuntime.ts`, `pdfDocument.ts`, `pdfLayout.ts`, `PdfView.tsx`, `PdfToolbar.tsx`, `PdfView.module.css`, `PdfToolbar.module.css`)

A `.pdf` opened from the tree, an attachment chip, a tool card or `OPEN_IN_EDITOR` renders as scrollable pages in a read-only editor tab, with zoom and page controls in the breadcrumb bar and selectable text that Quote or `Cmd+Shift+M` sends to the picked session. Before this a PDF fell through to `CodeEditor`, which reads a file as UTF-8, so it opened as garbage. The shape is `ImageView`'s (a read-only branch in `Editor.tsx`, excluded from `editablePathOf`, loaded through `convertFileSrc`), with one difference that drives most of the design: an `<img>` can die with its tab, and a parsed document with a reading position cannot.

## Responsibilities

- Owns the parsed document's lifetime, keyed by path rather than by mount, so two panes on one file share one parse and a tab switch costs nothing.
- Owns the page column's geometry: fit modes, the canvas pixel ceiling, virtualisation, and where the reader is.
- Owns the selectable text over each page and which pages keep it.
- Does **not** own the send. `PdfView` reports the selected text and the pages it spans; `Editor.tsx` passes the safe-send gate and calls `requestSend` ([[concept_safe_send]]).
- Does **not** own how a PDF reads on the wire. That is `model::file_ref_locator` plus `composeSelectionMention` and `chipLabel`.
- Deliberately out: search, outline, thumbnails, rotation, printing, annotations, form fields, password-protected files (they get one sentence), streaming or range loading, and reading-order fixes for multi-column text.

## Key files and entry points

- `src/panels/Editor/pdfjsRuntime.ts:1` - the only module that names `pdfjs-dist`, reachable by dynamic import alone. Exports the library, the worker URL and the four runtime data URLs. Fenced by `src/test/lazyEditorBoundary.test.ts`.
- `src/panels/Editor/pdfDocument.ts:73` - `held`, the path-keyed map of `{ task, load }`. Release goes through `PDFDocumentLoadingTask.destroy()`, because `PDFDocumentProxy` has no `destroy` in pdf.js 6 and the task's version also aborts a parse still in flight.
- `src/panels/Editor/pdfDocument.ts:74` - `views`, a `createStore` of `PdfViewState` per path. The toolbar and the view have no ancestor between them, so this is what they share. **Each field has exactly one writer**, which is what stops it being a loop: the toolbar owns `zoom` and `jump`, the view owns `page`, `offset`, `scale` and `pages`.
- `src/panels/Editor/pdfLayout.ts:23` - `CSS_PER_PT = 96 / 72`. Every scale here is CSS pixels per point, so "actual size" is 1.3333 and not 1.
- `src/panels/Editor/pdfLayout.ts:205` - `placeAt`, the reading position: the page crossing a third of the way down the viewport, plus the viewport's offset into it as a fraction of its height. `offset` can be negative, by up to that third.
- `src/panels/Editor/PdfView.tsx:229` - the re-anchor on a scale change. See [[lesson_anchor_a_zoom_on_the_line_the_position_is_read_from]].
- `src/panels/Editor/PdfView.tsx:291` - `installPinch`, both forms a browser reports a pinch in. `e.scale` is cumulative, so a step is a ratio against the last **applied** value, not the last event.
- `src/panels/Editor/PdfView.tsx:424` - `layText`, the `TextLayer` per page. Built once and only ever `update`d.
- `src/panels/Editor/PdfView.tsx:115` - `needsText`, the two-range text window.
- `src/panels/Editor/Editor.tsx:801` - `createEffect(on(allOpenPaths, releasePdfsExcept))`, the release, driven off the open-tab set.
- `src/panels/Editor/Editor.tsx:990` - `quoteFromPdf`, the send.
- `vite.config.ts` - the `sway-pdfjs-data` plugin. See [[concept_pdfjs_in_the_webview]].

## How the pieces fit

- **The document belongs to its path.** `PdfView` is created and destroyed with its pane's tab, so a reading position held in the component would die on every tab switch. `loadPdf`/`releasePdf` and the view store live outside it, and release is driven from one effect in `Editor.tsx` over the open-tab set, mirroring how `CodeEditor` evicts buffers. A mount-scoped release would re-parse on every tab switch, which is the exact thing the store exists to prevent.
- **Pages are virtualised with a canvas ceiling.** Every page holds a placeholder at its true height (page 1's size stands in until a page is measured), only pages crossing the viewport plus one either side get a canvas, and `renderScale` never asks for more than `MAX_CANVAS_PIXELS` (2^24, pdf.js's own default). Past the ceiling the page rasterises at the largest scale that fits and CSS stretches it: blurry at 400% beats blank at 400%. No `IntersectionObserver`; the window is computed from the scroll offset and the measured heights, and `scroll` already triggers that.
- **`goto`'s `line` means a page.** `OPEN_IN_EDITOR`, the attachment chip and the jump list all reach a page without a second event shape. The request is held until the document loads, so a cold open lands on the right page, and it is re-applied per `nonce` so asking for the page you are already on works.
- **The text layer outlives the canvas by as much as the selection needs.** A page is given selectable text when it is being drawn **or** when the selection reaches it, as two ranges rather than one spanning both. See [[gotcha_removing_a_node_a_range_is_anchored_in_collapses_the_selection]].
- **Quoting waits.** Widening the text window is synchronous, building a layer is not, so `quote` awaits the in-flight builds and re-reads the selection before handing it over.
- **`Cmd+Shift+M` belongs to the pane.** The scroller carries `tabIndex = 0` and the listener, so the browser's focus routing decides which pane answers; a selection left standing in a PDF must not answer for a keystroke typed in the composer.

## Connections

- Depends on [[concept_pdfjs_in_the_webview]] - how the library, its worker and its data reach the webview at all.
- Depends on [[concept_safe_send]] - the quote's route to a session, and the `.pdf` page form on the wire.
- Used by [[component_chat_panel]] - through `components/QuoteSelection/`, the floating Quote button both surfaces now mount.
- Beside [[component_markdown_preview]] - the other views that bypass `CodeEditor`'s text pipeline entirely.
- Governed by [[adr_cm6_editor]] - the editor is same-origin CodeMirror 6, so a file it cannot read needs a sibling view rather than an iframe.

## Related

- [[lesson_anchor_a_zoom_on_the_line_the_position_is_read_from]] - why zoom re-anchors on the probe line.
- [[lesson_a_url_import_is_transformed_in_dev_and_copied_at_build]] - the fake-worker split between dev and release.
- [[concept_axe_accessibility_gate]] - the text layer's transparent spans pass because pdf.js marks them presentational.
- [[gotcha_pdf_js_6_3_calls_promise_try_and_uint8array_tohex_without_feature_detecting_them]] - the WebKit floor.
- [[gotcha_jsdom_never_fires_selectionchange_and_its_range_has_no_getboundingclientrect]] - what testing any of the selection half costs.

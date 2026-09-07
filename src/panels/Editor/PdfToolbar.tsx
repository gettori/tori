import { ZoomIn, ZoomOut } from "lucide-solid";
import { createMemo } from "solid-js";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import SegmentedControl, { type SegmentedOption } from "../../components/SegmentedControl/SegmentedControl";
import { jumpToPdfPage, pdfView, setPdfView } from "./pdfDocument";
import {
  MAX_PERCENT,
  MIN_PERCENT,
  clampPage,
  parsePercent,
  percentOf,
  zoomStep,
  type PdfZoom,
} from "./pdfLayout";
import styles from "./PdfToolbar.module.css";

type FitMode = "fitWidth" | "fitPage" | "actual";
/** The strip's fourth state. A typed percentage is none of the three, and the
 *  control has no empty value, so it is named rather than faked with a cast. */
type FitValue = FitMode | "custom";

const FITS: SegmentedOption<FitValue>[] = [
  { value: "fitWidth", label: "Width" },
  { value: "fitPage", label: "Page" },
  { value: "actual", label: "100%" },
];

/**
 * The PDF tab's controls, in the breadcrumb bar's trailing cluster beside the
 * preview and blame toggles rather than inside the viewer. A viewer that drew
 * its own bar would put a second row of chrome in a pane that already has one,
 * and in a split it would draw one per pane.
 *
 * It owns `zoom` and `jump` in the shared view state and reads the rest, which
 * `PdfView` owns. Neither imports the other, which is what lets the viewer stay
 * behind its lazy edge while the bar stays eager.
 */
export default function PdfToolbar(props: { path: string }) {
  const view = () => pdfView(props.path);
  // What the zoom setting came out as at this pane's width. For a fit mode that
  // is only knowable from the view, which is why it is published rather than
  // recomputed here.
  const percent = createMemo(() => percentOf(view().scale));
  const fit = createMemo<FitValue>(() => {
    const zoom = view().zoom;
    return typeof zoom === "string" ? zoom : "custom";
  });

  const setZoom = (zoom: PdfZoom) => setPdfView(props.path, { zoom });

  /**
   * Commit what was typed, then put back what was actually taken. The write-back
   * is not belt and braces: typing 999 into a 12-page document clamps to 12, and
   * if the page was already 12 nothing in the state changes, so nothing would
   * re-render the field and it would sit there showing 999.
   */
  const commitPercent = (el: HTMLInputElement) => {
    const typed = parsePercent(el.value);
    if (typed !== null) setZoom(typed);
    el.value = String(typed ?? percent());
  };

  const commitPage = (el: HTMLInputElement) => {
    const typed = Number(el.value.trim());
    const page = el.value.trim() && Number.isFinite(typed) ? clampPage(typed, view().pages) : null;
    if (page !== null) jumpToPdfPage(props.path, page);
    el.value = String(page ?? view().page);
  };

  /** Enter commits, Escape abandons. Both stop here: this sits inside a pane,
   *  and a bare Enter reaching the window is a command somewhere else. */
  const keys =
    (commit: (el: HTMLInputElement) => void, revert: () => string) => (e: KeyboardEvent) => {
      const el = e.currentTarget as HTMLInputElement;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commit(el);
        el.blur();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        el.value = revert();
        el.blur();
      }
    };

  return (
    <div class={styles.toolbar}>
      <IconButton
        size="sm"
        tooltip="Zoom out"
        disabled={percent() <= MIN_PERCENT}
        icon={<Icon icon={ZoomOut} />}
        onClick={() => setZoom(zoomStep(percent(), -1))}
      />
      {/* Uncontrolled while it is being typed into, and rewritten by Solid when
          `percent()` changes from the outside (a re-fit, a pinch, the buttons
          either side). */}
      <input
        class={styles.field}
        type="text"
        inputMode="numeric"
        aria-label="Zoom percentage"
        value={percent()}
        onBlur={(e) => commitPercent(e.currentTarget)}
        onKeyDown={keys(commitPercent, () => String(percent()))}
      />
      <span class={styles.unit}>%</span>
      <IconButton
        size="sm"
        tooltip="Zoom in"
        disabled={percent() >= MAX_PERCENT}
        icon={<Icon icon={ZoomIn} />}
        onClick={() => setZoom(zoomStep(percent(), 1))}
      />
      <SegmentedControl
        size="sm"
        aria-label="Fit the page"
        options={FITS}
        value={fit()}
        onChange={(value) => value !== "custom" && setZoom(value)}
      />
      <span class={styles.pages}>
        <input
          class={styles.field}
          type="text"
          inputMode="numeric"
          aria-label="Page"
          value={view().page}
          onBlur={(e) => commitPage(e.currentTarget)}
          onKeyDown={keys(commitPage, () => String(view().page))}
        />
        <span class={styles.unit}>/ {view().pages}</span>
      </span>
    </div>
  );
}

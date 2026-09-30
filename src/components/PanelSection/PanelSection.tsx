import { Show, type JSX } from "solid-js";

import Chevron from "../Chevron/Chevron";
import Resizer from "../Resizer/Resizer";
import { chromeScale } from "../../panels/Settings/settingsStore";
import { SECTION_MIN_H, type SectionLayout } from "../../utils/sectionLayout";
import styles from "./PanelSection.module.css";

/**
 * One stacked section: a header that opens and closes it, then its body.
 *
 * Like VS Code, one open section fills what is left and the rest keep a height
 * of their own, dragged from their top edge. The layout store is passed in
 * rather than imported, so the Files and Changes tabs stack sections the same
 * way without sharing one set of section names.
 */
export default function PanelSection<Id extends string>(props: {
  layout: SectionLayout<Id>;
  id: Id;
  /** The open section that takes the leftover height. */
  fill: boolean;
  /** The tallest this section may be dragged to, in px. */
  maxH: () => number;
  title: JSX.Element;
  /** Buttons at the header's right, drawn only while the section is open. */
  actions?: JSX.Element;
  /** Off for a section that is always open (the Files tree): no chevron, and
   *  the header is a label rather than a toggle. */
  collapsible?: boolean;
  children: JSX.Element;
}) {
  const open = () => props.collapsible === false || props.layout.open(props.id);
  const fixed = () => open() && !props.fill;
  const height = () => props.layout.size(props.id) * chromeScale();
  return (
    <section
      class={styles.section}
      classList={{ [styles.fill]: open() && props.fill }}
      style={fixed() ? { flex: `0 1 ${height()}px` } : undefined}
      data-section={props.id}
    >
      <Show when={fixed()}>
        <div class={styles.sash}>
          <Resizer
            axis="y"
            side="after"
            value={height()}
            min={SECTION_MIN_H * chromeScale()}
            max={Math.max(SECTION_MIN_H * chromeScale(), props.maxH())}
            onInput={(h) => props.layout.setSize(props.id, h / chromeScale())}
            onCommit={props.layout.saveSizes}
          />
        </div>
      </Show>
      <div class={styles.sectionHeader}>
        <Show
          when={props.collapsible !== false}
          fallback={
            <span class={`${styles.sectionToggle} ${styles.sectionFixed}`}>
              <span class={styles.sectionTitle}>{props.title}</span>
            </span>
          }
        >
          <button
            type="button"
            class={styles.sectionToggle}
            aria-expanded={open()}
            onClick={() => props.layout.setOpen(props.id, !open())}
          >
            <Chevron open={open()} class={styles.sectionChevron} />
            <span class={styles.sectionTitle}>{props.title}</span>
          </button>
        </Show>
        <Show when={open()}>{props.actions}</Show>
      </div>
      <Show when={open()}>
        <div class={styles.sectionBody}>{props.children}</div>
      </Show>
    </section>
  );
}

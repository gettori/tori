// A branch's standing against its remote, as glyphs.
//
// One renderer for all three surfaces that draw it: the sidebar's branch rows,
// a Topic's roll-up, and the titlebar chip. They have wildly different room, so
// they differ in what they wrap this in and whether they add words, but the
// glyphs and their tones come from here. Two renderers is how a row and the
// chip above it end up disagreeing about the same branch.
//
// Every decision about *which* marks is `utils/branchSync.ts`'s. What lives
// here is the icon each one wears and the size it is drawn at.

import { For, Show, type JSX } from "solid-js";
import { ArrowDownToLine, ArrowUpFromLine, FilePen, GitMergeConflict, type LucideIcon } from "lucide-solid";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import type { SyncMark } from "../../utils/branchSync";
import styles from "./SyncMarks.module.css";

/// Push and pull are exact mirrors of each other, which is what lets both lit
/// at once read as "diverged" without a word for it. `FilePen` rather than a
/// bare dot because a dot is what every other status in this app already is.
const MARK_ICON: Record<SyncMark["kind"], LucideIcon> = {
  conflict: GitMergeConflict,
  push: ArrowUpFromLine,
  pull: ArrowDownToLine,
  dirty: FilePen,
};

export default function SyncMarks(props: {
  marks: readonly SyncMark[];
  /** The run's hover text, through Tori's own tooltip rather than the native
   *  attribute. One target for the whole run, because these are 13px glyphs and
   *  a tooltip per glyph is four hover targets inside twenty pixels.
   *
   *  A string for the surfaces whose answer is one phrase, or a `TooltipLines`
   *  for the branch row, whose answer is a run of facts that needs telling
   *  apart.
   *
   *  Omitted where the surface already has a tooltip of its own, which is the
   *  titlebar chip: its chrome wraps the run and says more than this could. */
  label?: JSX.Element;
  class?: string;
}) {
  const glyphs = () => (
    <For each={props.marks}>
      {(mark) => (
        <span class={`${styles.mark} ${styles[mark.tone]}`} data-sync-mark={mark.kind}>
          <Icon icon={MARK_ICON[mark.kind]} />
          <Show when={mark.count !== null}>{mark.count}</Show>
        </span>
      )}
    </For>
  );

  return (
    <Show when={props.marks.length > 0}>
      <Show
        when={props.label}
        fallback={
          <span class={`${styles.marks} ${props.class ?? ""}`} data-sync-marks>
            {glyphs()}
          </span>
        }
      >
        {(text) => (
          // A span, not a button. The row around it is a div with an onClick
          // and no keyboard path of its own, so a focusable trigger here would
          // add a tab stop per row into a list the keyboard cannot otherwise
          // reach - and the native attribute this replaces was mouse-only too.
          <Tooltip<HTMLSpanElement>
            as="span"
            class={`${styles.marks} ${props.class ?? ""}`}
            label={<span class={styles.lines}>{text()}</span>}
            data-sync-marks
          >
            {glyphs()}
          </Tooltip>
        )}
      </Show>
    </Show>
  );
}

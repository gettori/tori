import { createSignal, Show, type JSX } from "solid-js";
import Chevron from "../Chevron/Chevron";
import MemberChip from "../MemberChip/MemberChip";
import { OUTSIDE_MEMBERS_LABEL, type MemberRoot } from "../../utils/featureMembers";
import styles from "./MemberSection.module.css";

/**
 * One member's band in a right-panel list: its chip, its name, its state when it
 * has one, and whatever the panel draws for it.
 *
 * The Problems and TODO panels each list rows that belong to one repo
 * of a Feature, and each drew the same header to say which. The tree, the Search
 * panel and the Changes panel keep their own markup for now: their headers carry
 * per-section actions this one has no place for.
 *
 * `root` is null for the trailing bucket of rows under no member at all, which
 * is named rather than chipped: there is no repo to take initials from.
 */
export default function MemberSection(props: {
  root: MemberRoot | null;
  /** Whether to draw the header. Unheaded, the section is only its body, which
   *  is what keeps a branch unit's panel exactly as it was. */
  headed: boolean;
  /** How many rows are below, when the panel counts them. */
  count?: number;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(true);
  const state = () => props.root?.state;
  const usable = () => state()?.usable !== false;
  const label = () => props.root?.label || OUTSIDE_MEMBERS_LABEL;

  return (
    <div class={styles.section} data-root={props.root?.path}>
      <Show when={props.headed}>
        <Show
          when={usable()}
          fallback={
            <div class={styles.header}>
              {chip(props.root)}
              <span class={styles.name}>{label()}</span>
              {/* The reason reads out rather than hiding in a `title`: this
                  badge is the only account of why a member has no rows, and a
                  keyboard user never sees a tooltip. */}
              <span class={styles.badge}>
                {state()?.reason ? `${state()!.label}: ${state()!.reason}` : state()?.label}
              </span>
            </div>
          }
        >
          <button
            type="button"
            class={`${styles.header} ${styles.toggle}`}
            aria-expanded={open()}
            onClick={() => setOpen((o) => !o)}
          >
            <Chevron open={open()} />
            {chip(props.root)}
            <span class={styles.name}>{label()}</span>
            <Show when={props.count != null}>
              <span class={styles.count}>{props.count}</span>
            </Show>
          </button>
        </Show>
      </Show>
      <Show when={usable() && (!props.headed || open())}>{props.children}</Show>
    </div>
  );
}

/** No chip for the trailing bucket: it is not a repo, so there are no initials
 *  to take and a neutral box would read as one more member. */
function chip(root: MemberRoot | null) {
  return (
    <Show when={root}>
      {(r) => (
        <MemberChip
          member={{ displayName: r().label, repoPath: r().repoPath }}
          tint={r().tint}
          decorative
        />
      )}
    </Show>
  );
}

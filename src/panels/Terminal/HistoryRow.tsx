import { Show, type JSX } from "solid-js";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
import type { SessionStatus } from "../../utils/sessionStatus";
import type { StatusCertainty } from "../../utils/sessionStatus";
import TabMark from "./TabMark";
import styles from "./HistoryPanel.module.css";

/** One session in the History dropdown. Pure: the panel reads the stores and
 *  hands this what to draw, so the row can be drawn on its own. */
export default function HistoryRow(props: {
  label: string;
  agentId: string;
  status: SessionStatus | null;
  certainty?: StatusCertainty;
  secret?: "read" | "named" | null;
  /** Which account, only when there is a second one to tell it from. */
  profile?: string | null;
  /** Relative last activity, e.g. "3m". */
  when: string;
  active: boolean;
  /** A mark before the label, e.g. the autopilot's wheel on a session it started. */
  lead?: JSX.Element;
  /** Replaces the timestamp while something else holds the session. */
  locked?: JSX.Element;
  items: MenuItem[];
  onOpen: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  return (
    <ContextMenu
      class={styles.row}
      classList={{ [styles.rowActive]: props.active }}
      role="option"
      aria-selected={props.active}
      title={props.label}
      onClick={() => props.onOpen()}
      items={props.items}
      // The trigger is inside the panel but the surface is not: the wrapper
      // portals it out, which is what keeps it clear of `.panel`'s `overflow:
      // hidden` and its z-index.
      //
      // Non-modal, deliberately: a modal menu would `aria-hidden` the very panel
      // it is asking about a row in. See the wrapper's module comment.
      onOpenChange={(open) => props.onMenuOpenChange?.(open)}
    >
      {/* One glyph position for agent and status together, the tab strip's rule
          rather than the sidebar's four-glyph one: these rows are scanned, and
          a row that changes shape when a session merely goes quiet pulls the
          eye to the wrong one. */}
      <TabMark agentId={props.agentId} status={props.status} certainty={props.certainty} secret={props.secret} />
      {props.lead}
      <span class={styles.rowLabel}>{props.label}</span>
      {/* The backend sends a label only when there is a second account to tell
          this one apart from, so a machine that never added one renders exactly
          the list it rendered before. */}
      <Show when={props.profile}>{(profile) => <span class={styles.rowProfile}>{profile()}</span>}</Show>
      <Show when={props.locked} fallback={<span class={styles.rowWhen}>{props.when}</span>}>
        <span class={styles.rowWhen}>{props.locked}</span>
      </Show>
    </ContextMenu>
  );
}

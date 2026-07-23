import { PanelLeft, SquareTerminal, Code2 } from "lucide-solid";
import Icon from "../Icon/Icon";
import { emit, TOGGLE_SIDEBAR, TOGGLE_TERMINAL, TOGGLE_EDITOR } from "../../utils/events";
import styles from "./LayoutToggles.module.css";

// Topbar pane show/hide toggles. The sidebar toggle is a standalone bordered
// icon button (matching the editor's file-tree toggle); the terminal + editor
// toggles are a joined segmented pair (matching the terminal tab bar's new-split
// button). Terminal and editor are guarded by a ">=1 visible" invariant, so the
// last one showing is disabled and can't hide the pair. The file-tree toggle
// lives in the editor tab bar instead, since it is nested inside the editor.
export default function LayoutToggles(props: {
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
}) {
  const termLast = () => props.showTerminal && !props.showEditor;
  const editorLast = () => props.showEditor && !props.showTerminal;
  return (
    <div class={styles.cluster}>
      <button
        class={styles.solo}
        aria-pressed={props.showSidebar}
        title="Show or hide the sidebar (⌘B)"
        onClick={() => emit(TOGGLE_SIDEBAR)}
      >
        <Icon icon={PanelLeft} size={15} />
      </button>
      <div class={styles.split}>
        <button
          class={`${styles.seg} ${styles.segLeft}`}
          aria-pressed={props.showTerminal}
          disabled={termLast()}
          title={termLast() ? "Can't hide the terminal while the editor is hidden" : "Show or hide the terminal (⌘⌥J)"}
          onClick={() => emit(TOGGLE_TERMINAL)}
        >
          <Icon icon={SquareTerminal} size={15} />
        </button>
        <button
          class={`${styles.seg} ${styles.segRight}`}
          aria-pressed={props.showEditor}
          disabled={editorLast()}
          title={editorLast() ? "Can't hide the editor while the terminal is hidden" : "Show or hide the editor (⌘⌥E)"}
          onClick={() => emit(TOGGLE_EDITOR)}
        >
          <Icon icon={Code2} size={15} />
        </button>
      </div>
    </div>
  );
}

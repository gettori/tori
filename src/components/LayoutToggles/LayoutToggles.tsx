import { PanelLeft, SquareTerminal, Code2 } from "lucide-solid";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { emit, TOGGLE_SIDEBAR, TOGGLE_TERMINAL, TOGGLE_EDITOR } from "../../utils/events";
import styles from "./LayoutToggles.module.css";

// Topbar pane show/hide toggles, on the shared <IconButton>. Each is an
// independent toggle (terminal + editor are NOT single-select, so they are three
// icon buttons rather than a SegmentedControl): the "shown" state is the plain
// IconButton look and the "hidden" state accents the glyph (styles.off) as a
// "click to bring it back" cue. Terminal and editor are guarded by a ">=1
// visible" invariant, so the last one showing is disabled and can't hide the
// pair. The file-tree toggle lives in the editor tab bar instead, since it is
// nested inside the editor.
export default function LayoutToggles(props: {
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
}) {
  const termLast = () => props.showTerminal && !props.showEditor;
  const editorLast = () => props.showEditor && !props.showTerminal;
  return (
    <div class={styles.cluster}>
      <IconButton
        size="sm"
        class={props.showSidebar ? undefined : styles.off}
        icon={<Icon icon={PanelLeft} />}
        aria-pressed={props.showSidebar}
        title="Show or hide the sidebar (⌘B)"
        onClick={() => emit(TOGGLE_SIDEBAR)}
      />
      <IconButton
        size="sm"
        class={props.showTerminal ? undefined : styles.off}
        icon={<Icon icon={SquareTerminal} />}
        aria-pressed={props.showTerminal}
        disabled={termLast()}
        title={termLast() ? "Can't hide the terminal while the editor is hidden" : "Show or hide the terminal (⌘⌥J)"}
        onClick={() => emit(TOGGLE_TERMINAL)}
      />
      <IconButton
        size="sm"
        class={props.showEditor ? undefined : styles.off}
        icon={<Icon icon={Code2} />}
        aria-pressed={props.showEditor}
        disabled={editorLast()}
        title={editorLast() ? "Can't hide the editor while the terminal is hidden" : "Show or hide the editor (⌘⌥E)"}
        onClick={() => emit(TOGGLE_EDITOR)}
      />
    </div>
  );
}
